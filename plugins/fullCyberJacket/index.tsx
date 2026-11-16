/*
 * Sernicord FullCyberJacket — finds hate speech, threats and self-harm encouragement in a user's or a server's
 * messages (leet / homoglyph / spacing evasion aware) and lines it up for MANUAL review and reporting.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Hard rule: this plugin never calls Discord's reporting endpoints and never reports anything on its own.
 * Every finding is a jump link; reporting stays a human decision made in Discord's own report dialog.
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import { RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore,
    GuildStore,
    Menu,
    Modal,
    NavigationRouter,
    openModal,
    React,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    SnowflakeUtils,
    TextInput,
    UserStore,
    useState
} from "@webpack/common";
import { strToU8, zipSync } from "fflate";

import { detect, DetectOptions, Hit, mask } from "./detect";
import { CATEGORIES, Category, Confidence } from "./lexicon";
import { Bounds, guildChannels, messages, mutualGuilds, privateChannelsWith, sleep, Source } from "./scan";

const RESULTS_KEY = "FullCyberJacket_results";
const RESULTS_CAP = 5000;
const ACCENT = 0x105c5c;
const DANGER = 0x750f0f;
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const DEFAULT_CUSTOM = `# Extra rules, one per line. Same syntax as the built-in lexicon (see README):
#   stem(a|b|)  optional suffixes     stem*  open tail     word word  phrase
# Optional "=> category tier", e.g.:
#   someslur(s|) => hate_race slur
#   somegroup* => hate_origin group     (hit only near an aggravator)`;

const DEFAULT_ALLOW = `# Phrases that must never count as a hit, one per line (matched after normalization), e.g.:
# niger river`;

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Paragraph>
                FullCyberJacket finds messages that break Discord's rules on hateful conduct, violent speech,
                self-harm encouragement and violent extremism, including the usual filter dodges: leet speak,
                look-alike letters, spacing, zero-width characters and repeated letters. It <b>never reports anything</b>.
                You review each finding, jump to it and report it yourself through Discord's own menu, picking the
                reason it shows. Neutral words about a group (e.g. "Żydzi", "Jews", "geje") only count next to an
                insult, dehumanizing word or call for violence.
            </Paragraph>
        )
    },
    catHateRace: { type: OptionType.BOOLEAN, description: "Detect: race / ethnicity", default: true },
    catHateReligion: { type: OptionType.BOOLEAN, description: "Detect: religion", default: true },
    catHateLgbt: { type: OptionType.BOOLEAN, description: "Detect: sexual orientation / gender identity", default: true },
    catHateDisability: { type: OptionType.BOOLEAN, description: "Detect: disability slurs (many are casual insults; review carefully)", default: false },
    catHateOrigin: { type: OptionType.BOOLEAN, description: "Detect: national origin / immigration status", default: true },
    catViolence: { type: OptionType.BOOLEAN, description: "Detect: threats of violence", default: true },
    catSelfHarm: { type: OptionType.BOOLEAN, description: "Detect: encouraging self-harm (kys, kill yourself, zabij się)", default: true },
    catExtremism: { type: OptionType.BOOLEAN, description: "Detect: violent extremism (Nazi slogans, Holocaust denial)", default: true },
    minConfidence: {
        type: OptionType.SELECT,
        description: "Minimum confidence to keep a finding",
        options: [
            { label: "High only", value: "high" },
            { label: "Medium and up", value: "medium", default: true },
            { label: "Everything", value: "low" }
        ]
    },
    contextWindow: {
        type: OptionType.NUMBER,
        description: "Group terms and ambiguous slurs count only within this many words of an aggravator",
        default: 6
    },
    skipQuotes: {
        type: OptionType.BOOLEAN,
        description: "Ignore quoted lines (\"> ...\"); people quoting someone else are not the author",
        default: true
    },
    customRules: {
        type: OptionType.STRING,
        description: "Extra detection rules",
        default: DEFAULT_CUSTOM,
        multiline: true
    },
    allowlist: {
        type: OptionType.STRING,
        description: "Allowlist: phrases that never count",
        default: DEFAULT_ALLOW,
        multiline: true
    },
    sinceDays: {
        type: OptionType.NUMBER,
        description: "Only messages newer than N days (0 = whole history)",
        default: 0
    },
    delayMs: {
        type: OptionType.NUMBER,
        description: "Pause between search pages in ms (search is rate limited; keep it ≥ 1000)",
        default: 1500
    },
    webhookUrl: {
        type: OptionType.STRING,
        description: "Optional: webhook of a private log channel you own. Findings are posted there as embeds (your account posts nothing).",
        default: "",
        placeholder: "https://discord.com/api/webhooks/..."
    },
    webhookAuto: {
        type: OptionType.BOOLEAN,
        description: "Post new findings to the webhook automatically while scanning",
        default: true
    },
    webhookContent: {
        type: OptionType.SELECT,
        description: "How the message text appears in webhook embeds",
        options: [
            { label: "Full text behind a spoiler", value: "spoiler", default: true },
            { label: "Matched words masked (n***a)", value: "masked" },
            { label: "Full text, plain", value: "plain" }
        ]
    },
    panel: {
        type: OptionType.COMPONENT,
        component: ScanPanel
    }
});

/* ---------- results store ---------- */

