/*
 * Sernicord InstanceScout — with your permission, find other Discord / Vencord / Equicord /
 * Vesktop / BetterDiscord / Sernicord installs on disk, browse what they hold and import it:
 * plugin sets, plugin settings, themes, theme links, QuickCSS, BetterDiscord custom.css,
 * or a whole new switchable profile (ProfileVault, also switchable in the szmelc tab).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { promptToRestart } from "@utils/promptToRestart";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Alerts, Modal, openModal, React, showToast, useEffect, useMemo, useState } from "@webpack/common";
import Plugins from "~plugins";

import { uniqueProfileName, upsertProfile } from "../profileVault/store";
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

/* ---------- small UI bits (Szmelc palette, no purple) ---------- */

function Pill({ children, tone = "grey" }: { children: React.ReactNode; tone?: "grey" | "accent" | "danger" | "aqua"; }) {
    const bg = { grey: "#262626", accent: "#105c5c", danger: "#750f0f", aqua: "#7fffd4" }[tone];
    const fg = tone === "aqua" ? "#000" : tone === "grey" ? "#c0c0c0" : "#fff";
    return (
        <span style={{
            display: "inline-block", padding: "1px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: bg, color: fg, marginRight: 4, marginBottom: 2, whiteSpace: "nowrap"
        }}>{children}</span>
    );
}

const card: React.CSSProperties = {
    padding: 12, borderRadius: 8, background: "var(--background-secondary)",
    border: "1px solid var(--background-modifier-accent)"
};
const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };
const mono: React.CSSProperties = { fontFamily: "var(--font-code)", fontSize: 12 };

function Code({ text, max = 320 }: { text: string; max?: number; }) {
    return (
        <pre style={{
            ...mono, maxHeight: max, overflow: "auto", margin: 0, padding: 10, borderRadius: 6,
            background: "#0b0b0b", color: "#dcdddd", border: "1px solid #262626", whiteSpace: "pre-wrap", wordBreak: "break-word"
        }}>{text || "(empty)"}</pre>
    );
}

function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange(v: T): void; tabs: Array<[NoInfer<T>, string, number?]>; }) {
    return (
        <div style={{ ...row, gap: 4, marginBottom: 10, borderBottom: "1px solid #262626", paddingBottom: 6 }}>
            {tabs.map(([id, label, count]) => (
                <Button key={id} size="small" variant={value === id ? "primary" : "secondary"} onClick={() => onChange(id)}>
                    {label}{count != null ? ` (${count})` : ""}
                </Button>
            ))}
        </div>
    );
}

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

function confirm(title: string, body: React.ReactNode, onConfirm: () => void, _danger = false) {
    Alerts.show({
        title,
        body,
        confirmText: "Do it",
        cancelText: "Cancel",
        onConfirm
    });
}

/* ---------- browse modal ---------- */

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

    if (!themes.length) return <Paragraph style={{ opacity: 0.7 }}>No themes here.</Paragraph>;
    return (
        <div style={{ display: "grid", gap: 6 }}>
            <div style={row}>
                <Button size="small" disabled={!sel.size} onClick={() => doImport([...sel])}>Import selected ({sel.size})</Button>
                <Button size="small" variant="secondary" onClick={() => doImport(themes.map(t => t.fileName))}>Import all</Button>
                <span style={{ ...row, marginLeft: 8 }}>
                    <Switch checked={overwrite} onChange={setOverwrite} /> <span style={{ fontSize: 12 }}>overwrite existing</span>
                </span>
            </div>
            {themes.map(t => (
                <div key={t.fileName} style={{ ...card, padding: 8 }}>
                    <div style={{ ...row, justifyContent: "space-between" }}>
                        <label style={{ ...row, cursor: "pointer", minWidth: 0 }}>
                            <input
                                type="checkbox"
                                checked={sel.has(t.fileName)}
                                onChange={e => {
                                    const n = new Set(sel);
                                    e.currentTarget.checked ? n.add(t.fileName) : n.delete(t.fileName);
                                    setSel(n);
                                }}
                            />
                            <span>
                                <b>{t.name ?? t.fileName}</b>
                                <span style={{ opacity: 0.6, fontSize: 12 }}> {t.author ? `by ${t.author} · ` : ""}{(t.size / 1024).toFixed(1)} KB</span>
                                {t.description && <div style={{ fontSize: 12, opacity: 0.7 }}>{t.description}</div>}
                            </span>
                        </label>
                        <div style={row}>
                            <Button size="small" variant="secondary" onClick={async () => {
                                if (preview?.name === t.fileName) return setPreview(null);
                                try { setPreview({ name: t.fileName, src: await api.readSource(inst.root, where, t.fileName) }); } catch (e) { toastErr(e); }
                            }}>{preview?.name === t.fileName ? "Hide" : "View"}</Button>
                            <Button size="small" onClick={() => doImport([t.fileName])}>Import</Button>
                        </div>
                    </div>
                    {preview?.name === t.fileName && <div style={{ marginTop: 8 }}><Code text={preview.src} /></div>}
                </div>
            ))}
        </div>
    );
}

