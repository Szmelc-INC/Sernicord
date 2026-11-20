/*
 * Sernicord MessageOps — move / copy / export / bulk-delete message ranges
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pick a source (right-click → MessageOps: range start / end, or a whole
 * channel), narrow it down (authors, text or /regex/, files, bots, pins) and
 * run one action: Preview, Export (ZIP with files), Copy, Move or Delete.
 * Copy / Move land in one target channel as a native forward, a repost or a
 * webhook clone (original name + avatar; the webhook is created for you).
 * Requests are paced by Discord's rate limit headers (see limiter.ts), posts
 * and deletes run as two parallel queues, and a Move only deletes a source
 * message after its copy landed.
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, ChannelStore, Menu, React, showToast, useEffect, useState } from "@webpack/common";

import { isSnowflake, snowflakeTime } from "./api";
import {
    Action, collect, execute, isDestructive, isTransfer, job, parseIds, Plan, Report, RunOptions, setStatus, Speed, Style
} from "./ops";

const Author = { name: "sernik", id: 0n };

const ACTIONS: { id: Action; label: string; variant: "secondary" | "primary" | "dangerPrimary"; }[] = [
    { id: "preview", label: "Preview", variant: "secondary" },
    { id: "export", label: "Export ZIP", variant: "primary" },
    { id: "copy", label: "Copy", variant: "primary" },
    { id: "move", label: "Move", variant: "dangerPrimary" },
    { id: "delete", label: "Delete", variant: "dangerPrimary" }
];

const STYLE_LABEL: Record<Style, string> = { forward: "forward", repost: "repost", clone: "webhook clone" };

/* ---------- settings ---------- */

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <Panel />
    },
    channelId: {
        type: OptionType.STRING,
        description: "Source channel ID (set by right-click → MessageOps)",
        default: ""
    },
    startId: {
        type: OptionType.STRING,
        description: "Range start: first message ID (empty = channel beginning)",
        default: ""
    },
    endId: {
        type: OptionType.STRING,
        description: "Range end: last message ID (empty = newest)",
        default: ""
    },
    authorIds: {
        type: OptionType.STRING,
        description: "Filter — only these authors: user IDs or mentions (empty = everyone)",
        default: ""
    },
    text: {
        type: OptionType.STRING,
        description: "Filter — only messages containing this text, or /regex/flags",
        default: ""
    },
    attachments: {
        type: OptionType.SELECT,
        description: "Filter — attachments",
        options: [
            { label: "Any message", value: "any", default: true },
            { label: "Only with attachments", value: "with" },
            { label: "Only without attachments", value: "without" }
        ]
    },
    bots: {
        type: OptionType.SELECT,
        description: "Filter — bots / webhooks",
        options: [
            { label: "Include", value: "include", default: true },
            { label: "Exclude", value: "exclude" },
            { label: "Only bots / webhooks", value: "only" }
        ]
    },
    skipPinned: {
        type: OptionType.BOOLEAN,
        description: "Filter — skip pinned messages",
        default: true
    },
    includeSystem: {
        type: OptionType.BOOLEAN,
        description: "Filter — include system messages (joins, boosts, pins…); they cannot be forwarded",
        default: false
    },
    maxCount: {
        type: OptionType.NUMBER,
        description: "Filter — stop after this many matching messages (0 = no cap)",
        default: 0
    },
    targetChannelId: {
        type: OptionType.STRING,
        description: "Copy / Move — target channel or thread ID (right-click a channel → MessageOps → Set as target)",
        default: ""
    },
    style: {
        type: OptionType.SELECT,
        description: "Copy / Move — how messages land in the target",
        options: [
            { label: "Forward — native forward card, 1 request per message", value: "forward", default: true },
            { label: "Repost — as you: text + re-uploaded files", value: "repost" },
            { label: "Clone — webhook with the original name + avatar (needs Manage Webhooks, created for you)", value: "clone" }
        ]
    },
    merge: {
        type: OptionType.BOOLEAN,
        description: "Repost / Clone — merge consecutive messages of one author into one post (far fewer requests)",
        default: true
    },
    originLine: {
        type: OptionType.BOOLEAN,
        description: "Repost / Clone — add a small origin line (author, time; Copy also links the original)",
        default: true
    },
    safetyZip: {
        type: OptionType.BOOLEAN,
        description: "Move / Delete — save a ZIP of everything (with files) first; a failed download cancels the run",
        default: true
    },
    speed: {
        type: OptionType.SELECT,
        description: "Pacing — requests always follow Discord's rate limit headers; this adds a minimum gap between writes",
        options: [
            { label: "Fast — headers only", value: "fast" },
            { label: "Normal — at least 0.5 s between writes", value: "normal", default: true },
            { label: "Careful — at least 2 s between writes", value: "careful" }
        ]
    },
    webhookCache: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, string>
    }
});

