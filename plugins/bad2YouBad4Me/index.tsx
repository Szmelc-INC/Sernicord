/*
 * Sernicord Bad2YouBad4Me — Tolerator-T1000: keyword softener + LLM wordsmith + bulk "laundry day" for your own messages
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import {
    ChannelStore,
    GuildStore,
    React,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    SnowflakeUtils,
    UserStore,
    useState
} from "@webpack/common";
import { strToU8, zipSync } from "fflate";

import { LlmConfig, rewrite, Verdict } from "./llm";

const UNDO_KEY = "Bad2YouBad4Me_undo";
const UNDO_CAP = 5000;
const EDITABLE_TYPES = new Set([0, 19]);

const DEFAULT_KEYWORDS = `# from => to   (case-insensitive, whole words, one rule per line, # = comment)
# Empty by default — swearing is fine. Add only words you really want swapped, e.g.:
# someword => otherword`;

const DEFAULT_PURGE = `# One keyword per line, case-insensitive, whole words. # = comment.
# word*  = prefix match (word, words, wordsmith...)
# re:... = raw regex (JS syntax, flags "iu")`;

const DEFAULT_REPLACEMENT = "🔒 This content is available only for Discord Nitro+ Super Premium. Buy Nitro+ to view this post (i)";

type Scope = "channel" | "guild" | "dms" | "everywhere";
type UndoEntry = { c: string; m: string; old: string; at: number; };

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Paragraph>
                Tolerator-T1000 — Laundry day. Works on <b>your own</b> messages: optional keyword swaps,
                an LLM wordsmith that turns cheap stereotype jokes into proper dark comedy, and bulk laundry of your history —
                rewrite, purge (delete) by keyword list, or swap matches for one fixed text. The LLM never disguises threats,
                slurs, harassment of a specific person or illegal content (verdict "flag"); what happens to flagged
                messages is your call below. Optional ZIP backup of every original before it is edited or deleted.
            </Paragraph>
        )
    },
    liveKeywords: {
        type: OptionType.BOOLEAN,
        description: "Live: apply keyword rules to messages before they are sent (and on edit)",
        default: false
    },
    liveLlm: {
        type: OptionType.SELECT,
        description: "Live: LLM rewrite of outgoing messages",
        options: [
            { label: "Off", value: "off", default: true },
            { label: "Before sending (waits for the model)", value: "presend" },
            { label: "After sending (send now, polish by editing later)", value: "postsend" }
        ]
    },
    polishDelaySeconds: {
        type: OptionType.NUMBER,
        description: "After-sending mode: seconds to wait before the polish edit",
        default: 20
    },
    polishWindowMinutes: {
        type: OptionType.NUMBER,
        description: "After-sending mode: also re-polish your own messages you edit within this many minutes of sending (0 = off)",
        default: 10
    },
    keywords: {
        type: OptionType.STRING,
        description: "Keyword rules, one per line: from => to",
        default: DEFAULT_KEYWORDS,
        multiline: true
    },
    provider: {
        type: OptionType.SELECT,
        description: "LLM provider",
        options: [
            { label: "OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama /v1, LM Studio, llama.cpp)", value: "openai", default: true },
            { label: "Anthropic", value: "anthropic" }
        ]
    },
    baseUrl: {
        type: OptionType.STRING,
        description: "API base URL (Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1, Anthropic: https://api.anthropic.com)",
        default: "http://localhost:11434/v1"
    },
    apiKey: {
        type: OptionType.STRING,
        description: "API key (empty for local servers). Stored in Vencord settings in plain text.",
        default: ""
    },
    model: {
        type: OptionType.STRING,
        description: "Model name (e.g. llama3.1, gpt-4o-mini, claude-haiku-5-5)",
        default: "llama3.1"
    },
    style: {
        type: OptionType.SELECT,
        description: "Rewrite style",
        options: [
            { label: "Darkest Humor Deluxe (irony, satire, absurd)", value: "deluxe", default: true },
            { label: "Dry understatement", value: "dry" },
            { label: "Plain polite", value: "polite" }
        ]
    },
    extraPrompt: {
        type: OptionType.STRING,
        description: "Extra style instructions appended to the system prompt",
        default: "",
        multiline: true
    },
    timeoutSeconds: {
        type: OptionType.NUMBER,
        description: "LLM request timeout in seconds",
        default: 30
    },
    bulkAction: {
        type: OptionType.SELECT,
        description: "Laundry day: what to do",
        options: [
            { label: "Rewrite (keyword swaps + optional LLM)", value: "polish", default: true },
            { label: "Purge — delete messages matching the purge list", value: "purge" },
            { label: "Replace — edit messages matching the purge list to the fixed text", value: "replace" }
        ]
    },
    purgeKeywords: {
        type: OptionType.STRING,
        description: "Purge / replace list: a message matching any line is hit",
        default: DEFAULT_PURGE,
        multiline: true
    },
    replacementText: {
        type: OptionType.STRING,
        description: "Fixed text used by Replace mode and by the \"replace\" flagged action",
        default: DEFAULT_REPLACEMENT
    },
    flaggedAction: {
        type: OptionType.SELECT,
        description: "Laundry day with LLM: what to do with messages the model flags",
        options: [
            { label: "Leave untouched, just count", value: "leave", default: true },
            { label: "Replace with the fixed text", value: "replace" },
            { label: "Delete", value: "delete" }
        ]
    },
    bulkOlderThanDays: {
        type: OptionType.NUMBER,
        description: "Laundry day: only messages OLDER than N days (0 = no limit)",
        default: 0
    },
    backupZip: {
        type: OptionType.BOOLEAN,
        description: "Laundry day: save a ZIP with the original content of everything edited or deleted (also in dry run, as a preview)",
        default: true
    },
    bulkUseLlm: {
        type: OptionType.BOOLEAN,
        description: "Laundry day: also run the LLM (rewrite in Rewrite mode, flag detection in every mode)",
        default: false
    },
    bulkDryRun: {
        type: OptionType.BOOLEAN,
        description: "Laundry day: dry run — count what would change, edit nothing",
        default: true
    },
    bulkSinceDays: {
        type: OptionType.NUMBER,
        description: "Laundry day: only messages NEWER than N days (0 = no limit)",
        default: 0
    },
    bulkDelayMs: {
        type: OptionType.NUMBER,
        description: "Laundry day: pause between edits in ms (keep high, Discord rate-limits and flags fast mass edits)",
        default: 2500
    },
    laundry: {
        type: OptionType.COMPONENT,
        component: LaundryPanel
    }
});

/* ---------- keyword pass ---------- */

