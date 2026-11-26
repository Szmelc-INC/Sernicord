/*
 * Sernicord Szmelc — OG Szmelc Mode + Szmelc™ HQ (the "szmelc" tab in Vencord settings):
 * every Sernicord module by category with search / filters / quick toggles, profiles,
 * media tools, other installs, themes and the OG look.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import SettingsPlugin from "@plugins/_core/settings";
import { removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

import { HQ_CSS, SzmelcHQ } from "./hq";
import { applyBadge, applyOg, applyTitle, BADGE_CSS, szmelcSettings, SzmelcIcon } from "./look";

const Author = { name: "sernik", id: 0n };

export const settings = szmelcSettings;

export default definePlugin({
    name: "Szmelc",
    description: "Turns the client into OG szmelc mode (Szmelc™ palette, watermark, title) and adds Szmelc™ HQ — the 'szmelc' settings tab: every Sernicord module by category with search and quick toggles, profiles, media tools, other installs, themes.",
    authors: [Author],
    tags: ["Customisation", "Utility"],
    settings,
    managedStyle: HQ_CSS + BADGE_CSS,

    start() {
        applyOg(szmelcSettings.store.ogMode);
        applyBadge(szmelcSettings.store.watermark);
        applyTitle(szmelcSettings.store.retitle);
        SettingsPlugin.customEntries.push({
            key: "szmelc_hq",
            title: "szmelc",
            panelTitle: "Szmelc™ HQ",
            Component: SzmelcHQ,
            Icon: SzmelcIcon
        });
    },

    stop() {
        applyOg(false);
        applyBadge(false);
        applyTitle(false);
        document.getElementById("vc-szmelc-og")?.remove();
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "szmelc_hq");
        showToast({ text: "Szmelc™ out. Ctrl+R to settle the styles.", variant: "default" });
    }
});