type Status = "new" | "reported" | "dismissed";

interface Finding {
    id: string;
    channelId: string;
    guildId?: string;
    authorId: string;
    author: string;
    where: string;
    at: string;
    content: string;
    hits: Hit[];
    status: Status;
    posted?: boolean;
}

let results: Finding[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

async function load() {
    if (loaded) return;
    results = (await DataStore.get<Finding[]>(RESULTS_KEY)) ?? [];
    loaded = true;
}

async function persist() {
    results = results.slice(-RESULTS_CAP);
    await DataStore.set(RESULTS_KEY, results);
    emit();
}

function useResults() {
    const [, force] = useState(0);
    React.useEffect(() => {
        const l = () => force(x => x + 1);
        listeners.add(l);
        load().then(l);
        return () => void listeners.delete(l);
    }, []);
    return results;
}

const jumpUrl = (f: Pick<Finding, "guildId" | "channelId" | "id">) =>
    `https://discord.com/channels/${f.guildId ?? "@me"}/${f.channelId}/${f.id}`;

/* ---------- detection glue ---------- */

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function detectOptions(): DetectOptions {
    const s = settings.store;
    const lines = (src: string) => src.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    return {
        categories: {
            hate_race: s.catHateRace,
            hate_religion: s.catHateReligion,
            hate_lgbt: s.catHateLgbt,
            hate_disability: s.catHateDisability,
            hate_origin: s.catHateOrigin,
            violence: s.catViolence,
            self_harm: s.catSelfHarm,
            extremism: s.catExtremism
        },
        window: Math.max(1, s.contextWindow),
        skipQuotes: s.skipQuotes,
        allowlist: lines(s.allowlist ?? "")
    };
}

function scanText(content: string): Hit[] {
    const min = CONF_RANK[settings.store.minConfidence as Confidence] ?? 1;
    return detect(content, detectOptions(), settings.store.customRules ?? "")
        .filter(h => CONF_RANK[h.conf] >= min);
}

/* ---------- webhook ---------- */

function webhookText(f: Finding): string {
    const mode = settings.store.webhookContent;
    let text = f.content;
    if (mode === "masked") {
        // Replace from the end so earlier offsets stay valid.
        for (const h of [...f.hits].sort((a, b) => b.start - a.start))
            text = text.slice(0, h.start) + mask(h.canonical) + text.slice(h.end);
    }
    text = text.length > 3500 ? text.slice(0, 3500) + "…" : text;
    return mode === "spoiler" ? `||${text.replace(/\|\|/g, "|​|")}||` : text;
}

function embedFor(f: Finding) {
    const h = f.hits[0];
    const severe = f.hits.some(x => x.cat === "violence" || x.cat === "extremism" || x.cat === "self_harm" || x.policy.includes("Violent"));
    const ts = Math.floor(new Date(f.at).getTime() / 1000);
    return {
        title: `${h.policy}: ${h.detail}`.slice(0, 256),
        url: jumpUrl(f),
        color: severe ? DANGER : ACCENT,
        description: webhookText(f),
        fields: [
            { name: "Author", value: `<@${f.authorId}> (${f.author}, \`${f.authorId}\`)`, inline: true },
            { name: "Where", value: f.where.slice(0, 1024) || "?", inline: true },
            { name: "Sent", value: `<t:${ts}:f>`, inline: true },
            {
                name: f.hits.length > 1 ? `Matches (${f.hits.length})` : "Match",
                value: f.hits.map(x =>
                    `**${x.policy}**: \`${mask(x.canonical)}\`${x.evasion ? " (evasion)" : ""} · ${x.conf}` +
                    (x.context ? ` · next to \`${mask(x.context)}\`` : "")
                ).join("\n").slice(0, 1024)
            },
            { name: "Message link", value: jumpUrl(f) }
        ],
        footer: { text: "FullCyberJacket · review, then report it yourself in Discord" }
    };
}

async function postWebhook(batch: Finding[]) {
    const url = (settings.store.webhookUrl ?? "").trim();
    if (!WEBHOOK_RE.test(url)) throw new Error("webhook URL is not a discord.com/api/webhooks/... URL");
    for (let tries = 0; ; tries++) {
        const res = await fetch(`${url}?wait=true`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "FullCyberJacket", allowed_mentions: { parse: [] }, embeds: batch.map(embedFor) })
        });
        if (res.status === 429 && tries < 6) {
            const body = await res.json().catch(() => ({}));
            await sleep(Math.min(Number(body?.retry_after ?? 2), 60) * 1000 + 250);
            continue;
        }
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        batch.forEach(f => { f.posted = true; });
        return;
    }
}

