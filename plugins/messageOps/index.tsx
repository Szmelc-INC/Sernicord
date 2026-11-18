/*
 * Sernicord MessageOps — move / clone / backup / bulk-delete message ranges
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pick a channel, mark the first and last message of a range (right-click →
 * MessageOps), narrow it down (authors, text, regex, files, bots, pins) and run
 * one action on it: preview, ZIP backup, copy, move or delete. Every action can
 * also mirror each message into a log channel (native forward and/or a copy)
 * before it is touched. Writes are fail-closed: a source message is only
 * deleted after its mirror and transfer succeeded.
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
import { Action, collect, execute, job, MirrorMode, parseIds, Plan, RunOptions, setStatus, TransferMode } from "./ops";

const Author = { name: "sernik", id: 0n };

const ACTIONS: { id: Action; label: string; variant: "secondary" | "primary" | "dangerPrimary"; }[] = [
    { id: "preview", label: "Preview", variant: "secondary" },
    { id: "backup", label: "Backup ZIP", variant: "primary" },
    { id: "copy", label: "Copy", variant: "primary" },
    { id: "move", label: "Move", variant: "dangerPrimary" },
    { id: "delete", label: "Delete", variant: "dangerPrimary" }
];

/* ---------- settings ---------- */

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <Panel />
    },
    channelId: {
        type: OptionType.STRING,
        description: "Source channel ID (set automatically by right-click → MessageOps)",
        default: ""
    },
    startId: {
        type: OptionType.STRING,
        description: "Range start: message ID of the first message (empty = channel beginning)",
        default: ""
    },
    endId: {
        type: OptionType.STRING,
        description: "Range end: message ID of the last message (empty = newest)",
        default: ""
    },
    authorIds: {
        type: OptionType.STRING,
        description: "Only these authors: user IDs or mentions, comma/space separated (empty = everyone)",
        default: ""
    },
    contains: {
        type: OptionType.STRING,
        description: "Only messages containing this text (case-insensitive)",
        default: ""
    },
    regex: {
        type: OptionType.STRING,
        description: "Only messages matching this regex (JS syntax, flags \"iu\")",
        default: ""
    },
    attachments: {
        type: OptionType.SELECT,
        description: "Attachments filter",
        options: [
            { label: "Any message", value: "any", default: true },
            { label: "Only with attachments", value: "with" },
            { label: "Only without attachments", value: "without" }
        ]
    },
    bots: {
        type: OptionType.SELECT,
        description: "Bots / webhooks",
        options: [
            { label: "Include", value: "include", default: true },
            { label: "Exclude", value: "exclude" },
            { label: "Only bots / webhooks", value: "only" }
        ]
    },
    skipPinned: {
        type: OptionType.BOOLEAN,
        description: "Skip pinned messages",
        default: true
    },
    includeSystem: {
        type: OptionType.BOOLEAN,
        description: "Include system messages (joins, boosts, pins…). They cannot be forwarded",
        default: false
    },
    maxCount: {
        type: OptionType.NUMBER,
        description: "Stop after this many matching messages (0 = no cap)",
        default: 0
    },
    transferMode: {
        type: OptionType.SELECT,
        description: "Copy / Move: how messages land in the target",
        options: [
            { label: "Native forward (keeps the original card)", value: "forward", default: true },
            { label: "Copy as me (text + re-uploaded files + header)", value: "copy" },
            { label: "Webhook clone (original name + avatar)", value: "webhook" }
        ]
    },
    targetChannelId: {
        type: OptionType.STRING,
        description: "Copy / Move: target channel ID (forward and copy modes)",
        default: ""
    },
    webhookUrl: {
        type: OptionType.STRING,
        description: "Copy / Move: target webhook URL (webhook mode). Stored in plain text",
        default: ""
    },
    mirrorMode: {
        type: OptionType.SELECT,
        description: "Every action: mirror each message into the mirror channel before touching it",
        options: [
            { label: "Off", value: "off", default: true },
            { label: "Forward", value: "forward" },
            { label: "Copy", value: "copy" },
            { label: "Forward + copy", value: "both" }
        ]
    },
    mirrorChannelId: {
        type: OptionType.STRING,
        description: "Mirror / log channel ID",
        default: ""
    },
    dryRun: {
        type: OptionType.BOOLEAN,
        description: "Dry run: only count (Backup still saves the ZIP locally). Nothing is posted or deleted",
        default: true
    },
    delayMs: {
        type: OptionType.NUMBER,
        description: "Pause between messages in ms (keep it high; Discord flags fast mass actions)",
        default: 2500
    },
    copyHeader: {
        type: OptionType.BOOLEAN,
        description: "Copies: add a small header (author, time, jump link)",
        default: true
    },
    reuploadFiles: {
        type: OptionType.BOOLEAN,
        description: "Copies: re-upload attachments (off = post their links)",
        default: true
    },
    maxUploadMb: {
        type: OptionType.NUMBER,
        description: "Largest file to re-upload / put in the ZIP, in MB (bigger ones become links)",
        default: 10
    },
    autoBackup: {
        type: OptionType.BOOLEAN,
        description: "Move / Delete: save a ZIP of everything selected (with all files) before starting; a failed download stops the run",
        default: true
    },
    backupFiles: {
        type: OptionType.BOOLEAN,
        description: "Backups: download attachments into the ZIP too",
        default: false
    },
    uploadBackupToMirror: {
        type: OptionType.BOOLEAN,
        description: "Backup: also upload the ZIP into the mirror channel",
        default: false
    }
});

