/*
 * MessageOps limiter tests with mocked Discord responses (no Discord, no webpack).
 * Run: node --experimental-strip-types --no-warnings scripts/test-messageops-limiter.ts
 */
import assert from "node:assert/strict";
import { Limiter, routeOf, ApiError, AbortedError } from "../plugins/messageOps/limiter.ts";
type RawResponse = import("../plugins/messageOps/limiter.ts").RawResponse;

const ok = (h: Record<string, string> = {}, body: any = {}): RawResponse => ({ status: 200, headers: h, body });
const err = (status: number, body: any, h: Record<string, string> | undefined = {}) => ({ status, headers: h, body });
const job = { abort: false };
let pass = 0;
async function t(name: string, fn: () => Promise<void>) { await fn(); pass++; console.log("ok -", name); }

const R = routeOf("post", "/channels/111111111111111111/messages");
const D = (id: string) => routeOf("delete", `/channels/111111111111111111/messages/${id}`);

await t("routeOf templates ids, keeps major, webhook token", async () => {
    assert.equal(R.key, "POST /channels/:id/messages"); assert.equal(R.major, "111111111111111111"); assert.equal(R.write, true);
    const d = D("222222222222222222"); assert.equal(d.key, "DELETE /channels/:id/messages/:id");
    const w = routeOf("post", "https://discord.com/api/v10/webhooks/333333333333333333/abc-DEF_tok?wait=true&thread_id=444444444444444444");
    assert.equal(w.key, "POST /webhooks/:id/:token"); assert.equal(w.major, "333333333333333333");
    assert.equal(routeOf("get", "/channels/111111111111111111/messages").write, false);
});

await t("remaining 0 + reset-after: next request waits", async () => {
    const l = new Limiter(); const times: number[] = [];
    const send = async () => { times.push(Date.now()); return ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.3" }); };
    await l.run(R, send, job); await l.run(R, send, job);
    assert.ok(times[1] - times[0] >= 300, `gap ${times[1] - times[0]}`);
});

await t("no headers, fast: no artificial wait; write floor applies otherwise", async () => {
    let l = new Limiter(); let t0 = Date.now();
    for (let i = 0; i < 5; i++) await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t0 < 100);
    l = new Limiter({ writeFloorMs: 100 }); t0 = Date.now();
    for (let i = 0; i < 4; i++) await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t0 >= 300, `floor ${Date.now() - t0}`);
    t0 = Date.now(); const G = routeOf("get", "/channels/111111111111111111/messages");
    for (let i = 0; i < 4; i++) await l.run(G, async () => ok(), job);
    assert.ok(Date.now() - t0 < 100, "reads are not floored");
});

await t("429 user scope: retried (not a failure), waits retry_after, widens spacing", async () => {
    const l = new Limiter(); let n = 0; const times: number[] = [];
    const send = async () => { times.push(Date.now()); if (n++ === 0) throw err(429, { retry_after: 0.4, global: false }, { "x-ratelimit-scope": "user" }); return ok(); };
    const r = await l.run(R, send, job);
    assert.equal(r.status, 200); assert.equal(l.stats.limited, 1);
    assert.ok(times[1] - times[0] >= 400);
    const t0 = Date.now(); await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t0 >= 350, `widened spacing ${Date.now() - t0}`);
});

await t("429 shared scope: waits but does not widen spacing", async () => {
    const l = new Limiter(); let n = 0;
    await l.run(R, async () => { if (n++ === 0) throw err(429, { retry_after: 0.3 }, { "x-ratelimit-scope": "shared" }); return ok(); }, job);
    const t0 = Date.now(); await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t0 < 100);
});

await t("429 global pauses other buckets", async () => {
    const l = new Limiter(); let first = true; const t0 = Date.now(); let tOther = 0;
    const a = l.run(R, async () => { if (first) { first = false; throw err(429, { retry_after: 0.5, global: true }, {}); } return ok(); }, job);
    await new Promise(r => setTimeout(r, 30));
    const b = l.run(D("222222222222222222"), async () => { tOther = Date.now(); return ok(); }, job);
    await Promise.all([a, b]);
    assert.ok(tOther - t0 >= 450, `other bucket waited ${tOther - t0}`);
});

