/*
 * Sernicord MessageOps — selection, transfer (forward / repost / webhook clone), export, delete
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A run is: collect (scan + filter, nothing written) → confirm → execute.
 * Execute for Copy / Move runs two queues side by side, because they hit
 * different rate limit buckets: a writer posting to the target and, for Move,
 * a deleter removing each source message right after its copy landed.
 * Fail-closed: a source message is only deleted once everything it was copied
 * into was posted (files re-hosted, not linked).
 */

import { saveFile } from "@utils/web";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform, MessageReferenceType } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import {
    ChannelStore, Constants, GuildStore, PermissionsBits, PermissionStore, SnowflakeUtils, UserStore
} from "@webpack/common";
import { strToU8, Zippable, zipSync } from "fflate";

import {
    AbortedError, ApiError, bodyOf, download, fetchRange, isSnowflake, messageInChannel,
    normalizeRange, rest, snowflakeTime, webhookExecute
} from "./api";
import { Limiter } from "./limiter";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

export type Action = "preview" | "export" | "copy" | "move" | "delete";
export type Style = "forward" | "repost" | "clone";
export type Speed = "fast" | "normal" | "careful";

export interface Selection {
    channelId: string;
    startId?: string;
    endId?: string;
    /** empty = everyone */
    authorIds: string[];
    /** plain text (case-insensitive) or /regex/flags */
    text: string;
    attachments: "any" | "with" | "without";
    bots: "include" | "exclude" | "only";
    skipPinned: boolean;
    includeSystem: boolean;
    /** 0 = no cap */
    maxCount: number;
}

export interface RunOptions {
    action: Action;
    selection: Selection;
    targetChannelId: string;
    style: Style;
    /** repost / clone: pack consecutive messages of one author into one post */
    merge: boolean;
    /** repost / clone: small "author · time · link" line */
    originLine: boolean;
    /** Move / Delete: save a ZIP (with files) first */
    safetyZip: boolean;
    speed: Speed;
    /** parent channel id → "webhookId/token", kept in the plugin settings */
    webhookCache: Record<string, string>;
}

export interface Plan {
    opts: RunOptions;
    limiter: Limiter;
    messages: any[];
    /** Copy / Move: what gets posted together */
    groups: any[][];
    scanned: number;
    /** matched but dropped because you lack permission to delete them */
    noPermission: number;
}

export interface Report {
    /** messages copied / moved / deleted (preview + export: matched) */
    done: number;
    /** posts written to the target */
    posts: number;
    deleted: number;
    failed: number;
    /** Move: copied but the source is still there */
    notDeleted: number;
    errors: string[];
    aborted: boolean;
    /** first error that made the run stop early */
    fatal?: string;
    zip?: string;
}

/* ---------- job state (shared by the panel and /msgops) ---------- */

export const job = {
    running: false,
    /** hard stop: everything, right now */
    abort: false,
    /** soft stop: post nothing new, but finish deleting what was already moved */
    stopping: false,
    status: "Idle",
    listeners: new Set<() => void>()
};

export function setStatus(status: string) {
    job.status = status;
    job.listeners.forEach(l => l());
}

const SPEED_FLOOR: Record<Speed, number> = { fast: 0, normal: 500, careful: 2000 };

function newLimiter(speed: Speed, progress: () => string) {
    return new Limiter({
        writeFloorMs: SPEED_FLOOR[speed] ?? SPEED_FLOOR.normal,
        onWait: (ms, why) => setStatus(`${progress()} · ${why}, waiting ${(ms / 1000).toFixed(1)}s`)
    });
}

/* ---------- selection ---------- */

const USER_TYPES = new Set([0, 19, 20, 23]); // DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND
const THREAD_TYPES = new Set([10, 11, 12]);
const FORUM_TYPES = new Set([15, 16]);

export function parseIds(raw: string | undefined): string[] {
    return (raw ?? "").split(/[\s,;]+/).map(s => s.replace(/[<@!>]/g, "")).filter(isSnowflake);
}

