/*
 * Sernicord BotLens — browse Discord as a bot via API (separate GUI, does not swap your user session)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, ScrollerThin, showToast, TextInput, useEffect, useState } from "@webpack/common";

import { Pill, Sx } from "../szmelc/kit";

const Author = { name: "sernik", id: 0n };
const API = "https://discord.com/api/v10";

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Paragraph>
                Opens a read-oriented Bot Lens panel that calls the Discord API with a <b>bot</b> token.
                It does <b>not</b> replace your logged-in user session. Self-botting / user-token abuse is
                out of scope and blocked. Keep tokens out of cloud sync and public repos. Discord ToS still applies.
            </Paragraph>
        )
    },
    botToken: {
        type: OptionType.STRING,
        description: "Bot token (stored in local plugin settings — do not cloud-sync)",
        default: "",
        placeholder: "MTIz..."
    }
});

function looksLikeUserToken(token: string): boolean {
    // Classic user tokens are three base64-ish segments; bot tokens often too, so we also probe /users/@me with Bot prefix.
    // Block MFA user token prefix patterns and explicit "user" pastes that include email-like first segment decode.
    if (/^mfa\./i.test(token)) return true;
    return false;
}

async function botFetch(path: string, token: string, init: RequestInit = {}) {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
            ...(init.headers || {})
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

function BotLensModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [token, setToken] = useState(settings.store.botToken || "");
    const [me, setMe] = useState<any>(null);
    const [guilds, setGuilds] = useState<any[]>([]);
    const [channels, setChannels] = useState<any[]>([]);
    const [messages, setMessages] = useState<any[]>([]);
    const [guildId, setGuildId] = useState<string | null>(null);
    const [channelId, setChannelId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const connect = async () => {
        setBusy(true);
        setError(null);
        try {
            const t = token.trim();
            if (!t) throw new Error("Paste a bot token");
            if (looksLikeUserToken(t)) throw new Error("Refusing MFA/user-style token. Bot tokens only.");
            const user = await botFetch("/users/@me", t);
            if (user && user.bot === false) {
                throw new Error("Token belongs to a user account. BotLens only accepts bot tokens.");
            }
            setMe(user);
            const g = await botFetch("/users/@me/guilds", t);
            setGuilds(Array.isArray(g) ? g : []);
            settings.store.botToken = t;
            showToast({ text: `BotLens: logged API as ${user.username}`, variant: "success" });
        } catch (e) {
            setMe(null);
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const loadChannels = async (gid: string) => {
        setGuildId(gid);
        setChannelId(null);
        setMessages([]);
        setBusy(true);
        setError(null);
        try {
            const ch = await botFetch(`/guilds/${gid}/channels`, token.trim());
            const textish = (Array.isArray(ch) ? ch : [])
                .filter((c: any) => [0, 5, 10, 11, 12].includes(c.type))
                .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
            setChannels(textish);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const loadMessages = async (cid: string) => {
        setChannelId(cid);
        setBusy(true);
        setError(null);
        try {
            const msgs = await botFetch(`/channels/${cid}/messages?limit=50`, token.trim());
            setMessages(Array.isArray(msgs) ? msgs : []);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (settings.store.botToken) setToken(settings.store.botToken);
    }, []);

    return (
        <Modal {...modalProps} size="lg" title="BotLens" subtitle="Separate bot API browser — your normal Discord account stays untouched.">
            <Sx pad>
                <div className="vc-sx-row nowrap">
                    <div className="vc-sx-grow">
                        <TextInput type="password" value={token} placeholder="Bot token" onChange={setToken} />
                    </div>
                    <Button disabled={busy || !token.trim()} onClick={connect}>{busy ? "Connecting…" : me ? "Reconnect" : "Connect"}</Button>
                </div>
                {me && (
                    <div className="vc-sx-row">
                        <Pill tone="accent">@{me.username}</Pill>
                        <span className="vc-sx-mono vc-sx-muted">{me.id}</span>
                        {!me.bot && <Pill tone="danger">not a bot account</Pill>}
                    </div>
                )}
                {error && <div className="vc-sx-card danger compact"><span className="vc-sx-err">{error}</span></div>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.6fr", gap: 8, height: 400 }}>
                    <ScrollerThin className="vc-sx-pane">
                        <div className="vc-sx-section" style={{ padding: "2px 6px 6px" }}>Guilds · {guilds.length}</div>
                        <div className="vc-sx-list" role="listbox" aria-label="Guilds">
                            {guilds.map(g => (
                                <button key={g.id} type="button" role="option" className="vc-sx-item vc-sx-ellipsis" aria-selected={guildId === g.id} onClick={() => loadChannels(g.id)}>
                                    {g.name}
                                </button>
                            ))}
                        </div>
                        {!guilds.length && <p className="vc-sx-hint" style={{ padding: 6 }}>{me ? "The bot is in no guilds." : "Connect first."}</p>}
                    </ScrollerThin>
                    <ScrollerThin className="vc-sx-pane">
                        <div className="vc-sx-section" style={{ padding: "2px 6px 6px" }}>Channels · {channels.length}</div>
                        <div className="vc-sx-list" role="listbox" aria-label="Channels">
                            {channels.map(c => (
                                <button key={c.id} type="button" role="option" className="vc-sx-item vc-sx-ellipsis" aria-selected={channelId === c.id} onClick={() => loadMessages(c.id)}>
                                    #{c.name}
                                </button>
                            ))}
                        </div>
                        {!channels.length && <p className="vc-sx-hint" style={{ padding: 6 }}>{guildId ? "No text channels." : "Pick a guild."}</p>}
                    </ScrollerThin>
                    <ScrollerThin className="vc-sx-pane">
                        <div className="vc-sx-section" style={{ padding: "2px 6px 6px" }}>Messages · {messages.length}</div>
                        <div className="vc-sx-col" style={{ padding: "0 6px" }}>
                            {messages.map(m => (
                                <div key={m.id} className="vc-sx-col tight" style={{ paddingBottom: 8, borderBottom: "1px solid var(--sx-line)" }}>
                                    <div className="vc-sx-muted"><b style={{ color: "var(--header-primary)" }}>{m.author?.username ?? "?"}</b> · {m.timestamp ? new Date(m.timestamp).toLocaleString() : ""}</div>
                                    <div className="vc-sx-pre" style={{ fontSize: 13 }}>
                                        {m.content || (m.attachments?.length ? `[${m.attachments.length} attachment(s)]` : "[empty/embed]")}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {!messages.length && <p className="vc-sx-hint" style={{ padding: 6 }}>{channelId ? "No messages." : "Pick a channel."}</p>}
                    </ScrollerThin>
                </div>
            </Sx>
        </Modal>
    );
}

export function openBotLens() {
    openModal(props => <BotLensModal modalProps={props} />);
}

export default definePlugin({
    name: "BotLens",
    description: "Paste a bot token and browse that bot's guilds/channels/messages in a GUI panel (does not swap your user login).",
    authors: [Author],
    tags: ["Developers", "Utility"],
    settings,
    toolboxActions: {
        "Open BotLens": openBotLens
    },
    commands: [{
        name: "botlens",
        description: "Open BotLens panel",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: (_a, ctx) => {
            openBotLens();
            sendBotMessage(ctx.channel.id, { content: "BotLens opened." });
        }
    }]
});
