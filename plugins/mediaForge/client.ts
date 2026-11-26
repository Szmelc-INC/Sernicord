/*
 * Sernicord MediaForge — renderer helpers: native wrapper, shared media list, uploads,
 * server emoji / sticker / soundboard creation, upload limit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import {
    ChannelStore, DraftType, GuildStore, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore,
    UploadHandler, UserStore
} from "@webpack/common";

import type { FileInfo, JobSpec, JobStatus } from "./native";
import { Probe, uploadLimit } from "./planner";

export type Native = PluginNative<typeof import("./native")>;

export function api(): Native {
    const n = (typeof VencordNative !== "undefined" ? VencordNative.pluginHelpers.MediaForge : undefined) as Native | undefined;
    if (!n?.startJob) throw new Error("MediaForge native side is not loaded — fully restart Discord after enabling the plugin");
    return n;
}

export function hasNative() {
    try { api(); return true; } catch { return false; }
}

export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/* ---------------- shared media list ---------------- */

export type Origin = "upload" | "message" | "file" | "output" | "paint" | "download" | "link";

export interface MediaItem {
    id: string;
    file: FileInfo;
    origin: Origin;
    probe?: Probe;
    probeError?: string;
    /** where it came from, for the UI */
    note?: string;
}

let items: MediaItem[] = [];
const subs = new Set<() => void>();
let seq = 0;

export function getItems() { return items; }
export function subscribe(cb: () => void) { subs.add(cb); return () => void subs.delete(cb); }
function emit() { subs.forEach(cb => { try { cb(); } catch { /* ignore */ } }); }

export function addItem(file: FileInfo, origin: Origin, note?: string): MediaItem {
    const existing = items.find(i => i.file.path === file.path);
    if (existing) return existing;
    const item: MediaItem = { id: `m${++seq}`, file, origin, note };
    items = [item, ...items].slice(0, 200);
    emit();
    api().probe(file.path).then(p => { item.probe = p; items = [...items]; emit(); }, e => { item.probeError = errText(e); items = [...items]; emit(); });
    return item;
}

export function removeItem(id: string) {
    items = items.filter(i => i.id !== id);
    emit();
}

export function clearItems() {
    items = [];
    emit();
}

export async function addFromFile(f: File, origin: Origin = "upload") {
    const info = await api().writeTemp(f.name || "pasted", new Uint8Array(await f.arrayBuffer()));
    return addItem(info, origin);
}

export async function addFromUrl(url: string, name?: string, origin: Origin = "message") {
    const info = await api().fetchToTemp(url, name);
    return addItem(info, origin, new URL(url).hostname);
}

/* ---------------- jobs ---------------- */

export async function runJob(spec: JobSpec, onTick?: (s: JobStatus) => void, signal?: { cancelled: boolean; }): Promise<JobStatus> {
    const id = await api().startJob(spec);
    for (; ;) {
        await new Promise(r => setTimeout(r, 350));
        const s = await api().jobStatus(id);
        if (!s) throw new Error("job vanished");
        onTick?.(s);
        if (signal?.cancelled && s.status === "running") await api().cancelJob(id);
        if (s.status !== "running") return s;
    }
}

/* ---------------- uploads ---------------- */

export function currentChannel() {
    const id = SelectedChannelStore.getChannelId();
    return id ? ChannelStore.getChannel(id) : null;
}

/** Discord's upload limit for the current user in a channel (bytes). */
export function limitFor(channelId?: string | null, overrideMB = 0) {
    if (overrideMB > 0) return Math.round(overrideMB * 1024 * 1024);
    const ch = channelId ? ChannelStore.getChannel(channelId) : currentChannel();
    const guild = ch?.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    return uploadLimit((UserStore.getCurrentUser() as any)?.premiumType, (guild as any)?.premiumTier);
}

export async function toFile(info: FileInfo): Promise<File> {
    const bytes = await api().readBytes(info.path);
    return new File([new Uint8Array(bytes)], info.name, { type: info.mime });
}

export async function uploadToChannel(files: FileInfo[], channelId?: string) {
    const ch = channelId ? ChannelStore.getChannel(channelId) : currentChannel();
    if (!ch) throw new Error("Open a channel first");
    const list = await Promise.all(files.slice(0, 10).map(toFile));
    UploadHandler.promptToUpload(list, ch, DraftType.ChannelMessage);
    return files.length > 10 ? files.length - 10 : 0;
}

/* ---------------- server assets ---------------- */