/** "word" → case-insensitive substring, "/re/flags" → regex (default flags iu) */
export function textMatcher(raw: string): ((text: string) => boolean) | null {
    const s = raw.trim();
    if (!s) return null;
    const m = s.match(/^\/(.+)\/([a-z]*)$/s);
    if (m) {
        let re: RegExp;
        try {
            re = new RegExp(m[1], m[2].replace(/[gy]/g, "") || "iu");
        } catch (e: any) {
            throw new Error(`Bad regex: ${e?.message ?? e}`);
        }
        return t => re.test(t);
    }
    const needle = s.toLowerCase();
    return t => t.toLowerCase().includes(needle);
}

function matches(m: any, sel: Selection, text: ((t: string) => boolean) | null): boolean {
    if (!sel.includeSystem && !USER_TYPES.has(m.type)) return false;
    if (sel.authorIds.length && !sel.authorIds.includes(m.author?.id)) return false;
    const bot = !!m.author?.bot || m.webhook_id != null;
    if (sel.bots === "exclude" && bot) return false;
    if (sel.bots === "only" && !bot) return false;
    if (sel.skipPinned && m.pinned) return false;
    const files = m.attachments?.length ?? 0;
    if (sel.attachments === "with" && !files) return false;
    if (sel.attachments === "without" && files) return false;
    if (text && !text(m.content ?? "")) return false;
    return true;
}

export function isDestructive(a: Action) {
    return a === "move" || a === "delete";
}

export function isTransfer(a: Action) {
    return a === "copy" || a === "move";
}

function can(bit: bigint | undefined, channel: any) {
    return bit == null || PermissionStore.can(bit, channel);
}

/** Refuse a target that would only produce 403s (each one counts towards Discord's invalid request ban) */
function checkTarget(opts: RunOptions, messages: any[]) {
    const id = opts.targetChannelId;
    if (!isSnowflake(id)) throw new Error("Target channel ID missing or invalid (right-click a channel → MessageOps → Set as target)");
    if (id === opts.selection.channelId) throw new Error("Target is the source channel");
    const ch = ChannelStore.getChannel(id);
    if (!ch) throw new Error("Target channel is not loaded — open it once, then retry");
    if (FORUM_TYPES.has(ch.type)) throw new Error("Target is a forum — pick one of its posts instead");
    if (opts.style === "clone" && !ch.guild_id) throw new Error("Clone (webhook) works only in server channels — use Repost for DMs");
    if (!ch.guild_id) return;

    const thread = THREAD_TYPES.has(ch.type);
    if (opts.style === "clone") {
        const parent = thread ? ChannelStore.getChannel(ch.parent_id) : ch;
        if (!parent || !can(PermissionsBits.MANAGE_WEBHOOKS, parent)) throw new Error("Clone needs Manage Webhooks in the target channel");
        return;
    }
    if (!can(thread ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES, ch)) {
        throw new Error("No permission to send messages in the target");
    }
    if (opts.style === "repost" && messages.some(m => m.attachments?.length) && !can(PermissionsBits.ATTACH_FILES, ch)) {
        throw new Error("No permission to attach files in the target");
    }
}

