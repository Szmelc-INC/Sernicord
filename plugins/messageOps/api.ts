/*
 * Sernicord MessageOps — Discord gateway: every request of a job goes through the Limiter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI } from "@webpack/common";

import { Abortable, AbortedError, Limiter, RawResponse, routeOf } from "./limiter";

export { AbortedError, ApiError } from "./limiter";

type Method = "get" | "post" | "put" | "patch" | "del";

export interface RestData {
    query?: Record<string, any>;
    body?: Record<string, any>;
    /** multipart: files go out as files[n], the JSON as payload_json */
    files?: File[];
}

/**
 * RestAPI with retries off (the Limiter retries) and failImmediatelyWhenRateLimited,
 * so Discord's own per-URL queue cannot hide a wait from the job status.
 */
export function rest(limiter: Limiter, job: Abortable, method: Method, url: string, data: RestData = {}): Promise<RawResponse> {
    const req: any = { url, retries: 0, failImmediatelyWhenRateLimited: true };
    if (data.query) req.query = data.query;
    if (data.files?.length) {
        req.attachments = data.files.map((f, i) => ({ name: `files[${i}]`, file: f, filename: f.name }));
        req.fields = [{ name: "payload_json", value: JSON.stringify(data.body ?? {}) }];
    } else if (data.body) {
        req.body = data.body;
    }
    return limiter.run(routeOf(method === "del" ? "delete" : method, url), () => RestAPI[method](req), job);
}

/** POST to a webhook URL (fetch, same origin, so the rate limit headers are readable) */
export function webhookExecute(limiter: Limiter, job: Abortable, url: string, payload: any, files: File[]): Promise<RawResponse> {
    return limiter.run(routeOf("post", url), async () => {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        files.forEach((f, i) => form.append(`files[${i}]`, f, f.name));
        const res = await fetch(url, { method: "POST", body: form });
        const body = await res.json().catch(() => null);
        const raw: RawResponse = { status: res.status, headers: res.headers, body };
        if (!res.ok) throw raw;
        return raw;
    }, job);
}

export function bodyOf<T = any>(res: RawResponse): T {
    return (res as any)?.body;
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
export async function messageInChannel(limiter: Limiter, job: Abortable, channelId: string, messageId: string): Promise<boolean> {
    try {
        const res = await rest(limiter, job, "get", Constants.Endpoints.MESSAGES(channelId), { query: { around: messageId, limit: 1 } });
        const body = bodyOf(res);
        return Array.isArray(body) && body.some((m: any) => m?.id === messageId);
    } catch (e) {
        if (e instanceof AbortedError) throw e;
        return false;
    }
}

/**
 * Walk a channel oldest → newest between two message ids (both inclusive,
 * either side open when missing). Yields sorted pages of raw API messages.
 * No fixed delay: the Limiter paces the history bucket from its headers.
 */
export async function* fetchRange(limiter: Limiter, job: Abortable, channelId: string, lo?: string, hi?: string): AsyncGenerator<any[]> {
    const end = hi ? BigInt(hi) : null;
    let cursor = lo ? (BigInt(lo) - 1n).toString() : "0";

    while (!job.abort) {
        const res = await rest(limiter, job, "get", Constants.Endpoints.MESSAGES(channelId), { query: { limit: 100, after: cursor } });
        const body: any[] = Array.isArray(bodyOf(res)) ? bodyOf(res) : [];
        if (body.length === 0) return;

        // the order of `after` pages is not something to rely on
        body.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        cursor = body[body.length - 1].id;

        const page = end == null ? body : body.filter(m => BigInt(m.id) <= end);
        if (page.length) yield page;
        if (end != null && BigInt(cursor) >= end) return;
        if (body.length < 100) return;
    }
    if (job.abort) throw new AbortedError();
}

/* ---------- CDN downloads (not API rate limited: a few in parallel) ---------- */

const CDN_SLOTS = 4;
let cdnBusy = 0;
const cdnWaiters: (() => void)[] = [];

async function cdnSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (cdnBusy >= CDN_SLOTS) await new Promise<void>(r => cdnWaiters.push(r));
    cdnBusy++;
    try {
        return await fn();
    } finally {
        cdnBusy--;
        cdnWaiters.shift()?.();
    }
}

export function download(url: string, name: string, job: Abortable): Promise<File> {
    return cdnSlot(async () => {
        if (job.abort) throw new AbortedError();
        for (let tries = 0; ; tries++) {
            try {
                const res = await fetch(url);
                if (res.ok) return new File([await res.blob()], name);
                if (res.status !== 429 && res.status < 500 || tries >= 3) throw new Error(`download ${name}: HTTP ${res.status}`);
            } catch (e) {
                if (tries >= 3 || String((e as any)?.message).startsWith("download ")) throw e;
            }
            await new Promise(r => setTimeout(r, 1000 * 2 ** tries));
            if (job.abort) throw new AbortedError();
        }
    });
}