export function expressionGuilds() {
    const bits = PermissionsBits as any;
    return Object.values(GuildStore.getGuilds())
        .filter(g => {
            try {
                return PermissionStore.can(bits.CREATE_GUILD_EXPRESSIONS ?? bits.MANAGE_GUILD_EXPRESSIONS, g) || PermissionStore.can(bits.MANAGE_GUILD_EXPRESSIONS, g);
            } catch {
                return false;
            }
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function dataUrl(info: FileInfo) {
    const bytes = await api().readBytes(info.path);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${info.mime};base64,${btoa(bin)}`;
}

export function assetName(raw: string, min = 2) {
    const s = raw.replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    return s.length >= min ? s : `forge_${Date.now().toString(36)}`.slice(0, 32);
}

export async function createEmoji(guildId: string, info: FileInfo, name: string) {
    await RestAPI.post({ url: `/guilds/${guildId}/emojis`, body: { name: assetName(name), image: await dataUrl(info), roles: [] } });
}

export async function createSticker(guildId: string, info: FileInfo, name: string, tag: string, description = "") {
    const file = await toFile(info);
    await RestAPI.post({
        url: `/guilds/${guildId}/stickers`,
        fields: [
            { name: "name", value: name.slice(0, 30).padEnd(2, "_") },
            { name: "tags", value: (tag || "sparkles").slice(0, 200) },
            { name: "description", value: description.slice(0, 100) }
        ],
        attachments: [{ name: "file", file, filename: file.name }]
    } as any);
}

export async function createSound(guildId: string, info: FileInfo, name: string, emojiName?: string) {
    await RestAPI.post({
        url: `/guilds/${guildId}/soundboard-sounds`,
        body: { name: name.slice(0, 32).padEnd(2, "_"), sound: await dataUrl(info), volume: 1, ...(emojiName ? { emoji_name: emojiName } : {}) }
    });
}

/* ---------------- message media ---------------- */

export interface RemoteMedia { url: string; name: string; kind: "image" | "video" | "audio" | "file" | "link"; }

const MEDIA_RE = /\.(mp4|mkv|webm|mov|m4v|avi|gif|png|jpe?g|webp|avif|heic|bmp|tiff?|mp3|ogg|opus|wav|flac|m4a|aac)(\?|$)/i;

export function kindOf(name: string, contentType?: string): RemoteMedia["kind"] {
    const ct = contentType ?? "";
    if (ct.startsWith("video/") || /\.(mp4|mkv|webm|mov|m4v|avi)(\?|$)/i.test(name)) return "video";
    if (ct.startsWith("audio/") || /\.(mp3|ogg|opus|wav|flac|m4a|aac)(\?|$)/i.test(name)) return "audio";
    if (ct.startsWith("image/") || /\.(gif|png|jpe?g|webp|avif|heic|bmp|tiff?)(\?|$)/i.test(name)) return "image";
    return "file";
}

/** Attachments, embedded media and plain links of a message. */
export function mediaOfMessage(msg: any): RemoteMedia[] {
    const out: RemoteMedia[] = [];
    const seen = new Set<string>();
    const push = (m: RemoteMedia) => { if (m.url && !seen.has(m.url)) { seen.add(m.url); out.push(m); } };
    for (const a of msg?.attachments ?? []) push({ url: a.url, name: a.filename ?? "file", kind: kindOf(a.filename ?? "", a.content_type) });
    for (const e of msg?.embeds ?? []) {
        const v = e.video?.proxyURL || e.video?.url;
        const i = e.image?.proxyURL || e.image?.url || (e.type === "image" || e.type === "gifv" ? e.thumbnail?.proxyURL || e.thumbnail?.url : null);
        if (v && /^https?:/.test(v) && !/youtube\.com\/embed/.test(v)) push({ url: v, name: v.split("?")[0].split("/").pop() || "video.mp4", kind: "video" });
        else if (i) push({ url: i, name: i.split("?")[0].split("/").pop() || "image", kind: "image" });
    }
    for (const s of msg?.stickerItems ?? msg?.sticker_items ?? []) {
        if (s.format_type === 1 || s.format_type === 2 || s.format_type === 4) push({ url: `https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? "gif" : "png"}`, name: `${s.name}.${s.format_type === 4 ? "gif" : "png"}`, kind: "image" });
    }
    for (const m of String(msg?.content ?? "").matchAll(/https?:\/\/[^\s<>()]+/g)) {
        const url = m[0].replace(/[.,!?)]+$/, "");
        if (seen.has(url)) continue;
        push({ url, name: url.split("?")[0].split("/").pop() || "link", kind: MEDIA_RE.test(url) ? kindOf(url) : "link" });
    }
    return out;
}
