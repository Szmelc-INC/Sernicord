/*
 * Sernicord Szmelc — Szmelc™ HQ: one hub for every Sernicord module, profiles, media tools,
 * other installs, themes and the OG look.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { hasAnyVisibleSettings, isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings, useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { Switch } from "@components/Switch";
import { Plugin } from "@utils/types";
import { React, showToast, useEffect, useState } from "@webpack/common";
import Plugins, { PluginMeta } from "~plugins";

import { ScoutPanel } from "../instanceScout";
import { ToolSummary } from "../mediaForge";
import { openInPaint, openStudio } from "../mediaForge/ui";
import { ProfileList, ProfileSaveBar, useVault } from "../profileVault";
import { applyBadge, applyOg, applyTitle, szmelcSettings, SzmelcIcon } from "./look";


/* ---------------- categories ---------------- */

const CATEGORIES: Array<{ id: string; label: string; folders: string[]; }> = [
    { id: "media", label: "Media & files", folders: ["mediaForge", "allMyGifs", "megaDrop", "discloudStorage", "localArchive"] },
    { id: "chat", label: "Messages & chat", folders: ["messageOps", "secureChat", "embedForge", "bad2YouBad4Me", "omniSearch"] },
    { id: "setup", label: "Setup, profiles & look", folders: ["profileVault", "instanceScout", "szmelc"] },
    { id: "safety", label: "Safety & moderation", folders: ["secretSentinel", "fullCyberJacket", "botLens"] },
    { id: "dev", label: "Dev", folders: ["helloDev"] }
];

const folderOf = (name: string) => PluginMeta[name]?.folderName?.split("/").pop() ?? name;
const isOurs = (name: string) => PluginMeta[name]?.userPlugin === true;

function categoryOf(name: string) {
    const f = folderOf(name);
    return CATEGORIES.find(c => c.folders.includes(f))?.id ?? "other";
}

/* ---------------- restart tracking ---------------- */

let pending = new Set<string>();
const pendingSubs = new Set<() => void>();
function markPending(name: string) {
    pending = new Set(pending).add(name);
    pendingSubs.forEach(f => f());
}
function usePending() {
    const [p, set] = useState(pending);
    useEffect(() => {
        const f = () => set(pending);
        pendingSubs.add(f);
        return () => void pendingSubs.delete(f);
    }, []);
    return p;
}

/** Same rules as Vencord's own plugin card: dependencies first, restart when patches are involved. */
export function togglePlugin(plugin: Plugin) {
    const s = Settings.plugins[plugin.name];
    const wasEnabled = isPluginEnabled(plugin.name);
    if (!wasEnabled) {
        const { restartNeeded, failures } = startDependenciesRecursive(plugin);
        if (failures.length) {
            showNotice(`Failed to start dependencies: ${failures.join(", ")}`, "Close", () => null);
            return;
        }
        if (restartNeeded) {
            s.enabled = true;
            markPending(plugin.name);
            return;
        }
    }
    if (pluginRequiresRestart(plugin)) {
        s.enabled = !wasEnabled;
        markPending(plugin.name);
        return;
    }
    if (wasEnabled && !plugin.started) {
        s.enabled = false;
        return;
    }
    const ok = wasEnabled ? stopPlugin(plugin) : startPlugin(plugin);
    if (!ok) {
        s.enabled = false;
        showToast({ text: `Error while ${wasEnabled ? "stopping" : "starting"} ${plugin.name}`, variant: "critical" });
        return;
    }
    s.enabled = !wasEnabled;
}

/* ---------------- modules ---------------- */

