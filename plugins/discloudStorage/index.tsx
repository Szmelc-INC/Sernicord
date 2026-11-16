/*
 * Sernicord Discloud Storage — turn a Discord server into your private cloud
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Files are chunked, uploaded as attachments to a storage channel, and indexed
 * as plain JSON in an index channel — so your bots can read/serve them too,
 * with nothing but the normal Discord API.
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import {
    Constants, GuildStore, Menu, React, RestAPI,
    SnowflakeUtils, showToast, useState
} from "@webpack/common";

const Author = { name: "sernik", id: 0n };
const MANIFEST_PREFIX = "DISCLOUD1:";
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

type Part = { channel: string; message: string; file: string; url: string; size: number; };

type StoredFile = {
    v: 1;
    name: string;
    size: number;
    sha256: string;
    parts: Part[];
    storedAt: number;
    messageId: string;
    indexChannel: string;
};

function u8toHex(buf: ArrayBuffer): string {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(buf: ArrayBuffer): Promise<string> {
    return u8toHex(await crypto.subtle.digest("SHA-256", buf));
}

async function uploadFileToChannel(channelId: string, file: File, content: string): Promise<{ id: string; url: string; }> {
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
            }).then(res => {
                const att = res.body?.attachments?.[0];
                resolve({ id: res.body.id, url: att?.url ?? "" });
            }).catch(reject);
        });
        upload.on("error", err => reject(err ?? new Error("upload error")));
        upload.upload();
    });
}

async function fetchManifests(channelId: string, pages = 5): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    let before: string | undefined;
    for (let p = 0; p < pages; p++) {
        const { body } = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100, ...(before ? { before } : {}) }
        });
        if (!Array.isArray(body) || body.length === 0) break;
        for (const m of body) {
            const idx = (m.content || "").indexOf(MANIFEST_PREFIX);
            if (idx < 0) continue;
            try {
                const raw = m.content.slice(idx + MANIFEST_PREFIX.length);
                const start = raw.indexOf("{");
                const end = raw.lastIndexOf("}");
                if (start >= 0 && end > start) {
                    const man = JSON.parse(raw.slice(start, end + 1)) as StoredFile;
                    if (man?.v === 1 && Array.isArray(man.parts)) {
                        man.messageId = m.id;
                        out.push(man);
                    }
                }
            } catch { /* skip malformed */ }
            before = m.id;
        }
        if (body.length < 100) break;
    }
    return out;
}

async function deleteMessage(channelId: string, messageId: string) {
    await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
}

async function provision(guildId: string): Promise<{ index: string; storage: string; }> {
    const category = await RestAPI.post({
        url: `/guilds/${guildId}/channels`,
        body: { name: settings.store.categoryName || "Discloud", type: 4 }
    });
    const mk = (name: string) => RestAPI.post({
        url: `/guilds/${guildId}/channels`,
        body: { name, type: 0, parent_id: category.body.id }
    });
    const index = await mk("discloud-index");
    const storage = await mk("discloud-storage");
    return { index: index.body.id, storage: storage.body.id };
}

async function resolveChannels(): Promise<{ index: string; storage: string; } | null> {
    const gid = settings.store.guildId?.trim();
    if (!gid) {
        showToast({ text: "Discloud: set a server ID first", variant: "critical" });
        return null;
    }
    const guild = GuildStore.getGuild(gid);
    if (!guild) {
        showToast({ text: "Discloud: unknown server ID (are you in it?)", variant: "critical" });
        return null;
    }
    let index = settings.store.indexChannelId?.trim();
    let storage = settings.store.storageChannelId?.trim();
    if (!index || !storage) {
        if (!settings.store.autoProvision) {
            showToast({ text: "Discloud: index/storage channels not set", variant: "critical" });
            return null;
        }
        showToast({ text: "Discloud: provisioning channels…", variant: "default" });
        try {
            ({ index, storage } = await provision(gid));
        } catch (e) {
            showToast({ text: `Discloud: provisioning failed (${e}) — need Manage Channels`, variant: "critical" });
            return null;
        }
        settings.store.indexChannelId = index;
        settings.store.storageChannelId = storage;
        showToast({ text: `Discloud: ready in ${guild.name}`, variant: "success" });
    }
    return { index, storage };
}

