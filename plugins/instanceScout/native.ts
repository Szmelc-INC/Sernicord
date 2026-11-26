/*
 * Sernicord InstanceScout — main-process side: find other Discord / Vencord / Equicord /
 * Vesktop / BetterDiscord / Sernicord installs and read their settings, themes and plugins.
 * Read-only towards other installs; the only write is copying themes into our THEMES_DIR.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR, THEMES_DIR } from "@main/utils/constants";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, shell } from "electron";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import { basename, join, resolve, sep } from "path";

export type InstanceKind = "vencord" | "equicord" | "vesktop" | "betterdiscord" | "discord" | "sernicord" | "custom";

export interface ModData {
    /** dir containing settings/settings.json and/or themes/ */
    dir: string;
    label: string;
}

export interface Instance {
    id: string;
    kind: InstanceKind;
    label: string;
    root: string;
    /** Vencord-style data dirs found under this root (Vencord, Equicord, Vesktop, Sernicord profiles) */
    mods: ModData[];
    caps: {
        settings: boolean;
        quickCss: boolean;
        themes: number;
        bdPlugins: number;
        bdCustomCss: boolean;
        userplugins: number;
        session: boolean;
    };
}

export interface ThemeInfo { fileName: string; size: number; name?: string; author?: string; description?: string; }
export interface BdPluginInfo { fileName: string; size: number; name?: string; author?: string; description?: string; version?: string; }

export interface InstanceDetails {
    root: string;
    mods: Array<ModData & {
        settings: any | null;
        settingsError?: string;
        quickCss: string;
        themes: ThemeInfo[];
    }>;
    bd: null | {
        themes: ThemeInfo[];
        plugins: BdPluginInfo[];
        customCss: string;
    };
    userplugins: string[];
}

const allowedRoots = new Set<string>();
const MAX_TEXT = 4 * 1024 * 1024;

function norm(p: string) {
    return resolve(p);
}

function isSelf(p: string) {
    const r = norm(p);
    const self = norm(DATA_DIR);
    return r === self || r.startsWith(self + sep);
}

function assertAllowed(root: string) {
    const r = norm(root);
    if (!allowedRoots.has(r)) throw new Error("Path was not found by a scan or picked by you");
    return r;
}

/** join(dir, name) where name must be a plain file name (no traversal) */
function safeChild(dir: string, name: string) {
    if (!/^[^/\\\0]+$/.test(name) || name === "." || name === "..") throw new Error(`Bad file name: ${name}`);
    const p = resolve(dir, name);
    if (!p.startsWith(resolve(dir) + sep)) throw new Error(`Bad file name: ${name}`);
    return p;
}

