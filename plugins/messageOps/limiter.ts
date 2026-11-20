/*
 * Sernicord MessageOps — header-driven rate limiter
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every Discord request of a job goes through one Limiter. It follows what
 * https://docs.discord.com/developers/topics/rate-limits asks for instead of a
 * fixed delay:
 *
 * - one request in flight per bucket (route + major id, aliased to the
 *   X-RateLimit-Bucket hash once a response reveals it)
 * - an exhausted bucket (remaining 0) waits reset-after before the next call
 * - 429: wait retry_after; scope "global" pauses every bucket, "shared" (a limit
 *   other users fill too) only waits, "user" / unknown also widens this bucket's
 *   spacing, which shrinks back on successes (user accounts have limits that the
 *   headers do not show)
 * - a 429 is never a failure: it is retried until the job is aborted
 *
 * No webpack imports: the transport is passed in, so this file can be tested
 * with plain node.
 */

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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

/** A finished request: RestAPI resolves / rejects with this shape, the webhook path builds it */
export interface RawResponse {
    status: number;
    /** plain object with lowercase keys (RestAPI) or a fetch Headers; missing on Discord's own queued rejections */
    headers?: any;
    body?: any;
}

export interface Route {
    /** method + path with ids templated, e.g. "DELETE /channels/:id/messages/:id" */
    key: string;
    /** first id of the path: channel / guild / webhook */
    major: string;
    write: boolean;
}

const ID = /\d{15,21}/g;

export function routeOf(method: string, url: string): Route {
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").replace(/^\/api(?:\/v\d+)?/, "");
    const major = path.match(/^\/(?:channels|guilds|webhooks)\/(\d{15,21})/)?.[1] ?? "";
    const key = `${method.toUpperCase()} ${path.replace(/^(\/webhooks\/\d+\/)[\w-]+/, "$1:token").replace(ID, ":id")}`;
    return { key, major, write: method.toLowerCase() !== "get" };
}

export function header(headers: any, name: string): string | undefined {
    if (headers == null) return undefined;
    const v = typeof headers.get === "function" ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
    return v == null ? undefined : String(v);
}