function PluginSetView({ inst, mod }: { inst: Instance; mod: ModDetails; }) {
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
            <Paragraph style={{ opacity: 0.7, marginTop: 8 }}>Tip: save a profile first (szmelc tab → Profiles) so you can switch back.</Paragraph>
        </>,
        () => {
            const n = applyPluginSet(mod.settings, [...sel], withSettings, exact);
            showToast({ text: `${n} plugin(s) changed`, variant: "success" });
            promptToRestart("reload");
        },
        exact
    );

    if (!mod.settings) {
        return <Paragraph style={{ opacity: 0.7 }}>{mod.settingsError ? `settings.json unreadable: ${mod.settingsError}` : "No settings.json here."}</Paragraph>;
    }
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <div style={row}>
                <Pill tone="accent">{enabled.length} enabled there</Pill>
                <Pill>{enabled.length - missing} available here</Pill>
                {missing > 0 && <Pill tone="danger">{missing} not installed here</Pill>}
            </div>
            <div style={row}>
                <Button size="small" disabled={!sel.size} onClick={() => apply(false)}>Enable selected ({sel.size})</Button>
                <Button size="small" variant="dangerSecondary" disabled={!sel.size} onClick={() => apply(true)}>Mirror exactly</Button>
                <span style={{ ...row, marginLeft: 8 }}><Switch checked={withSettings} onChange={setWithSettings} /> <span style={{ fontSize: 12 }}>copy plugin settings</span></span>
                <span style={{ flex: 1 }} />
                <Tabs<"all" | "here" | "missing"> value={filter} onChange={setFilter} tabs={[["all", "All"], ["here", "Here"], ["missing", "Missing"]]} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4, maxHeight: 340, overflow: "auto" }}>
                {shown.map(n => {
                    const ok = knownHere(n);
                    return (
                        <label key={n} style={{ ...row, fontSize: 13, opacity: ok ? 1 : 0.5, cursor: ok ? "pointer" : "default" }} title={ok ? "" : "not installed in this client"}>
                            <input
                                type="checkbox"
                                disabled={!ok}
                                checked={sel.has(n)}
                                onChange={e => {
                                    const s = new Set(sel);
                                    e.currentTarget.checked ? s.add(n) : s.delete(n);
                                    setSel(s);
                                }}
                            />
                            {n}
                        </label>
                    );
                })}
            </div>
        </div>
    );
}

