/*
 * Sernicord MessageOps — selection, transfer (forward / copy / webhook clone), backup, delete
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { saveFile } from "@utils/web";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform, MessageReferenceType } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import {
    ChannelStore, Constants, PermissionsBits, PermissionStore, RestAPI, SnowflakeUtils, UserStore
} from "@webpack/common";
import { strToU8, zipSync } from "fflate";

import {
    AbortedError, errorText, fetchRange, isSnowflake, messageInChannel, normalizeRange,
    pause, snowflakeTime, withRetry
} from "./api";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

export type Action = "preview" | "backup" | "copy" | "move" | "delete";
export type TransferMode = "forward" | "copy" | "webhook";
export type MirrorMode = "off" | "forward" | "copy" | "both";

export interface Selection {
    channelId: string;
    startId?: string;
    endId?: string;
    /** empty = everyone */
    authorIds: string[];
    contains?: string;
    regex?: string;
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
    dryRun: boolean;
    transferMode: TransferMode;
    targetChannelId: string;
    webhookUrl: string;
    mirrorMode: MirrorMode;
    mirrorChannelId: string;
    delayMs: number;
    copyHeader: boolean;
    reuploadFiles: boolean;
    maxUploadMb: number;
    autoBackup: boolean;
    backupFiles: boolean;
    uploadBackupToMirror: boolean;
}

export interface Plan {
    opts: RunOptions;
    messages: any[];
    scanned: number;
    /** matched but dropped because you lack permission to delete them */
    noPermission: number;
}

/* ---------- job state (shared by the panel and /msgops) ---------- */

export const job = {
    running: false,
    abort: false,
    status: "Idle",
    listeners: new Set<() => void>()
};

export function setStatus(status: string) {
    job.status = status;
    job.listeners.forEach(l => l());
}

const onWait = (s: number) => setStatus(`${job.status.replace(/ \(rate limited.*\)$/, "")} (rate limited, ${s}s)`);

/* ---------- selection ---------- */

const USER_TYPES = new Set([0, 19, 20, 23]); // DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND

export function parseIds(raw: string | undefined): string[] {
    return (raw ?? "").split(/[\s,;]+/).map(s => s.replace(/[<@!>]/g, "")).filter(isSnowflake);
}

function buildRegex(sel: Selection): RegExp | null {
    if (!sel.regex) return null;
    try {
        return new RegExp(sel.regex, "iu");
    } catch (e) {
        throw new Error(`Bad regex: ${errorText(e)}`);
    }
}

function matches(m: any, sel: Selection, re: RegExp | null): boolean {
    if (!sel.includeSystem && !USER_TYPES.has(m.type)) return false;
    if (sel.authorIds.length && !sel.authorIds.includes(m.author?.id)) return false;
    const bot = !!m.author?.bot || m.webhook_id != null;
    if (sel.bots === "exclude" && bot) return false;
    if (sel.bots === "only" && !bot) return false;
    if (sel.skipPinned && m.pinned) return false;
    const files = m.attachments?.length ?? 0;
    if (sel.attachments === "with" && !files) return false;
    if (sel.attachments === "without" && files) return false;
    const text: string = m.content ?? "";
    if (sel.contains && !text.toLowerCase().includes(sel.contains.toLowerCase())) return false;
    if (re && !re.test(text)) return false;
    return true;
}

function isDestructive(a: Action) {
    return a === "move" || a === "delete";
}

function validate(opts: RunOptions) {
    const { action, selection: sel } = opts;
    if (!isSnowflake(sel.channelId)) throw new Error("Source channel ID missing or invalid");
    if (action === "copy" || action === "move") {
        if (opts.transferMode === "webhook") {
            if (!WEBHOOK_RE.test(opts.webhookUrl.trim())) throw new Error("Webhook URL missing or not a discord.com webhook");
        } else if (!isSnowflake(opts.targetChannelId)) {
            throw new Error("Target channel ID missing or invalid");
        }
    }
    if (opts.mirrorMode !== "off" && !isSnowflake(opts.mirrorChannelId)) {
        throw new Error("Mirror is on but the mirror channel ID is missing or invalid");
    }
}