function num(v: string | undefined): number | undefined {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function statusOf(e: any): number {
    const status = Number(e?.status ?? e?.statusCode ?? 0);
    return Number.isFinite(status) ? status : 0;
}

/** Seconds to wait from a 429, or undefined when the response does not say */
export function retryAfterOf(raw: any): number | undefined {
    const body = num(raw?.body?.retry_after != null ? String(raw.body.retry_after) : undefined);
    if (body != null && body >= 0) return body;
    return num(header(raw?.headers, "retry-after"));
}

/** Non-429 HTTP error, already classified */
export class ApiError extends Error {
    status: number;
    code: number;
    /** further requests of this job would fail the same way (no access, missing permission, captcha…) */
    fatal: boolean;
    constructor(raw: any) {
        const status = statusOf(raw);
        const code = Number(raw?.body?.code ?? 0) || 0;
        const msg = typeof raw?.body?.message === "string" ? raw.body.message
            : raw?.body?.captcha_key ? "captcha required — solve one in Discord and retry"
                : typeof raw?.message === "string" ? raw.message : `HTTP ${status}`;
        super(`${status || "?"}${code ? `/${code}` : ""} ${msg}`);
        this.status = status;
        this.code = code;
        this.fatal = status === 401 || status === 403 || !!raw?.body?.captcha_key || FATAL_CODES.has(code);
    }
}

// Unknown Channel, Unknown Webhook, Missing Access, Missing Permissions,
// Thread archived/locked, account verification needed
const FATAL_CODES = new Set([10003, 10015, 50001, 50013, 50083, 160005, 40002]);

interface BucketState {
    tail: Promise<void>;
    /** do not send before this timestamp */
    nextAt: number;
    /** adaptive minimum gap between requests */
    spacing: number;
}

export interface LimiterStats {
    requests: number;
    limited: number;
    limitedMs: number;
}

export interface LimiterOptions {
    /** minimum gap between writes on one bucket (ms) */
    writeFloorMs?: number;
    /** upper bound of the adaptive spacing (ms) */
    maxSpacingMs?: number;
    /** called before every wait longer than 0.5 s */
    onWait?: (ms: number, why: string, route: Route) => void;
    /** transient errors (network, 5xx) retried this many times */
    transientRetries?: number;
}

export class Limiter {
    stats: LimiterStats = { requests: 0, limited: 0, limitedMs: 0 };
    globalUntil = 0;
    /** called before every wait longer than 0.5 s (status line) */
    onWait?: (ms: number, why: string, route: Route) => void;
    private states = new Map<string, BucketState>();
    /** route.key|major → bucket hash|major */
    private alias = new Map<string, string>();
    private opts: Required<Omit<LimiterOptions, "onWait">>;

    constructor(opts: LimiterOptions = {}) {
        this.opts = {
            writeFloorMs: opts.writeFloorMs ?? 0,
            maxSpacingMs: opts.maxSpacingMs ?? 15_000,
            transientRetries: opts.transientRetries ?? 4
        };
        this.onWait = opts.onWait;
    }

    private floor(route: Route) {
        return route.write ? this.opts.writeFloorMs : 0;
    }

    private state(route: Route): BucketState {
        const own = `${route.key}|${route.major}`;
        const id = this.alias.get(own) ?? own;
        let s = this.states.get(id);
        if (!s) {
            s = { tail: Promise.resolve(), nextAt: 0, spacing: this.floor(route) };
            this.states.set(id, s);
        }
        return s;
    }

    /** Point this route at the shared bucket state named by X-RateLimit-Bucket */
    private learn(route: Route, headers: any) {
        const hash = header(headers, "x-ratelimit-bucket");
        if (!hash) return;
        const own = `${route.key}|${route.major}`;
        const id = `${hash}|${route.major}`;
        if (this.alias.get(own) === id) return;
        const current = this.state(route);
        if (!this.states.has(id)) this.states.set(id, current);
        this.alias.set(own, id);
    }

    /**
     * Send through the limiter. `send` resolves with a RawResponse on 2xx and
     * rejects with one (or a network Error) otherwise. Resolves with the
     * response, throws ApiError / AbortedError.
     */
    async run(route: Route, send: () => Promise<RawResponse>, job: Abortable): Promise<RawResponse> {
        const s = this.state(route);
        const prev = s.tail;
        let release!: () => void;
        s.tail = new Promise<void>(r => { release = r; });
        try {
            await prev;
            return await this.attempt(route, send, job);
        } finally {
            release();
        }
    }

    private async wait(until: number, why: string, route: Route, job: Abortable) {
        const ms = until - Date.now();
        if (ms <= 0) return;
        if (ms > 500) this.onWait?.(ms, why, route);
        await pause(ms, job);
    }

    private async attempt(route: Route, send: () => Promise<RawResponse>, job: Abortable): Promise<RawResponse> {
        let transient = 0;
        let blind = 0; // 429s in a row that did not say how long to wait
        for (; ;) {
            if (job.abort) throw new AbortedError();
            await this.wait(this.globalUntil, "global rate limit", route, job);
            const before = this.state(route);
            await this.wait(before.nextAt, before.nextAt - Date.now() > before.spacing + 50 ? "rate limit" : "pacing", route, job);
            await this.wait(this.globalUntil, "global rate limit", route, job);

            let raw: any;
            let ok = true;
            this.stats.requests++;
            try {
                raw = await send();
            } catch (e) {
                if (e instanceof AbortedError) throw e;
                raw = e;
                ok = false;
            }
            const status = statusOf(raw);
            this.learn(route, raw?.headers);
            const s = this.state(route);
            const now = Date.now();

            if (ok && (status === 0 || status < 400)) {
                const remaining = num(header(raw?.headers, "x-ratelimit-remaining"));
                const resetAfter = num(header(raw?.headers, "x-ratelimit-reset-after"));
                s.spacing = Math.max(this.floor(route), s.spacing * 0.9);
                const gap = remaining === 0 && resetAfter != null ? resetAfter * 1000 + 50 : s.spacing;
                s.nextAt = Math.max(s.nextAt, now + gap);
                return raw;
            }

            if (status === 429) {
                const scope = header(raw?.headers, "x-ratelimit-scope");
                const global = !!raw?.body?.global || header(raw?.headers, "x-ratelimit-global") === "true" || scope === "global";
                // Discord's HTTP layer rejects queued requests itself (no headers): just wait it out
                const synthetic = raw?.headers === undefined;
                const after = retryAfterOf(raw);
                const ms = after != null
                    ? Math.max(250, after * 1000) + Math.random() * 250
                    : Math.min(60_000, 5000 * 2 ** blind++);
                if (after != null) blind = 0;
                this.stats.limited++;
                this.stats.limitedMs += ms;
                if (global) this.globalUntil = Math.max(this.globalUntil, now + ms);
                else s.nextAt = Math.max(s.nextAt, now + ms);
                if (!synthetic && !global && scope !== "shared") {
                    s.spacing = Math.min(this.opts.maxSpacingMs, Math.max(s.spacing * 2, 500));
                }
                continue;
            }

            if ((status === 0 || status >= 500) && transient < this.opts.transientRetries) {
                s.nextAt = Math.max(s.nextAt, now + 1000 * 2 ** transient++);
                continue;
            }

            throw status === 0 && raw instanceof Error ? raw : new ApiError(raw);
        }
    }
}