function ModuleRow({ plugin }: { plugin: Plugin; }) {
    useSettings([`plugins.${plugin.name}.enabled` as any]);
    const on = isPluginEnabled(plugin.name);
    const hasNative = typeof VencordNative !== "undefined" && !!(VencordNative.pluginHelpers as any)[plugin.name];
    const required = !!plugin.required;
    return (
        <div className={`vc-hq-mod ${on ? "on" : ""}`}>
            <label title={required ? "required by Vencord" : on ? "Turn off" : "Turn on"} aria-label={`${plugin.name} ${on ? "on" : "off"}`}>
                <Switch checked={on} disabled={required} onChange={() => togglePlugin(plugin)} />
            </label>
            <div style={{ minWidth: 0 }}>
                <div className="name">
                    {plugin.name}
                    {on && <span className="vc-hq-pill on">on</span>}
                    {hasNative && <span className="vc-hq-pill" title="has a desktop (main process) part">native</span>}
                    {required && <span className="vc-hq-pill">required</span>}
                </div>
                <div className="desc" title={plugin.description}>{plugin.description}</div>
            </div>
            {hasAnyVisibleSettings(plugin)
                ? <Button size="small" variant="secondary" onClick={() => openPluginModal(plugin, name => markPending(name))} aria-label={`${plugin.name} settings`}>Settings</Button>
                : <span />}
        </div>
    );
}

let lastQuery = "";
let lastScope: "ours" | "all" = "ours";
let lastFilter: "all" | "on" | "off" = "all";

function ModulesPanel() {
    const [q, setQ] = useState(lastQuery);
    const [scope, setScope] = useState(lastScope);
    const [filter, setFilter] = useState(lastFilter);
    useSettings(["plugins"] as any);
    useEffect(() => { lastQuery = q; lastScope = scope; lastFilter = filter; }, [q, scope, filter]);

    const list = Object.values(Plugins)
        .filter(p => scope === "all" || isOurs(p.name))
        .filter(p => !p.hidden)
        .filter(p => filter === "all" || (filter === "on") === isPluginEnabled(p.name))
        .filter(p => {
            if (!q.trim()) return true;
            const needle = q.toLowerCase();
            return p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle) || (p.tags ?? []).some(t => t.toLowerCase().includes(needle));
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const groups = scope === "ours"
        ? [...CATEGORIES, { id: "other", label: "Other", folders: [] }].map(c => ({ ...c, items: list.filter(p => categoryOf(p.name) === c.id) })).filter(g => g.items.length)
        : [{ id: "all", label: `${list.length} plugins`, folders: [], items: list }];

    return (
        <div className="vc-hq" style={{ gap: 10 }}>
            <div className="vc-hq-tools">
                <input className="vc-hq-search" placeholder="Search modules, descriptions, tags…" value={q} onChange={e => setQ(e.currentTarget.value)} aria-label="Search modules" autoFocus />
                <div className="vc-hq-seg" role="group" aria-label="Which plugins">
                    <button aria-pressed={scope === "ours"} onClick={() => setScope("ours")}>Sernicord</button>
                    <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All plugins</button>
                </div>
                <div className="vc-hq-seg" role="group" aria-label="Filter">
                    {(["all", "on", "off"] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "on" ? "On" : "Off"}</button>)}
                </div>
            </div>
            {!list.length && <div className="vc-hq-empty">{scope === "ours" && !Object.keys(Plugins).some(isOurs) ? "No Sernicord modules loaded — run ./sernicord sync-plugins and rebuild." : "Nothing matches."}</div>}
            {groups.map(g => (
                <div key={g.id} className="vc-hq-group">
                    <h3>{g.label} <span style={{ opacity: .6 }}>· {g.items.filter(p => isPluginEnabled(p.name)).length}/{g.items.length} on</span></h3>
                    <div className="vc-hq-grid">{g.items.map(p => <ModuleRow key={p.name} plugin={p} />)}</div>
                </div>
            ))}
        </div>
    );
}

/* ---------------- other panels ---------------- */

function NeedPlugin({ name, what }: { name: string; what: string; }) {
    const plugin = Plugins[name];
    useSettings([`plugins.${name}.enabled` as any]);
    if (!plugin) return <div className="vc-hq-empty">{name} is not part of this build.</div>;
    return (
        <div className="vc-hq-card">
            <h4>{name} is off</h4>
            <div className="vc-hq-sub">{what}</div>
            <div><Button onClick={() => togglePlugin(plugin)}>Turn on {name}</Button></div>
        </div>
    );
}