async function flushWebhook(onlyNew = true) {
    if (!(settings.store.webhookUrl ?? "").trim()) return toast("Set a webhook URL first", "critical");
    await load();
    const queue = results.filter(f => !f.posted && (!onlyNew || f.status === "new"));
    let sent = 0;
    try {
        for (let i = 0; i < queue.length; i += 10) {
            await postWebhook(queue.slice(i, i + 10));
            sent += Math.min(10, queue.length - i);
            setStatus(`Webhook: posted ${sent}/${queue.length}`);
            await sleep(1200);
        }
    } catch (e: any) {
        toast(`Webhook failed: ${e?.message ?? e}`, "critical");
    } finally {
        await persist();
    }
    setStatus(`Webhook: posted ${sent}/${queue.length}`);
}

/* ---------- scanning ---------- */

const job = { running: false, abort: false, status: "Idle" };
function setStatus(s: string) {
    job.status = s;
    emit();
}

function toast(text: string, variant: "default" | "success" | "critical" = "default") {
    showToast({ text: `FullCyberJacket: ${text}`, variant });
}

type Scope = "channel" | "guild" | "everywhere";

interface Target {
    authorId?: string;
    label: string;
    sources: () => Promise<Source[]>;
}

function targetFor(scope: Scope, authorId?: string, guildId?: string, channelId?: string): Target | string {
    const cid = channelId ?? SelectedChannelStore.getChannelId();
    const gid = guildId ?? (scope === "guild" ? SelectedGuildStore.getGuildId() : undefined);
    const who = authorId ? (UserStore.getUser(authorId)?.username ?? authorId) : "everyone";
    switch (scope) {
        case "channel": {
            if (!cid) return "Open a channel first";
            const ch = ChannelStore.getChannel(cid);
            const label = ch?.name ? `#${ch.name}` : cid;
            // Channel search only exists for DMs; guild channels are searched through the guild with channel_id.
            const src: Source = !authorId ? { kind: "history", id: cid, label }
                : ch?.guild_id ? { kind: "guild-search", id: ch.guild_id, channelId: cid, label }
                    : { kind: "channel-search", id: cid, label };
            return { authorId, label: `${who} in this channel`, sources: async () => [src] };
        }
        case "guild":
            if (!gid) return "Open a server first";
            return {
                authorId,
                label: `${who} in ${GuildStore.getGuild(gid)?.name ?? gid}`,
                sources: async () => authorId
                    ? [{ kind: "guild-search", id: gid, label: GuildStore.getGuild(gid)?.name ?? gid }]
                    // Guild search needs a filter; without an author walk every channel's history instead.
                    : guildChannels(gid)
            };
        case "everywhere":
            if (!authorId) return "Scanning everywhere needs a user";
            return {
                authorId,
                label: `${who} in every shared server and DM`,
                sources: async () => [...await mutualGuilds(authorId), ...privateChannelsWith(authorId)]
            };
    }
}

