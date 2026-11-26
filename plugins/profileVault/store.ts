/*
 * Sernicord ProfileVault — shared profile store (used by ProfileVault, InstanceScout and Szmelc HQ)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PlainSettings } from "@api/Settings";

export const STORE_KEY = "SernicordProfileVault";
const ACTIVE_KEY = "SernicordProfileVault:active";

export type VaultEntry = {
    name: string;
    favorite?: boolean;
    createdAt: number;
    updatedAt: number;
    note?: string;
    /** where the profile came from, e.g. "Vesktop @ ~/.config/vesktop" */
    source?: string;
    payload: {
        settings: any;
        quickCss: string;
    };
};

export type Vault = { entries: VaultEntry[]; };

const listeners = new Set<() => void>();

/** Subscribe to vault changes (any writer in this window). Returns an unsubscribe fn. */
export function onVaultChange(cb: () => void) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
}

function emit() {
    listeners.forEach(cb => {
        try { cb(); } catch { /* listener errors must not break writers */ }
    });
}

export async function loadVault(): Promise<Vault> {
    const v = await DataStore.get<Vault>(STORE_KEY);
    return v && Array.isArray(v.entries) ? v : { entries: [] };
}

export async function saveVault(v: Vault) {
    await DataStore.set(STORE_KEY, v);
    emit();
}

export async function getActiveProfile(): Promise<string | null> {
    return (await DataStore.get<string>(ACTIVE_KEY)) ?? null;
}

export async function snapshotCurrent(): Promise<VaultEntry["payload"]> {
    const settings = typeof VencordNative !== "undefined"
        ? VencordNative.settings.get()
        : structuredClone(PlainSettings);
    const quickCss = typeof VencordNative !== "undefined"
        ? await VencordNative.quickCss.get()
        : "";
    return { settings, quickCss };
}

export async function applyPayload(payload: VaultEntry["payload"]) {
    if (!payload?.settings || typeof payload.settings !== "object") throw new Error("Invalid profile payload");
    Object.assign(PlainSettings, payload.settings);
    if (typeof VencordNative !== "undefined") {
        await VencordNative.settings.set(payload.settings);
        await VencordNative.quickCss.set(payload.quickCss ?? "");
    }
}

/** Insert or replace a profile by name. Returns the stored entry. */
export async function upsertProfile(entry: Omit<VaultEntry, "createdAt" | "updatedAt"> & Partial<Pick<VaultEntry, "createdAt">>) {
    const v = await loadVault();
    const now = Date.now();
    const existing = v.entries.find(e => e.name === entry.name);
    if (existing) {
        Object.assign(existing, entry, { updatedAt: now, createdAt: existing.createdAt });
    } else {
        v.entries.push({ ...entry, createdAt: entry.createdAt ?? now, updatedAt: now });
    }
    await saveVault(v);
    return v.entries.find(e => e.name === entry.name)!;
}

/** Pick a free name: "base", "base (2)", ... */
export async function uniqueProfileName(base: string) {
    const names = new Set((await loadVault()).entries.map(e => e.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}

/**
 * Switch to a profile. Before switching, the current state is saved into the
 * profile that was active (or "Autosave" if none), so switching back is lossless.
 */
export async function switchProfile(name: string) {
    const v = await loadVault();
    const target = v.entries.find(e => e.name === name);
    if (!target) throw new Error(`No profile "${name}"`);
    const prev = await getActiveProfile();
    const keepAs = prev && prev !== name && v.entries.some(e => e.name === prev) ? prev : "Autosave";
    if (keepAs !== name) {
        const payload = await snapshotCurrent();
        const keep = v.entries.find(e => e.name === keepAs);
        if (keep) {
            keep.payload = payload;
            keep.updatedAt = Date.now();
        } else {
            v.entries.push({ name: keepAs, createdAt: Date.now(), updatedAt: Date.now(), note: "state before the last switch", payload });
        }
        await saveVault(v);
    }
    await applyPayload(target.payload);
    await DataStore.set(ACTIVE_KEY, name);
    emit();
}

export async function deleteProfile(name: string) {
    const v = await loadVault();
    v.entries = v.entries.filter(x => x.name !== name);
    await saveVault(v);
    if (await getActiveProfile() === name) await DataStore.del(ACTIVE_KEY);
}

export function sortProfiles(entries: VaultEntry[]) {
    return [...entries].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.updatedAt - a.updatedAt);
}