/** Fetch + filter the range. Nothing is written. */
export async function collect(opts: RunOptions): Promise<Plan> {
    const sel = opts.selection;
    if (!isSnowflake(sel.channelId)) throw new Error("Source channel ID missing or invalid");
    const text = textMatcher(sel.text);
    const { lo, hi } = normalizeRange(sel.startId, sel.endId);

    let scanned = 0;
    const messages: any[] = [];
    const scanLine = () => `Scanning… ${scanned} read, ${messages.length} matched`;
    const limiter = newLimiter(opts.speed, scanLine);
    // nothing is written yet, so the first Stop click ends the scan
    const scanJob = { get abort() { return job.abort || job.stopping; } };

    for (const id of [lo, hi]) {
        if (id && !await messageInChannel(limiter, scanJob, sel.channelId, id)) {
            throw new Error(`Message ${id} is not in channel ${sel.channelId} (threads have their own channel ID)`);
        }
    }

    for await (const page of fetchRange(limiter, scanJob, sel.channelId, lo, hi)) {
        scanned += page.length;
        for (const m of page) {
            if (matches(m, sel, text)) messages.push(m);
            if (sel.maxCount > 0 && messages.length >= sel.maxCount) break;
        }
        setStatus(scanLine());
        if (sel.maxCount > 0 && messages.length >= sel.maxCount) break;
    }
    if (scanJob.abort) throw new AbortedError();

    let noPermission = 0;
    if (isDestructive(opts.action)) {
        const me = UserStore.getCurrentUser()?.id;
        const channel = ChannelStore.getChannel(sel.channelId);
        const canManage = !!channel?.guild_id && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);
        if (!canManage) {
            const own = messages.filter(m => m.author?.id === me);
            noPermission = messages.length - own.length;
            messages.splice(0, messages.length, ...own);
        }
    }

    let groups: any[][] = [];
    if (isTransfer(opts.action)) {
        if (messages.length) checkTarget(opts, messages);
        groups = groupMessages(messages, opts, uploadLimit(opts));
    }

    return { opts, limiter, messages, groups, scanned, noPermission };
}

/* ---------- grouping ---------- */

const MB = 1024 * 1024;
/** above this the files go through Discord's cloud upload instead of one multipart request */
const DIRECT_UPLOAD_MAX = 24 * MB;
const GROUP_GAP_MS = 7 * 60_000;
/** room left for the origin line */
const GROUP_TEXT = 1800;

/** Biggest upload the target accepts: your Nitro or the server boost tier (webhooks: boost only) */
function uploadLimit(opts: RunOptions): number {
    const ch = ChannelStore.getChannel(opts.targetChannelId);
    const tier = ch?.guild_id ? GuildStore.getGuild(ch.guild_id)?.premiumTier ?? 0 : 0;
    const boost = tier >= 3 ? 100 * MB : tier === 2 ? 50 * MB : 10 * MB;
    if (opts.style === "clone") return boost;
    const premium = Number(UserStore.getCurrentUser()?.premiumType ?? 0);
    const nitro = premium === 2 ? 500 * MB : premium === 1 || premium === 3 ? 50 * MB : 10 * MB;
    return Math.max(boost, nitro);
}

function authorKey(m: any) {
    return `${m.author?.id}:${m.webhook_id ? m.author?.username : ""}`;
}

function richEmbeds(m: any): any[] {
    return (m.embeds ?? []).filter((e: any) => e.type === "rich");
}

/**
 * Consecutive messages of one author within a few minutes become one post
 * (≤ 1800 chars, ≤ 10 files within the upload limit, ≤ 10 embeds). Forward
 * cannot merge: one forward is one message.
 */
export function groupMessages(messages: any[], opts: RunOptions, limitBytes: number): any[][] {
    if (opts.style === "forward" || !opts.merge) return messages.map(m => [m]);
    const out: any[][] = [];
    let cur: any[] = [];
    let chars = 0, files = 0, bytes = 0, embeds = 0;
    for (const m of messages) {
        const t = bodyText(m, opts.style === "repost").length;
        const f = m.attachments?.length ?? 0;
        const b = (m.attachments ?? []).reduce((n: number, a: any) => n + (a.size ?? 0), 0);
        const e = opts.style === "clone" ? richEmbeds(m).length : 0;
        const prev = cur[cur.length - 1];
        const fits = prev
            && authorKey(prev) === authorKey(m)
            && snowflakeTime(m.id) - snowflakeTime(prev.id) <= GROUP_GAP_MS
            && chars + 1 + t <= GROUP_TEXT
            && files + f <= 10
            && bytes + b <= limitBytes
            && embeds + e <= 10;
        if (!fits && cur.length) {
            out.push(cur);
            cur = [];
            chars = files = bytes = embeds = 0;
        }
        chars += (cur.length ? 1 : 0) + t;
        files += f;
        bytes += b;
        embeds += e;
        cur.push(m);
    }
    if (cur.length) out.push(cur);
    return out;
}