function whereLabel(m: any, src: Source): string {
    const ch = ChannelStore.getChannel(m.channel_id);
    const guild = m.guild_id ?? ch?.guild_id;
    const g = guild ? GuildStore.getGuild(guild)?.name : undefined;
    const c = ch?.name ? `#${ch.name}` : src.kind === "history" ? src.label : `channel ${m.channel_id}`;
    return g ? `${g} › ${c}` : ch?.isPrivate?.() ? (ch.name || "DM") : c;
}

async function runScan(t: Target) {
    if (job.running) return toast("a scan is already running");
    await load();
    const s = settings.store;
    const minId = s.sinceDays > 0 ? SnowflakeUtils.fromTimestamp(Date.now() - s.sinceDays * 86_400_000) : undefined;
    const known = new Map(results.map(f => [f.id, f]));
    const autoPost = s.webhookAuto && WEBHOOK_RE.test((s.webhookUrl ?? "").trim());
    let scanned = 0, found = 0, failed = 0;
    const pending: Finding[] = [];

    const flush = async (force = false) => {
        if (!autoPost || !pending.length || (!force && pending.length < 10)) return;
        const batch = pending.splice(0, 10);
        try {
            await postWebhook(batch);
        } catch (e: any) {
            failed++;
            toast(`webhook failed: ${e?.message ?? e}`, "critical");
        }
    };

    job.running = true;
    job.abort = false;
    setStatus(`Resolving sources for ${t.label}…`);
    try {
        const sources = await t.sources();
        const bounds: Bounds = { authorId: t.authorId, minId, delayMs: Math.max(800, s.delayMs), abort: () => job.abort };
        for (const [i, src] of sources.entries()) {
            if (job.abort) break;
            try {
                for await (const m of messages(src, bounds)) {
                    if (job.abort) break;
                    scanned++;
                    if (!m.content || known.has(m.id)) continue;
                    const hits = scanText(m.content);
                    if (!hits.length) continue;
                    const f: Finding = {
                        id: m.id,
                        channelId: m.channel_id,
                        guildId: m.guild_id ?? ChannelStore.getChannel(m.channel_id)?.guild_id ?? (src.kind === "guild-search" ? src.id : undefined),
                        authorId: m.author?.id,
                        author: m.author?.global_name || m.author?.username || m.author?.id,
                        where: whereLabel(m, src),
                        at: m.timestamp,
                        content: m.content,
                        hits,
                        status: "new"
                    };
                    results.push(f);
                    known.set(f.id, f);
                    found++;
                    pending.push(f);
                    await flush();
                    if (found % 25 === 0) await persist();
                    setStatus(`[${i + 1}/${sources.length}] ${src.label}: scanned ${scanned}, found ${found}`);
                }
            } catch (e: any) {
                // 403 = no access to that server / channel; carry on with the rest.
                if (Number(e?.status) !== 403) failed++;
            }
            setStatus(`[${i + 1}/${sources.length}] ${src.label}: scanned ${scanned}, found ${found}`);
        }
        while (pending.length) await flush(true);
    } finally {
        await persist();
        job.running = false;
        const summary = `${job.abort ? "Stopped" : "Done"}: ${t.label}: scanned ${scanned}, found ${found}${failed ? `, errors ${failed}` : ""}`;
        setStatus(summary);
        toast(summary, found ? "success" : "default");
    }
}

function start(scope: Scope, authorId?: string, guildId?: string, channelId?: string) {
    const t = targetFor(scope, authorId?.trim() || undefined, guildId, channelId);
    if (typeof t === "string") return toast(t, "critical");
    runScan(t);
}