type Overrides = Partial<Omit<RunOptions, "selection">> & { selection?: Partial<RunOptions["selection"]>; };

function optionsFor(action: Action, over: Overrides = {}): RunOptions {
    const s = settings.store;
    return {
        action,
        targetChannelId: s.targetChannelId.trim(),
        style: s.style as Style,
        merge: s.merge,
        originLine: s.originLine,
        safetyZip: s.safetyZip,
        speed: s.speed as Speed,
        webhookCache: s.webhookCache,
        ...over,
        selection: {
            channelId: s.channelId.trim(),
            startId: s.startId.trim(),
            endId: s.endId.trim(),
            authorIds: parseIds(s.authorIds),
            text: s.text,
            attachments: s.attachments as any,
            bots: s.bots as any,
            skipPinned: s.skipPinned,
            includeSystem: s.includeSystem,
            maxCount: Math.max(0, s.maxCount || 0),
            ...over.selection
        }
    };
}

/* ---------- running ---------- */

function confirmRun(title: string, body: string): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
        Alerts.show({
            title,
            body: <Paragraph style={{ whiteSpace: "pre-line" }}>{body}</Paragraph>,
            confirmText: "Run it",
            cancelText: "Cancel",
            onConfirm: () => done(true),
            onCancel: () => done(false),
            onCloseCallback: () => done(false)
        });
    });
}

function describePlan(plan: Plan): string {
    const { opts, messages, groups, scanned, noPermission } = plan;
    const lines = [`${messages.length} matched of ${scanned} scanned`];
    if (noPermission) lines.push(`${noPermission} skipped: not yours and no Manage Messages`);
    if (isTransfer(opts.action)) {
        const merged = groups.length < messages.length ? `, merged into ${groups.length} post(s)` : "";
        lines.push(`→ <#${opts.targetChannelId}> as ${STYLE_LABEL[opts.style]}${merged}`);
    }
    if (opts.action === "move") lines.push("each source is deleted right after its copy landed");
    if (isDestructive(opts.action)) lines.push(opts.safetyZip ? "a ZIP with all files is saved first" : "NO safety ZIP (turned off)");
    return lines.join("\n");
}

function summarize(opts: RunOptions, r: Report): string {
    const what = opts.action === "move" ? `moved ${r.done}, deleted ${r.deleted}`
        : opts.action === "delete" ? `deleted ${r.deleted}`
            : opts.action === "copy" ? `copied ${r.done} in ${r.posts} post(s)`
                : `${r.done} message(s)`;
    const state = r.aborted ? "stopped" : r.fatal ? "stopped early" : job.stopping ? "stopped" : "done";
    const parts = [`MessageOps — ${opts.action} ${state}: ${what}, failed ${r.failed}`];
    if (r.notDeleted) parts.push(`${r.notDeleted} copied but NOT deleted from the source`);
    if (r.zip) parts.push(`ZIP: ${r.zip}`);
    if (r.fatal) parts.push(`reason: ${r.fatal}`);
    return [parts.join(" · "), ...r.errors.slice(0, 5)].join("\n");
}

/** Shared by the panel and /msgops. `say` gets the final summary. */
async function run(opts: RunOptions, say?: (text: string) => void): Promise<void> {
    if (job.running) {
        showToast({ text: "MessageOps: a job is already running", variant: "critical" });
        return;
    }
    job.running = true;
    job.abort = false;
    job.stopping = false;
    let summary = "";
    let bad = false;
    try {
        setStatus("Scanning…");
        const plan = await collect(opts);
        const head = describePlan(plan);
        if (plan.messages.length === 0 || opts.action === "preview") {
            summary = `MessageOps — ${opts.action}: ${head.replace(/\n/g, " · ")}`;
            return;
        }
        if (opts.action !== "export") {
            setStatus("Waiting for confirmation…");
            const ok = await confirmRun(`MessageOps: ${opts.action} ${plan.messages.length} message(s)?`, head);
            if (!ok) {
                summary = "MessageOps — cancelled";
                return;
            }
        }
        const r = await execute(plan);
        summary = summarize(opts, r);
        bad = r.failed > 0 || !!r.fatal || r.notDeleted > 0;
    } catch (e: any) {
        summary = job.abort ? "MessageOps — stopped" : `MessageOps — error: ${e?.message ?? e}`;
        bad = !job.abort;
    } finally {
        job.running = false;
        job.stopping = false;
        setStatus(summary.split("\n")[0] || "Idle");
        showToast({ text: summary.split("\n")[0], variant: bad ? "critical" : "success" });
        say?.(summary);
    }
}