/* ---------- building posts ---------- */

const NO_PINGS = { parse: [] as string[] };
const WEBHOOK_NAME = "MessageOps";

function guildOf(channelId: string): string | undefined {
    return ChannelStore.getChannel(channelId)?.guild_id ?? undefined;
}

function jumpLink(m: any, channelId: string) {
    return `https://discord.com/channels/${guildOf(channelId) ?? "@me"}/${channelId}/${m.id}`;
}

function displayName(m: any): string {
    return m.author?.global_name || m.author?.username || "unknown";
}

/** Split text into ≤ limit chunks, preferring newline boundaries */
function chunk(text: string, limit = 2000): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n", limit);
        if (cut < limit / 2) cut = limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) out.push(rest);
    return out;
}

/** What a plain user can repost of a message: text + a readable trace of embeds/stickers */
function bodyText(m: any, withEmbeds: boolean): string {
    const parts: string[] = [];
    if (m.content) parts.push(m.content);
    if (withEmbeds) {
        for (const e of richEmbeds(m)) {
            const line = [e.title, e.description].filter(Boolean).join(" — ");
            if (line) parts.push(`> ${line.replace(/\n/g, "\n> ")}`);
        }
    }
    for (const s of m.sticker_items ?? []) parts.push(`[sticker: ${s.name}]`);
    if (!USER_TYPES.has(m.type) && !m.content) parts.push(`[system message, type ${m.type}]`);
    return parts.join("\n");
}

function avatarUrl(m: any): string | undefined {
    const a = m.author;
    if (!a?.id) return undefined;
    if (a.avatar) return `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.${a.avatar.startsWith("a_") ? "gif" : "png"}?size=128`;
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(a.id) >> 22n) % 6n)}.png`;
}

/** Webhook usernames may not contain "discord"/"clyde" and must be 1–80 chars */
function webhookName(m: any): string {
    const name = displayName(m).replace(/discord/gi, "d1scord").replace(/clyde/gi, "c1yde").trim();
    return (name || "unknown").slice(0, 80);
}

function cleanEmbed(e: any) {
    const pick = (o: any, keys: string[]) => o ? Object.fromEntries(keys.filter(k => o[k] != null).map(k => [k, o[k]])) : undefined;
    return {
        title: e.title, description: e.description, url: e.url, color: e.color, timestamp: e.timestamp,
        fields: e.fields,
        author: pick(e.author, ["name", "url", "icon_url"]),
        footer: pick(e.footer, ["text", "icon_url"]),
        image: pick(e.image, ["url"]),
        thumbnail: pick(e.thumbnail, ["url"])
    };
}

interface Post {
    /** forward: the source message id */
    forward?: string;
    content: string;
    files: File[];
    embeds?: any[];
}

interface Ctx {
    opts: RunOptions;
    limiter: Limiter;
    report: Report;
    uploadLimit: number;
    /** error that stops the writer */
    fatal?: ApiError;
}

/**
 * Download what a group needs (runs a few groups ahead of the writer). Files
 * that cannot be re-hosted become links — except on Move: a CDN link dies with
 * the source message, so that fails the group and its sources are kept.
 */
async function prepare(ctx: Ctx, group: any[]): Promise<Post[]> {
    const { opts } = ctx;
    if (opts.style === "forward") return group.map(m => ({ forward: m.id, content: "", files: [] }));

    const strict = opts.action === "move";
    const atts = group.flatMap(m => m.attachments ?? []).slice(0, 10);
    const files: File[] = [];
    const links: string[] = [];
    const got = await Promise.all(atts.map(async (a: any) => {
        const name = a.filename || "file";
        if ((a.size ?? 0) > ctx.uploadLimit) return { a, why: `bigger than the ${Math.round(ctx.uploadLimit / MB)} MB upload limit` };
        try {
            return { a, file: await download(a.url, name, job) };
        } catch (e: any) {
            if (e instanceof AbortedError) throw e;
            return { a, why: e?.message ?? String(e) };
        }
    }));
    for (const g of got) {
        if (g.file) files.push(g.file);
        else if (strict) throw new Error(`attachment ${g.a.filename} not re-uploaded (${g.why}); source kept`);
        else links.push(g.a.url);
    }

    const first = group[0];
    const when = `<t:${Math.floor(snowflakeTime(first.id) / 1000)}:f>`;
    // a jump link to a message that is about to be deleted is useless
    const link = opts.action === "copy" ? ` · ${jumpLink(first, opts.selection.channelId)}` : "";
    const header = !opts.originLine ? ""
        : opts.style === "repost" ? `-# **${displayName(first)}** · ${when}${link}` : `-# ${when}${link}`;
    const body = group.map(m => bodyText(m, opts.style === "repost")).filter(Boolean).join("\n");
    const embeds = opts.style === "clone" ? group.flatMap(richEmbeds).slice(0, 10).map(cleanEmbed) : [];

    const parts = chunk([header, body, ...links].filter(Boolean).join("\n"));
    return parts.map((content, i) => {
        const last = i === parts.length - 1;
        const post: Post = { content, files: last ? files : [] };
        if (last && embeds.length) post.embeds = embeds;
        if (!post.content && !post.files.length && !post.embeds) post.content = "​";
        return post;
    });
}