/* ---------- export ---------- */

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function exportFindings() {
    await load();
    const rows = results.filter(f => f.status !== "dismissed");
    if (!rows.length) return toast("nothing to export");
    const flat = rows.map(f => ({
        link: jumpUrl(f),
        author: f.author,
        author_id: f.authorId,
        where: f.where,
        sent_at: f.at,
        status: f.status,
        policies: [...new Set(f.hits.map(h => h.policy))].join("; "),
        matches: f.hits.map(h => `${h.raw} -> ${h.canonical}${h.evasion ? " (evasion)" : ""}${h.context ? ` [next to ${h.context}]` : ""}`).join("; "),
        content: f.content
    }));
    const head = Object.keys(flat[0]);
    const csv = [head.join(","), ...flat.map(r => head.map(k => csvCell((r as any)[k])).join(","))].join("\n");
    const txt = rows.map(f =>
        `${jumpUrl(f)}\n  ${[...new Set(f.hits.map(h => `${h.policy}: ${h.detail}`))].join(" | ")}\n  ${f.author} (${f.authorId}), ${f.where}, ${f.at}\n`
    ).join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zip = zipSync({
        "findings.json": strToU8(JSON.stringify(rows, null, 2)),
        "findings.csv": strToU8(csv),
        "links.txt": strToU8(txt)
    });
    saveFile(new File([zip], `fullcyberjacket-${stamp}.zip`, { type: "application/zip" }));
}

/* ---------- review UI ---------- */

function Highlighted({ f }: { f: Finding; }) {
    const parts: React.ReactNode[] = [];
    let at = 0;
    for (const [i, h] of [...f.hits].sort((a, b) => a.start - b.start).entries()) {
        if (h.start < at) continue;
        parts.push(f.content.slice(at, h.start));
        parts.push(<mark key={i} style={{ background: "#750f0f", color: "#fff", borderRadius: 3, padding: "0 2px" }}>{f.content.slice(h.start, h.end)}</mark>);
        at = h.end;
    }
    parts.push(f.content.slice(at));
    return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "6px 0", color: "var(--text-normal)" }}>{parts}</div>;
}

const tag = (text: string, bg: string, fg = "#fff") => (
    <span style={{ background: bg, color: fg, borderRadius: 4, padding: "1px 6px", fontSize: 11, marginRight: 4, display: "inline-block" }}>{text}</span>
);