/** Fetch + filter the range. Nothing is written. */
export async function collect(opts: RunOptions): Promise<Plan> {
    validate(opts);
    const sel = opts.selection;
    const re = buildRegex(sel);
    const { lo, hi } = normalizeRange(sel.startId, sel.endId);

    for (const id of [lo, hi]) {
        if (id && !await messageInChannel(sel.channelId, id, job)) {
            throw new Error(`Message ${id} is not in channel ${sel.channelId} (threads have their own channel ID)`);
        }
    }

    const messages: any[] = [];
    let scanned = 0;
    for await (const page of fetchRange(sel.channelId, lo, hi, job, 300, onWait)) {
        scanned += page.length;
        for (const m of page) {
            if (matches(m, sel, re)) messages.push(m);
            if (sel.maxCount > 0 && messages.length >= sel.maxCount) break;
        }
        setStatus(`Scanning… ${scanned} read, ${messages.length} matched`);
        if (sel.maxCount > 0 && messages.length >= sel.maxCount) break;
    }
    if (job.abort) throw new AbortedError();

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

    return { opts, messages, scanned, noPermission };
}

/* ---------- writing helpers ---------- */

const NO_PINGS = { parse: [] as string[] };
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

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
        for (const e of m.embeds ?? []) {
            if (e.type !== "rich") continue;
            const line = [e.title, e.description].filter(Boolean).join(" — ");
            if (line) parts.push(`> ${line.replace(/\n/g, "\n> ")}`);
        }
    }
    for (const s of m.sticker_items ?? []) parts.push(`[sticker: ${s.name}]`);
    if (!USER_TYPES.has(m.type) && !m.content) parts.push(`[system message, type ${m.type}]`);
    return parts.join("\n");
}

async function download(url: string, name: string): Promise<File> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
    return new File([await res.blob()], name);
}

function uploadOne(channelId: string, file: File): Promise<{ filename: string; uploaded_filename: string; }> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        // CloudUpload may never settle; don't let that freeze the job
        const timer = setTimeout(() => reject(new Error(`upload ${file.name} timed out`)), 120_000);
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

/**
 * Re-host a message's attachments through `take`. Files that cannot be
 * re-hosted become links — except before a delete (Move / Delete): a CDN link
 * dies with the source message, so that throws and the source is kept.
 */
async function gatherFiles<T>(m: any, opts: RunOptions, take: (f: File) => Promise<T>): Promise<{ items: T[]; links: string[]; }> {
    const strict = isDestructive(opts.action);
    const limit = opts.maxUploadMb * 1024 * 1024;
    const items: T[] = [];
    const links: string[] = [];
    for (const att of (m.attachments ?? []).slice(0, 10)) {
        const name = att.filename || "file";
        let why = "";
        if (!opts.reuploadFiles) why = "re-upload is off";
        else if ((att.size ?? 0) > limit) why = `bigger than ${opts.maxUploadMb} MB`;
        else {
            try {
                items.push(await take(await download(att.url, name)));
                continue;
            } catch (e) {
                why = errorText(e);
            }
        }
        if (strict) throw new Error(`attachment ${name} not re-uploaded (${why}); source kept`);
        links.push(att.url);
    }
    return { items, links };
}

async function postText(channelId: string, content: string, attachments: any[] = []) {
    await withRetry(() => RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            content,
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            tts: false,
            flags: 0,
            allowed_mentions: NO_PINGS,
            ...(attachments.length ? { attachments: attachments.map((a, i) => ({ id: String(i), ...a })) } : {})
        }
    }), job, onWait);
}

/** Native Discord forward of the original message */
export async function forwardMessage(targetId: string, m: any, sourceChannelId: string) {
    const guildId = guildOf(sourceChannelId);
    await withRetry(() => RestAPI.post({
        url: Constants.Endpoints.MESSAGES(targetId),
        body: {
            content: "",
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            tts: false,
            flags: 0,
            message_reference: {
                type: MessageReferenceType.FORWARD,
                message_id: m.id,
                channel_id: sourceChannelId,
                ...(guildId ? { guild_id: guildId } : {})
            }
        }
    }), job, onWait);
}