function uploadOne(channelId: string, file: File): Promise<{ filename: string; uploaded_filename: string; }> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        // CloudUpload may never settle; don't let that freeze the job
        const timer = setTimeout(() => reject(new Error(`upload ${file.name} timed out`)), 300_000);
        upload.on("complete", () => {
            clearTimeout(timer);
            resolve({ filename: upload.filename, uploaded_filename: upload.uploadedFilename });
        });
        upload.on("error", (err: any) => {
            clearTimeout(timer);
            reject(err ?? new Error("upload error"));
        });
        upload.upload();
    });
}

let nonceSeq = 0;

function messageBody(content: string) {
    // unique per post (the low bits of a snowflake are a counter), reused by the
    // Limiter's retries: with enforce_nonce a retry whose first try did land is not posted twice
    const nonce = (BigInt(SnowflakeUtils.fromTimestamp(Date.now())) + BigInt(nonceSeq++ & 0xfff)).toString();
    return { content, nonce, enforce_nonce: true, tts: false, flags: 0, allowed_mentions: NO_PINGS };
}

async function postRepost(ctx: Ctx, post: Post) {
    const url = Constants.Endpoints.MESSAGES(ctx.opts.targetChannelId);
    const body: any = messageBody(post.content);
    const total = post.files.reduce((n, f) => n + f.size, 0);
    if (post.files.length && total <= DIRECT_UPLOAD_MAX) {
        body.attachments = post.files.map((f, i) => ({ id: String(i), filename: f.name }));
        try {
            await rest(ctx.limiter, job, "post", url, { body, files: post.files });
            return;
        } catch (e) {
            // too big for a direct upload: fall through to the cloud upload
            if (!(e instanceof ApiError) || (e.status !== 413 && e.code !== 40005)) throw e;
        }
    }
    if (post.files.length) {
        const ups: { filename: string; uploaded_filename: string; }[] = [];
        for (const f of post.files) {
            if (job.abort) throw new AbortedError();
            ups.push(await uploadOne(ctx.opts.targetChannelId, f));
        }
        body.attachments = ups.map((u, i) => ({ id: String(i), ...u }));
    }
    await rest(ctx.limiter, job, "post", url, { body });
}

