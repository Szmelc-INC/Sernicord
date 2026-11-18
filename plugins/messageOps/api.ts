/*
 * Sernicord MessageOps — REST helpers + range fetch
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI } from "@webpack/common";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AbortedError extends Error {
    constructor() { super("aborted"); }
}

export interface Abortable {
    abort: boolean;
}

/** Sleep that wakes up early (and throws) once the job is aborted */
export async function pause(ms: number, job: Abortable): Promise<void> {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
        if (job.abort) throw new AbortedError();
        await sleep(Math.min(250, end - Date.now()));
    }
    if (job.abort) throw new AbortedError();
}

export function statusOf(e: any): number {
    const status = Number(e?.status ?? e?.statusCode ?? 0);
    return Number.isFinite(status) ? status : 0;
}

export function errorText(e: any): string {
    if (typeof e?.body?.message === "string") return `${statusOf(e) || "?"} ${e.body.message}`;
    if (typeof e?.message === "string" && e.message) return e.message;
    return String(e);
}

/** Retries 429 (honoring retry_after) and transient 5xx / network errors */
export async function withRetry<T>(fn: () => Promise<T>, job: Abortable, onWait?: (s: number) => void): Promise<T> {
    for (let tries = 0; ; tries++) {
        if (job.abort) throw new AbortedError();
        try {
            return await fn();
        } catch (e: any) {
            if (e instanceof AbortedError) throw e;
            const status = statusOf(e);
            if (status === 429 && tries < 10) {
                const seconds = Math.min(Number(e?.body?.retry_after ?? e?.retry_after ?? 2) || 2, 120);
                onWait?.(seconds);
                await pause(seconds * 1000 + 250, job);
                continue;
            }
            if ((status === 0 || status >= 500) && tries < 3) {
                await pause(800 * (tries + 1), job);
                continue;
            }
            throw e;
        }
    }
}

export function snowflakeTime(id: string): number {
    try {
        return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch {
        return 0;
    }
}

export function isSnowflake(id: string | undefined | null): id is string {
    return !!id && /^\d{15,21}$/.test(id);
}

/** Order two ids so that `lo <= hi` (either may be missing) */
export function normalizeRange(a?: string, b?: string): { lo?: string; hi?: string; } {
    const lo = isSnowflake(a) ? a : undefined;
    const hi = isSnowflake(b) ? b : undefined;
    if (lo && hi && BigInt(lo) > BigInt(hi)) return { lo: hi, hi: lo };
    return { lo, hi };
}

/** True when the message exists in that channel (single GET is refused for users, so use `around`) */
export async function messageInChannel(channelId: string, messageId: string, job: Abortable): Promise<boolean> {
    try {
        const res: any = await withRetry(() => RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { around: messageId, limit: 1 },
            retries: 0
        }), job);
        const body = res?.body ?? res;
        return Array.isArray(body) && body.some((m: any) => m?.id === messageId);
    } catch {
        return false;
    }
}

/**
 * Walk a channel oldest → newest between two message ids (both inclusive,
 * either side open when missing). Yields sorted pages of raw API messages.
 */
export async function* fetchRange(
    channelId: string,
    lo: string | undefined,
    hi: string | undefined,
    job: Abortable,
    pageDelayMs: number,
    onWait?: (s: number) => void
): AsyncGenerator<any[]> {
    const end = hi ? BigInt(hi) : null;
    let cursor = lo ? (BigInt(lo) - 1n).toString() : "0";

    while (!job.abort) {
        const res: any = await withRetry(() => RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100, after: cursor },
            retries: 0
        }), job, onWait);
        const body: any[] = Array.isArray(res?.body) ? res.body : Array.isArray(res) ? res : [];
        if (body.length === 0) return;

        // the order of `after` pages is not something to rely on
        body.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        cursor = body[body.length - 1].id;

        const page = end == null ? body : body.filter(m => BigInt(m.id) <= end);
        if (page.length) yield page;
        if (end != null && BigInt(cursor) >= end) return;
        if (body.length < 100) return;
        if (pageDelayMs > 0) await pause(pageDelayMs, job);
    }
}