/** Repost as yourself: header + text + re-uploaded attachments (see gatherFiles) */
export async function copyMessage(targetId: string, m: any, sourceChannelId: string, opts: RunOptions) {
    const header = opts.copyHeader
        ? `-# **${displayName(m)}** · <t:${Math.floor(snowflakeTime(m.id) / 1000)}:f> · ${jumpLink(m, sourceChannelId)}`
        : "";
    const { items: uploads, links } = await gatherFiles(m, opts, f => uploadOne(targetId, f));

    const text = [header, bodyText(m, true), ...links].filter(Boolean).join("\n");
    const parts = chunk(text || (uploads.length ? "" : "​"));
    for (let i = 0; i < parts.length; i++) {
        await postText(targetId, parts[i], i === parts.length - 1 ? uploads : []);
    }
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

async function webhookPost(url: string, payload: any, files: File[]) {
    await withRetry(async () => {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        files.forEach((f, i) => form.append(`files[${i}]`, f, f.name));
        const res = await fetch(`${url}?wait=true`, { method: "POST", body: form });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw { status: res.status, body };
        }
    }, job, onWait);
}

/** Clone under the original author's name + avatar through a webhook (needs Manage Webhooks to create one) */
export async function webhookMessage(url: string, m: any, sourceChannelId: string, opts: RunOptions) {
    const { items: files, links } = await gatherFiles(m, opts, async f => f);
    const header = opts.copyHeader ? `-# <t:${Math.floor(snowflakeTime(m.id) / 1000)}:f> · ${jumpLink(m, sourceChannelId)}` : "";
    const embeds = (m.embeds ?? []).filter((e: any) => e.type === "rich").slice(0, 10).map(cleanEmbed);
    const text = [header, bodyText(m, false), ...links].filter(Boolean).join("\n");
    const parts = chunk(text);
    const base = { username: webhookName(m), avatar_url: avatarUrl(m), allowed_mentions: NO_PINGS };

    for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        const payload: any = { ...base, content: parts[i] };
        if (last && embeds.length) payload.embeds = embeds;
        if (!payload.content && !payload.embeds && !(last && files.length)) payload.content = "​";
        await webhookPost(url.trim(), payload, last ? files : []);
    }
}

export async function deleteMessage(channelId: string, messageId: string) {
    await withRetry(() => RestAPI.del({ url: `${Constants.Endpoints.MESSAGES(channelId)}/${messageId}` }), job, onWait);
}

/* ---------- backup ---------- */

function safeName(s: string) {
    return s.replace(/[^\w.-]+/g, "_").slice(0, 120) || "file";
}