async function postForward(ctx: Ctx, messageId: string) {
    const src = ctx.opts.selection.channelId;
    const guildId = guildOf(src);
    await rest(ctx.limiter, job, "post", Constants.Endpoints.MESSAGES(ctx.opts.targetChannelId), {
        body: {
            ...messageBody(""),
            message_reference: {
                type: MessageReferenceType.FORWARD,
                message_id: messageId,
                channel_id: src,
                ...(guildId ? { guild_id: guildId } : {})
            }
        }
    });
}

/** The target's "MessageOps" webhook: cached, else found, else created (needs Manage Webhooks) */
async function webhookFor(ctx: Ctx, fresh: boolean): Promise<string> {
    const ch = ChannelStore.getChannel(ctx.opts.targetChannelId);
    const threadId = THREAD_TYPES.has(ch?.type) ? ch.id : undefined;
    const parentId: string = threadId ? ch.parent_id : ctx.opts.targetChannelId;
    const cache = ctx.opts.webhookCache;

    let idToken = fresh ? undefined : cache[parentId];
    if (!idToken) {
        const list = bodyOf<any[]>(await rest(ctx.limiter, job, "get", `/channels/${parentId}/webhooks`));
        const mine = (Array.isArray(list) ? list : []).find(w => w?.type === 1 && w.name === WEBHOOK_NAME && w.token);
        let hook = mine;
        if (!hook) {
            try {
                hook = bodyOf(await rest(ctx.limiter, job, "post", `/channels/${parentId}/webhooks`, { body: { name: WEBHOOK_NAME } }));
            } catch (e) {
                if (e instanceof ApiError && e.code === 30007) {
                    throw new Error("The target channel already has the maximum number of webhooks — delete one or use Repost");
                }
                throw e;
            }
        }
        if (!hook?.id || !hook?.token) throw new Error("Could not get a webhook token for the target channel");
        idToken = `${hook.id}/${hook.token}`;
        cache[parentId] = idToken;
    }
    return `${location.origin}/api/v10/webhooks/${idToken}?wait=true${threadId ? `&thread_id=${threadId}` : ""}`;
}

async function postClone(ctx: Ctx, post: Post, author: any) {
    const payload: any = {
        username: webhookName(author),
        avatar_url: avatarUrl(author),
        allowed_mentions: NO_PINGS,
        content: post.content
    };
    if (post.embeds?.length) payload.embeds = post.embeds;
    if (post.files.length) payload.attachments = post.files.map((f, i) => ({ id: i, filename: f.name }));

    for (let fresh = false; ; fresh = true) {
        const url = await webhookFor(ctx, fresh);
        try {
            await webhookExecute(ctx.limiter, job, url, payload, post.files);
            return;
        } catch (e) {
            // deleted webhook: never reuse it, make a new one once
            if (!fresh && e instanceof ApiError && (e.code === 10015 || e.status === 404)) continue;
            throw e;
        }
    }
}

async function deleteOne(ctx: Ctx, messageId: string) {
    try {
        await rest(ctx.limiter, job, "del", `${Constants.Endpoints.MESSAGES(ctx.opts.selection.channelId)}/${messageId}`);
    } catch (e) {
        if (e instanceof ApiError && e.code === 10008) return; // already gone
        throw e;
    }
}

/* ---------- export ZIP (Export action + the safety copy before Move / Delete) ---------- */

function safeName(s: string) {
    return s.replace(/[^\w.-]+/g, "_").slice(0, 120) || "file";
}

/**
 * messages.json + messages.txt + every attachment (parallel downloads, stored
 * uncompressed). `strict`: a failed download throws, so nothing gets deleted
 * whose files are not in the ZIP.
 */