function ProfilesPanel({ go }: { go(t: TabId): void; }) {
    return (
        <div className="vc-hq">
            <div className="vc-hq-card">
                <h4>Save the current setup</h4>
                <div className="vc-hq-sub">Plugins, plugin settings, themes, theme links and QuickCSS. Switching keeps the previous state as “Autosave”, so you can always go back.</div>
                <ProfileSaveBar />
            </div>
            <ProfileList />
            <div className="vc-hq-row">
                <Button size="small" variant="secondary" onClick={() => go("installs")}>Import a profile from another install…</Button>
            </div>
        </div>
    );
}

function MediaPanel() {
    useSettings(["plugins.MediaForge.enabled" as any]);
    if (!isPluginEnabled("MediaForge")) return <NeedPlugin name="MediaForge" what="Re-encode, clip, split, join, make emoji / stickers / sounds, download links, mpv / VLC, Paint." />;
    return (
        <div className="vc-hq">
            <div className="vc-hq-card">
                <h4>Tools</h4>
                <ToolSummary />
            </div>
            <div className="vc-hq-row">
                <Button onClick={() => openStudio()}>Open MediaForge</Button>
                <Button variant="secondary" onClick={() => openStudio({ tab: "download" })}>Download a link</Button>
                <Button variant="secondary" onClick={() => openStudio({ tab: "tools" })}>Install / update tools</Button>
                <Button variant="secondary" onClick={() => openInPaint()}>Paint</Button>
            </div>
            <div className="vc-hq-sub">Also: right-click any message with media → MediaForge · the film button in the chat bar · <code>/forge</code> · oversized uploads are caught automatically.</div>
        </div>
    );
}

function InstallsPanel() {
    useSettings(["plugins.InstanceScout.enabled" as any]);
    if (!isPluginEnabled("InstanceScout")) return <NeedPlugin name="InstanceScout" what="Find other Discord / Vencord / BetterDiscord installs and import their plugins, themes, CSS or make a profile from them." />;
    return <ScoutPanel />;
}

