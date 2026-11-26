/*
 * Sernicord MediaForge — media command centre inside Discord.
 * ffmpeg + sox + yt-dlp (system or portable, auto-detected), mpv / VLC control, JSPaint.
 * Re-encode anything (already posted or being uploaded), auto-fit to the channel's upload
 * limit, clip / edit, split, join, make emoji / stickers / soundboard sounds / screenshots /
 * avatars, download links, play in mpv / VLC, draw in Paint.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, React, showToast } from "@webpack/common";

import { addFromUrl, api, currentChannel, errText, hasNative, limitFor, MediaItem, mediaOfMessage, RemoteMedia, runJob, uploadToChannel } from "./client";
import { humanBytes, Target } from "./planner";
import { openInPaint, openOversize, openStudio, shrinkFiles, STUDIO_CSS, useTools } from "./ui";

const Author = { name: "sernik", id: 0n };

export const settings = definePluginSettings({
    oversize: {
        type: OptionType.SELECT,
        description: "When a file is too big for the channel",
        options: [
            { label: "Ask (shrink / open in MediaForge / upload anyway)", value: "ask", default: true },
            { label: "Shrink automatically, then upload", value: "auto" },
            { label: "Do nothing (Discord's own error)", value: "off" }
        ]
    },
    splitIfNeeded: {
        type: OptionType.BOOLEAN,
        description: "If a video can't fit even after re-encoding, split it into parts that fit",
        default: true
    },
    uploadLimitMB: {
        type: OptionType.NUMBER,
        description: "Upload limit in MB (0 = detect from your Nitro and the server's boosts)",
        default: 0
    },
    defaultPlayer: {
        type: OptionType.SELECT,
        description: "Player for 'Play' in menus",
        options: [{ label: "mpv", value: "mpv", default: true }, { label: "VLC", value: "vlc" }]
    },
    chatButton: {
        type: OptionType.BOOLEAN,
        description: "Show the MediaForge button in the chat bar",
        default: true
    },
    ffmpegPath: { type: OptionType.STRING, description: "Custom ffmpeg path (empty = auto)", default: "", onChange: pushPaths },
    ffprobePath: { type: OptionType.STRING, description: "Custom ffprobe path (empty = auto)", default: "", onChange: pushPaths },
    soxPath: { type: OptionType.STRING, description: "Custom sox path (empty = auto)", default: "", onChange: pushPaths },
    ytdlpPath: { type: OptionType.STRING, description: "Custom yt-dlp path (empty = auto)", default: "", onChange: pushPaths },
    mpvPath: { type: OptionType.STRING, description: "Custom mpv path (empty = auto)", default: "", onChange: pushPaths },
    vlcPath: { type: OptionType.STRING, description: "Custom vlc path (empty = auto)", default: "", onChange: pushPaths },
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    }
});

function pushPaths() {
    if (!hasNative()) return;
    const s = settings.store;
    api().configure({ "ffmpeg": s.ffmpegPath, "ffprobe": s.ffprobePath, "sox": s.soxPath, "yt-dlp": s.ytdlpPath, "mpv": s.mpvPath, "vlc": s.vlcPath }).catch(() => { });
}

/** Tool status block, reused in Szmelc HQ. */
export function ToolSummary() {
    const { tools, refresh } = useTools();
    if (!hasNative()) return <Paragraph>Native side not loaded — fully restart Discord (not just Ctrl+R).</Paragraph>;
    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {tools.map(t => (
                <span key={t.name} title={t.path ?? t.hint} style={{
                    padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600,
                    background: t.path ? "#105c5c" : "#750f0f", color: "#fff"
                }}>{t.name}{t.path ? "" : " ✗"}</span>
            ))}
            <Button size="min" variant="secondary" onClick={refresh}>Re-detect</Button>
        </div>
    );
}

function SettingsPanel() {
    return (
        <div style={{ display: "grid", gap: 10 }}>
            <ToolSummary />
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={() => openStudio({ channelId: currentChannel()?.id })}>Open MediaForge</Button>
                <Button variant="secondary" onClick={() => openStudio({ tab: "tools" })}>Tools & installs</Button>
            </div>
        </div>
    );
}

/* ---------------- upload interception ---------------- */

function chatChannelId() {
    const ch = currentChannel();
    // user settings or another full-screen layer open → not a chat upload
    if (!ch || document.querySelector('[class*="standardSidebarView"]')) return null;
    return ch.id;
}

function intercept(files: File[], e: Event) {
    const mode = settings.store.oversize;
    if (mode === "off" || !files.length || !hasNative()) return;
    const channelId = chatChannelId();
    if (!channelId) return;
    const limit = limitFor(channelId, settings.store.uploadLimitMB);
    if (!files.some(f => f.size > limit)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (mode === "auto") {
        const signal = { cancelled: false };
        showToast({ text: `MediaForge: shrinking ${files.length} file(s) to fit ${humanBytes(limit)}…`, variant: "default" });
        shrinkFiles(files, limit, settings.store.splitIfNeeded, () => { }, signal)
            .then(outs => uploadToChannel(outs, channelId))
            .then(left => left && showToast({ text: `${left} part(s) left over — open MediaForge to send them`, variant: "critical" }))
            .catch(err => showToast({ text: `MediaForge: ${errText(err)}`, variant: "critical" }));
    } else {
        openOversize(files, channelId, limit, settings.store.splitIfNeeded);
    }
}

function insideOurUi(t: EventTarget | null) {
    return t instanceof Element && !!t.closest(".vc-mf");
}

const onDrop = (e: DragEvent) => {
    if (insideOurUi(e.target)) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) intercept(files, e);
};

