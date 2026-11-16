/*
 * Sernicord AllMyGifs — bulk-manage your favorite GIFs
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Dump all favorites into a channel (URLs or as files, one under another) and
 * suck every GIF out of a channel straight into your favorites, in bulk.
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy, findStoreLazy } from "@webpack";
import {
    Constants, React, RestAPI, SnowflakeUtils, showToast,
    UserSettingsActionCreators, useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };

// discord_protos.discord_users.v1.FavoriteGIFs — synced to the account.
// format enum: 0 NONE, 1 IMAGE (.gif/.webp/.avif), 2 VIDEO (.mp4/.webm)
type FavGif = {
    url: string;
    src: string;
    gifSrc?: string;
    width?: number;
    height?: number;
    order?: number;
    format?: number;
    name?: string;
};

const UserSettingsProtoStore = findStoreLazy("UserSettingsProtoStore") as {
    frecencyWithoutFetchingLatest?: { favoriteGifs?: { gifs?: Record<string, FavGif>; }; };
};

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

function getFavorites(): Record<string, FavGif> {
    return UserSettingsProtoStore.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs ?? {};
}

function favoriteCount(): number {
    return Object.keys(getFavorites()).length;
}

function nextOrder(): number {
    const orders = Object.values(getFavorites()).map(g => g.order ?? 0);
    return (orders.length ? Math.max(...orders) : 0) + 1;
}

async function addFavorites(gifs: FavGif[]): Promise<number> {
    const existing = new Set(
        Object.values(getFavorites()).flatMap(g => [g.url, g.src].filter(Boolean))
    );
    const fresh = gifs.filter(g => g.url && !existing.has(g.url) && !existing.has(g.src));
    if (fresh.length === 0) return 0;

    let order = nextOrder();
    let added = 0;
    // updateAsync batches + syncs the FrecencyUserSettings proto to the account
    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
        "favoriteGifs",
        (s: { gifs: Record<string, FavGif>; }) => {
            for (const g of fresh) {
                s.gifs[g.url] = { ...g, order: order++ };
                added++;
            }
        },
        0 // INFREQUENT_USER_ACTION — same intent Discord's picker uses
    );
    return added;
}

async function removeFavorite(url: string) {
    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
        "favoriteGifs",
        (s: { gifs: Record<string, FavGif>; }) => {
            if (url in s.gifs) delete s.gifs[url];
            else {
                for (const key of Object.keys(s.gifs)) {
                    if (s.gifs[key].src === url) {
                        delete s.gifs[key];
                        break;
                    }
                }
            }
        },
        0
    );
}

async function uploadFileToChannel(channelId: string, file: File, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const upload = new CloudUpload({
            file,
            isThumbnail: false,
            platform: CloudUploadPlatform.WEB,
        }, channelId);

        upload.on("complete", () => {
            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content,
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{
                        id: "0",
                        filename: upload.filename,
                        uploaded_filename: upload.uploadedFilename,
                    }]
                }
            }).then(() => resolve()).catch(reject);
        });
        upload.on("error", err => reject(err ?? new Error("upload error")));
        upload.upload();
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Dump every favorite into a channel, one message per GIF */
async function dumpFavorites(channelId: string) {
    const favs = Object.values(getFavorites())
        .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    if (favs.length === 0) {
        showToast({ text: "AllMyGifs: no favorites to dump", variant: "critical" });
        return;
    }
    const asFiles = settings.store.dumpMode === "files";
    showToast({ text: `AllMyGifs: dumping ${favs.length} gif(s) as ${asFiles ? "files" : "URLs"}…`, variant: "default" });
    let sent = 0;
    for (const g of favs) {
        const url = g.src || g.url;
        try {
            if (asFiles) {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const name = url.split("/").pop()?.split("?")[0] || "gif";
                const ext = /\.(mp4|webm|gif|webp|apng|png)$/i.test(name) ? "" : ".gif";
                await uploadFileToChannel(channelId, new File([await res.blob()], name + ext), "");
            } else {
                await sendMessage(channelId, { content: url });
            }
            sent++;
            await sleep(450); // stay well under the send rate limit
        } catch (e) {
            console.error("[AllMyGifs] failed on", url, e);
        }
    }
    showToast({ text: `AllMyGifs: dumped ${sent}/${favs.length} into the channel`, variant: "success" });
}