/** First click: finish what is in flight (a Move still deletes what it already copied). Second click: now. */
function stop() {
    if (!job.running) return;
    if (job.stopping) {
        job.abort = true;
        setStatus("Stopping now…");
    } else {
        job.stopping = true;
        setStatus("Stopping after the current message… (click Stop again to stop at once)");
    }
}

/* ---------- panel ---------- */

function useJobStatus() {
    const [, bump] = useState(0);
    useEffect(() => {
        const l = () => bump(n => n + 1);
        job.listeners.add(l);
        return () => void job.listeners.delete(l);
    }, []);
    return job;
}

function idLabel(id: string) {
    if (!isSnowflake(id)) return "—";
    return `${id} · ${new Date(snowflakeTime(id)).toLocaleString()}`;
}

function channelLabel(id: string) {
    if (!id) return "—";
    const c = ChannelStore.getChannel(id);
    return c ? `#${c.name || c.id}` : id;
}

function Panel() {
    const s = settings.use(["channelId", "startId", "endId", "authorIds", "text", "targetChannelId", "style"]);
    const j = useJobStatus();
    const authors = parseIds(s.authorIds);
    const line = (text: string) => <Paragraph style={{ fontSize: 13, margin: "4px 0" }}>{text}</Paragraph>;

    return (
        <div style={{ padding: 12, borderRadius: 8, background: "var(--background-secondary)", marginBottom: 16 }}>
            <Heading tag="h5">Source</Heading>
            {line(`Channel: ${s.channelId ? channelLabel(s.channelId) : "— (right-click a message or channel → MessageOps)"}`)}
            {line(`From: ${idLabel(s.startId)}`)}
            {line(`To: ${idLabel(s.endId)}`)}
            {line(`Authors: ${authors.length ? authors.join(", ") : "everyone"}${s.text ? ` · text: ${s.text}` : ""}`)}
            <Heading tag="h5" style={{ marginTop: 8 }}>Target (Copy / Move)</Heading>
            {line(`${channelLabel(s.targetChannelId)} as ${STYLE_LABEL[s.style as Style] ?? s.style}`)}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
                {ACTIONS.map(a => (
                    <Button
                        key={a.id}
                        size="small"
                        variant={a.variant}
                        disabled={j.running}
                        onClick={() => run(optionsFor(a.id))}
                    >
                        {a.label}
                    </Button>
                ))}
                <Button size="small" variant="dangerSecondary" disabled={!j.running} onClick={stop}>
                    {j.stopping ? "Stop now" : "Stop"}
                </Button>
                <Button
                    size="small" variant="secondary" disabled={j.running}
                    onClick={() => {
                        settings.store.startId = "";
                        settings.store.endId = "";
                        settings.store.authorIds = "";
                        settings.store.text = "";
                    }}
                >
                    Clear range + filters
                </Button>
            </div>

            <Paragraph style={{ fontSize: 12, fontFamily: "var(--font-code)", opacity: 0.85, margin: 0 }}>
                {j.status}
            </Paragraph>
        </div>
    );
}

/* ---------- context menus ---------- */

function setStart(channelId: string, messageId: string) {
    if (settings.store.channelId !== channelId) settings.store.endId = "";
    settings.store.channelId = channelId;
    settings.store.startId = messageId;
    showToast({ text: "MessageOps: range start set", variant: "success" });
}

function setEnd(channelId: string, messageId: string) {
    if (settings.store.startId && settings.store.channelId !== channelId) {
        showToast({ text: "MessageOps: the start is in another channel — set the start here first", variant: "critical" });
        return;
    }
    settings.store.channelId = channelId;
    settings.store.endId = messageId;
    showToast({ text: "MessageOps: range end set", variant: "success" });
}

const messageMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const msg = props?.message;
    const channelId = msg?.channel_id ?? props?.channel?.id;
    if (!msg?.id || !channelId) return;
    children.push(
        <Menu.MenuItem id="vc-msgops" label="MessageOps">
            <Menu.MenuItem id="vc-msgops-start" label="Range start here" action={() => setStart(channelId, msg.id)} />
            <Menu.MenuItem id="vc-msgops-end" label="Range end here" action={() => setEnd(channelId, msg.id)} />
            <Menu.MenuItem
                id="vc-msgops-author"
                label={`Only ${msg.author?.username ?? "this author"}`}
                action={() => {
                    settings.store.authorIds = msg.author?.id ?? "";
                    showToast({ text: `MessageOps: author filter = ${msg.author?.username}`, variant: "success" });
                }}
            />
            <Menu.MenuItem
                id="vc-msgops-author-add"
                label="Add author to filter"
                action={() => {
                    const ids = new Set(parseIds(settings.store.authorIds));
                    if (msg.author?.id) ids.add(msg.author.id);
                    settings.store.authorIds = [...ids].join(", ");
                    showToast({ text: `MessageOps: ${ids.size} author(s) in filter`, variant: "success" });
                }}
            />
        </Menu.MenuItem>
    );
};

const channelMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel?.id) return;
    const set = (key: "channelId" | "targetChannelId", what: string) => () => {
        if (key === "channelId" && settings.store.channelId !== channel.id) {
            settings.store.startId = "";
            settings.store.endId = "";
        }
        settings.store[key] = channel.id;
        showToast({ text: `MessageOps: ${what} = #${channel.name ?? channel.id}`, variant: "success" });
    };
    children.push(
        <Menu.MenuItem id="vc-msgops-ch" label="MessageOps">
            <Menu.MenuItem id="vc-msgops-ch-source" label="Set as source (whole channel)" action={set("channelId", "source")} />
            <Menu.MenuItem id="vc-msgops-ch-target" label="Set as target" action={set("targetChannelId", "target")} />
        </Menu.MenuItem>
    );
};

/* ---------- plugin ---------- */

export default definePlugin({
    name: "MessageOps",
    description: "Move, copy, export and bulk-delete message ranges: mark first/last message, filter by author/text/regex/files, forward / repost / webhook-clone into a channel, ZIP export. Paced by Discord's rate limit headers.",
    authors: [Author],
    tags: ["Utility", "Chat"],
    settings,
    contextMenus: {
        "message": messageMenuPatch,
        "channel-context": channelMenuPatch,
        "thread-context": channelMenuPatch
    },
    commands: [{
        name: "msgops",
        description: "MessageOps: run an action on a message range (rest comes from the plugin settings)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            {
                name: "action",
                description: "What to do",
                type: ApplicationCommandOptionType.STRING,
                required: true,
                choices: ACTIONS.map(a => ({ name: a.id, label: a.label, value: a.id }))
            },
            { name: "start", description: "First message ID (range in this channel)", type: ApplicationCommandOptionType.STRING, required: false },
            { name: "end", description: "Last message ID", type: ApplicationCommandOptionType.STRING, required: false },
            { name: "user", description: "Only this author", type: ApplicationCommandOptionType.USER, required: false },
            { name: "target", description: "Copy / Move target channel", type: ApplicationCommandOptionType.CHANNEL, required: false },
            {
                name: "style",
                description: "Copy / Move: forward, repost or clone (default: plugin setting)",
                type: ApplicationCommandOptionType.STRING,
                required: false,
                choices: (["forward", "repost", "clone"] as Style[]).map(v => ({ name: v, label: v, value: v }))
            },
            { name: "max", description: "Stop after N matching messages", type: ApplicationCommandOptionType.INTEGER, required: false }
        ],
        execute: async (args, ctx) => {
            const action = findOption<string>(args, "action", "preview") as Action;
            const start = findOption<string>(args, "start", "");
            const end = findOption<string>(args, "end", "");
            const user = findOption<string>(args, "user", "");
            const target = findOption<string>(args, "target", "");
            const style = findOption<string>(args, "style", "");
            const max = findOption<number | undefined>(args, "max", undefined);

            const useHere = !!(start || end) || !settings.store.channelId;
            const over: Overrides = {
                selection: {
                    ...(useHere ? { channelId: ctx.channel.id, startId: start, endId: end } : {}),
                    ...(user ? { authorIds: [user] } : {}),
                    ...(max != null ? { maxCount: Math.max(0, max) } : {})
                },
                ...(target ? { targetChannelId: target } : {}),
                ...(style ? { style: style as Style } : {})
            };
            const opts = optionsFor(action, over);

            sendBotMessage(ctx.channel.id, { content: `MessageOps: ${action} on <#${opts.selection.channelId}>…` });
            await run(opts, text => sendBotMessage(ctx.channel.id, { content: text }));
        }
    }],

    stop() {
        job.abort = true;
    }
});
