/*
 * Sernicord InstanceScout — with your permission, find other Discord / Vencord / Equicord /
 * Vesktop / BetterDiscord / Sernicord installs on disk, browse what they hold and import it:
 * plugin sets, plugin settings, themes, theme links, QuickCSS, BetterDiscord custom.css,
 * or a whole new switchable profile (ProfileVault, also switchable in the szmelc tab).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { promptToRestart } from "@utils/promptToRestart";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Alerts, Modal, openModal, React, showToast, useEffect, useMemo, useState } from "@webpack/common";
import Plugins from "~plugins";

import { uniqueProfileName, upsertProfile } from "../profileVault/store";
import { Check, Code, cx, Empty, Pill, Sx, Tabs, Toggle } from "../szmelc/kit";
import type { Instance, InstanceDetails } from "./native";

const Author = { name: "sernik", id: 0n };
type Native = PluginNative<typeof import("./native")>;
type ModDetails = InstanceDetails["mods"][number];

function native(): Native | null {
    if (IS_WEB || typeof VencordNative === "undefined") return null;
    return (VencordNative.pluginHelpers.InstanceScout as Native | undefined) ?? null;
}

const KIND_LABEL: Record<Instance["kind"], string> = {
    vencord: "Vencord", equicord: "Equicord", vesktop: "Vesktop", betterdiscord: "BetterDiscord",
    discord: "Discord", sernicord: "Sernicord", custom: "Folder"
};

const err = (e: unknown) => String((e as Error)?.message ?? e);
const toastErr = (e: unknown) => showToast({ text: err(e), variant: "critical" });

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/* ---------- import actions ---------- */

function knownHere(name: string) {
    return Object.prototype.hasOwnProperty.call(Plugins, name);
}

function enabledIn(settings: any): string[] {
    return Object.entries<any>(settings?.plugins ?? {}).filter(([, v]) => v?.enabled).map(([k]) => k).sort();
}

function applyPluginSet(src: any, names: string[], withSettings: boolean, exact: boolean) {
    const here = Settings.plugins;
    let changed = 0;
    if (exact) {
        for (const [name, p] of Object.entries<any>(here)) {
            if (Plugins[name]?.required || !p?.enabled || names.includes(name)) continue;
            p.enabled = false;
            changed++;
        }
    }
    for (const name of names) {
        if (!knownHere(name)) continue;
        const from = src?.plugins?.[name] ?? {};
        here[name] ??= { enabled: false };
        if (withSettings) {
            for (const [k, v] of Object.entries(from)) if (k !== "enabled") (here[name] as any)[k] = structuredClone(v);
        }
        if (!here[name].enabled) changed++;
        here[name].enabled = true;
    }
    return changed;
}

function importThemeLinks(src: any) {
    const links: string[] = Array.isArray(src?.themeLinks) ? src.themeLinks.filter((l: any) => typeof l === "string") : [];
    const fresh = links.filter(l => !Settings.themeLinks.includes(l));
    if (fresh.length) Settings.themeLinks = [...Settings.themeLinks, ...fresh];
    return fresh.length;
}

async function importQuickCss(css: string, mode: "append" | "replace", from: string) {
    const cur = await VencordNative.quickCss.get();
    const block = `/* ── imported by InstanceScout from ${from.replace(/\*\//g, "* /")} ── */\n${css}\n`;
    await VencordNative.quickCss.set(mode === "replace" ? block : `${cur.trimEnd()}\n\n${block}`);
}

async function makeProfile(inst: Instance, mod: ModDetails, extraCss = "") {
    const name = await uniqueProfileName(`${KIND_LABEL[inst.kind]} · ${mod.label}`);
    await upsertProfile({
        name,
        source: `${KIND_LABEL[inst.kind]} @ ${mod.dir}`,
        note: "imported by InstanceScout",
        payload: {
            settings: mod.settings ?? {},
            quickCss: [mod.quickCss, extraCss].filter(Boolean).join("\n\n")
        }
    });
    return name;
}

function confirm(title: string, body: React.ReactNode, onConfirm: () => void) {
    Alerts.show({
        title,
        body,
        confirmText: "Do it",
        cancelText: "Cancel",
        onConfirm
    });
}

