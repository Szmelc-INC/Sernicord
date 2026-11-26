/*
 * Sernicord ProfileVault — save / favorite / switch Vencord settings+plugins+themes profiles
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { React, showToast, TextInput, useEffect, useState } from "@webpack/common";

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

const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };

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
    if (sorted.length === 0) return <Paragraph style={{ opacity: 0.7 }}>No profiles yet.</Paragraph>;

    return (
        <div style={{ display: "grid", gap: 6 }}>
            {sorted.map(entry => {
                const isActive = entry.name === active;
                return (
                    <div
                        key={entry.name}
                        style={{
                            padding: compact ? "6px 10px" : 10,
                            borderRadius: 8,
                            background: "var(--background-secondary)",
                            border: `1px solid ${isActive ? "#1f8a8a" : "var(--background-modifier-accent)"}`
                        }}
                    >
                        <div style={{ ...row, justifyContent: "space-between" }}>
                            <div style={{ minWidth: 0 }}>
                                <Heading tag="h5" style={{ margin: 0 }}>
                                    {entry.favorite ? "★ " : ""}{entry.name}
                                    {isActive && (
                                        <span style={{
                                            marginLeft: 8, padding: "1px 6px", borderRadius: 4, fontSize: 10,
                                            background: "#105c5c", color: "#fff", textTransform: "uppercase"
                                        }}>active</span>
                                    )}
                                </Heading>
                                <Paragraph style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
                                    {new Date(entry.updatedAt).toLocaleString()}
                                    {entry.source ? ` · from ${entry.source}` : ""}
                                    {entry.note ? ` · ${entry.note}` : ""}
                                </Paragraph>
                            </div>
                            <div style={row}>
                                <Button size="small" disabled={busy || isActive}
                                    onClick={run(() => switchProfile(entry.name), `Switched to "${entry.name}". Ctrl+R to apply everything.`)}>
                                    Switch
                                </Button>
                                <Button size="small" variant="secondary" disabled={busy}
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
        <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <TextInput placeholder="Profile name" value={name} onChange={setName} />
                <TextInput placeholder="Optional note" value={note} onChange={setNote} />
            </div>
            <div style={row}>
                <Button size="small" disabled={busy} onClick={() => save(false)}>Save current</Button>
                <Button size="small" variant="positive" disabled={busy} onClick={() => save(true)}>Save as ★</Button>
                <Button size="small" variant="secondary" onClick={() => fileRef.current?.click()}>Import .json</Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
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
        </div>
    );
}

function VaultPanel() {
    return (
        <div style={{ display: "grid", gap: 12 }}>
            <Paragraph>
                Snapshots include plugin enablement, plugin settings, themes, theme links, and QuickCSS.
                Profiles stay in local DataStore (not cloud). Switching saves the current state into the
                active profile first, so you can always switch back. Reload Discord after switching.
            </Paragraph>
            <ProfileSaveBar />
            <ProfileList />
        </div>
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