function ModView({ inst, mod }: { inst: Instance; mod: ModDetails; }) {
    const [tab, setTab] = useState<"overview" | "plugins" | "themes" | "css" | "raw">("overview");
    const links: string[] = Array.isArray(mod.settings?.themeLinks) ? mod.settings.themeLinks : [];
    const [enableAfter, setEnableAfter] = useState(true);

    return (
        <div style={{ ...card, marginBottom: 10 }}>
            <Heading tag="h5" style={{ margin: "0 0 2px" }}>{mod.label}</Heading>
            <Paragraph style={{ ...mono, opacity: 0.6, marginBottom: 8 }}>{mod.dir}</Paragraph>
            <Tabs<"overview" | "plugins" | "themes" | "css" | "raw"> value={tab} onChange={setTab} tabs={[
                ["overview", "Overview"],
                ["plugins", "Plugins", enabledIn(mod.settings).length],
                ["themes", "Themes", mod.themes.length],
                ["css", "QuickCSS"],
                ["raw", "settings.json"]
            ]} />
            {tab === "overview" && (
                <div style={{ display: "grid", gap: 8 }}>
                    <div style={row}>
                        <Pill tone="accent">{enabledIn(mod.settings).length} plugins on</Pill>
                        <Pill>{mod.themes.length} themes</Pill>
                        <Pill>{(mod.settings?.enabledThemes ?? []).length} themes on</Pill>
                        <Pill>{links.length} theme links</Pill>
                        <Pill>{mod.quickCss ? `QuickCSS ${(mod.quickCss.length / 1024).toFixed(1)} KB` : "no QuickCSS"}</Pill>
                    </div>
                    <div style={row}>
                        <Button size="small" variant="positive" disabled={!mod.settings} onClick={async () => {
                            try {
                                showToast({ text: `Profile "${await makeProfile(inst, mod)}" created — switch to it in the szmelc tab`, variant: "success" });
                            } catch (e) { toastErr(e); }
                        }}>New profile from this</Button>
                        <Button size="small" disabled={!links.length} onClick={() => {
                            const n = importThemeLinks(mod.settings);
                            showToast({ text: n ? `Added ${n} theme link(s)` : "All theme links already present", variant: n ? "success" : "default" });
                        }}>Import theme links</Button>
                        <Button size="small" disabled={!mod.quickCss} onClick={() => importQuickCss(mod.quickCss, "append", mod.dir)
                            .then(() => showToast({ text: "QuickCSS appended", variant: "success" })).catch(toastErr)}>Append QuickCSS</Button>
                        <Button size="small" variant="secondary" onClick={() => setTab("plugins")}>Pick plugins…</Button>
                        <Button size="small" variant="secondary" onClick={() => setTab("themes")}>Pick themes…</Button>
                    </div>
                </div>
            )}
            {tab === "plugins" && <PluginSetView inst={inst} mod={mod} />}
            {tab === "themes" && (
                <>
                    <div style={{ ...row, marginBottom: 6 }}><Switch checked={enableAfter} onChange={setEnableAfter} /> <span style={{ fontSize: 12 }}>enable themes after import</span></div>
                    <ThemeList inst={inst} where={mod.dir} themes={mod.themes} enableAfter={enableAfter} />
                </>
            )}
            {tab === "css" && (
                <div style={{ display: "grid", gap: 6 }}>
                    <div style={row}>
                        <Button size="small" disabled={!mod.quickCss} onClick={() => importQuickCss(mod.quickCss, "append", mod.dir)
                            .then(() => showToast({ text: "QuickCSS appended", variant: "success" })).catch(toastErr)}>Append to mine</Button>
                        <Button size="small" variant="dangerSecondary" disabled={!mod.quickCss} onClick={() => confirm(
                            "Replace your QuickCSS?", <Paragraph>Your current QuickCSS is overwritten.</Paragraph>,
                            () => importQuickCss(mod.quickCss, "replace", mod.dir).then(() => showToast({ text: "QuickCSS replaced", variant: "success" })).catch(toastErr),
                            true
                        )}>Replace mine</Button>
                    </div>
                    <Code text={mod.quickCss} />
                </div>
            )}
            {tab === "raw" && <Code text={mod.settings ? JSON.stringify(mod.settings, null, 2) : mod.settingsError ?? "(none)"} max={400} />}
        </div>
    );
}