type Rule = { re: RegExp; to: string; };
let rulesSource = "";
let rules: Rule[] = [];

function escapeRe(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRules(): Rule[] {
    const src = settings.store.keywords ?? "";
    if (src === rulesSource) return rules;
    rulesSource = src;
    rules = src.split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && l.includes("=>"))
        .map(l => {
            const [from, ...rest] = l.split("=>");
            return { from: from.trim(), to: rest.join("=>").trim() };
        })
        .filter(r => r.from)
        // Longer phrases first so "bullshit" wins over "shit".
        .sort((a, b) => b.from.length - a.from.length)
        .map(r => ({ re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(r.from)}(?![\\p{L}\\p{N}_])`, "giu"), to: r.to }));
    return rules;
}

function matchCase(src: string, to: string) {
    if (src === src.toUpperCase() && src !== src.toLowerCase()) return to.toUpperCase();
    if (src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) return to[0].toUpperCase() + to.slice(1);
    return to;
}

// Leave code, links, mentions and custom emoji alone.
const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|<[@#:a-z][^>]*>)/i;

export function applyKeywords(text: string): string {
    const rs = getRules();
    if (!rs.length || !text) return text;
    return text.split(PROTECTED).map((part, i) => {
        if (i % 2 === 1) return part;
        for (const r of rs) part = part.replace(r.re, m => matchCase(m, r.to));
        return part;
    }).join("");
}

/* ---------- purge list ---------- */

type PurgeRule = { re: RegExp; label: string; };
let purgeSource = "";
let purgeRules: PurgeRule[] = [];

function getPurgeRules(): PurgeRule[] {
    const src = settings.store.purgeKeywords ?? "";
    if (src === purgeSource) return purgeRules;
    purgeSource = src;
    purgeRules = src.split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#"))
        .flatMap(l => {
            try {
                if (l.startsWith("re:")) return [{ re: new RegExp(l.slice(3), "iu"), label: l }];
                const prefix = l.endsWith("*");
                const word = escapeRe(prefix ? l.slice(0, -1) : l);
                const tail = prefix ? "" : "(?![\\p{L}\\p{N}_])";
                return [{ re: new RegExp(`(?<![\\p{L}\\p{N}_])${word}${tail}`, "iu"), label: l }];
            } catch {
                // Invalid user regex: skip the line instead of breaking the whole list.
                return [];
            }
        });
    return purgeRules;
}

function purgeHit(text: string): string | null {
    for (const r of getPurgeRules()) if (r.re.test(text)) return `keyword: ${r.label}`;
    return null;
}

/* ---------- LLM pass ---------- */

function llmConfig(): LlmConfig {
    const s = settings.store;
    return {
        provider: s.provider as LlmConfig["provider"],
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        style: s.style as LlmConfig["style"],
        extraPrompt: s.extraPrompt,
        timeoutMs: Math.max(5, s.timeoutSeconds) * 1000
    };
}

async function polish(text: string, useLlm: boolean): Promise<{ text: string; verdict?: Verdict; }> {
    const kw = applyKeywords(text);
    if (!useLlm || !text.trim()) return { text: kw };
    // The model sees the original, so it rewrites meaning-in-context rather than our keyword patch.
    const verdict = await rewrite(llmConfig(), text);
    return { text: verdict.verdict === "rewrite" ? verdict.text : kw, verdict };
}

function toast(text: string, variant: "default" | "success" | "critical" = "default") {
    showToast({ text, variant });
}

/* ---------- REST helpers ---------- */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
        try {
            return await fn();
        } catch (e: any) {
            const status = Number(e?.status ?? 0);
            if (status === 429 && tries < 8) {
                await sleep(Math.min(Number(e?.body?.retry_after ?? 2), 120) * 1000 + 250);
                continue;
            }
            if ((status === 0 || status >= 500) && tries < 3) {
                await sleep(800 * (tries + 1));
                continue;
            }
            throw e;
        }
    }
}

async function editMessage(channelId: string, messageId: string, content: string) {
    await withRetry(() => RestAPI.patch({ url: `/channels/${channelId}/messages/${messageId}`, body: { content } }));
}

async function pushUndo(entries: UndoEntry[]) {
    if (!entries.length) return;
    await DataStore.update<UndoEntry[]>(UNDO_KEY, old => [...(old ?? []), ...entries].slice(-UNDO_CAP));
}

/* ---------- live hooks ---------- */

const recentlyPolished = new Set<string>();

async function postSendPolish(channelId: string, messageId: string, content: string) {
    try {
        const { text, verdict } = await polish(content, true);
        if (verdict?.verdict === "flag") {
            toast(`Bad2YouBad4Me: not rewritten (${verdict.reason})`, "critical");
            return;
        }
        if (text === content) return;
        recentlyPolished.add(messageId);
        await editMessage(channelId, messageId, text);
        await pushUndo([{ c: channelId, m: messageId, old: content, at: Date.now() }]);
    } catch (e: any) {
        toast(`Bad2YouBad4Me: polish failed — ${e?.message ?? e}`, "critical");
    }
}

/* ---------- laundry day (bulk) ---------- */

const job = { running: false, abort: false, status: "Idle" };
const listeners = new Set<() => void>();
function setStatus(s: string) {
    job.status = s;
    listeners.forEach(l => l());
}

type Target = { kind: "guild" | "channel"; id: string; label: string; };

function targetsFor(scope: Scope): Target[] {
    const dmTargets = (): Target[] => ChannelStore.getSortedPrivateChannels().map(c => ({
        kind: "channel" as const,
        id: c.id,
        label: c.name || c.rawRecipients?.map((r: any) => r.username).join(", ") || `DM ${c.id}`
    }));
    const guildTargets = (): Target[] => Object.values(GuildStore.getGuilds()).map(g => ({ kind: "guild" as const, id: g.id, label: g.name }));

    switch (scope) {
        case "channel": {
            const id = SelectedChannelStore.getChannelId();
            return id ? [{ kind: "channel", id, label: "current channel" }] : [];
        }
        case "guild": {
            const id = SelectedGuildStore.getGuildId();
            return id ? [{ kind: "guild", id, label: GuildStore.getGuild(id)?.name ?? id }] : [];
        }
        case "dms": return dmTargets();
        case "everywhere": return [...guildTargets(), ...dmTargets()];
    }
}

// Discord search returns 25 hits per page; page backwards with max_id so the 10k offset cap never bites.
async function* searchOwnMessages(t: Target, authorId: string, minId?: string, olderThanId?: string) {
    let maxId = olderThanId;
    const seen = new Set<string>();
    const base = t.kind === "guild" ? `/guilds/${t.id}/messages/search` : `/channels/${t.id}/messages/search`;
    while (!job.abort) {
        const query: Record<string, string> = { author_id: authorId, include_nsfw: "true" };
        if (maxId) query.max_id = maxId;
        if (minId) query.min_id = minId;
        const res: any = await withRetry(() => RestAPI.get({ url: base, query }));
        if (res.status === 202) {
            // Index still building on Discord's side.
            await sleep((Number(res.body?.retry_after) || 2) * 1000);
            continue;
        }
        const hits: any[] = (res.body?.messages ?? []).map((group: any[]) => group.find(m => m.hit) ?? group[0]);
        const fresh = hits.filter(m => m && !seen.has(m.id));
        if (!fresh.length) return;
        for (const m of fresh) {
            seen.add(m.id);
            yield m;
        }
        maxId = String(BigInt(fresh.reduce((a, m) => (BigInt(m.id) < BigInt(a) ? m.id : a), fresh[0].id)) - 1n);
        await sleep(1200);
    }
}

type BackupEntry = {
    action: "edit" | "delete";
    reason: string;
    guild_id?: string;
    channel_id: string;
    message_id: string;
    sent_at: string;
    original: string;
    new?: string;
};

function saveBackup(entries: BackupEntry[], scope: Scope, dry: boolean) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const txt = entries.map(e =>
        `[${e.sent_at}] ${e.action.toUpperCase()} (${e.reason}) channel ${e.channel_id} message ${e.message_id}\n` +
        `--- original ---\n${e.original}\n` +
        (e.new != null ? `--- new ---\n${e.new}\n` : "")
    ).join("\n");
    const zip = zipSync({
        "messages.json": strToU8(JSON.stringify(entries, null, 2)),
        "messages.txt": strToU8(txt)
    });
    saveFile(new File([zip], `laundry-${scope}${dry ? "-dryrun" : ""}-${stamp}.zip`, { type: "application/zip" }));
}

async function deleteMessage(channelId: string, messageId: string) {
    await withRetry(() => RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }));
}

type Plan = { action: "edit"; text: string; reason: string; } | { action: "delete"; reason: string; } | null;

async function planFor(content: string, s: typeof settings.store): Promise<{ plan: Plan; flagged: boolean; }> {
    if (s.bulkAction === "polish") {
        const res = await polish(content, s.bulkUseLlm);
        if (res.verdict?.verdict === "flag") {
            const reason = `flagged: ${res.verdict.reason}`;
            if (s.flaggedAction === "delete") return { plan: { action: "delete", reason }, flagged: true };
            if (s.flaggedAction === "replace") return { plan: { action: "edit", text: s.replacementText, reason }, flagged: true };
            return { plan: null, flagged: true };
        }
        return { plan: res.text === content ? null : { action: "edit", text: res.text, reason: res.verdict ? "llm rewrite" : "keywords" }, flagged: false };
    }

    let reason = purgeHit(content);
    let flagged = false;
    if (!reason && s.bulkUseLlm && content.trim()) {
        const v = await rewrite(llmConfig(), content);
        if (v.verdict === "flag") {
            flagged = true;
            reason = `flagged: ${v.reason}`;
        }
    }
    if (!reason) return { plan: null, flagged };
    return {
        plan: s.bulkAction === "purge" ? { action: "delete", reason } : { action: "edit", text: s.replacementText, reason },
        flagged
    };
}

async function laundry(scope: Scope) {
    if (job.running) return toast("Laundry already running");
    const s = settings.store;
    const me = UserStore.getCurrentUser()?.id;
    const targets = targetsFor(scope);
    if (!me || !targets.length) return toast("Nothing to wash here", "critical");
    if (s.bulkAction !== "polish" && !getPurgeRules().length && !s.bulkUseLlm)
        return toast("Purge list is empty and LLM is off — nothing would match", "critical");

    const day = 86_400_000;
    const minId = s.bulkSinceDays > 0 ? SnowflakeUtils.fromTimestamp(Date.now() - s.bulkSinceDays * day) : undefined;
    const maxId = s.bulkOlderThanDays > 0 ? SnowflakeUtils.fromTimestamp(Date.now() - s.bulkOlderThanDays * day) : undefined;
    const dry = s.bulkDryRun;
    const verb = dry ? "would hit" : "hit";
    let scanned = 0, edited = 0, deleted = 0, flagged = 0, failed = 0;
    const undo: UndoEntry[] = [];
    const backup: BackupEntry[] = [];

    job.running = true;
    job.abort = false;
    try {
        for (const [i, t] of targets.entries()) {
            if (job.abort) break;
            try {
                for await (const m of searchOwnMessages(t, me, minId, maxId)) {
                    if (job.abort) break;
                    scanned++;
                    if (m.author?.id !== me || !EDITABLE_TYPES.has(m.type)) continue;
                    if (!m.content) continue;

                    let plan: Plan;
                    try {
                        const r = await planFor(m.content, s);
                        plan = r.plan;
                        if (r.flagged) flagged++;
                    } catch {
                        failed++;
                        continue;
                    }
                    if (!plan || (plan.action === "edit" && plan.text === m.content)) continue;

                    const entry: BackupEntry = {
                        action: plan.action,
                        reason: plan.reason,
                        guild_id: m.guild_id ?? (t.kind === "guild" ? t.id : undefined),
                        channel_id: m.channel_id,
                        message_id: m.id,
                        sent_at: m.timestamp,
                        original: m.content,
                        new: plan.action === "edit" ? plan.text : undefined
                    };

                    if (dry) {
                        if (plan.action === "edit") edited++;
                        else deleted++;
                        backup.push(entry);
                    } else {
                        try {
                            if (plan.action === "edit") {
                                await editMessage(m.channel_id, m.id, plan.text);
                                undo.push({ c: m.channel_id, m: m.id, old: m.content, at: Date.now() });
                                edited++;
                            } else {
                                await deleteMessage(m.channel_id, m.id);
                                deleted++;
                            }
                            backup.push(entry);
                            await sleep(Math.max(500, s.bulkDelayMs));
                        } catch {
                            failed++;
                        }
                    }
                    setStatus(`[${i + 1}/${targets.length}] ${t.label}: scanned ${scanned}, ${verb}: edit ${edited} / delete ${deleted}, flagged ${flagged}, failed ${failed}`);
                }
            } catch (e: any) {
                failed++;
                setStatus(`[${i + 1}/${targets.length}] ${t.label}: search failed (${e?.status ?? e?.message ?? e})`);
            }
        }
    } finally {
        await pushUndo(undo);
        if (s.backupZip && backup.length) {
            try {
                saveBackup(backup, scope, dry);
            } catch (e: any) {
                toast(`Backup ZIP failed — ${e?.message ?? e}`, "critical");
            }
        }
        job.running = false;
        const summary = `${job.abort ? "Stopped" : "Done"}${dry ? " (dry run)" : ""}: scanned ${scanned}, ${verb}: edit ${edited} / delete ${deleted}, flagged ${flagged}, failed ${failed}`;
        setStatus(summary);
        toast(`Laundry day — ${summary}`);
    }
}

async function undoAll() {
    if (job.running) return toast("Stop the running job first");
    const entries = (await DataStore.get<UndoEntry[]>(UNDO_KEY)) ?? [];
    if (!entries.length) return toast("Nothing to undo");
    job.running = true;
    job.abort = false;
    const left: UndoEntry[] = [];
    let done = 0;
    try {
        for (const e of [...entries].reverse()) {
            if (job.abort) {
                left.unshift(e);
                continue;
            }
            try {
                await editMessage(e.c, e.m, e.old);
                done++;
                setStatus(`Undo: restored ${done}/${entries.length}`);
                await sleep(Math.max(500, settings.store.bulkDelayMs));
            } catch (err: any) {
                // 404 = message gone; nothing to restore.
                if (Number(err?.status) !== 404) left.unshift(e);
            }
        }
    } finally {
        await DataStore.set(UNDO_KEY, left);
        job.running = false;
        setStatus(`Undo finished: restored ${done}, ${left.length} left in log`);
    }
}

function LaundryPanel() {
    const [, force] = useState(0);
    React.useEffect(() => {
        const l = () => force(x => x + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);

    const btn = (label: string, scope: Scope) => (
        <Button size="small" disabled={job.running} onClick={() => laundry(scope)}>{label}</Button>
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <HeadingTertiary>Laundry day</HeadingTertiary>
            <Paragraph>
                Washes only your own messages. Start with dry run on, read the counts, then turn it off.
                Every real edit is logged locally so it can be undone.
            </Paragraph>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {btn("This channel", "channel")}
                {btn("This server", "guild")}
                {btn("All DMs", "dms")}
                {btn("Everywhere", "everywhere")}
                <Button size="small" variant="dangerPrimary" disabled={!job.running} onClick={() => { job.abort = true; }}>Stop</Button>
                <Button size="small" variant="secondary" disabled={job.running} onClick={undoAll}>Undo all logged edits</Button>
            </div>
            <Paragraph>{job.status}</Paragraph>
        </div>
    );
}

/* ---------- plugin ---------- */

export default definePlugin({
    name: "Bad2YouBad4Me",
    description: "Tolerator-T1000 — Laundry day. Softens your own messages with keyword rules and an optional LLM wordsmith (dark, dry satire, no swearing), live or in bulk across channels, servers and DMs.",
    authors: [{ name: "sernik", id: 0n }],
    dependencies: ["MessageEventsAPI", "CommandsAPI"],
    settings,

    async onBeforeMessageSend(_channelId, msg) {
        const s = settings.store;
        if (s.liveLlm === "presend" && msg.content.trim()) {
            try {
                const { text, verdict } = await polish(msg.content, true);
                if (verdict?.verdict === "flag") toast(`Bad2YouBad4Me: not rewritten (${verdict.reason})`, "critical");
                msg.content = text;
            } catch (e: any) {
                toast(`Bad2YouBad4Me: LLM failed, sent with keywords only — ${e?.message ?? e}`, "critical");
                if (s.liveKeywords) msg.content = applyKeywords(msg.content);
            }
            return;
        }
        if (s.liveKeywords) msg.content = applyKeywords(msg.content);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        if (settings.store.liveKeywords) msg.content = applyKeywords(msg.content);
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic || settings.store.liveLlm !== "postsend") return;
            if (message.author?.id !== UserStore.getCurrentUser()?.id || !message.content || !EDITABLE_TYPES.has(message.type)) return;
            setTimeout(() => postSendPolish(message.channel_id, message.id, message.content), Math.max(0, settings.store.polishDelaySeconds) * 1000);
        },
        MESSAGE_UPDATE({ message }: { message: any; }) {
            const s = settings.store;
            // Embed unfurls also fire MESSAGE_UPDATE; only real user edits carry edited_timestamp.
            if (s.liveLlm !== "postsend" || s.polishWindowMinutes <= 0 || !message?.content || !message.edited_timestamp) return;
            if (message.author?.id !== UserStore.getCurrentUser()?.id) return;
            // Skip the echo of our own polish edit.
            if (recentlyPolished.delete(message.id)) return;
            const age = Date.now() - SnowflakeUtils.extractTimestamp(message.id);
            if (age > s.polishWindowMinutes * 60_000) return;
            postSendPolish(message.channel_id, message.id, message.content);
        }
    },

    commands: [{
        name: "laundry",
        description: "Tolerator-T1000: wash your own messages (respects dry-run setting)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [{
            name: "scope",
            description: "Where to wash",
            type: ApplicationCommandOptionType.STRING,
            required: true,
            choices: [
                { name: "This channel", label: "This channel", value: "channel" },
                { name: "This server", label: "This server", value: "guild" },
                { name: "All DMs", label: "All DMs", value: "dms" },
                { name: "Everywhere", label: "Everywhere", value: "everywhere" }
            ]
        }],
        execute(args, ctx) {
            const scope = args[0].value as Scope;
            sendBotMessage(ctx.channel.id, { content: `Laundry day started (${scope}${settings.store.bulkDryRun ? ", dry run" : ""}). Progress in plugin settings / toasts.` });
            laundry(scope);
        }
    }]
});
