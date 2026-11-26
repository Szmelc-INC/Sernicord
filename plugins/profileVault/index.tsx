/*
 * Sernicord ProfileVault — save / favorite / switch Vencord settings+plugins+themes profiles
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import { React, showToast, TextInput, useEffect, useState } from "@webpack/common";

import { cx, Empty, Pill, Sx } from "../szmelc/kit";
import {
    deleteProfile, getActiveProfile, loadVault, onVaultChange, snapshotCurrent, sortProfiles,
    switchProfile, uniqueProfileName, upsertProfile, Vault, VaultEntry
} from "./store";

const Author = { name: "sernik", id: 0n };

export function useVault() {
    const [vault, setVault] = useState<Vault>({ entries: [] });
    const [active, setActive] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const [v, a] = await Promise.all([loadVault(), getActiveProfile()]);
            if (alive) { setVault(v); setActive(a); }
        };
        refresh();
        const off = onVaultChange(refresh);
        return () => { alive = false; off(); };
    }, []);
    return { vault, active };
}

function exportEntry(entry: VaultEntry) {
    const json = JSON.stringify(entry, null, 2);
    const fileName = `sernicord-profile-${entry.name.replace(/[^\w.-]+/g, "_")}.json`;
    if (IS_DISCORD_DESKTOP) {
        DiscordNative.fileManager.saveWithDialog(new TextEncoder().encode(json), fileName);
    } else {
        import("@utils/web").then(({ saveFile }) => saveFile(new File([json], fileName, { type: "application/json" })));
    }
}

async function importEntryFile(file: File) {
    const parsed = JSON.parse(await file.text());
    if (!parsed?.payload?.settings) throw new Error("Not a Sernicord profile file");
    const name = await uniqueProfileName(String(parsed.name || file.name.replace(/\.json$/i, "")));
    await upsertProfile({
        name,
        note: parsed.note,
        source: parsed.source ?? `imported file ${file.name}`,
        favorite: !!parsed.favorite,
        payload: { settings: parsed.payload.settings, quickCss: String(parsed.payload.quickCss ?? "") }
    });
    return name;
}

/** Compact profile list with switch/favorite/export/delete. Reused by Szmelc HQ. */
export function ProfileList({ compact = false }: { compact?: boolean; }) {
    const { vault, active } = useVault();
    const [busy, setBusy] = useState(false);

    const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
        setBusy(true);
        try {
            await fn();
            if (ok) showToast({ text: ok, variant: "success" });
        } catch (e) {
            showToast({ text: String((e as Error)?.message ?? e), variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const sorted = sortProfiles(vault.entries);
    if (sorted.length === 0) return <Sx><Empty>No profiles yet. Save the current setup above to create one.</Empty></Sx>;

    return (
        <Sx>
            <div className="vc-sx-col tight">
                {sorted.map(entry => {
                    const isActive = entry.name === active;
                    return (
                        <div key={entry.name} className={cx("vc-sx-card", compact && "compact", isActive && "active")}>
                            <div className="vc-sx-row between nowrap">
                                <div className="vc-sx-col tight vc-sx-grow">
                                    <div className="vc-sx-title">
                                        {entry.favorite && <span className="vc-sx-ok" aria-label="favorite">★</span>}
                                        <span className="vc-sx-ellipsis">{entry.name}</span>
                                        {isActive && <Pill tone="accent">active</Pill>}
                                    </div>
                                    <div className="vc-sx-muted vc-sx-ellipsis">
                                        {[new Date(entry.updatedAt).toLocaleString(), entry.source && `from ${entry.source}`, entry.note].filter(Boolean).join(" · ")}
                                    </div>
                                </div>
                                <div className="vc-sx-row nowrap">
                                    <Button size="small" disabled={busy || isActive}
                                        onClick={run(() => switchProfile(entry.name), `Switched to "${entry.name}". Ctrl+R to apply everything.`)}>
                                        {isActive ? "Current" : "Switch"}
                                    </Button>
                                    <Button size="small" variant="secondary" disabled={busy}
                                        aria-label={entry.favorite ? "Unfavorite" : "Favorite"}
                                        onClick={run(() => upsertProfile({ ...entry, favorite: !entry.favorite }))}>
                                        {entry.favorite ? "★" : "☆"}
                                    </Button>
                                    {!compact && <Button size="small" variant="secondary" onClick={() => exportEntry(entry)}>Export</Button>}
                                    {!compact && (
                                        <Button size="small" variant="dangerSecondary" disabled={busy}
                                            onClick={run(() => deleteProfile(entry.name), `Deleted "${entry.name}"`)}>
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Sx>
    );
}

/** Save-current form + import, reused by Szmelc HQ. */
export function ProfileSaveBar() {
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const fileRef = React.useRef<HTMLInputElement>(null);

    const save = async (favorite: boolean) => {
        const n = name.trim();
        if (!n) return showToast({ text: "Name required", variant: "critical" });
        setBusy(true);
        try {
            await upsertProfile({ name: n, note: note || undefined, favorite: favorite || undefined, payload: await snapshotCurrent() });
            setName("");
            setNote("");
            showToast({ text: `Saved profile "${n}"`, variant: "success" });
        } catch (e) {
            showToast({ text: String(e), variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Sx>
            <div className="vc-sx-grid" style={{ "--sx-min": "180px" } as React.CSSProperties}>
                <TextInput placeholder="Profile name" value={name} onChange={setName} />
                <TextInput placeholder="Optional note" value={note} onChange={setNote} />
            </div>
            <div className="vc-sx-row">
                <Button size="small" disabled={busy || !name.trim()} onClick={() => save(false)}>Save current</Button>
                <Button size="small" variant="positive" disabled={busy || !name.trim()} onClick={() => save(true)}>Save as ★</Button>
                <span className="vc-sx-spacer" />
                <Button size="small" variant="secondary" onClick={() => fileRef.current?.click()}>Import .json</Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={async e => {
                        const input = e.currentTarget;
                        const f = input.files?.[0];
                        input.value = "";
                        if (!f) return;
                        try {
                            showToast({ text: `Imported "${await importEntryFile(f)}"`, variant: "success" });
                        } catch (err) {
                            showToast({ text: String((err as Error)?.message ?? err), variant: "critical" });
                        }
                    }}
                />
            </div>
        </Sx>
    );
}

function VaultPanel() {
    return (
        <Sx>
            <p className="vc-sx-hint">
                Snapshots include plugin enablement, plugin settings, themes, theme links, and QuickCSS.
                Profiles stay in local DataStore (not cloud). Switching saves the state before the switch as
                "Autosave" (named profiles change only when you save them), keeps plugins a profile doesn't
                mention as they are, and never turns ProfileVault / Szmelc off. Reload Discord after switching.
            </p>
            <section className="vc-sx-card">
                <h4>Save current setup</h4>
                <ProfileSaveBar />
            </section>
            <div className="vc-sx-section">Profiles</div>
            <ProfileList />
        </Sx>
    );
}

export const settings = definePluginSettings({
    manager: {
        type: OptionType.COMPONENT,
        component: () => <VaultPanel />
    }
});

export default definePlugin({
    name: "ProfileVault",
    description: "Save Vencord/Sernicord config, plugins, themes, and QuickCSS as named favorites and switch between them (also from the szmelc tab).",
    authors: [Author],
    tags: ["Utility", "Customisation", "Organisation"],
    settings
});
