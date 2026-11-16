/*
 * Sernicord Szmelc — OG Szmelc Mode + the "szmelc" tab in Vencord settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings, useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { PaintbrushIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { PluginCard } from "@components/settings/tabs/plugins/PluginCard";
import SettingsPlugin from "@plugins/_core/settings";
import { removeFromArray } from "@utils/misc";
import { promptToRestart } from "@utils/promptToRestart";
import definePlugin, { IconProps, OptionType } from "@utils/types";
import { React, showToast, useEffect, useState } from "@webpack/common";
import { Switch } from "@components/Switch";
import Plugins, { PluginMeta } from "~plugins";

const Author = { name: "sernik", id: 0n };

// Szmelc brand palette (see Sernicord CLI): dirty cyan accent, dark neutral
// greys, silver secondary, aquamarine highlights. Dark backgrounds carry the
// accent as fills with white text.
const OG_CSS = `
.vc-szmelc-og {
    --brand-500: #1f8a8a;
    --brand-560: #105c5c;
    --brand-600: #0d4a4a;
    --brand-700: #0a3b3b;
    --brand-200: #9ed4d4;
    --brand-300: #6fc4c4;
    --brand-400: #3fa9a9;
    --brand-experiment-500: #1f8a8a;
    --brand-experiment-560: #105c5c;
    --brand-experiment-600: #0d4a4a;
    --brand-experiment-200: #9ed4d4;
    --brand-experiment-300: #6fc4c4;
    --brand-experiment-400: #3fa9a9;
    --text-brand: #1f8a8a;
    --text-link: #1f8a8a;
    --text-link-low-saturation: #1f8a8a;
    --control-brand-foreground: #1f8a8a;
    --control-brand-foreground-new: #1f8a8a;
    --background-primary: #131313;
    --background-secondary: #1b1b1b;
    --background-secondary-alt: #161616;
    --background-tertiary: #0b0b0b;
    --background-floating: #1b1b1b;
    --background-mobile-primary: #131313;
    --background-mobile-secondary: #1b1b1b;
    --channeltextarea-background: #1b1b1b;
    --input-background: #1b1b1b;
    --activity-card-background: #131313;
    --background-modifier-accent: #262626;
    --background-modifier-hover: rgba(255, 255, 255, 0.04);
    --background-modifier-active: rgba(255, 255, 255, 0.07);
    --background-modifier-selected: rgba(31, 138, 138, 0.15);
    --background-modifier-brand: rgba(31, 138, 138, 0.2);
    --background-code: #0b0b0b;
    --text-normal: #dcdddd;
    --text-muted: #a0a0a0;
    --header-primary: #f2f3f3;
    --header-secondary: #c0c0c0;
    --interactive-normal: #c0c0c0;
    --interactive-hover: #f2f3f3;
    --interactive-active: #1f8a8a;
    --channels-default: #a0a0a0;
    --guild-header-text-shadow: rgba(0, 0, 0, 0.5);
    --scrollbar-thin-thumb: #262626;
    --scrollbar-auto-thumb: #262626;
    --scrollbar-auto-scrollbar-color-thumb: #262626;
    --elevation-stroke: 0 0 0 1px rgba(38, 38, 38, 0.6);
    --elevation-low: 0 1px 0 rgba(11, 11, 11, 0.3);
    --focus-primary: 0 0 0 2px rgba(127, 255, 212, 0.35);
}
.vc-szmelc-og [class*="unreadMentionsIndicator"], .vc-szmelc-og [class*="mention"] {
    --brand-500: #1f8a8a;
}
/* aquamarine used sparingly: typing dots + selected nav item glow */
.vc-szmelc-og [class*="typingDots"] span { background: #7fffd4 !important; }
.vc-szmelc-og [class*="blobContainer"][class*="selected"] svg { fill: #7fffd4; }
`;

const BADGE_CSS = `
.vc-szmelc-badge {
    position: fixed;
    left: 8px;
    bottom: 8px;
    z-index: 9999;
    background: #105c5c;
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    padding: 3px 10px;
    border-radius: 4px;
    opacity: 0.9;
    pointer-events: none;
    text-transform: uppercase;
    box-shadow: 0 0 0 1px rgba(127, 255, 212, 0.25);
}
`;

function SzmelcIcon({ width = 24, height = 24, className }: IconProps) {
    return (
        <svg
            width={width}
            height={height}
            className={className}
            viewBox="0 0 24 24"
            aria-label="Szmelc"
            role="img"
        >
            <path
                fill="#1f8a8a"
                d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.8 3.8v7.8L12 19.7l-6.8-3.8V8.1L12 4.3Z"
            />
            <path
                fill="#7fffd4"
                d="M9.2 8.8h5.6v1.7h-3.7v1h3.1v1.7h-3.1v1h3.8v1.7H9.2V8.8Z"
            />
        </svg>
    );
}

let ogStyle: HTMLStyleElement | null = null;
let badge: HTMLElement | null = null;
let prevTitle: string | null = null;

function applyOg(on: boolean) {
    if (on) {
        if (!ogStyle) {
            ogStyle = document.createElement("style");
            ogStyle.id = "vc-szmelc-og";
            ogStyle.textContent = OG_CSS;
            document.head.appendChild(ogStyle);
        }
        document.documentElement.classList.add("vc-szmelc-og");
    } else {
        document.documentElement.classList.remove("vc-szmelc-og");
    }
}

function applyBadge(on: boolean) {
    if (on) {
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "vc-szmelc-badge";
            badge.textContent = "Szmelc™";
            document.body.appendChild(badge);
        }
    } else if (badge) {
        badge.remove();
        badge = null;
    }
}

function applyTitle(on: boolean) {
    const mark = "Szmelc™";
    if (on) {
        if (prevTitle === null && !document.title.startsWith(mark)) {
            prevTitle = document.title;
            document.title = `${mark} — ${document.title}`;
        }
    } else if (prevTitle !== null) {
        document.title = prevTitle;
        prevTitle = null;
    }
}

function isOurs(name: string) {
    return PluginMeta[name]?.userPlugin === true;
}

function SzmelcTab() {
    const settings = useSettings(["enabledThemes", "themeLinks"]);
    const [localThemes, setLocalThemes] = useState<{ fileName: string; name?: string; }[]>([]);

    useEffect(() => {
        if (IS_WEB || typeof VencordNative === "undefined") return;
        VencordNative.themes.getThemesList().then(setLocalThemes).catch(() => setLocalThemes([]));
    }, []);

    const ourPlugins = Object.keys(Plugins).filter(isOurs).sort((a, b) => a.localeCompare(b));
    const szmelcThemes = localThemes.filter(t => /szmelc|sernicord/i.test(t.fileName));
    const szmelcLinks = settings.themeLinks.filter(l => /szmelc|sernicord/i.test(l));

    const toggleLocalTheme = (fileName: string, enabled: boolean) => {
        Settings.enabledThemes = enabled
            ? [...Settings.enabledThemes, fileName]
            : Settings.enabledThemes.filter(f => f !== fileName);
    };

    return (
        <div>
            <div style={{
                display: "flex", alignItems: "center", gap: 10, marginBottom: 4
            }}>
                <SzmelcIcon width={28} height={28} />
                <Heading tag="h3" style={{ margin: 0 }}>Szmelc™ HQ</Heading>
            </div>
            <Paragraph style={{ marginBottom: 16, opacity: 0.75 }}>
                Everything from the Szmelc / Sernicord workshop: plugins we ship in this repo,
                plus the OG Szmelc look. Enable <b>Szmelc</b> in Plugins to turn the whole
                client into OG szmelc mode (palette, watermark, title).
            </Paragraph>

            <Heading tag="h5">Our plugins <span style={{ opacity: 0.5 }}>({ourPlugins.length})</span></Heading>
            <div style={{ display: "grid", gap: 8, marginBottom: 24 }}>
                {ourPlugins.length === 0 && (
                    <Paragraph>No Sernicord userplugins loaded — run ./sernicord sync-plugins.</Paragraph>
                )}
                {ourPlugins.map(name => (
                    <PluginCard
                        key={name}
                        plugin={Plugins[name]}
                        disabled={false}
                        onRestartNeeded={() => promptToRestart("reload")}
                    />
                ))}
            </div>

            <Heading tag="h5">Themes</Heading>
            <div
                style={{
                    padding: 10, marginBottom: 8, borderRadius: 8,
                    background: "var(--background-secondary)",
                    border: "1px solid var(--background-modifier-accent)"
                }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div>
                        <Paragraph style={{ margin: 0 }}>Szmelc OG — built-in client skin</Paragraph>
                        <Paragraph style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                            The palette this plugin applies when enabled
                        </Paragraph>
                    </div>
                    <Switch
                        checked={szmelcSettings.store.ogMode}
                        onChange={v => { szmelcSettings.store.ogMode = v; applyOg(v); }}
                    />
                </div>
            </div>

            {szmelcThemes.map(t => (
                <div
                    key={t.fileName}
                    style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: 10, marginBottom: 8, borderRadius: 8,
                        background: "var(--background-secondary)"
                    }}
                >
                    <span>{t.name || t.fileName}</span>
                    <Switch
                        checked={settings.enabledThemes.includes(t.fileName)}
                        onChange={v => toggleLocalTheme(t.fileName, v)}
                    />
                </div>
            ))}

            {szmelcLinks.length > 0 && (
                <>
                    <Paragraph style={{ fontSize: 12, opacity: 0.7 }}>
                        Remote theme links from the workshop:
                    </Paragraph>
                    {szmelcLinks.map(l => (
                        <Paragraph key={l} style={{ fontSize: 12, fontFamily: "var(--font-code)" }}>
                            {l}
                        </Paragraph>
                    ))}
                </>
            )}

            {szmelcThemes.length === 0 && szmelcLinks.length === 0 && (
                <Paragraph style={{ fontSize: 12, opacity: 0.7 }}>
                    No szmelc/sernicord themes installed yet — ./sernicord scan --import themes --from &lt;dir&gt;
                </Paragraph>
            )}
        </div>
    );
}

const szmelcSettings = definePluginSettings({
    ogMode: {
        type: OptionType.BOOLEAN,
        description: "OG Szmelc palette — dirty cyan accent on neutral dark greys",
        default: true,
        onChange: applyOg
    },
    watermark: {
        type: OptionType.BOOLEAN,
        description: "Show the Szmelc™ badge in the bottom-left corner",
        default: true,
        onChange: applyBadge
    },
    retitle: {
        type: OptionType.BOOLEAN,
        description: "Brand the window title (Szmelc™ — Discord)",
        default: true,
        onChange: applyTitle
    }
});

export const settings = szmelcSettings;

export default definePlugin({
    name: "Szmelc",
    description: "Turns the client into OG szmelc mode (Szmelc™ palette, watermark, title) and adds the 'szmelc' tab in Vencord settings with all Sernicord plugins and themes.",
    authors: [Author],
    tags: ["Customisation", "Utility"],
    settings,

    start() {
        applyOg(szmelcSettings.store.ogMode);
        applyBadge(szmelcSettings.store.watermark);
        applyTitle(szmelcSettings.store.retitle);

        const badgeStyle = document.createElement("style");
        badgeStyle.id = "vc-szmelc-badge-css";
        badgeStyle.textContent = BADGE_CSS;
        document.head.appendChild(badgeStyle);

        SettingsPlugin.customEntries.push({
            key: "szmelc_hq",
            title: "szmelc",
            panelTitle: "Szmelc™ HQ",
            Component: SzmelcTab,
            Icon: SzmelcIcon
        });
    },

    stop() {
        applyOg(false);
        applyBadge(false);
        applyTitle(false);
        document.getElementById("vc-szmelc-badge-css")?.remove();
        ogStyle?.remove();
        ogStyle = null;
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "szmelc_hq");
        showToast({ text: "Szmelc™ out. Ctrl+R to settle the styles.", variant: "default" });
    }
});