const TENOR_RE = /https?:\/\/(?:media\.tenor\.[a-z.]+|c\.tenor\.[a-z.]+|tenor\.com)\/[^\s<>"']+/gi;
const GIF_URL_RE = /https?:\/\/[^\s<>"']+?\.(?:gif|mp4|webm)(?:\?[^\s<>"']*)?/gi;

/** Pull every GIF found in a channel into favorites, in bulk */
async function collectFromChannel(channelId: string, pages = 10) {
    const found = new Map<string, FavGif>();
    let before: string | undefined;
    let scanned = 0;
    for (let p = 0; p < pages; p++) {
        let body: any[];
        try {
            ({ body } = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query: { limit: 100, ...(before ? { before } : {}) }
            }));
        } catch (e) {
            showToast({ text: `AllMyGifs: cannot read channel (${e})`, variant: "critical" });
            return;
        }
        if (!Array.isArray(body) || body.length === 0) break;
        scanned += body.length;
        for (const m of body) {
            for (const att of m.attachments ?? []) {
                const isGif = att.content_type === "image/gif" || /\.gif$/i.test(att.filename || "");
                const isVid = /\.(mp4|webm)$/i.test(att.filename || "");
                if (!isGif && !isVid) continue;
                const format = isGif ? 1 : 2;
                found.set(att.url, {
                    url: att.url, src: att.url, format,
                    width: att.width, height: att.height,
                    name: att.filename
                });
            }
            const content: string = m.content || "";
            for (const re of [TENOR_RE, GIF_URL_RE]) {
                for (const m of content.matchAll(re)) {
                    found.set(m[0], { url: m[0], src: m[0], format: /\.(mp4|webm)/i.test(m[0]) ? 2 : 1 });
                }
            }
        }
        before = body[body.length - 1].id;
        if (body.length < 100) break;
    }
    if (found.size === 0) {
        showToast({ text: `AllMyGifs: no gifs found (${scanned} messages scanned)`, variant: "critical" });
        return;
    }
    const added = await addFavorites([...found.values()]);
    showToast({
        text: added > 0
            ? `AllMyGifs: +${added} favorites (${found.size} found, ${found.size - added} already saved)`
            : `AllMyGifs: all ${found.size} found gif(s) were already favorites`,
        variant: added > 0 ? "success" : "default"
    });
}