function BdView({ inst, bd }: { inst: Instance; bd: NonNullable<InstanceDetails["bd"]>; }) {
    const [tab, setTab] = useState<"themes" | "plugins" | "css">(bd.themes.length ? "themes" : bd.plugins.length ? "plugins" : "css");
    const [src, setSrc] = useState<{ name: string; text: string; } | null>(null);
    const api = native()!;
    return (
        <div style={{ ...card, marginBottom: 10 }}>
            <Heading tag="h5" style={{ margin: "0 0 8px" }}>BetterDiscord</Heading>
            <Tabs<"themes" | "plugins" | "css"> value={tab} onChange={setTab} tabs={[["themes", "Themes", bd.themes.length], ["plugins", "Plugins", bd.plugins.length], ["css", "custom.css"]]} />
            {tab === "themes" && <ThemeList inst={inst} where="bd-themes" themes={bd.themes} enableAfter />}
            {tab === "plugins" && (
                <div style={{ display: "grid", gap: 6 }}>
                    <Paragraph style={{ fontSize: 12, opacity: 0.75 }}>
                        BetterDiscord <code>.plugin.js</code> files use the BdApi and cannot run on Vencord. Browse them here;
                        many have a Vencord / Equicord counterpart with the same name.
                    </Paragraph>
                    {bd.plugins.map(p => (
                        <div key={p.fileName} style={{ ...card, padding: 8 }}>
                            <div style={{ ...row, justifyContent: "space-between" }}>
                                <span>
                                    <b>{p.name ?? p.fileName}</b> <span style={{ opacity: 0.6, fontSize: 12 }}>{p.version ? `v${p.version} · ` : ""}{p.author ?? ""}</span>
                                    {knownHere(p.name ?? "") && <Pill tone="accent">Vencord has it</Pill>}
                                    {p.description && <div style={{ fontSize: 12, opacity: 0.7 }}>{p.description}</div>}
                                </span>
                                <Button size="small" variant="secondary" onClick={async () => {
                                    if (src?.name === p.fileName) return setSrc(null);
                                    try { setSrc({ name: p.fileName, text: await api.readSource(inst.root, "bd-plugins", p.fileName) }); } catch (e) { toastErr(e); }
                                }}>{src?.name === p.fileName ? "Hide" : "Source"}</Button>
                            </div>
                            {src?.name === p.fileName && <div style={{ marginTop: 8 }}><Code text={src.text} /></div>}
                        </div>
                    ))}
                </div>
            )}
            {tab === "css" && (
                <div style={{ display: "grid", gap: 6 }}>
                    <div style={row}>
                        <Button size="small" disabled={!bd.customCss} onClick={() => importQuickCss(bd.customCss, "append", `${inst.root} (BD custom.css)`)
                            .then(() => showToast({ text: "custom.css appended to QuickCSS", variant: "success" })).catch(toastErr)}>Append to my QuickCSS</Button>
                    </div>
                    <Code text={bd.customCss} />
                </div>
            )}
        </div>
    );
}