const onPaste = (e: ClipboardEvent) => {
    if (insideOurUi(e.target)) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    const t = e.target as Element | null;
    if (!t?.closest?.('[class*="channelTextArea"], [role="textbox"]')) return;
    intercept(files, e);
};

const onChange = (e: Event) => {
    const t = e.target;
    // the chat's attach input is the only multi-file input; avatar / banner pickers are single
    if (!(t instanceof HTMLInputElement) || t.type !== "file" || !t.multiple || insideOurUi(t)) return;
    const files = [...(t.files ?? [])];
    if (!files.length) return;
    const before = files.length;
    intercept(files, e);
    if (e.defaultPrevented && before) t.value = "";
};

/* ---------------- context menus ---------------- */

async function withRemote(m: RemoteMedia, fn: (item: MediaItem) => Promise<unknown>) {
    try {
        showToast({ text: `Fetching ${m.name}…`, variant: "default" });
        const item = await addFromUrl(m.url, m.name);
        await fn(item);
    } catch (e) {
        showToast({ text: errText(e), variant: "critical" });
    }
}

async function quick(m: RemoteMedia, target: Target, channelId: string, label: string) {
    await withRemote(m, async ({ file: { path } }) => {
        const limit = limitFor(channelId, settings.store.uploadLimitMB);
        showToast({ text: `${label}…`, variant: "default" });
        let s = await runJob({ op: "convert", input: path, target, maxBytes: Math.floor(limit * 0.98) });
        if (s.status === "error" && settings.store.splitIfNeeded && /split/i.test(s.hint ?? "")) {
            s = await runJob({ op: "split", input: path, mode: "size", value: Math.floor(limit * 0.98), maxBytes: Math.floor(limit * 0.98) });
        }
        if (s.status !== "done") throw new Error(`${s.error ?? s.status}${s.hint ? ` — ${s.hint}` : ""}`);
        await uploadToChannel(s.outputs, channelId);
    });
}

function mediaItems(m: RemoteMedia, channelId: string, idx: number) {
    const player = settings.store.defaultPlayer as "mpv" | "vlc";
    const id = `vc-mf-${idx}`;
    if (m.kind === "link") {
        return [
            <Menu.MenuItem key={id + "dl"} id={id + "-dl"} label="Download (yt-dlp) & upload here" action={async () => {
                try {
                    const limit = limitFor(channelId, settings.store.uploadLimitMB);
                    showToast({ text: "Downloading with yt-dlp…", variant: "default" });
                    const s = await runJob({ op: "download", url: m.url, mode: "discord", maxBytes: Math.floor(limit * 0.98) });
                    if (s.status !== "done") throw new Error(s.error ?? s.status);
                    await uploadToChannel(s.outputs, channelId);
                } catch (e) { showToast({ text: errText(e), variant: "critical" }); }
            }} />,
            <Menu.MenuItem key={id + "dls"} id={id + "-dls"} label="Download in MediaForge…" action={() => openStudio({ channelId, tab: "download", url: m.url })} />,
            <Menu.MenuItem key={id + "pl"} id={id + "-pl"} label={`Stream in ${player}`} action={() => api().play(player, m.url, {}).catch(e => showToast({ text: errText(e), variant: "critical" }))} />
        ];
    }
    const items = [
        <Menu.MenuItem key={id + "o"} id={id + "-open"} label="Open in MediaForge" action={() => withRemote(m, async it => openStudio({ channelId, focus: it.id }))} />,
        <Menu.MenuItem key={id + "s"} id={id + "-shrink"} label="Re-encode to fit & upload here" action={() => quick(m, "auto", channelId, "Re-encoding")} />
    ];
    if (m.kind === "video" || m.kind === "image") {
        items.push(<Menu.MenuItem key={id + "g"} id={id + "-gif"} label="Make GIF & upload" action={() => quick(m, "gif", channelId, "Making a GIF")} />);
        items.push(
            <Menu.MenuItem key={id + "a"} id={id + "-assets"} label="Make…">
                <Menu.MenuItem id={id + "-emoji"} label="Emoji" action={() => withRemote(m, async it => openStudio({ channelId, target: "emoji", focus: it.id }))} />
                <Menu.MenuItem id={id + "-sticker"} label="Sticker" action={() => withRemote(m, async it => openStudio({ channelId, target: "sticker", focus: it.id }))} />
                <Menu.MenuItem id={id + "-avatar"} label="Avatar" action={() => withRemote(m, async it => openStudio({ channelId, target: "avatar", focus: it.id }))} />
                {m.kind === "video" && <Menu.MenuItem id={id + "-shot"} label="Screenshot" action={() => withRemote(m, async it => openStudio({ channelId, target: "screenshot", focus: it.id }))} />}
                {m.kind === "video" && <Menu.MenuItem id={id + "-sound"} label="Soundboard sound" action={() => withRemote(m, async it => openStudio({ channelId, target: "soundboard", focus: it.id }))} />}
            </Menu.MenuItem>
        );
    }
    if (m.kind === "audio") items.push(<Menu.MenuItem key={id + "sb"} id={id + "-sound"} label="Make soundboard sound…" action={() => withRemote(m, async it => openStudio({ channelId, target: "soundboard", focus: it.id }))} />);
    if (m.kind === "image") items.push(<Menu.MenuItem key={id + "p"} id={id + "-paint"} label="Edit in Paint" action={() => withRemote(m, async it => openInPaint(it.file))} />);
    if (m.kind !== "image") {
        items.push(<Menu.MenuItem key={id + "m"} id={id + "-mpv"} label="Play in mpv" action={() => api().play("mpv", m.url, {}).catch(e => showToast({ text: errText(e), variant: "critical" }))} />);
        items.push(<Menu.MenuItem key={id + "v"} id={id + "-vlc"} label="Play in VLC" action={() => api().play("vlc", m.url, {}).catch(e => showToast({ text: errText(e), variant: "critical" }))} />);
    }
    return items;
}