export async function buildZip(plan: Plan, label: string, strict: boolean, errors: string[]): Promise<File> {
    const { opts, messages } = plan;
    const sel = opts.selection;
    const zip: Zippable = {};

    const txt = messages.map(m => {
        const when = new Date(snowflakeTime(m.id)).toISOString();
        const atts = (m.attachments ?? []).map((a: any) => `  [file] files/${m.id}-${safeName(a.filename || a.id)} ${a.url}`).join("\n");
        return `[${when}] ${m.author?.username ?? "?"} (${m.author?.id ?? "?"}) #${m.id}\n${bodyText(m, true)}${atts ? "\n" + atts : ""}`;
    }).join("\n\n");

    zip["manifest.json"] = strToU8(JSON.stringify({
        tool: "Sernicord MessageOps",
        createdAt: new Date().toISOString(),
        action: label,
        channelId: sel.channelId,
        guildId: guildOf(sel.channelId) ?? null,
        range: { start: sel.startId || null, end: sel.endId || null },
        filters: { ...sel, channelId: undefined },
        count: messages.length
    }, null, 2));
    zip["messages.json"] = strToU8(JSON.stringify(messages, null, 2));
    zip["messages.txt"] = strToU8(txt);

    const atts = messages.flatMap(m => (m.attachments ?? []).map((a: any) => ({ m, a })));
    let n = 0;
    let failed = false;
    // queued downloads give up once one strict download failed or Stop was clicked
    const gate = { get abort() { return failed || job.abort || job.stopping; } };
    await Promise.all(atts.map(async ({ m, a }) => {
        try {
            const f = await download(a.url, a.filename || "file", gate);
            zip[`files/${m.id}-${safeName(a.filename || a.id)}`] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
        } catch (e: any) {
            if (failed) return;
            if (e instanceof AbortedError || strict) {
                failed = true;
                throw e instanceof AbortedError ? e : new Error(`backup of ${a.filename} failed (${e?.message ?? e}); nothing deleted`);
            }
            errors.push(`ZIP: ${a.filename}: ${e?.message ?? e} (URL kept in messages.json)`);
        }
        if (!failed) setStatus(`ZIP: files ${++n}/${atts.length}`);
    }));

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([zipSync(zip)], `msgops-${label}-${sel.channelId}-${stamp}.zip`, { type: "application/zip" });
}

/* ---------- pipeline ---------- */

