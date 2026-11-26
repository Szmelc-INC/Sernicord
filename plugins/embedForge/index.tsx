/*
 * Sernicord EmbedForge — craft weird/useful embeds & interactive-ish chat objects
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, SelectedChannelStore, showToast, TextArea, TextInput, useState } from "@webpack/common";

import { Sx, Toggle } from "../szmelc/kit";

const Author = { name: "sernik", id: 0n };

export const settings = definePluginSettings({
    about: {
        type: OptionType.COMPONENT,
        component: () => (
            <Paragraph>
                User accounts cannot post true rich embeds. EmbedForge sends via a webhook you control
                (real embeds + link buttons) or falls back to a crafted markdown / ANSI-ish card in chat.
                Use /embed or the toolbox builder.
            </Paragraph>
        )
    },
    defaultWebhook: {
        type: OptionType.STRING,
        description: "Default webhook URL (https://discord.com/api/webhooks/...)",
        default: "",
        placeholder: "https://discord.com/api/webhooks/..."
    },
    username: {
        type: OptionType.STRING,
        description: "Webhook display name override",
        default: "EmbedForge"
    },
    preferWebhook: {
        type: OptionType.BOOLEAN,
        description: "Prefer webhook when URL is set",
        default: true
    }
});

function parseColor(input: string): number {
    const s = input.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16);
    const n = Number(input);
    return Number.isFinite(n) ? n : 0x5865f2;
}

function markdownCard(opts: {
    title?: string;
    description?: string;
    url?: string;
    footer?: string;
    fields?: string;
    color?: string;
}): string {
    const lines: string[] = [];
    const bar = "─".repeat(24);
    lines.push("```ansi");
    lines.push(`[1;34m${bar}[0m`);
    if (opts.title) lines.push(`[1;37m${opts.title}[0m`);
    if (opts.description) lines.push(opts.description);
    if (opts.fields) {
        for (const line of opts.fields.split("\n").filter(Boolean)) {
            const [k, ...rest] = line.split("=");
            lines.push(`[1;36m${k.trim()}[0m: ${rest.join("=").trim()}`);
        }
    }
    if (opts.url) lines.push(`[4;34m${opts.url}[0m`);
    if (opts.footer) lines.push(`[2m${opts.footer}[0m`);
    lines.push(`[1;34m${bar}[0m`);
    lines.push("```");
    return lines.join("\n");
}

async function sendWebhookEmbed(webhook: string, body: any) {
    const url = webhook.includes("?") ? `${webhook}&wait=true` : `${webhook}?wait=true`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json().catch(() => null);
}

export async function forgeSend(opts: {
    channelId: string;
    title?: string;
    description?: string;
    url?: string;
    color?: string;
    footer?: string;
    fields?: string; // name=value per line
    buttonLabel?: string;
    buttonUrl?: string;
    webhook?: string;
    asMarkdown?: boolean;
}) {
    const webhook = (opts.webhook || settings.store.defaultWebhook || "").trim();
    const useWebhook = settings.store.preferWebhook && !!webhook && !opts.asMarkdown;

    if (useWebhook) {
        const fields = (opts.fields || "")
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .map(line => {
                const [name, ...rest] = line.split("=");
                return { name: name.trim().slice(0, 256), value: rest.join("=").trim().slice(0, 1024) || "—", inline: true };
            });

        const embed: any = {
            title: opts.title || undefined,
            description: opts.description || undefined,
            url: opts.url || undefined,
            color: parseColor(opts.color || "#1f8a8a"),
            footer: opts.footer ? { text: opts.footer } : undefined,
            fields: fields.length ? fields : undefined
        };

        const body: any = {
            username: settings.store.username || "EmbedForge",
            embeds: [embed]
        };

        if (opts.buttonLabel && opts.buttonUrl) {
            body.components = [{
                type: 1,
                components: [{
                    type: 2,
                    style: 5,
                    label: opts.buttonLabel.slice(0, 80),
                    url: opts.buttonUrl
                }]
            }];
        }

        await sendWebhookEmbed(webhook, body);
        showToast({ text: "EmbedForge: webhook embed sent", variant: "success" });
        return;
    }

    const content = markdownCard(opts);
    await sendMessage(opts.channelId, { content });
    showToast({ text: "EmbedForge: markdown card sent", variant: "default" });
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode; }) {
    return (
        <label className="vc-sx-col tight">
            <span className="vc-sx-section" style={{ margin: 0 }}>{label}{hint && <span className="vc-sx-muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}> · {hint}</span>}</span>
            {children}
        </label>
    );
}

function BuilderModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [title, setTitle] = useState("Hello from EmbedForge");
    const [description, setDescription] = useState("Configurable weird useful object.");
    const [url, setUrl] = useState("");
    const [color, setColor] = useState("#1f8a8a");
    const [footer, setFooter] = useState("Sernicord");
    const [fields, setFields] = useState("mode=webhook|markdown\nstatus=online");
    const [buttonLabel, setButtonLabel] = useState("Open");
    const [buttonUrl, setButtonUrl] = useState("");
    const [webhook, setWebhook] = useState(settings.store.defaultWebhook);
    const [asMarkdown, setAsMarkdown] = useState(false);

    return (
        <Modal {...modalProps} size="md" title="EmbedForge builder" subtitle="Webhook embed with a link button, or a markdown card">
            <Sx pad>
                <Field label="Title"><TextInput value={title} onChange={setTitle} /></Field>
                <Field label="Description"><TextArea value={description} onChange={setDescription} rows={3} /></Field>
                <div className="vc-sx-grid" style={{ "--sx-min": "160px" } as React.CSSProperties}>
                    <Field label="URL"><TextInput value={url} onChange={setUrl} placeholder="https://..." /></Field>
                    <Field label="Color">
                        <div className="vc-sx-row nowrap">
                            <span aria-hidden style={{ width: 20, height: 20, borderRadius: 4, flex: "none", background: /^#?[0-9a-f]{6}$/i.test(color.trim()) ? `#${color.trim().replace("#", "")}` : "transparent", border: "1px solid var(--sx-line)" }} />
                            <div className="vc-sx-grow"><TextInput value={color} onChange={setColor} placeholder="#1f8a8a" /></div>
                        </div>
                    </Field>
                    <Field label="Footer"><TextInput value={footer} onChange={setFooter} /></Field>
                </div>
                <Field label="Fields" hint="one name=value per line"><TextArea value={fields} onChange={setFields} rows={3} /></Field>
                <div className="vc-sx-grid" style={{ "--sx-min": "180px" } as React.CSSProperties}>
                    <Field label="Button label" hint="webhook only"><TextInput value={buttonLabel} onChange={setButtonLabel} placeholder="Label" /></Field>
                    <Field label="Button URL"><TextInput value={buttonUrl} onChange={setButtonUrl} placeholder="https://..." /></Field>
                </div>
                <Field label="Webhook override" hint="empty = default from settings"><TextInput value={webhook} onChange={setWebhook} /></Field>
                <hr className="vc-sx-divider" />
                <div className="vc-sx-row">
                    <Toggle checked={asMarkdown} onChange={setAsMarkdown}>Send as markdown card (no webhook)</Toggle>
                    <span className="vc-sx-spacer" />
                    <Button onClick={async () => {
                        try {
                            await forgeSend({
                                channelId: SelectedChannelStore.getChannelId(),
                                title, description, url, color, footer, fields,
                                buttonLabel, buttonUrl, webhook, asMarkdown
                            });
                            modalProps.onClose();
                        } catch (e) {
                            showToast({ text: String(e), variant: "critical" });
                        }
                    }}>Send</Button>
                </div>
            </Sx>
        </Modal>
    );
}

export function openEmbedForge() {
    openModal(props => <BuilderModal modalProps={props} />);
}

export default definePlugin({
    name: "EmbedForge",
    description: "Build and send custom embeds / interactive link-button objects via webhook, or markdown cards without one.",
    authors: [Author],
    tags: ["Chat", "Fun", "Utility"],
    settings,
    toolboxActions: {
        "EmbedForge builder": openEmbedForge
    },
    commands: [
        {
            name: "embed",
            description: "Send a forged embed/card",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                { name: "title", description: "Title", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "description", description: "Description", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "color", description: "Hex color", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "url", description: "Embed URL", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "footer", description: "Footer", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "webhook", description: "Webhook URL override", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "markdown", description: "Force markdown card", type: ApplicationCommandOptionType.BOOLEAN, required: false },
                { name: "button_label", description: "Link button label", type: ApplicationCommandOptionType.STRING, required: false },
                { name: "button_url", description: "Link button URL", type: ApplicationCommandOptionType.STRING, required: false },
            ],
            async execute(args, ctx) {
                try {
                    await forgeSend({
                        channelId: ctx.channel.id,
                        title: findOption(args, "title", undefined),
                        description: findOption(args, "description", undefined),
                        color: findOption(args, "color", undefined),
                        url: findOption(args, "url", undefined),
                        footer: findOption(args, "footer", undefined),
                        webhook: findOption(args, "webhook", undefined),
                        asMarkdown: findOption(args, "markdown", false),
                        buttonLabel: findOption(args, "button_label", undefined),
                        buttonUrl: findOption(args, "button_url", undefined),
                    });
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `EmbedForge error: ${e}` });
                }
            }
        },
        {
            name: "embedforge",
            description: "Open EmbedForge builder",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_a, ctx) => {
                openEmbedForge();
                sendBotMessage(ctx.channel.id, { content: "EmbedForge builder opened." });
            }
        }
    ]
});