async function isDir(p: string) {
    try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function isFile(p: string) {
    try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function listFiles(dir: string, re: RegExp) {
    try {
        const ents = await fs.readdir(dir, { withFileTypes: true });
        return ents.filter(e => e.isFile() && re.test(e.name)).map(e => e.name).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

async function readText(p: string) {
    const st = await fs.stat(p);
    if (st.size > MAX_TEXT) throw new Error(`${basename(p)} is larger than 4 MB`);
    return fs.readFile(p, "utf8");
}

/** BetterDiscord-style /** @name X ... *\/ meta header (themes and plugins) */
function parseMeta(src: string) {
    const head = src.slice(0, 4096).match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
    const meta: Record<string, string> = {};
    for (const m of head.matchAll(/@(\w+)[ \t]+([^\r\n]+)/g)) meta[m[1].toLowerCase()] = m[2].trim();
    return meta;
}

function looksLikeModData(dir: string) {
    return existsSync(join(dir, "settings", "settings.json")) || existsSync(join(dir, "themes"));
}

/** Bounded search for Vencord-style data dirs under a root (Sernicord checkouts keep them in data/**) */
async function findModDirs(root: string, depth: number, out: string[] = []) {
    if (depth < 0 || out.length > 24) return out;
    if (looksLikeModData(root) && !isSelf(root)) out.push(root);
    let ents: import("fs").Dirent[] = [];
    try { ents = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".git")) continue;
        if (/^(Cache|Code Cache|GPUCache|blob_storage|IndexedDB|Service Worker|Crashpad|DawnCache|dist|src)$/.test(e.name)) continue;
        await findModDirs(join(root, e.name), depth - 1, out);
    }
    return out;
}

function candidates(): Array<{ kind: InstanceKind; label: string; path: string; }> {
    const appData = app.getPath("appData");
    const home = homedir();
    const c: Array<{ kind: InstanceKind; label: string; path: string; }> = [
        { kind: "vencord", label: "Vencord", path: join(appData, "Vencord") },
        { kind: "equicord", label: "Equicord", path: join(appData, "Equicord") },
        { kind: "vesktop", label: "Vesktop", path: join(appData, "vesktop") },
        { kind: "vesktop", label: "Vesktop", path: join(appData, "Vesktop") },
        { kind: "vesktop", label: "Equibop", path: join(appData, "equibop") },
        { kind: "betterdiscord", label: "BetterDiscord", path: join(appData, "BetterDiscord") },
        { kind: "discord", label: "Discord", path: join(appData, "discord") },
        { kind: "discord", label: "Discord PTB", path: join(appData, "discordptb") },
        { kind: "discord", label: "Discord PTB", path: join(appData, "discordPTB") },
        { kind: "discord", label: "Discord Canary", path: join(appData, "discordcanary") },
        { kind: "discord", label: "WebCord", path: join(appData, "WebCord") }
    ];
    if (process.platform === "linux") {
        const fp = join(home, ".var", "app");
        c.push(
            { kind: "discord", label: "Discord (Flatpak)", path: join(fp, "com.discordapp.Discord", "config", "discord") },
            { kind: "vencord", label: "Vencord (Flatpak Discord)", path: join(fp, "com.discordapp.Discord", "config", "Vencord") },
            { kind: "vesktop", label: "Vesktop (Flatpak)", path: join(fp, "dev.vencord.Vesktop", "config", "vesktop") },
            { kind: "vesktop", label: "Vesktop (Flatpak)", path: join(fp, "com.vencord.Vesktop", "config", "vesktop") },
            { kind: "discord", label: "Discord (Snap)", path: join(home, "snap", "discord", "current", ".config", "discord") },
            { kind: "vencord", label: "Vencord (Snap Discord)", path: join(home, "snap", "discord", "current", ".config", "Vencord") }
        );
        for (const n of [2, 3, 4, 5, 6]) {
            c.push({ kind: "sernicord", label: `Sernicord (~/Projects-${n})`, path: join(home, `Projects-${n}`, "VENCORD") });
        }
        c.push({ kind: "sernicord", label: "Sernicord (packaged)", path: join(home, ".local", "share", "sernicord") });
    }
    return c;
}

async function describe(kind: InstanceKind, label: string, root: string): Promise<Instance | null> {
    if (!(await isDir(root)) || isSelf(root)) return null;
    const modDirs = kind === "discord"
        ? []
        : await findModDirs(root, kind === "sernicord" || kind === "custom" ? 5 : 1);
    const mods: ModData[] = modDirs.map(dir => ({
        dir,
        label: dir === root ? label : `${label} · ${dir.slice(root.length + 1) || "."}`
    }));

    const caps: Instance["caps"] = {
        settings: false, quickCss: false, themes: 0, bdPlugins: 0, bdCustomCss: false, userplugins: 0,
        session: await isFile(join(root, "Cookies")) || await isDir(join(root, "Local Storage"))
    };
    for (const m of mods) {
        caps.settings ||= await isFile(join(m.dir, "settings", "settings.json"));
        caps.quickCss ||= await isFile(join(m.dir, "settings", "quickCss.css"));
        caps.themes += (await listFiles(join(m.dir, "themes"), /\.css$/i)).length;
    }
    if (kind === "betterdiscord" || kind === "custom") {
        caps.themes += (await listFiles(join(root, "themes"), /\.theme\.css$/i)).length;
        caps.bdPlugins = (await listFiles(join(root, "plugins"), /\.plugin\.js$/i)).length;
        caps.bdCustomCss = (await bdCustomCssPath(root)) != null;
    }
    const up = kind === "sernicord" ? join(root, "plugins") : join(root, "src", "userplugins");
    if (await isDir(up)) {
        caps.userplugins = (await fs.readdir(up, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith(".")).length;
    }

    const anything = caps.settings || caps.quickCss || caps.themes || caps.bdPlugins || caps.bdCustomCss || caps.userplugins || caps.session;
    if (!anything) return null;
    return { id: norm(root), kind, label, root: norm(root), mods, caps };
}

async function bdCustomCssPath(root: string) {
    for (const ch of ["stable", "ptb", "canary"]) {
        const p = join(root, "data", ch, "custom.css");
        if (await isFile(p)) return p;
    }
    return null;
}

export async function scan(_e: IpcMainInvokeEvent, extraRoots: string[] = []): Promise<Instance[]> {
    const seen = new Set<string>();
    const out: Instance[] = [];
    const list = [
        ...candidates(),
        ...extraRoots.filter(p => typeof p === "string" && p).map(p => ({ kind: "custom" as const, label: basename(p) || p, path: p }))
    ];
    for (const c of list) {
        const r = norm(c.path);
        if (seen.has(r)) continue;
        seen.add(r);
        try {
            const inst = await describe(c.kind, c.label, r);
            if (inst) {
                allowedRoots.add(inst.root);
                out.push(inst);
            }
        } catch { /* unreadable candidate: skip */ }
    }
    return out;
}

export async function pickFolder(e: IpcMainInvokeEvent): Promise<string | null> {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await (win
        ? dialog.showOpenDialog(win, { title: "Pick a Discord / Vencord / BetterDiscord folder", properties: ["openDirectory", "showHiddenFiles"] })
        : dialog.showOpenDialog({ title: "Pick a Discord / Vencord / BetterDiscord folder", properties: ["openDirectory", "showHiddenFiles"] }));
    if (res.canceled || !res.filePaths[0]) return null;
    const r = norm(res.filePaths[0]);
    if (isSelf(r)) throw new Error("That is this client's own data folder");
    allowedRoots.add(r);
    return r;
}

async function themeInfos(dir: string, re: RegExp): Promise<ThemeInfo[]> {
    const names = await listFiles(dir, re);
    return Promise.all(names.map(async fileName => {
        const p = join(dir, fileName);
        const st = await fs.stat(p);
        let meta: Record<string, string> = {};
        try { meta = parseMeta((await fs.readFile(p, "utf8")).slice(0, 4096)); } catch { /* unreadable */ }
        return { fileName, size: st.size, name: meta.name, author: meta.author, description: meta.description };
    }));
}

export async function details(_e: IpcMainInvokeEvent, root: string, kind: InstanceKind): Promise<InstanceDetails> {
    const r = assertAllowed(root);
    const inst = await describe(kind, basename(r), r);
    const mods: InstanceDetails["mods"] = [];
    for (const m of inst?.mods ?? []) {
        let settings: any = null;
        let settingsError: string | undefined;
        const sp = join(m.dir, "settings", "settings.json");
        if (await isFile(sp)) {
            try { settings = JSON.parse(await readText(sp)); } catch (err) { settingsError = String((err as Error).message ?? err); }
        }
        const qp = join(m.dir, "settings", "quickCss.css");
        const quickCss = await isFile(qp) ? await readText(qp).catch(() => "") : "";
        mods.push({ ...m, settings, settingsError, quickCss, themes: await themeInfos(join(m.dir, "themes"), /\.css$/i) });
    }

    let bd: InstanceDetails["bd"] = null;
    if (kind === "betterdiscord" || kind === "custom") {
        const themes = await themeInfos(join(r, "themes"), /\.theme\.css$/i);
        const pluginNames = await listFiles(join(r, "plugins"), /\.plugin\.js$/i);
        const plugins: BdPluginInfo[] = await Promise.all(pluginNames.map(async fileName => {
            const p = join(r, "plugins", fileName);
            const st = await fs.stat(p);
            let meta: Record<string, string> = {};
            try { meta = parseMeta((await fs.readFile(p, "utf8")).slice(0, 4096)); } catch { /* unreadable */ }
            return { fileName, size: st.size, name: meta.name, author: meta.author, description: meta.description, version: meta.version };
        }));
        const cssPath = await bdCustomCssPath(r);
        const customCss = cssPath ? await readText(cssPath).catch(() => "") : "";
        if (themes.length || plugins.length || customCss) bd = { themes, plugins, customCss };
    }

    const up = kind === "sernicord" ? join(r, "plugins") : join(r, "src", "userplugins");
    const userplugins = await isDir(up)
        ? (await fs.readdir(up, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort()
        : [];

    return { root: r, mods, bd, userplugins };
}

/** Resolve a theme / plugin file of an allowed instance: where = mod data dir (themes/) or "bd-themes" / "bd-plugins" */
function sourceFile(root: string, where: string, fileName: string) {
    const r = assertAllowed(root);
    let dir: string;
    if (where === "bd-themes") dir = join(r, "themes");
    else if (where === "bd-plugins") dir = join(r, "plugins");
    else {
        const d = norm(where);
        if (d !== r && !d.startsWith(r + sep)) throw new Error("Data dir is outside the instance");
        dir = join(d, "themes");
    }
    return safeChild(dir, fileName);
}

export async function readSource(_e: IpcMainInvokeEvent, root: string, where: string, fileName: string): Promise<string> {
    return readText(sourceFile(root, where, fileName));
}

export async function importThemes(
    _e: IpcMainInvokeEvent, root: string, where: string, fileNames: string[], overwrite: boolean
): Promise<{ copied: string[]; skipped: string[]; }> {
    await fs.mkdir(THEMES_DIR, { recursive: true });
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const name of fileNames) {
        const src = sourceFile(root, where, name);
        // Vencord only lists *.css; BetterDiscord themes are *.theme.css already
        const destName = /\.css$/i.test(name) ? name : `${name}.css`;
        const dest = safeChild(THEMES_DIR, destName);
        if (!overwrite && existsSync(dest)) {
            skipped.push(destName);
            continue;
        }
        await fs.copyFile(src, dest);
        copied.push(destName);
    }
    return { copied, skipped };
}

export async function openFolder(_e: IpcMainInvokeEvent, root: string): Promise<string> {
    return shell.openPath(assertAllowed(root));
}