function fmtTime(ms: number) {
    const s = Math.round(ms / 1000);
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

function errText(e: any) {
    return e?.message ?? String(e);
}

/** Deletes source messages one by one, fed while the writer is still posting */
class DeleteQueue {
    private ids: string[] = [];
    private closed = false;
    private wake?: () => void;
    done: Promise<void>;
    /** ids that were queued but not deleted when the queue ended early */
    left = 0;

    constructor(private ctx: Ctx, private onTick: () => void, private stopOnSoft: boolean) {
        this.done = this.loop();
    }

    push(ids: string[]) {
        this.ids.push(...ids);
        this.wake?.();
    }

    close() {
        this.closed = true;
        this.wake?.();
    }

    private async loop() {
        const { report } = this.ctx;
        try {
            for (; ;) {
                if (this.stopOnSoft && job.stopping) break;
                const id = this.ids.shift();
                if (!id) {
                    if (this.closed) break;
                    await new Promise<void>(r => { this.wake = r; });
                    this.wake = undefined;
                    continue;
                }
                try {
                    await deleteOne(this.ctx, id);
                    report.deleted++;
                } catch (e) {
                    if (e instanceof AbortedError) throw e;
                    report.failed++;
                    if (report.errors.length < 20) report.errors.push(`delete ${id}: ${errText(e)}`);
                    if (e instanceof ApiError && e.fatal) {
                        report.fatal ??= `delete: ${e.message}`;
                        this.ctx.fatal ??= e;
                        break;
                    }
                }
                this.onTick();
            }
        } catch (e) {
            if (!(e instanceof AbortedError)) throw e;
            report.aborted = true;
        } finally {
            this.left = this.ids.length;
        }
    }
}

const PREFETCH = 3;

async function writer(ctx: Ctx, groups: any[][], deleter: DeleteQueue | null, onTick: () => void) {
    const { report, opts } = ctx;
    const ahead: { group: any[]; posts: Promise<Post[]>; }[] = [];
    let next = 0;
    const fill = () => {
        while (ahead.length < PREFETCH && next < groups.length) {
            const group = groups[next++];
            const posts = prepare(ctx, group);
            posts.catch(() => { }); // handled when its turn comes
            ahead.push({ group, posts });
        }
    };

    for (let i = 0; i < groups.length; i++) {
        if (job.abort) throw new AbortedError();
        if (job.stopping || ctx.fatal) break;
        fill();
        const { group, posts } = ahead.shift()!;
        try {
            for (const post of await posts) {
                if (post.forward) await postForward(ctx, post.forward);
                else if (opts.style === "clone") await postClone(ctx, post, group[0]);
                else await postRepost(ctx, post);
                report.posts++;
            }
            report.done += group.length;
            deleter?.push(group.map(m => m.id));
        } catch (e) {
            if (e instanceof AbortedError) throw e;
            report.failed += group.length;
            if (report.errors.length < 20) report.errors.push(`${group[0].id}${group.length > 1 ? ` (+${group.length - 1})` : ""}: ${errText(e)}`);
            if (e instanceof ApiError && e.fatal) {
                report.fatal ??= e.message;
                ctx.fatal ??= e;
            }
        }
        onTick();
    }
}

export async function execute(plan: Plan): Promise<Report> {
    const { opts, messages, groups, limiter } = plan;
    const { action } = opts;
    const report: Report = { done: 0, posts: 0, deleted: 0, failed: 0, notDeleted: 0, errors: [], aborted: false };
    const ctx: Ctx = { opts, limiter, report, uploadLimit: uploadLimit(opts) };
    const started = Date.now();

    const progress = () => {
        const total = messages.length;
        const work = action === "delete" ? report.deleted + report.failed : report.done + report.failed;
        const rate = work / Math.max(1, (Date.now() - started) / 60_000);
        const eta = work > 0 && work < total ? ` · ETA ${fmtTime((total - work) / rate * 60_000)}` : "";
        const del = action === "move" ? ` · deleted ${report.deleted}` : "";
        const lim = limiter.stats.limited ? ` · 429×${limiter.stats.limited}` : "";
        return `${action}: ${work}/${total}${del} · failed ${report.failed} · ${rate.toFixed(0)}/min${eta}${lim}`;
    };
    // wait notices from the limiter use the live counters
    limiter.onWait = (ms, why) => setStatus(`${progress()} · ${why}, waiting ${(ms / 1000).toFixed(1)}s`);
    const tick = () => setStatus(progress());

    try {
        if (action === "export" || (isDestructive(action) && opts.safetyZip)) {
            setStatus("Building ZIP…");
            const zip = await buildZip(plan, action === "export" ? "export" : `pre-${action}`, action !== "export", report.errors);
            saveFile(zip);
            report.zip = zip.name;
        }
        if (action === "preview" || action === "export") {
            report.done = messages.length;
            return report;
        }

        if (action === "delete") {
            const deleter = new DeleteQueue(ctx, tick, true);
            deleter.push(messages.map(m => m.id));
            deleter.close();
            await deleter.done;
            report.done = report.deleted;
            return report;
        }

        const deleter = action === "move" ? new DeleteQueue(ctx, tick, false) : null;
        try {
            await writer(ctx, groups, deleter, tick);
        } finally {
            // already-copied sources still get deleted after a soft stop or a writer error
            deleter?.close();
            await deleter?.done;
        }
    } catch (e) {
        if (!(e instanceof AbortedError)) throw e;
        report.aborted = true;
    }
    if (action === "move") report.notDeleted = Math.max(0, report.done - report.deleted);
    return report;
}