/* ---------- browse modal ---------- */

function toggleIn(set: Set<string>, key: string, on: boolean) {
    const n = new Set(set);
    on ? n.add(key) : n.delete(key);
    return n;
}

function ThemeList({ inst, where, themes, enableAfter }: {
    inst: Instance; where: string; themes: InstanceDetails["mods"][number]["themes"]; enableAfter: boolean;
}) {
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [preview, setPreview] = useState<{ name: string; src: string; } | null>(null);
    const [overwrite, setOverwrite] = useState(false);
    const api = native()!;

    const doImport = async (names: string[]) => {
        try {
            const { copied, skipped } = await api.importThemes(inst.root, where, names, overwrite);
            if (enableAfter && copied.length) {
                Settings.enabledThemes = [...new Set([...Settings.enabledThemes, ...copied])];
            }
            showToast({
                text: `Imported ${copied.length} theme(s)${skipped.length ? `, ${skipped.length} already existed` : ""}`,
                variant: copied.length ? "success" : "default"
            });
        } catch (e) { toastErr(e); }
    };

    if (!themes.length) return <Empty>No themes here.</Empty>;
    return (
        <div className="vc-sx-col">
            <div className="vc-sx-row">
                <Button size="small" disabled={!sel.size} onClick={() => doImport([...sel])}>Import selected ({sel.size})</Button>
                <Button size="small" variant="secondary" onClick={() => doImport(themes.map(t => t.fileName))}>Import all</Button>
                <span className="vc-sx-spacer" />
                <Toggle checked={overwrite} onChange={setOverwrite}>Overwrite existing</Toggle>
            </div>
            <div className="vc-sx-col tight">
                {themes.map(t => {
                    const open = preview?.name === t.fileName;
                    return (
                        <div key={t.fileName} className={cx("vc-sx-card compact", sel.has(t.fileName) && "active")}>
                            <div className="vc-sx-row between nowrap">
                                <Check checked={sel.has(t.fileName)} onChange={v => setSel(toggleIn(sel, t.fileName, v))}>
                                    <div className="vc-sx-ellipsis"><b>{t.name ?? t.fileName}</b></div>
                                    <div className="vc-sx-muted">
                                        {t.author ? `by ${t.author} · ` : ""}{(t.size / 1024).toFixed(1)} KB
                                        {t.description ? ` · ${t.description}` : ""}
                                    </div>
                                </Check>
                                <div className="vc-sx-row nowrap">
                                    <Button size="small" variant="secondary" onClick={async () => {
                                        if (open) return setPreview(null);
                                        try { setPreview({ name: t.fileName, src: await api.readSource(inst.root, where, t.fileName) }); } catch (e) { toastErr(e); }
                                    }}>{open ? "Hide" : "View"}</Button>
                                    <Button size="small" onClick={() => doImport([t.fileName])}>Import</Button>
                                </div>
                            </div>
                            {open && <Code text={preview.src} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PluginSetView({ mod }: { mod: ModDetails; }) {
    const enabled = useMemo(() => enabledIn(mod.settings), [mod]);
    const [sel, setSel] = useState<Set<string>>(() => new Set(enabled.filter(knownHere)));
    const [withSettings, setWithSettings] = useState(true);
    const [filter, setFilter] = useState<"all" | "here" | "missing">("all");
    const shown = enabled.filter(n => filter === "all" || (filter === "here") === knownHere(n));
    const missing = enabled.filter(n => !knownHere(n)).length;

    const apply = (exact: boolean) => confirm(
        exact ? "Mirror this plugin set" : "Enable selected plugins",
        <>
            <Paragraph>
                {exact
                    ? `Enable the ${sel.size} selected plugins and disable every other non-required plugin here.`
                    : `Enable ${sel.size} plugins here (nothing gets disabled).`}
                {withSettings ? " Their settings from the source are copied too." : ""}
            </Paragraph>
            <Paragraph className="vc-sx-hint" style={{ marginTop: 8 }}>Tip: save a profile first (szmelc tab → Profiles) so you can switch back.</Paragraph>
        </>,
        () => {
            const n = applyPluginSet(mod.settings, [...sel], withSettings, exact);
            showToast({ text: `${n} plugin(s) changed`, variant: "success" });
            promptToRestart("reload");
        }
    );

    if (!mod.settings) {
        return <Empty>{mod.settingsError ? `settings.json unreadable: ${mod.settingsError}` : "No settings.json here."}</Empty>;
    }
    return (
        <div className="vc-sx-col">
            <div className="vc-sx-pills">
                <Pill tone="accent">{enabled.length} enabled there</Pill>
                <Pill>{enabled.length - missing} available here</Pill>
                {missing > 0 && <Pill tone="danger">{missing} not installed here</Pill>}
            </div>
            <div className="vc-sx-row">
                <Button size="small" disabled={!sel.size} onClick={() => apply(false)}>Enable selected ({sel.size})</Button>
                <Button size="small" variant="dangerSecondary" disabled={!sel.size} onClick={() => apply(true)}>Mirror exactly</Button>
                <Toggle checked={withSettings} onChange={setWithSettings}>Copy plugin settings</Toggle>
                <span className="vc-sx-spacer" />
                <Tabs<"all" | "here" | "missing"> inline label="Filter" value={filter} onChange={setFilter} tabs={[["all", "All"], ["here", "Here"], ["missing", "Missing"]]} />
            </div>
            {shown.length
                ? (
                    <div className="vc-sx-grid vc-sx-scroll" style={{ gap: 2 }}>
                        {shown.map(n => {
                            const ok = knownHere(n);
                            return (
                                <Check key={n} disabled={!ok} checked={sel.has(n)} title={ok ? undefined : "not installed in this client"} onChange={v => setSel(toggleIn(sel, n, v))}>
                                    <span className="vc-sx-ellipsis">{n}</span>
                                </Check>
                            );
                        })}
                    </div>
                )
                : <Empty>Nothing in this filter.</Empty>}
        </div>
    );
}

function ModView({ inst, mod }: { inst: Instance; mod: ModDetails; }) {
    const [tab, setTab] = useState<"overview" | "plugins" | "themes" | "css" | "raw">("overview");
    const links: string[] = Array.isArray(mod.settings?.themeLinks) ? mod.settings.themeLinks : [];
    const [enableAfter, setEnableAfter] = useState(true);
    const pluginCount = enabledIn(mod.settings).length;

    return (
        <section className="vc-sx-card">
            <div className="vc-sx-col tight">
                <h4>{mod.label}</h4>
                <div className="vc-sx-mono vc-sx-muted">{mod.dir}</div>
            </div>
            <Tabs<"overview" | "plugins" | "themes" | "css" | "raw"> label={`${mod.label} sections`} value={tab} onChange={setTab} tabs={[
                ["overview", "Overview"],
                ["plugins", "Plugins", pluginCount],
                ["themes", "Themes", mod.themes.length],
                ["css", "QuickCSS"],
                ["raw", "settings.json"]
            ]} />
            {tab === "overview" && (
                <div className="vc-sx-col">
                    <div className="vc-sx-pills">
                        <Pill tone="accent">{pluginCount} plugins on</Pill>
                        <Pill>{mod.themes.length} themes</Pill>
                        <Pill>{(mod.settings?.enabledThemes ?? []).length} themes on</Pill>
                        <Pill>{links.length} theme links</Pill>
                        <Pill>{mod.quickCss ? `QuickCSS ${(mod.quickCss.length / 1024).toFixed(1)} KB` : "no QuickCSS"}</Pill>
                    </div>
                    <div className="vc-sx-row">
                        <Button size="small" variant="positive" disabled={!mod.settings} onClick={async () => {
                            try {
                                showToast({ text: `Profile "${await makeProfile(inst, mod)}" created — switch to it in the szmelc tab`, variant: "success" });
                            } catch (e) { toastErr(e); }
                        }}>New profile from this</Button>
                        <Button size="small" variant="secondary" disabled={!links.length} onClick={() => {
                            const n = importThemeLinks(mod.settings);
                            showToast({ text: n ? `Added ${n} theme link(s)` : "All theme links already present", variant: n ? "success" : "default" });
                        }}>Import theme links</Button>
                        <Button size="small" variant="secondary" disabled={!mod.quickCss} onClick={() => importQuickCss(mod.quickCss, "append", mod.dir)
                            .then(() => showToast({ text: "QuickCSS appended", variant: "success" })).catch(toastErr)}>Append QuickCSS</Button>
                    </div>
                    <p className="vc-sx-hint">Pick single plugins or themes in their tabs above.</p>
                </div>
            )}
            {tab === "plugins" && <PluginSetView mod={mod} />}
            {tab === "themes" && (
                <div className="vc-sx-col">
                    <Toggle checked={enableAfter} onChange={setEnableAfter}>Enable themes after import</Toggle>
                    <ThemeList inst={inst} where={mod.dir} themes={mod.themes} enableAfter={enableAfter} />
                </div>
            )}
            {tab === "css" && (
                <div className="vc-sx-col">
                    <div className="vc-sx-row">
                        <Button size="small" disabled={!mod.quickCss} onClick={() => importQuickCss(mod.quickCss, "append", mod.dir)
                            .then(() => showToast({ text: "QuickCSS appended", variant: "success" })).catch(toastErr)}>Append to mine</Button>
                        <Button size="small" variant="dangerSecondary" disabled={!mod.quickCss} onClick={() => confirm(
                            "Replace your QuickCSS?", <Paragraph>Your current QuickCSS is overwritten.</Paragraph>,
                            () => importQuickCss(mod.quickCss, "replace", mod.dir).then(() => showToast({ text: "QuickCSS replaced", variant: "success" })).catch(toastErr)
                        )}>Replace mine</Button>
                    </div>
                    <Code text={mod.quickCss} />
                </div>
            )}
            {tab === "raw" && <Code text={mod.settings ? JSON.stringify(mod.settings, null, 2) : mod.settingsError ?? "(none)"} max={400} />}
        </section>
    );
}

function BdView({ inst, bd }: { inst: Instance; bd: NonNullable<InstanceDetails["bd"]>; }) {
    const [tab, setTab] = useState<"themes" | "plugins" | "css">(bd.themes.length ? "themes" : bd.plugins.length ? "plugins" : "css");
    const [src, setSrc] = useState<{ name: string; text: string; } | null>(null);
    const api = native()!;
    return (
        <section className="vc-sx-card">
            <h4>BetterDiscord <Pill tone="danger">BdApi</Pill></h4>
            <Tabs<"themes" | "plugins" | "css"> label="BetterDiscord sections" value={tab} onChange={setTab} tabs={[["themes", "Themes", bd.themes.length], ["plugins", "Plugins", bd.plugins.length], ["css", "custom.css"]]} />
            {tab === "themes" && <ThemeList inst={inst} where="bd-themes" themes={bd.themes} enableAfter />}
            {tab === "plugins" && (
                <div className="vc-sx-col">
                    <p className="vc-sx-hint">
                        BetterDiscord <code>.plugin.js</code> files use the BdApi and cannot run on Vencord. Browse them here;
                        many have a Vencord / Equicord counterpart with the same name.
                    </p>
                    {!bd.plugins.length && <Empty>No BetterDiscord plugins.</Empty>}
                    <div className="vc-sx-col tight">
                        {bd.plugins.map(p => {
                            const open = src?.name === p.fileName;
                            return (
                                <div key={p.fileName} className="vc-sx-card compact">
                                    <div className="vc-sx-row between nowrap">
                                        <div className="vc-sx-grow">
                                            <div className="vc-sx-row" style={{ gap: 6 }}>
                                                <b className="vc-sx-ellipsis">{p.name ?? p.fileName}</b>
                                                {knownHere(p.name ?? "") && <Pill tone="accent">Vencord has it</Pill>}
                                            </div>
                                            <div className="vc-sx-muted">
                                                {[p.version && `v${p.version}`, p.author, p.description].filter(Boolean).join(" · ")}
                                            </div>
                                        </div>
                                        <Button size="small" variant="secondary" onClick={async () => {
                                            if (open) return setSrc(null);
                                            try { setSrc({ name: p.fileName, text: await api.readSource(inst.root, "bd-plugins", p.fileName) }); } catch (e) { toastErr(e); }
                                        }}>{open ? "Hide" : "Source"}</Button>
                                    </div>
                                    {open && <Code text={src.text} />}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            {tab === "css" && (
                <div className="vc-sx-col">
                    <div className="vc-sx-row">
                        <Button size="small" disabled={!bd.customCss} onClick={() => importQuickCss(bd.customCss, "append", `${inst.root} (BD custom.css)`)
                            .then(() => showToast({ text: "custom.css appended to QuickCSS", variant: "success" })).catch(toastErr)}>Append to my QuickCSS</Button>
                    </div>
                    <Code text={bd.customCss} />
                </div>
            )}
        </section>
    );
}

function BrowseModal({ inst, modalProps }: { inst: Instance; modalProps: any; }) {
    const [d, setD] = useState<InstanceDetails | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { native()!.details(inst.root, inst.kind).then(setD, e => setError(err(e))); }, [inst.root]);

    return (
        <Modal {...modalProps} size="xl" title={`${KIND_LABEL[inst.kind]} — ${inst.label}`} subtitle={inst.root}>
            <Sx pad>
                {error && <div className="vc-sx-card danger"><span className="vc-sx-err">{error}</span></div>}
                {!d && !error && <Empty>Reading…</Empty>}
                {d && (
                    <>
                        {d.mods.map(m => <ModView key={m.dir} inst={inst} mod={m} />)}
                        {d.bd && <BdView inst={inst} bd={d.bd} />}
                        {d.userplugins.length > 0 && (
                            <section className="vc-sx-card">
                                <h4>Source userplugins <Pill>{d.userplugins.length}</Pill></h4>
                                <div className="vc-sx-pills">
                                    {d.userplugins.map(p => <Pill key={p} tone={knownHere(p) ? "accent" : "grey"}>{p}</Pill>)}
                                </div>
                                <p className="vc-sx-hint">Source plugins need a rebuild. Copy them into Sernicord with:</p>
                                <Code text={`./sernicord scan --import plugins --from ${shq(inst.root)}`} />
                            </section>
                        )}
                        {inst.caps.session && (
                            <section className="vc-sx-card">
                                <h4>Discord session</h4>
                                <p className="vc-sx-hint">Login data is never copied from inside a running client. Stop Discord and use the CLI:</p>
                                <Code text={`./sernicord stop && ./sernicord scan --import cache --from ${shq(inst.root)}`} />
                            </section>
                        )}
                        {!d.mods.length && !d.bd && !d.userplugins.length && !inst.caps.session && <Empty>Nothing importable here.</Empty>}
                    </>
                )}
            </Sx>
        </Modal>
    );
}

/* ---------- main panel ---------- */

const settings = definePluginSettings({
    consent: {
        type: OptionType.BOOLEAN,
        description: "Allow InstanceScout to look for other Discord / Vencord / BetterDiscord installs on this computer (read-only)",
        default: false
    },
    extraRoots: {
        type: OptionType.STRING,
        description: "Extra folders to scan, one per line",
        default: "",
        multiline: true
    },
    panel: {
        type: OptionType.COMPONENT,
        component: () => <ScoutPanel />
    }
});

function extraRoots() {
    return settings.store.extraRoots.split("\n").map(s => s.trim()).filter(Boolean);
}

let lastScan: Instance[] | null = null;

export function ScoutPanel() {
    const { consent } = settings.use(["consent"]);
    const [list, setList] = useState<Instance[] | null>(lastScan);
    const [busy, setBusy] = useState(false);
    const api = native();

    const run = async () => {
        if (!api) return;
        setBusy(true);
        try {
            lastScan = await api.scan(extraRoots());
            setList(lastScan);
        } catch (e) { toastErr(e); } finally { setBusy(false); }
    };

    useEffect(() => { if (consent && !lastScan) run(); }, [consent]);

    if (!api) return <Sx><Empty>InstanceScout needs the desktop client (native side). Restart Discord fully after enabling it.</Empty></Sx>;

    if (!consent) {
        return (
            <Sx>
                <section className="vc-sx-card">
                    <h4>Find other Discord installs?</h4>
                    <p className="vc-sx-hint">
                        InstanceScout looks in the usual places (Discord stable/PTB/Canary, Vencord, Equicord, Vesktop,
                        BetterDiscord, Flatpak/Snap, Sernicord checkouts) and in folders you add. It only <b>reads</b>;
                        nothing is imported until you click an import button, and login data is never touched.
                    </p>
                    <div className="vc-sx-row"><Button onClick={() => { settings.store.consent = true; }}>Allow and scan</Button></div>
                </section>
            </Sx>
        );
    }

    return (
        <Sx>
            <div className="vc-sx-row">
                <Button size="small" disabled={busy} onClick={run}>{busy ? "Scanning…" : "Rescan"}</Button>
                <Button size="small" variant="secondary" onClick={async () => {
                    try {
                        const p = await api.pickFolder();
                        if (!p) return;
                        if (!extraRoots().includes(p)) settings.store.extraRoots = [...extraRoots(), p].join("\n");
                        await run();
                    } catch (e) { toastErr(e); }
                }}>Add folder…</Button>
                {list && <span className="vc-sx-muted">{list.length} install(s) found</span>}
                <span className="vc-sx-spacer" />
                <Button size="small" variant="dangerSecondary" onClick={() => { settings.store.consent = false; lastScan = null; setList(null); }}>Revoke permission</Button>
            </div>
            {!list && busy && <Empty>Scanning…</Empty>}
            {list?.length === 0 && <Empty>No other installs found. Add a folder by hand.</Empty>}
            {list?.map(inst => (
                <section key={inst.id} className="vc-sx-card">
                    <div className="vc-sx-row between nowrap">
                        <div className="vc-sx-col tight vc-sx-grow">
                            <div className="vc-sx-title">
                                <Pill tone={inst.kind === "betterdiscord" ? "danger" : "accent"}>{KIND_LABEL[inst.kind]}</Pill>
                                <span className="vc-sx-ellipsis">{inst.label}</span>
                            </div>
                            <div className="vc-sx-mono vc-sx-muted">{inst.root}</div>
                            <div className="vc-sx-pills">
                                {inst.caps.settings && <Pill tone="outline">settings</Pill>}
                                {inst.caps.quickCss && <Pill tone="outline">QuickCSS</Pill>}
                                {inst.caps.themes > 0 && <Pill tone="outline">{inst.caps.themes} themes</Pill>}
                                {inst.caps.bdPlugins > 0 && <Pill tone="outline">{inst.caps.bdPlugins} BD plugins</Pill>}
                                {inst.caps.bdCustomCss && <Pill tone="outline">custom.css</Pill>}
                                {inst.caps.userplugins > 0 && <Pill tone="outline">{inst.caps.userplugins} userplugins</Pill>}
                                {inst.caps.session && <Pill tone="outline">session</Pill>}
                                {inst.mods.length > 1 && <Pill tone="aqua">{inst.mods.length} profiles</Pill>}
                            </div>
                        </div>
                        <div className="vc-sx-col tight" style={{ flex: "none" }}>
                            <Button size="small" onClick={() => openModal(p => <BrowseModal inst={inst} modalProps={p} />)}>Browse & import</Button>
                            <Button size="small" variant="secondary" onClick={() => api.openFolder(inst.root).then(e => e && toastErr(e)).catch(toastErr)}>Open folder</Button>
                        </div>
                    </div>
                </section>
            ))}
        </Sx>
    );
}

export function openScout() {
    openModal(p => (
        <Modal {...p} size="lg" title="InstanceScout" subtitle="Other Discord / Vencord / BetterDiscord installs on this computer">
            <div style={{ padding: "4px 0 12px" }}><ScoutPanel /></div>
        </Modal>
    ));
}

export default definePlugin({
    name: "InstanceScout",
    description: "With your permission, finds other Discord / Vencord / Equicord / Vesktop / BetterDiscord / Sernicord installs on disk; browse them and import plugin sets, plugin settings, themes, theme links, QuickCSS, or make a switchable profile from them.",
    authors: [Author],
    tags: ["Utility", "Customisation", "Organisation"],
    settings,
    toolboxActions: {
        "Find other installs"() { openScout(); }
    }
});
