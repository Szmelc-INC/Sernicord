/*
 * Sernicord Szmelc — OG szmelc look: palette, watermark, window title (+ the settings for it)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { IconProps, OptionType } from "@utils/types";

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


export function SzmelcIcon({ width = 24, height = 24, className }: IconProps) {
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

export function applyOg(on: boolean) {
    if (on) {
        if (!ogStyle?.isConnected) {
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

export function applyBadge(on: boolean) {
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

export function applyTitle(on: boolean) {
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

export const szmelcSettings = definePluginSettings({
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