async function storeFile(file: File) {
    const chans = await resolveChannels();
    if (!chans) return;
    const partBytes = Math.max(50_000, Math.min((settings.store.chunkMb || 7.5) * 1_000_000, 8_000_000));
    const buf = await file.arrayBuffer();
    const hash = await sha256(buf);
    const bytes = new Uint8Array(buf);
    const parts = Math.ceil(bytes.length / partBytes) || 1;

    showToast({ text: `Discloud: storing ${file.name} (${parts} part${parts > 1 ? "s" : ""})…`, variant: "default" });
    const manifest: StoredFile = {
        v: 1, name: file.name, size: file.size, sha256: hash,
        parts: [], storedAt: Date.now(), messageId: "", indexChannel: chans.index
    };
    for (let i = 0; i < parts; i++) {
        const slice = bytes.subarray(i * partBytes, Math.min(bytes.length, (i + 1) * partBytes));
        const partFile = new File(
            [slice],
            `${file.name}.dcp${String(i + 1).padStart(3, "0")}`,
            { type: "application/octet-stream" }
        );
        const { id, url } = await uploadFileToChannel(
            chans.storage,
            partFile,
            `DISCLOUD_PART ${i + 1}/${parts} ${file.name}`
        );
        manifest.parts.push({ channel: chans.storage, message: id, file: partFile.name, url, size: slice.length });
        if (parts > 1) showToast({ text: `Discloud: part ${i + 1}/${parts} up`, variant: "default" });
    }
    await sendMessage(chans.index, { content: `${MANIFEST_PREFIX}${JSON.stringify(manifest)}` });
    showToast({ text: `Discloud: stored ${file.name}`, variant: "success" });
}

async function downloadFile(man: StoredFile) {
    showToast({ text: `Discloud: fetching ${man.name}…`, variant: "default" });
    const chunks: Uint8Array[] = [];
    for (const p of man.parts) {
        let url = p.url;
        if (!url) {
            const { body } = await RestAPI.get({ url: `/channels/${p.channel}/messages/${p.message}` });
            url = body?.attachments?.[0]?.url;
        }
        if (!url) throw new Error(`part ${p.file} has no attachment URL`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`part ${p.file}: HTTP ${res.status}`);
        chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    const out = new Uint8Array(man.size);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    const hash = await sha256(out.buffer);
    if (hash !== man.sha256) {
        showToast({ text: "Discloud: checksum mismatch — file corrupted?", variant: "critical" });
        return;
    }
    if (IS_DISCORD_DESKTOP) {
        DiscordNative.fileManager.saveWithDialog(out, man.name);
    } else {
        saveFile(new File([out], man.name, { type: "application/octet-stream" }));
    }
    showToast({ text: `Discloud: downloaded ${man.name}`, variant: "success" });
}

async function deleteFile(man: StoredFile) {
    for (const p of man.parts) {
        try { await deleteMessage(p.channel, p.message); } catch { /* already gone */ }
    }
    try { await deleteMessage(man.indexChannel || settings.store.indexChannelId || "", man.messageId); } catch { /* */ }
    showToast({ text: `Discloud: deleted ${man.name}`, variant: "default" });
}

function fmtBytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
    return `${n} B`;
}