function BrowseModal({ inst, modalProps }: { inst: Instance; modalProps: any; }) {
    const [d, setD] = useState<InstanceDetails | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { native()!.details(inst.root, inst.kind).then(setD, e => setError(err(e))); }, [inst.root]);

    return (
        <Modal {...modalProps} size="xl" title={`${KIND_LABEL[inst.kind]} — ${inst.label}`} subtitle={inst.root}>
            <div style={{ padding: "4px 0 12px" }}>
                {error && <Paragraph style={{ color: "#b83a3a" }}>{error}</Paragraph>}
                {!d && !error && <Paragraph>Reading…</Paragraph>}
                {d && (
                    <>
                        {d.mods.map(m => <ModView key={m.dir} inst={inst} mod={m} />)}
                        {d.bd && <BdView inst={inst} bd={d.bd} />}
                        {d.userplugins.length > 0 && (
                            <div style={{ ...card, marginBottom: 10 }}>
                                <Heading tag="h5" style={{ margin: "0 0 6px" }}>Source userplugins ({d.userplugins.length})</Heading>
                                <div style={{ ...row, marginBottom: 8 }}>
                                    {d.userplugins.map(p => <Pill key={p} tone={knownHere(p) ? "accent" : "grey"}>{p}</Pill>)}
                                </div>
                                <Paragraph style={{ fontSize: 12, opacity: 0.75 }}>Source plugins need a rebuild. Copy them into Sernicord with:</Paragraph>
                                <Code text={`./sernicord scan --import plugins --from '${inst.root.replace(/'/g, "'\\''")}'`} />
                            </div>
                        )}
                        {inst.caps.session && (
                            <div style={{ ...card, marginBottom: 10 }}>
                                <Heading tag="h5" style={{ margin: "0 0 6px" }}>Discord session</Heading>
                                <Paragraph style={{ fontSize: 12, opacity: 0.75 }}>
                                    Login data is never copied from inside a running client. Stop Discord and use the CLI:
                                </Paragraph>
                                <Code text={`./sernicord stop && ./sernicord scan --import cache --from '${inst.root.replace(/'/g, "'\\''")}'`} />
                            </div>
                        )}
                        {!d.mods.length && !d.bd && !d.userplugins.length && !inst.caps.session && <Paragraph>Nothing importable here.</Paragraph>}
                    </>
                )}
            </div>
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

    if (!api) return <Paragraph>InstanceScout needs the desktop client (native side). Restart Discord fully after enabling it.</Paragraph>;

    if (!consent) {
        return (
            <div style={card}>
                <Heading tag="h5" style={{ marginTop: 0 }}>Find other Discord installs?</Heading>
                <Paragraph style={{ marginBottom: 10 }}>
                    InstanceScout looks in the usual places (Discord stable/PTB/Canary, Vencord, Equicord, Vesktop,
                    BetterDiscord, Flatpak/Snap, Sernicord checkouts) and in folders you add. It only <b>reads</b>;
                    nothing is imported until you click an import button, and login data is never touched.
                </Paragraph>
                <Button onClick={() => { settings.store.consent = true; }}>Allow and scan</Button>
            </div>
        );
    }

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={row}>
                <Button size="small" disabled={busy} onClick={run}>{busy ? "Scanning…" : "Rescan"}</Button>
                <Button size="small" variant="secondary" onClick={async () => {
                    try {
                        const p = await api.pickFolder();
                        if (!p) return;
                        if (!extraRoots().includes(p)) settings.store.extraRoots = [...extraRoots(), p].join("\n");
                        await run();
                    } catch (e) { toastErr(e); }
                }}>Add folder…</Button>
                <span style={{ flex: 1 }} />
                <Button size="small" variant="dangerSecondary" onClick={() => { settings.store.consent = false; lastScan = null; setList(null); }}>Revoke permission</Button>
            </div>
            {list?.length === 0 && <Paragraph style={{ opacity: 0.7 }}>No other installs found. Add a folder by hand.</Paragraph>}
            {list?.map(inst => (
                <div key={inst.id} style={card}>
                    <div style={{ ...row, justifyContent: "space-between" }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={row}>
                                <Pill tone={inst.kind === "betterdiscord" ? "danger" : "accent"}>{KIND_LABEL[inst.kind]}</Pill>
                                <b>{inst.label}</b>
                            </div>
                            <div style={{ ...mono, opacity: 0.6, margin: "2px 0 6px", overflowWrap: "anywhere" }}>{inst.root}</div>
                            <div>
                                {inst.caps.settings && <Pill>settings</Pill>}
                                {inst.caps.quickCss && <Pill>QuickCSS</Pill>}
                                {inst.caps.themes > 0 && <Pill>{inst.caps.themes} themes</Pill>}
                                {inst.caps.bdPlugins > 0 && <Pill>{inst.caps.bdPlugins} BD plugins</Pill>}
                                {inst.caps.bdCustomCss && <Pill>custom.css</Pill>}
                                {inst.caps.userplugins > 0 && <Pill>{inst.caps.userplugins} userplugins</Pill>}
                                {inst.caps.session && <Pill>session</Pill>}
                                {inst.mods.length > 1 && <Pill tone="aqua">{inst.mods.length} profiles</Pill>}
                            </div>
                        </div>
                        <div style={row}>
                            <Button size="small" onClick={() => openModal(p => <BrowseModal inst={inst} modalProps={p} />)}>Browse & import</Button>
                            <Button size="small" variant="secondary" onClick={() => api.openFolder(inst.root).then(e => e && toastErr(e)).catch(toastErr)}>Open</Button>
                        </div>
                    </div>
                </div>
            ))}
        </div>
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