function ThemesPanel() {
    const settings = useSettings(["enabledThemes", "themeLinks"]);
    const og = szmelcSettings.use(["ogMode"]);
    const [themes, setThemes] = useState<Array<{ fileName: string; name?: string; author?: string; description?: string; }>>([]);
    const [q, setQ] = useState("");
    useEffect(() => {
        if (IS_WEB || typeof VencordNative === "undefined") return;
        VencordNative.themes.getThemesList().then(setThemes).catch(() => setThemes([]));
    }, []);
    const toggle = (fileName: string, on: boolean) => {
        Settings.enabledThemes = on ? [...new Set([...Settings.enabledThemes, fileName])] : Settings.enabledThemes.filter(f => f !== fileName);
    };
    const shown = themes
        .filter(t => !q || `${t.name} ${t.fileName} ${t.author}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Number(/szmelc|sernicord/i.test(b.fileName)) - Number(/szmelc|sernicord/i.test(a.fileName)) || (a.name ?? a.fileName).localeCompare(b.name ?? b.fileName));
    return (
        <div className="vc-hq">
            <div className="vc-hq-theme" style={{ borderColor: "#105c5c" }}>
                <div><b>Szmelc OG</b> <span className="vc-hq-pill hot">built in</span><div className="vc-hq-sub">dirty-cyan accent on neutral dark greys</div></div>
                <Switch checked={og.ogMode} onChange={v => { szmelcSettings.store.ogMode = v; applyOg(v); }} />
            </div>
            <div className="vc-hq-tools">
                <input className="vc-hq-search" placeholder="Search themes…" value={q} onChange={e => setQ(e.currentTarget.value)} aria-label="Search themes" />
                <Button size="small" variant="secondary" onClick={() => VencordNative.themes.openFolder()}>Themes folder</Button>
                <span className="vc-hq-sub">{settings.enabledThemes.length} on · {settings.themeLinks.length} links</span>
            </div>
            {!shown.length && <div className="vc-hq-empty">{themes.length ? "Nothing matches." : "No local themes. Import some from another install (Installs tab) or drop .css files in the themes folder."}</div>}
            {shown.map(t => (
                <div key={t.fileName} className="vc-hq-theme">
                    <div style={{ minWidth: 0 }}>
                        <b>{t.name || t.fileName}</b>{/szmelc|sernicord/i.test(t.fileName) && <span className="vc-hq-pill on" style={{ marginLeft: 6 }}>szmelc</span>}
                        <div className="vc-hq-sub">{t.author ? `by ${t.author} · ` : ""}{t.fileName}</div>
                    </div>
                    <Switch checked={settings.enabledThemes.includes(t.fileName)} onChange={v => toggle(t.fileName, v)} />
                </div>
            ))}
        </div>
    );
}

function LookPanel() {
    const s = szmelcSettings.use(["ogMode", "watermark", "retitle"]);
    const row = (key: "ogMode" | "watermark" | "retitle", title: string, sub: string) => (
        <div className="vc-hq-theme">
            <div><b>{title}</b><div className="vc-hq-sub">{sub}</div></div>
            <Switch checked={s[key]} onChange={v => {
                szmelcSettings.store[key] = v;
                (key === "ogMode" ? applyOg : key === "watermark" ? applyBadge : applyTitle)(v);
            }} />
        </div>
    );
    return (
        <div className="vc-hq">
            {row("ogMode", "OG palette", "dirty cyan accent, neutral dark greys, aquamarine highlights")}
            {row("watermark", "Szmelc™ badge", "small badge in the bottom-left corner")}
            {row("retitle", "Window title", "Szmelc™ — Discord")}
        </div>
    );
}

/* ---------------- hub ---------------- */

type TabId = "modules" | "profiles" | "media" | "installs" | "themes" | "look";
let lastTab: TabId = "modules";

export function SzmelcHQ() {
    const [tab, setTab] = useState<TabId>(lastTab);
    const pend = usePending();
    const { vault, active } = useVault();
    useSettings(["plugins"] as any);
    useEffect(() => { lastTab = tab; }, [tab]);

    const ours = Object.keys(Plugins).filter(isOurs);
    const onCount = ours.filter(isPluginEnabled).length;
    const tabs: Array<[TabId, string, string?]> = [
        ["modules", "Modules", `${onCount}/${ours.length}`],
        ["profiles", "Profiles", String(vault.entries.length)],
        ["media", "Media"],
        ["installs", "Installs"],
        ["themes", "Themes"],
        ["look", "Look"]
    ];
    const onKey = (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = tabs.findIndex(t => t[0] === tab);
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
        setTab(next);
        (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
    };

    return (
        <div className="vc-hq">
            <div className="vc-hq-head">
                <SzmelcIcon width={36} height={36} />
                <div style={{ flex: 1, minWidth: 200 }}>
                    <h2>Szmelc™ HQ</h2>
                    <div className="vc-hq-sub">Every Sernicord module, profile, media tool and theme in one place.</div>
                </div>
                <div className="vc-hq-chips">
                    <span className="vc-hq-chip accent"><b style={{ color: "#fff" }}>{onCount}</b> / {ours.length} modules on</span>
                    <span className="vc-hq-chip">profile: <b>{active ?? "—"}</b></span>
                </div>
            </div>

            {pend.size > 0 && (
                <div className="vc-hq-banner" role="status">
                    <span><b>Reload to apply</b> <span className="vc-hq-sub">— {[...pend].join(", ")}</span></span>
                    <Button size="small" onClick={() => location.reload()}>Reload now</Button>
                </div>
            )}

            <div className="vc-hq-nav" role="tablist" aria-label="Szmelc HQ sections" onKeyDown={onKey}>
                {tabs.map(([id, label, n]) => (
                    <button key={id} data-tab={id} className="vc-hq-tab" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
                        {label}{n && <span className="n">{n}</span>}
                    </button>
                ))}
            </div>

            <div role="tabpanel">
                {tab === "modules" && <ModulesPanel />}
                {tab === "profiles" && <ProfilesPanel go={setTab} />}
                {tab === "media" && <MediaPanel />}
                {tab === "installs" && <InstallsPanel />}
                {tab === "themes" && <ThemesPanel />}
                {tab === "look" && <LookPanel />}
            </div>
        </div>
    );
}