await t("Discord's own queued rejection (no headers, retry_after 0): min wait, no hot loop, no widening", async () => {
    const l = new Limiter(); let n = 0; const t0 = Date.now();
    await l.run(R, async () => { if (n++ < 2) throw { status: 429, body: { message: "x", retry_after: 0 } }; return ok(); }, job);
    assert.equal(n, 3); assert.ok(Date.now() - t0 >= 500);
    const t1 = Date.now(); await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t1 < 100);
});

await t("429 without retry_after (Cloudflare): long fallback wait", async () => {
    const l = new Limiter(); const job2 = { abort: false }; let n = 0;
    setTimeout(() => { job2.abort = true; }, 300);
    await assert.rejects(l.run(R, async () => { n++; throw { status: 429, headers: {}, body: "<html>" }; }, job2), AbortedError);
    assert.equal(n, 1);
});

await t("abort mid-wait throws AbortedError fast", async () => {
    const l = new Limiter(); const job2 = { abort: false };
    await l.run(R, async () => ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "30" }), job2);
    setTimeout(() => { job2.abort = true; }, 200); const t0 = Date.now();
    await assert.rejects(l.run(R, async () => ok(), job2), AbortedError);
    assert.ok(Date.now() - t0 < 700);
});

await t("same bucket is serialized (one in flight)", async () => {
    const l = new Limiter(); let inFlight = 0, max = 0;
    const send = async () => { inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 20)); inFlight--; return ok(); };
    await Promise.all(Array.from({ length: 6 }, () => l.run(R, send, job)));
    assert.equal(max, 1);
});

await t("different buckets run in parallel (posts vs deletes)", async () => {
    const l = new Limiter(); let inFlight = 0, max = 0;
    const send = async () => { inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 30)); inFlight--; return ok(); };
    await Promise.all([l.run(R, send, job), l.run(D("222222222222222222"), send, job)]);
    assert.equal(max, 2);
});

await t("X-RateLimit-Bucket aliases routes onto one state", async () => {
    const l = new Limiter();
    const P = routeOf("patch", "/channels/111111111111111111/messages/222222222222222222");
    await l.run(D("222222222222222222"), async () => ok({ "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "5", "x-ratelimit-reset-after": "1" }), job);
    await l.run(P, async () => ok({ "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.3" }), job);
    // the delete route shares the hash, so it waits for the patch's exhausted bucket
    const t0 = Date.now(); await l.run(D("333333333333333333"), async () => ok(), job);
    assert.ok(Date.now() - t0 >= 280, `shared bucket wait ${Date.now() - t0}`);
});

await t("fetch Headers object is read too", async () => {
    const l = new Limiter(); const times: number[] = [];
    const send = async () => { times.push(Date.now()); return { status: 200, headers: new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.25" }), body: {} }; };
    await l.run(R, send, job); await l.run(R, send, job);
    assert.ok(times[1] - times[0] >= 250);
});

await t("errors: 403/50013 fatal, 10008 not fatal, captcha fatal, 5xx retried", async () => {
    const l = new Limiter({ transientRetries: 2 });
    await assert.rejects(l.run(R, async () => { throw err(403, { code: 50013, message: "Missing Permissions" }); }, job), (e: any) => e instanceof ApiError && e.fatal && e.code === 50013);
    await assert.rejects(l.run(D("2".repeat(18)), async () => { throw err(404, { code: 10008, message: "Unknown Message" }); }, job), (e: any) => e instanceof ApiError && !e.fatal);
    await assert.rejects(l.run(R, async () => { throw err(400, { captcha_key: ["captcha-required"] }); }, job), (e: any) => e instanceof ApiError && e.fatal);
    let n = 0; const r = await l.run(routeOf("get", "/channels/555555555555555555/messages"), async () => { if (n++ < 2) throw err(502, {}); return ok(); }, job);
    assert.equal(r.status, 200); assert.equal(n, 3);
});

await t("spacing decays back after successes", async () => {
    const l = new Limiter(); let n = 0;
    await l.run(R, async () => { if (n++ < 3) throw err(429, { retry_after: 0.05 }, { "x-ratelimit-scope": "user" }); return ok(); }, job);
    for (let i = 0; i < 30; i++) await l.run(R, async () => ok(), job);
    const t1 = Date.now(); await l.run(R, async () => ok(), job);
    assert.ok(Date.now() - t1 < 200, `decayed gap ${Date.now() - t1}`);
});

console.log(`\n${pass} passed`);