type Overrides = Partial<Omit<RunOptions, "selection">> & { selection?: Partial<RunOptions["selection"]>; };

function optionsFor(action: Action, over: Overrides = {}): RunOptions {
    const s = settings.store;
    return {
        action,
        dryRun: s.dryRun,
        transferMode: s.transferMode as TransferMode,
        targetChannelId: s.targetChannelId.trim(),
        webhookUrl: s.webhookUrl.trim(),
        mirrorMode: s.mirrorMode as MirrorMode,
        mirrorChannelId: s.mirrorChannelId.trim(),
        delayMs: Math.max(0, s.delayMs || 0),
        copyHeader: s.copyHeader,
        reuploadFiles: s.reuploadFiles,
        maxUploadMb: Math.max(1, s.maxUploadMb || 10),
        autoBackup: s.autoBackup,
        backupFiles: s.backupFiles,
        uploadBackupToMirror: s.uploadBackupToMirror,
        ...over,
        selection: {
            channelId: s.channelId.trim(),
            startId: s.startId.trim(),
            endId: s.endId.trim(),
            authorIds: parseIds(s.authorIds),
            contains: s.contains,
            regex: s.regex,
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
            body: <Paragraph>{body}</Paragraph>,
            confirmText: "Run it",
            cancelText: "Cancel",
            onConfirm: () => done(true),
            onCancel: () => done(false),
            onCloseCallback: () => done(false)
        });
    });
}

function describePlan(plan: Plan): string {
    const { opts, messages, scanned, noPermission } = plan;
    const where = opts.action === "copy" || opts.action === "move"
        ? opts.transferMode === "webhook" ? " → webhook" : ` → <#${opts.targetChannelId}> (${opts.transferMode})`
        : "";
    const mirror = opts.mirrorMode !== "off" ? `, mirror ${opts.mirrorMode} → <#${opts.mirrorChannelId}>` : "";
    const perm = noPermission ? `, ${noPermission} skipped (not yours, no Manage Messages)` : "";
    return `${opts.action}${where}${mirror}: ${messages.length} matched of ${scanned} scanned${perm}`;
}

function needsConfirm(opts: RunOptions): boolean {
    if (opts.dryRun || opts.action === "preview") return false;
    return opts.action !== "backup" || opts.mirrorMode !== "off" || opts.uploadBackupToMirror;
}