export async function buildBackup(plan: Plan, label: string): Promise<File> {
    const { opts, messages } = plan;
    const sel = opts.selection;
    const files: Record<string, Uint8Array> = {};
    const limit = opts.maxUploadMb * 1024 * 1024;

    const txt = messages.map(m => {
        const when = new Date(snowflakeTime(m.id)).toISOString();
        const atts = (m.attachments ?? []).map((a: any) => `  [file] ${a.filename} ${a.url}`).join("\n");
        return `[${when}] ${m.author?.username ?? "?"} (${m.author?.id ?? "?"}) #${m.id}\n${bodyText(m, true)}${atts ? "\n" + atts : ""}`;
    }).join("\n\n");

    files["manifest.json"] = strToU8(JSON.stringify({
        tool: "Sernicord MessageOps",
        createdAt: new Date().toISOString(),
        action: label,
        channelId: sel.channelId,
        guildId: guildOf(sel.channelId) ?? null,
        range: { start: sel.startId || null, end: sel.endId || null },
        filters: { ...sel, channelId: undefined },
        count: messages.length
    }, null, 2));
    files["messages.json"] = strToU8(JSON.stringify(messages, null, 2));
    files["messages.txt"] = strToU8(txt);

    // the pre-Move/Delete ZIP must hold the files: their URLs die with the messages
    // (no size cap, and a failed download aborts the whole run before anything is deleted)
    const strict = isDestructive(opts.action);
    if (opts.backupFiles || strict) {
        let n = 0;
        for (const m of messages) {
            for (const a of m.attachments ?? []) {
                if (job.abort) throw new AbortedError();
                if (!strict && (a.size ?? 0) > limit) continue;
                setStatus(`Backup: downloading files… ${++n}`);
                try {
                    const f = await download(a.url, a.filename || "file");
                    files[`files/${m.id}-${safeName(a.filename || a.id)}`] = new Uint8Array(await f.arrayBuffer());
                } catch (e) {
                    if (strict) throw new Error(`backup of ${a.filename} failed (${errorText(e)}); nothing deleted`);
                    // otherwise keep going; the URL stays in messages.json
                }
            }
        }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([zipSync(files)], `msgops-${label}-${sel.channelId}-${stamp}.zip`, { type: "application/zip" });
}

/* ---------- pipeline ---------- */

export interface Report {
    done: number;
    failed: number;
    errors: string[];
    aborted: boolean;
}

async function mirror(m: any, opts: RunOptions) {
    const src = opts.selection.channelId;
    if (opts.mirrorMode === "forward" || opts.mirrorMode === "both") await forwardMessage(opts.mirrorChannelId, m, src);
    if (opts.mirrorMode === "copy" || opts.mirrorMode === "both") await copyMessage(opts.mirrorChannelId, m, src, opts);
}

async function transfer(m: any, opts: RunOptions) {
    const src = opts.selection.channelId;
    if (opts.transferMode === "forward") await forwardMessage(opts.targetChannelId, m, src);
    else if (opts.transferMode === "copy") await copyMessage(opts.targetChannelId, m, src, opts);
    else await webhookMessage(opts.webhookUrl, m, src, opts);
}

/**
 * Per message, oldest first: mirror → transfer → delete. Fail-closed: a source
 * message is only deleted when every earlier step for it succeeded.
 */
export async function execute(plan: Plan): Promise<Report> {
    const { opts, messages } = plan;
    const { action } = opts;
    const report: Report = { done: 0, failed: 0, errors: [], aborted: false };

    try {
        // a failed auto-backup throws here, before anything is deleted
        if (action === "backup" || (isDestructive(action) && opts.autoBackup && !opts.dryRun)) {
            setStatus("Building backup ZIP…");
            const zip = await buildBackup(plan, action === "backup" ? "backup" : `pre-${action}`);
            saveFile(zip);
            if (action === "backup" && opts.uploadBackupToMirror && isSnowflake(opts.mirrorChannelId) && !opts.dryRun) {
                setStatus("Uploading backup ZIP to the mirror channel…");
                try {
                    const up = await uploadOne(opts.mirrorChannelId, zip);
                    await postText(opts.mirrorChannelId, `-# MessageOps backup · ${messages.length} message(s) from <#${opts.selection.channelId}>`, [up]);
                } catch (e) {
                    report.errors.push(`ZIP upload: ${errorText(e)} (too big? it is saved locally)`);
                }
            }
        }

        const writes = !opts.dryRun && (action !== "backup" || opts.mirrorMode !== "off");
        if (action === "preview" || !writes) {
            report.done = messages.length;
            return report;
        }

        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            setStatus(`${action}: ${i + 1}/${messages.length} · ok ${report.done} · failed ${report.failed}`);
            try {
                if (opts.mirrorMode !== "off") await mirror(m, opts);
                if (action === "copy" || action === "move") await transfer(m, opts);
                if (isDestructive(action)) await deleteMessage(opts.selection.channelId, m.id);
                report.done++;
            } catch (e) {
                if (e instanceof AbortedError) throw e;
                report.failed++;
                if (report.errors.length < 20) report.errors.push(`${m.id}: ${errorText(e)}`);
            }
            if (i < messages.length - 1) await pause(opts.delayMs, job);
        }
    } catch (e) {
        if (!(e instanceof AbortedError)) throw e;
        report.aborted = true;
    }
    return report;
}