function StoragePanel() {
    const [busy, setBusy] = useState(false);
    const [files, setFiles] = useState<StoredFile[]>([]);

    const refresh = async () => {
        const chans = await resolveChannels();
        if (!chans) return;
        setBusy(true);
        try {
            setFiles(await fetchManifests(chans.index));
        } catch (e) {
            showToast({ text: `Discloud: listing failed (${e})`, variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const upload = async () => {
        const file = await chooseFile("*/*");
        if (!file) return;
        setBusy(true);
        try {
            await storeFile(file);
            await refresh();
        } catch (e) {
            showToast({ text: `Discloud: ${e}`, variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const guild = settings.store.guildId ? GuildStore.getGuild(settings.store.guildId) : null;
    const used = files.reduce((n, f) => n + f.size, 0);

    return (
        <div>
            <Paragraph style={{ marginBottom: 8, opacity: 0.75 }}>
                One server = your private cloud. Files are chunked into a storage channel and
                indexed as JSON in an index channel — you, your bots, anything with the Discord
                API can list and fetch them. Perfect for backups and bot assets.
            </Paragraph>
            <Paragraph style={{ fontSize: 12 }}>
                server: {guild ? guild.name : (settings.store.guildId || "not set")}
                {files.length > 0 && <> · {files.length} file(s) · {fmtBytes(used)} stored</>}
            </Paragraph>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0 16px" }}>
                <Button disabled={busy} onClick={upload}>Upload file…</Button>
                <Button variant="secondary" disabled={busy} onClick={refresh}>
                    {files.length ? "Refresh" : "Open storage"}
                </Button>
            </div>
            {files.length === 0
                ? <Paragraph>No indexed files yet (or nothing loaded — hit Refresh).</Paragraph>
                : files.map(f => (
                    <div
                        key={f.messageId}
                        style={{
                            padding: 10, marginBottom: 8, borderRadius: 8,
                            background: "var(--background-secondary)"
                        }}
                    >
                        <Heading tag="h5" style={{ margin: 0, wordBreak: "break-all" }}>{f.name}</Heading>
                        <Paragraph style={{ fontSize: 12, opacity: 0.7, margin: "2px 0 8px" }}>
                            {fmtBytes(f.size)} · {f.parts.length} part(s) · {new Date(f.storedAt).toLocaleString()}
                        </Paragraph>
                        <div style={{ display: "flex", gap: 6 }}>
                            <Button size="small" disabled={busy} onClick={() => downloadFile(f)}>Download</Button>
                            <Button
                                size="small" variant="dangerSecondary" disabled={busy}
                                onClick={() => { setBusy(true); deleteFile(f).then(refresh).finally(() => setBusy(false)); }}
                            >
                                Delete
                            </Button>
                        </div>
                    </div>
                ))}
            {files.length > 0 && (
                <Paragraph style={{ fontSize: 11, opacity: 0.6 }}>
                    Bots: read the latest <code>{MANIFEST_PREFIX}</code> messages from the index channel —
                    each one lists part attachment URLs, in order, with a SHA-256 of the assembled file.
                </Paragraph>
            )}
        </div>
    );
}

export const settings = definePluginSettings({
    manager: {
        type: OptionType.COMPONENT,
        component: () => <StoragePanel />
    },
    guildId: {
        type: OptionType.STRING,
        description: "Server ID used as your cloud (right-click a server → Copy Server ID)"
    },
    categoryName: {
        type: OptionType.STRING,
        description: "Category created when auto-provisioning",
        default: "Discloud"
    },
    autoProvision: {
        type: OptionType.BOOLEAN,
        description: "Create the Discloud category + index/storage channels when missing",
        default: true
    },
    indexChannelId: {
        type: OptionType.STRING,
        description: "Index channel ID (auto-filled when provisioning)"
    },
    storageChannelId: {
        type: OptionType.STRING,
        description: "Storage channel ID (auto-filled when provisioning)"
    },
    chunkMb: {
        type: OptionType.NUMBER,
        description: "Chunk size in MB per part (default 7.5, max 8)",
        default: 7.5
    }
});

const guildMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const guildId = props?.guild?.id;
    if (!guildId) return;
    children.push(
        <Menu.MenuItem
            id="sc-discloud-use-guild"
            label="Use server as Discloud storage"
            action={() => {
                settings.store.guildId = guildId;
                settings.store.indexChannelId = "";
                settings.store.storageChannelId = "";
                showToast({ text: `Discloud: server set — opening settings`, variant: "default" });
            }}
        />
    );
};

const channelMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel?.id || channel.guild_id == null) return;
    children.push(
        <Menu.MenuItem
            id="sc-discloud-storage-channel"
            label="Set as Discloud storage channel"
            action={() => {
                settings.store.storageChannelId = channel.id;
                if (!settings.store.guildId) settings.store.guildId = channel.guild_id;
                showToast({ text: `Discloud: storage channel = #${channel.name}`, variant: "default" });
            }}
        />,
        <Menu.MenuItem
            id="sc-discloud-index-channel"
            label="Set as Discloud index channel"
            action={() => {
                settings.store.indexChannelId = channel.id;
                if (!settings.store.guildId) settings.store.guildId = channel.guild_id;
                showToast({ text: `Discloud: index channel = #${channel.name}`, variant: "default" });
            }}
        />
    );
};

export default definePlugin({
    name: "DiscloudStorage",
    description: "Turns a server into your private cloud storage: chunked file upload/download via a storage channel + JSON index channel, readable by you and your bots. Great for backups.",
    authors: [Author],
    tags: ["Utility", "Organisation", "Servers"],
    settings,
    contextMenus: {
        "guild-context": guildMenuPatch,
        "channel-context": channelMenuPatch
    },
    commands: [{
        name: "discloud",
        description: "Store a file in your Discloud server (picker)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_a, ctx) => {
            sendBotMessage(ctx.channel.id, { content: "Discloud: pick a file…" });
            const file = await chooseFile("*/*");
            if (file) await storeFile(file);
        }
    }]
});