/** Shared by the panel and /msgops. `say` gets the final summary line. */
async function run(opts: RunOptions, say?: (text: string) => void): Promise<void> {
    if (job.running) {
        showToast({ text: "MessageOps: a job is already running", variant: "critical" });
        return;
    }
    job.running = true;
    job.abort = false;
    let summary = "";
    try {
        setStatus("Scanning…");
        const plan = await collect(opts);
        const head = describePlan(plan);
        if (plan.messages.length === 0) {
            summary = `MessageOps — ${head}. Nothing to do.`;
            return;
        }
        if (needsConfirm(opts)) {
            setStatus(`Waiting for confirmation — ${head}`);
            const ok = await confirmRun(
                `MessageOps: ${opts.action} ${plan.messages.length} message(s)?`,
                `${head}.${opts.action === "move" || opts.action === "delete" ? " Deleted messages cannot be restored." : ""}`
            );
            if (!ok) {
                summary = `MessageOps — cancelled (${head})`;
                return;
            }
        }
        const r = await execute(plan);
        const mode = opts.dryRun && opts.action !== "preview" ? " (dry run)" : "";
        summary = `MessageOps — ${r.aborted ? "stopped" : "done"}${mode}: ${head}; ok ${r.done}, failed ${r.failed}`
            + (r.errors.length ? `\n${r.errors.slice(0, 5).join("\n")}` : "");
    } catch (e: any) {
        summary = job.abort ? "MessageOps — stopped" : `MessageOps — error: ${e?.message ?? e}`;
    } finally {
        job.running = false;
        setStatus(summary.split("\n")[0] || "Idle");
        showToast({ text: summary.split("\n")[0], variant: /error|failed [1-9]/.test(summary) ? "critical" : "success" });
        say?.(summary);
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

function Panel() {
    const s = settings.use(["channelId", "startId", "endId", "dryRun", "authorIds", "mirrorMode"]);
    const j = useJobStatus();
    const channel = s.channelId ? ChannelStore.getChannel(s.channelId) : null;
    const authors = parseIds(s.authorIds);

    return (
        <div style={{ padding: 12, borderRadius: 8, background: "var(--background-secondary)", marginBottom: 16 }}>
            <Heading tag="h5">Selection</Heading>
            <Paragraph style={{ fontSize: 13, margin: "4px 0" }}>
                Channel: {channel ? `#${channel.name ?? channel.id}` : s.channelId || "— (right-click a message → MessageOps)"}
            </Paragraph>
            <Paragraph style={{ fontSize: 13, margin: "4px 0" }}>Start: {idLabel(s.startId)}</Paragraph>
            <Paragraph style={{ fontSize: 13, margin: "4px 0" }}>End: {idLabel(s.endId)}</Paragraph>
            <Paragraph style={{ fontSize: 13, margin: "4px 0 10px" }}>
                Authors: {authors.length ? authors.join(", ") : "everyone"} · Mirror: {s.mirrorMode} · {s.dryRun ? "DRY RUN" : "LIVE"}
            </Paragraph>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
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
                <Button size="small" variant="dangerSecondary" disabled={!j.running} onClick={() => { job.abort = true; setStatus("Stopping…"); }}>
                    Stop
                </Button>
                <Button
                    size="small" variant="secondary" disabled={j.running}
                    onClick={() => { settings.store.startId = ""; settings.store.endId = ""; settings.store.authorIds = ""; }}
                >
                    Clear range
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
    const set = (key: "channelId" | "targetChannelId" | "mirrorChannelId", what: string) => () => {
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
            <Menu.MenuItem id="vc-msgops-ch-mirror" label="Set as mirror / log channel" action={set("mirrorChannelId", "mirror")} />
        </Menu.MenuItem>
    );
};

/* ---------- plugin ---------- */

export default definePlugin({
    name: "MessageOps",
    description: "Move, clone, back up and bulk-delete message ranges: mark first/last message by ID, filter by author/text/regex/files, forward/copy/webhook-clone to a channel, mirror every action into a log channel, ZIP backups, dry run.",
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
            { name: "mirror", description: "Mirror / log channel (uses the mirror mode from settings, or forward)", type: ApplicationCommandOptionType.CHANNEL, required: false },
            { name: "dry", description: "Dry run (default: plugin setting)", type: ApplicationCommandOptionType.BOOLEAN, required: false },
            { name: "max", description: "Stop after N matching messages", type: ApplicationCommandOptionType.INTEGER, required: false }
        ],
        execute: async (args, ctx) => {
            const action = findOption<string>(args, "action", "preview") as Action;
            const start = findOption<string>(args, "start", "");
            const end = findOption<string>(args, "end", "");
            const user = findOption<string>(args, "user", "");
            const target = findOption<string>(args, "target", "");
            const mirror = findOption<string>(args, "mirror", "");
            const dry = findOption<boolean | undefined>(args, "dry", undefined);
            const max = findOption<number | undefined>(args, "max", undefined);

            const useHere = !!(start || end) || !settings.store.channelId;
            const over: Overrides = {
                selection: {
                    ...(useHere ? { channelId: ctx.channel.id, startId: start, endId: end } : {}),
                    ...(user ? { authorIds: [user] } : {}),
                    ...(max != null ? { maxCount: Math.max(0, max) } : {})
                },
                ...(target ? { targetChannelId: target } : {}),
                ...(mirror ? {
                    mirrorChannelId: mirror,
                    mirrorMode: settings.store.mirrorMode === "off" ? "forward" : settings.store.mirrorMode as MirrorMode
                } : {}),
                ...(dry != null ? { dryRun: dry } : {})
            };
            const opts = optionsFor(action, over);
            if (target && opts.transferMode === "webhook") opts.transferMode = "forward";

            sendBotMessage(ctx.channel.id, { content: `MessageOps: ${action} on <#${opts.selection.channelId}>…` });
            await run(opts, text => sendBotMessage(ctx.channel.id, { content: text }));
        }
    }],

    stop() {
        job.abort = true;
    }
});