function FindingRow({ f, close }: { f: Finding; close: () => void; }) {
    const set = async (status: Status) => {
        f.status = f.status === status ? "new" : status;
        await persist();
    };
    return (
        <div style={{ borderTop: "1px solid #262626", padding: "8px 0", opacity: f.status === "dismissed" ? 0.5 : 1 }}>
            <div style={{ fontSize: 12, color: "#c0c0c0" }}>
                <b>{f.author}</b> · {f.where} · {new Date(f.at).toLocaleString()}
            </div>
            <Highlighted f={f} />
            <div>
                {f.hits.map((h, i) => (
                    <span key={i}>
                        {tag(`${h.policy}`, h.policy.includes("Violent") || h.cat === "self_harm" ? "#750f0f" : "#105c5c")}
                        {tag(`${h.raw} → ${h.canonical}`, "#1b1b1b", "#c0c0c0")}
                        {h.evasion && tag("evasion", "#7fffd4", "#000")}
                        {h.context && tag(`next to: ${h.context}`, "#1b1b1b", "#c0c0c0")}
                        {tag(h.conf, "#1b1b1b", "#c0c0c0")}
                    </span>
                ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <Button size="small" onClick={() => {
                    NavigationRouter.transitionTo(`/channels/${f.guildId ?? "@me"}/${f.channelId}/${f.id}`);
                    close();
                }}>Jump</Button>
                <Button size="small" variant="secondary" onClick={() => copyWithToast(jumpUrl(f), "Link copied")}>Copy link</Button>
                <Button size="small" variant={f.status === "reported" ? "primary" : "secondary"} onClick={() => set("reported")}>
                    {f.status === "reported" ? "✓ Reported" : "Mark reported"}
                </Button>
                <Button size="small" variant="secondary" onClick={() => set("dismissed")}>
                    {f.status === "dismissed" ? "Restore" : "Dismiss (false positive)"}
                </Button>
            </div>
        </div>
    );
}

function ResultsModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const all = useResults();
    const [status, setStatusFilter] = useState<Status | "all">("new");
    const [cat, setCat] = useState<Category | "all">("all");
    const [q, setQ] = useState("");
    const [limit, setLimit] = useState(100);

    const list = all.filter(f =>
        (status === "all" || f.status === status) &&
        (cat === "all" || f.hits.some(h => h.cat === cat)) &&
        (!q || `${f.author} ${f.authorId} ${f.where}`.toLowerCase().includes(q.toLowerCase()))
    ).sort((a, b) => b.at.localeCompare(a.at));
    const count = (s: Status) => all.filter(f => f.status === s).length;
    const chip = (active: boolean, label: string, onClick: () => void) => (
        <Button size="small" variant={active ? "primary" : "secondary"} onClick={onClick}>{label}</Button>
    );

    return (
        <Modal {...modalProps} size="lg" title={`FullCyberJacket: findings (${all.length})`}>
            <div>
                <Paragraph style={{ margin: "8px 0" }}>
                    Read each finding in context before reporting: Jump → right-click the message → Report, then pick the
                    reason shown in the tag. Dismiss anything that is a quote, a reclaimed word or a joke between friends.
                </Paragraph>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {chip(status === "new", `New (${count("new")})`, () => setStatusFilter("new"))}
                    {chip(status === "reported", `Reported (${count("reported")})`, () => setStatusFilter("reported"))}
                    {chip(status === "dismissed", `Dismissed (${count("dismissed")})`, () => setStatusFilter("dismissed"))}
                    {chip(status === "all", "All", () => setStatusFilter("all"))}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {chip(cat === "all", "Any category", () => setCat("all"))}
                    {(Object.keys(CATEGORIES) as Category[])
                        .filter(c => all.some(f => f.hits.some(h => h.cat === c)))
                        .map(c => <span key={c}>{chip(cat === c, c.replace("_", " "), () => setCat(c))}</span>)}
                </div>
                <TextInput value={q} onChange={setQ} placeholder="Filter by author, ID or place…" />
                <div style={{ marginTop: 8 }}>
                    {list.slice(0, limit).map(f => <FindingRow key={f.id} f={f} close={modalProps.onClose} />)}
                    {!list.length && <Paragraph>No findings here.</Paragraph>}
                    {list.length > limit && <Button size="small" variant="secondary" onClick={() => setLimit(l => l + 100)}>Show more ({list.length - limit} left)</Button>}
                </div>
            </div>
        </Modal>
    );
}

export function openResults() {
    openModal(props => <ResultsModal modalProps={props} />);
}

function ScanPanel() {
    useResults();
    const [userId, setUserId] = useState("");
    const [guildId, setGuildId] = useState("");
    const btn = (label: string, run: () => void, disabled = job.running) => (
        <Button size="small" disabled={disabled} onClick={run}>{label}</Button>
    );
    const fresh = results.filter(f => f.status === "new").length;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <HeadingTertiary>Scan</HeadingTertiary>
            <Paragraph>
                User ID to scan (empty = every author; only for a channel or one server). Right-click a user,
                message or server for the same actions.
            </Paragraph>
            <TextInput value={userId} onChange={setUserId} placeholder="User ID (Developer Mode → Copy User ID)" />
            <TextInput value={guildId} onChange={setGuildId} placeholder="Server ID (optional, for “Server by ID”)" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {btn("This channel", () => start("channel", userId))}
                {btn("This server", () => start("guild", userId))}
                {btn("Server by ID", () => start("guild", userId, guildId.trim()), job.running || !/^\d{15,22}$/.test(guildId.trim()))}
                {btn("Everywhere (shared servers + DMs)", () => start("everywhere", userId), job.running || !/^\d{15,22}$/.test(userId.trim()))}
                <Button size="small" variant="dangerPrimary" disabled={!job.running} onClick={() => { job.abort = true; }}>Stop</Button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button size="small" variant="secondary" onClick={openResults}>Review findings ({fresh} new / {results.length})</Button>
                <Button size="small" variant="secondary" onClick={exportFindings}>Export ZIP (json, csv, links)</Button>
                <Button size="small" variant="secondary" disabled={job.running} onClick={() => flushWebhook()}>Post unsent to webhook</Button>
                <Button size="small" variant="dangerSecondary" disabled={job.running} onClick={async () => {
                    results = [];
                    await persist();
                }}>Clear findings</Button>
            </div>
            <Paragraph>{job.status}</Paragraph>
        </div>
    );
}

/* ---------- context menus ---------- */

type MenuAction = { id: string; label: string; run: () => void; };

function group(items: MenuAction[]) {
    return (
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-fcj" label="FullCyberJacket">
                {items.map(i => <Menu.MenuItem key={i.id} id={i.id} label={i.label} action={i.run} />)}
                <Menu.MenuItem id="vc-fcj-results" label="Review findings" action={openResults} />
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
}

const userMenu: NavContextMenuPatchCallback = (children, props) => {
    const uid: string | undefined = props?.user?.id;
    if (!uid || uid === UserStore.getCurrentUser()?.id) return;
    const gid: string | undefined = props?.guildId ?? props?.channel?.guild_id;
    const cid: string | undefined = props?.channel?.id;
    const items: MenuAction[] = [];
    if (cid) items.push({ id: "vc-fcj-user-channel", label: "Scan their messages in this channel", run: () => start("channel", uid, undefined, cid) });
    if (gid) items.push({ id: "vc-fcj-user-guild", label: "Scan their messages in this server", run: () => start("guild", uid, gid) });
    items.push({ id: "vc-fcj-user-all", label: "Scan their messages everywhere", run: () => start("everywhere", uid) });
    children.push(group(items));
};

const messageMenu: NavContextMenuPatchCallback = (children, props) => {
    const uid: string | undefined = props?.message?.author?.id;
    if (!uid || uid === UserStore.getCurrentUser()?.id) return;
    const gid: string | undefined = props?.channel?.guild_id;
    const items: MenuAction[] = [];
    if (gid) items.push({ id: "vc-fcj-msg-guild", label: "Scan this author in this server", run: () => start("guild", uid, gid) });
    items.push({ id: "vc-fcj-msg-all", label: "Scan this author everywhere", run: () => start("everywhere", uid) });
    children.push(group(items));
};

const guildMenu: NavContextMenuPatchCallback = (children, props) => {
    const gid: string | undefined = props?.guild?.id;
    if (!gid) return;
    children.push(group([{ id: "vc-fcj-guild", label: "Scan every author in this server (slow)", run: () => start("guild", undefined, gid) }]));
};

/* ---------- plugin ---------- */

export default definePlugin({
    name: "FullCyberJacket",
    description: "Finds hate speech, threats, self-harm encouragement and extremist content in a user's or a server's messages, including leet / look-alike / spacing evasion, and lines it up for manual review and reporting. Never reports anything itself.",
    authors: [{ name: "sernik", id: 0n }],
    tags: ["Utility", "Chat"],
    searchTerms: ["hate speech", "slur", "moderation", "report", "scan"],
    dependencies: ["CommandsAPI"],
    settings,

    start() {
        load().then(emit);
    },

    contextMenus: {
        "user-context": userMenu,
        "message": messageMenu,
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu
    },

    commands: [
        {
            name: "cyberjacket",
            description: "FullCyberJacket: scan messages for hate speech, threats and self-harm encouragement",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "scope",
                    description: "Where to scan",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        { name: "This channel", label: "This channel", value: "channel" },
                        { name: "This server", label: "This server", value: "guild" },
                        { name: "Everywhere (needs user)", label: "Everywhere (needs user)", value: "everywhere" }
                    ]
                },
                { name: "user", description: "Only this user's messages", type: ApplicationCommandOptionType.USER, required: false }
            ],
            execute(args, ctx) {
                const scope = args.find(a => a.name === "scope")?.value as Scope;
                const user = args.find(a => a.name === "user")?.value as string | undefined;
                sendBotMessage(ctx.channel.id, { content: `FullCyberJacket: scanning (${scope}${user ? `, <@${user}>` : ""}). Progress in toasts; review with /cyberjacket-results.` });
                start(scope, user, scope === "guild" ? ctx.guild?.id : undefined, scope === "channel" ? ctx.channel.id : undefined);
            }
        },
        {
            name: "cyberjacket-results",
            description: "FullCyberJacket: review findings",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute() {
                openResults();
            }
        }
    ]
});