const messageMenu: NavContextMenuPatchCallback = (children, props) => {
    const msg = props?.message;
    const channelId = msg?.channel_id;
    if (!msg || !channelId || !hasNative()) return;
    const media = mediaOfMessage(msg).slice(0, 8);
    if (!media.length) return;
    children.push(
        <Menu.MenuItem id="vc-mf" label="MediaForge">
            {media.length === 1
                ? mediaItems(media[0], channelId, 0)
                : media.map((m, i) => (
                    <Menu.MenuItem key={i} id={`vc-mf-file-${i}`} label={`${m.kind === "link" ? "🔗" : m.kind === "video" ? "🎞" : m.kind === "audio" ? "🎵" : "🖼"} ${m.name.slice(0, 40)}`}>
                        {mediaItems(m, channelId, i)}
                    </Menu.MenuItem>
                ))}
            {media.filter(m => m.kind !== "link").length > 1 && (
                <Menu.MenuItem id="vc-mf-all" label="Open all in MediaForge" action={async () => {
                    for (const m of media.filter(x => x.kind !== "link")) await addFromUrl(m.url, m.name).catch(() => { });
                    openStudio({ channelId });
                }} />
            )}
        </Menu.MenuItem>
    );
};

const imageMenu: NavContextMenuPatchCallback = (children, props) => {
    const src: string | undefined = props?.src ?? props?.itemSrc ?? props?.itemHref;
    if (!src || !/^https?:/.test(src) || !hasNative()) return;
    const channelId = currentChannel()?.id ?? "";
    const name = src.split("?")[0].split("/").pop() || "image";
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-mf-img" label="MediaForge">
                {mediaItems({ url: src, name, kind: /\.(mp4|webm|mov)(\?|$)/i.test(src) ? "video" : "image" }, channelId, 99)}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

/* ---------------- chat bar ---------------- */

const ForgeIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M4 4h10l2 2h4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm6 5v6l5-3-5-3Z" />
    </svg>
);

const ForgeButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    if (!isMainChat || !settings.store.chatButton) return null;
    return (
        <ChatBarButton tooltip="MediaForge" onClick={() => openStudio({ channelId: channel?.id })}>
            <ForgeIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "MediaForge",
    description: "Media command centre: re-encode anything to fit Discord (uploads too), clip / edit, split, join, make emoji / stickers / sounds / screenshots, yt-dlp downloads, mpv / VLC control, Win95 Paint. Uses system or portable ffmpeg, sox, yt-dlp.",
    authors: [Author],
    tags: ["Media", "Utility", "Chat"],
    settings,
    managedStyle: STUDIO_CSS,

    contextMenus: {
        "message": messageMenu,
        "image-context": imageMenu
    },

    chatBarButton: {
        icon: ForgeIcon,
        render: ForgeButton
    },

    commands: [{
        name: "forge",
        description: "Open MediaForge (optionally download a link with yt-dlp)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [{ name: "url", description: "Link to download", type: ApplicationCommandOptionType.STRING, required: false }],
        execute(args, ctx) {
            const url = findOption<string>(args, "url", "");
            openStudio({ channelId: ctx.channel.id, tab: url ? "download" : undefined, url: url || undefined });
        }
    }],

    toolboxActions: {
        "Open MediaForge"() { openStudio({ channelId: currentChannel()?.id }); },
        "Open Paint"() { openInPaint(); }
    },

    start() {
        pushPaths();
        window.addEventListener("drop", onDrop, true);
        window.addEventListener("paste", onPaste, true);
        window.addEventListener("change", onChange, true);
    },

    stop() {
        window.removeEventListener("drop", onDrop, true);
        window.removeEventListener("paste", onPaste, true);
        window.removeEventListener("change", onChange, true);
    }
});