function GifManagerPanel() {
    const [, forceRerender] = useState(0);
    const [busy, setBusy] = useState(false);
    const [dumpCh, setDumpCh] = useState(settings.store.dumpChannelId || "");
    const [collectCh, setCollectCh] = useState("");
    const favs = Object.entries(getFavorites())
        .sort(([, a], [, b]) => (b.order ?? 0) - (a.order ?? 0));

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        try {
            await fn();
            forceRerender(n => n + 1);
        } catch (e) {
            showToast({ text: `AllMyGifs: ${e}`, variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <Paragraph style={{ marginBottom: 8, opacity: 0.75 }}>
                {favs.length} favorite gif(s). Dump them all into a channel (URLs or files,
                one under another) or suck every gif out of a channel into your favorites.
            </Paragraph>

            <div style={{
                display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                padding: 10, borderRadius: 8, background: "var(--background-secondary)",
                marginBottom: 8
            }}>
                <input
                    className="vc-textinput"
                    placeholder="Dump channel ID"
                    value={dumpCh}
                    style={{
                        flex: 1, minWidth: 160, padding: "8px",
                        borderRadius: 4, border: "1px solid var(--background-modifier-accent)",
                        background: "var(--input-background)", color: "var(--text-normal)"
                    }}
                    onChange={e => {
                        setDumpCh(e.currentTarget.value);
                        settings.store.dumpChannelId = e.currentTarget.value;
                    }}
                />
                <Button
                    disabled={busy || !dumpCh}
                    onClick={() => run(() => dumpFavorites(dumpCh.trim()))}
                >
                    Dump all favorites
                </Button>
            </div>

            <div style={{
                display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                padding: 10, borderRadius: 8, background: "var(--background-secondary)",
                marginBottom: 16
            }}>
                <input
                    className="vc-textinput"
                    placeholder="Channel ID full of gifs to favorite"
                    value={collectCh}
                    style={{
                        flex: 1, minWidth: 160, padding: "8px",
                        borderRadius: 4, border: "1px solid var(--background-modifier-accent)",
                        background: "var(--input-background)", color: "var(--text-normal)"
                    }}
                    onChange={e => setCollectCh(e.currentTarget.value)}
                />
                <Button
                    variant="positive" disabled={busy || !collectCh}
                    onClick={() => run(() => collectFromChannel(collectCh.trim()))}
                >
                    Suck into favorites
                </Button>
            </div>

            {favs.length === 0 && <Paragraph>No favorites yet — star some gifs in the picker first.</Paragraph>}
            {favs.map(([key, g]) => (
                <div
                    key={key}
                    style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: 8, marginBottom: 6, borderRadius: 8,
                        background: "var(--background-secondary)"
                    }}
                >
                    <img
                        src={g.src || g.url}
                        alt={g.name || "gif"}
                        style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, background: "#0b0b0b" }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <Paragraph style={{ margin: 0, fontSize: 13, wordBreak: "break-all" }}>
                            {g.name || key.slice(0, 80)}
                        </Paragraph>
                        <Paragraph style={{ margin: 0, fontSize: 11, opacity: 0.6 }}>
                            {g.width && g.height ? `${g.width}×${g.height} · ` : ""}order #{g.order ?? "?"}
                        </Paragraph>
                    </div>
                    <Button
                        size="small" variant="dangerSecondary" disabled={busy}
                        onClick={() => run(async () => {
                            await removeFavorite(g.url || key);
                        })}
                    >
                        Remove
                    </Button>
                </div>
            ))}
        </div>
    );
}

export const settings = definePluginSettings({
    manager: {
        type: OptionType.COMPONENT,
        component: () => <GifManagerPanel />
    },
    dumpChannelId: {
        type: OptionType.STRING,
        description: "Default channel ID for /allmygifs dump"
    },
    dumpMode: {
        type: OptionType.SELECT,
        description: "Dump format",
        options: [
            { label: "URLs (one message per gif)", value: "urls", default: true },
            { label: "Files (uploaded attachments)", value: "files" }
        ]
    }
});

export default definePlugin({
    name: "AllMyGifs",
    description: "Bulk-manage favorite gifs: dump all of them into a channel (URLs or files, one under another) and suck every gif from a channel straight into your favorites.",
    authors: [Author],
    tags: ["Emotes", "Utility"],
    settings,
    commands: [
        {
            name: "gifdump",
            description: "AllMyGifs: dump every favorite gif into a channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [{
                name: "channel",
                description: "Channel ID to dump into (defaults to the plugin setting)",
                type: ApplicationCommandOptionType.STRING,
                required: false
            }],
            execute: async (args, ctx) => {
                const ch = findOption<string>(args, "channel", settings.store.dumpChannelId || ctx.channel.id);
                sendBotMessage(ctx.channel.id, { content: `AllMyGifs: dumping favorites into <#${ch}>…` });
                await dumpFavorites(ch);
            }
        },
        {
            name: "gifcollect",
            description: "AllMyGifs: favorite every gif found in a channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [{
                name: "channel",
                description: "Channel ID to suck gifs from",
                type: ApplicationCommandOptionType.STRING,
                required: true
            }],
            execute: async (args, ctx) => {
                const ch = findOption<string>(args, "channel", "");
                if (!ch) {
                    sendBotMessage(ctx.channel.id, { content: "AllMyGifs: pass a channel ID" });
                    return;
                }
                sendBotMessage(ctx.channel.id, { content: `AllMyGifs: scanning <#${ch}>…` });
                await collectFromChannel(ch);
            }
        },
        {
            name: "gifcount",
            description: "AllMyGifs: how many favorite gifs you have",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_args, ctx) => {
                sendBotMessage(ctx.channel.id, {
                    content: `AllMyGifs: you have ${favoriteCount()} favorite gif(s)`
                });
            }
        }
    ]
});
