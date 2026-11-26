/*
 * Sernicord MediaForge — Studio UI (one modal: media list · preview · tools · jobs)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { ChannelStore, DraftType, Modal, openModal, React, showToast, UploadHandler, useEffect, useMemo, useState } from "@webpack/common";

import {
    addFromFile, addFromUrl, addItem, api, assetName, clearItems, createEmoji, createSound, createSticker, errText,
    expressionGuilds, getItems, limitFor, MediaItem, removeItem, runJob, subscribe, uploadToChannel
} from "./client";
import type { FileInfo, JobSpec, JobStatus, PlayerStatus, ToolStatus } from "./native";
import { EditOptions, humanBytes, LIMITS, Target } from "./planner";

export const STUDIO_CSS = `
.vc-mf { display: grid; grid-template-columns: 260px 1fr; gap: 12px; min-height: 520px; color: var(--text-normal); }
.vc-mf * { box-sizing: border-box; }
.vc-mf-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.vc-mf-card { background: var(--background-secondary); border: 1px solid var(--background-modifier-accent, #262626); border-radius: 8px; padding: 10px; }
.vc-mf-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.vc-mf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.vc-mf-list { display: flex; flex-direction: column; gap: 4px; overflow: auto; max-height: 430px; }
.vc-mf-item { display: grid; grid-template-columns: 18px 1fr; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.vc-mf-item:hover { background: var(--background-modifier-hover); }
.vc-mf-item[aria-selected="true"] { border-color: #1f8a8a; background: rgba(31,138,138,.12); }
.vc-mf-item b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.vc-mf-sub { font-size: 11px; color: var(--text-muted); }
.vc-mf-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #262626; padding-bottom: 6px; }
.vc-mf-tab { background: transparent; color: var(--text-muted); border: 0; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; }
.vc-mf-tab:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
.vc-mf-tab[aria-selected="true"] { background: #105c5c; color: #fff; }
.vc-mf label { font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 3px; }
.vc-mf label.inline { flex-direction: row; align-items: center; gap: 6px; color: var(--text-normal); }
.vc-mf input[type=text], .vc-mf input[type=number], .vc-mf select, .vc-mf textarea {
  background: #0b0b0b; color: var(--text-normal); border: 1px solid #262626; border-radius: 6px; padding: 6px 8px; font-size: 13px; width: 100%; }
.vc-mf input:focus-visible, .vc-mf select:focus-visible, .vc-mf button:focus-visible, .vc-mf-item:focus-visible { outline: 2px solid #7fffd4; outline-offset: 1px; }
.vc-mf-preview { background: #0b0b0b; border-radius: 8px; display: flex; align-items: center; justify-content: center; min-height: 180px; max-height: 300px; overflow: hidden; }
.vc-mf-preview video, .vc-mf-preview img { max-width: 100%; max-height: 300px; }
.vc-mf-bar { height: 6px; border-radius: 3px; background: #262626; overflow: hidden; }
.vc-mf-bar > i { display: block; height: 100%; background: #1f8a8a; transition: width .3s; }
.vc-mf-pill { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #262626; color: #c0c0c0; }
.vc-mf-pill.ok { background: #105c5c; color: #fff; }
.vc-mf-pill.bad { background: #750f0f; color: #fff; }
.vc-mf-pill.hot { background: #7fffd4; color: #000; }
.vc-mf-err { color: #b83a3a; font-size: 13px; }
.vc-mf-hint { font-size: 12px; color: var(--text-muted); }
.vc-mf-drop { border: 1px dashed #262626; border-radius: 8px; padding: 10px; text-align: center; font-size: 12px; color: var(--text-muted); }
.vc-mf-drop.on { border-color: #7fffd4; color: var(--text-normal); }
.vc-mf code { font-family: var(--font-code); font-size: 11px; }
@media (max-width: 900px) { .vc-mf { grid-template-columns: 1fr; } }
`;

type Tab = "convert" | "split" | "join" | "fx" | "download" | "play" | "paint" | "tools";

const TARGET_GROUPS: Array<[string, Array<[Target, string]>]> = [
    ["Smart", [["auto", "Discord-ready (picks the best format)"]]],
    ["Discord assets", [["emoji", "Emoji · 128px · ≤256 KB"], ["sticker", "Sticker · 320px · ≤512 KB"], ["soundboard", "Soundboard · ≤5.2 s · ≤512 KB"], ["screenshot", "Screenshot (PNG frame)"], ["avatar", "Avatar (square)"]]],
    ["Video", [["mp4", "MP4 (H.264/AAC)"], ["webm", "WebM (VP9/Opus)"], ["mkv", "MKV"], ["gif", "GIF"], ["webp", "Animated WebP"], ["apng", "APNG"]]],
    ["Image", [["png", "PNG"], ["jpg", "JPEG"], ["webp", "WebP"]]],
    ["Audio", [["mp3", "MP3"], ["opus", "Opus (OGG)"], ["m4a", "M4A (AAC)"], ["wav", "WAV"], ["flac", "FLAC"]]]
];

const fmtTime = (s?: number) => s == null || !Number.isFinite(s) ? "–" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${s < 60 ? `.${Math.floor((s % 1) * 10)}` : ""}`;
const toast = (text: string, ok = true) => showToast({ text, variant: ok ? "success" : "critical" });
const fail = (e: unknown) => showToast({ text: errText(e), variant: "critical" });

function useItems() {
    const [list, setList] = useState(getItems());
    useEffect(() => subscribe(() => setList(getItems())), []);
    return list;
}

function describe(i: MediaItem) {
    const p = i.probe;
    if (i.probeError) return `${humanBytes(i.file.size)} · unreadable`;
    if (!p) return `${humanBytes(i.file.size)} · reading…`;
    const kind = p.isImage ? "image" : p.isAnimated ? "animated" : p.video ? "video" : p.audio ? "audio" : "file";
    const dims = p.video ? ` · ${p.video.width}×${p.video.height}` : "";
    const dur = p.duration ? ` · ${fmtTime(p.duration)}` : "";
    return `${kind}${dims}${dur} · ${humanBytes(i.file.size)}`;
}

/* ---------------- preview ---------------- */

function usePreviewUrl(item: MediaItem | null) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        setUrl(null);
        if (!item || item.file.size > 300 * 1024 * 1024) return;
        let u: string | null = null;
        let alive = true;
        api().readBytes(item.file.path).then(b => {
            if (!alive) return;
            u = URL.createObjectURL(new Blob([new Uint8Array(b)], { type: item.file.mime }));
            setUrl(u);
        }, () => { });
        return () => { alive = false; if (u) URL.revokeObjectURL(u); };
    }, [item?.file.path]);
    return url;
}

function Preview({ item, mediaRef }: { item: MediaItem | null; mediaRef: React.MutableRefObject<HTMLMediaElement | null>; }) {
    const url = usePreviewUrl(item);
    if (!item) return <div className="vc-mf-preview vc-mf-hint">Pick or drop a file</div>;
    if (!url) return <div className="vc-mf-preview vc-mf-hint">{item.file.size > 300 * 1024 * 1024 ? "Too big to preview here — play it in mpv / VLC" : "Loading preview…"}</div>;
    const p = item.probe;
    const mime = item.file.mime;
    if (p?.isImage || p?.isAnimated || mime.startsWith("image/")) return <div className="vc-mf-preview"><img src={url} alt={item.file.name} /></div>;
    if (p?.video || mime.startsWith("video/")) return <div className="vc-mf-preview"><video ref={el => { mediaRef.current = el; }} src={url} controls loop /></div>;
    return <div className="vc-mf-preview"><audio ref={el => { mediaRef.current = el; }} src={url} controls style={{ width: "90%" }} /></div>;
}

/* ---------------- output actions ---------------- */

function AddToServer({ file, kind, onDone }: { file: FileInfo; kind: "emoji" | "sticker" | "soundboard"; onDone(): void; }) {
    const guilds = useMemo(expressionGuilds, []);
    const [gid, setGid] = useState(guilds[0]?.id ?? "");
    const [name, setName] = useState(assetName(file.name.replace(/-(emoji|sticker|sound)$/, "")));
    const [tag, setTag] = useState("🔥");
    const [busy, setBusy] = useState(false);
    if (!guilds.length) return <div className="vc-mf-hint">You can't add expressions to any server.</div>;
    const go = async () => {
        setBusy(true);
        try {
            if (kind === "emoji") await createEmoji(gid, file, name);
            else if (kind === "sticker") await createSticker(gid, file, name, tag);
            else await createSound(gid, file, name);
            toast(`Added ${kind} "${name}"`);
            onDone();
        } catch (e: any) {
            fail(e?.body?.message ? `${e.body.message}${e.body.errors ? " — " + JSON.stringify(e.body.errors).slice(0, 160) : ""}` : e);
        } finally { setBusy(false); }
    };
    return (
        <div className="vc-mf-row" style={{ marginTop: 6 }}>
            <select value={gid} onChange={e => setGid(e.currentTarget.value)} aria-label="Server" style={{ maxWidth: 180 }}>
                {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <input type="text" value={name} onChange={e => setName(e.currentTarget.value)} aria-label="Name" style={{ maxWidth: 140 }} />
            {kind === "sticker" && <input type="text" value={tag} onChange={e => setTag(e.currentTarget.value)} aria-label="Related emoji" style={{ maxWidth: 70 }} />}
            <Button size="small" disabled={busy || !gid} onClick={go}>{busy ? "Adding…" : `Add ${kind}`}</Button>
        </div>
    );
}

export function OutputActions({ file, channelId, onPaint }: { file: FileInfo; channelId?: string; onPaint?(f: FileInfo): void; }) {
    const [adding, setAdding] = useState<null | "emoji" | "sticker" | "soundboard">(null);
    const kindGuess = /-emoji\.(png|gif)$/.test(file.name) ? "emoji" : /-sticker\.(png|gif)$/.test(file.name) ? "sticker" : /-sound\.mp3$/.test(file.name) ? "soundboard" : null;
    const limit = limitFor(channelId);
    const tooBig = file.size > limit;
    return (
        <div>
            <div className="vc-mf-row">
                <Button size="small" disabled={tooBig} title={tooBig ? `over this channel's ${humanBytes(limit)} limit` : ""}
                    onClick={() => uploadToChannel([file], channelId).then(left => left && toast(`${left} more file(s) not attached (10 max)`, false)).catch(fail)}>Upload here</Button>
                <Button size="small" variant="secondary" onClick={() => api().saveAs(file.path, file.name).then(p => p && toast(`Saved to ${p}`)).catch(fail)}>Save…</Button>
                <Button size="small" variant="secondary" onClick={() => api().reveal(file.path).catch(fail)}>Show</Button>
                <Button size="small" variant="secondary" onClick={() => api().play("mpv", file.path, {}).catch(fail)}>mpv</Button>
                <Button size="small" variant="secondary" onClick={() => api().play("vlc", file.path, {}).catch(fail)}>VLC</Button>
                {file.mime.startsWith("image/") && onPaint && <Button size="small" variant="secondary" onClick={() => onPaint(file)}>Paint</Button>}
                {(kindGuess ?? null) && <Button size="small" variant="positive" onClick={() => setAdding(kindGuess)}>Add to server…</Button>}
                {!kindGuess && file.mime.startsWith("image/") && file.size <= LIMITS.emoji && <Button size="small" variant="secondary" onClick={() => setAdding("emoji")}>as emoji…</Button>}
                {!kindGuess && /image\/(png|gif|apng)/.test(file.mime) && file.size <= LIMITS.sticker && <Button size="small" variant="secondary" onClick={() => setAdding("sticker")}>as sticker…</Button>}
                {!kindGuess && /audio\/(mpeg|ogg)/.test(file.mime) && file.size <= LIMITS.soundboard && <Button size="small" variant="secondary" onClick={() => setAdding("soundboard")}>as sound…</Button>}
            </div>
            {adding && <AddToServer file={file} kind={adding} onDone={() => setAdding(null)} />}
        </div>
    );
}

/* ---------------- jobs tray ---------------- */

function JobCard({ j, channelId, onPaint }: { j: JobStatus; channelId?: string; onPaint?(f: FileInfo): void; }) {
    const [showLog, setShowLog] = useState(false);
    return (
        <div className="vc-mf-card" style={{ padding: 8 }}>
            <div className="vc-mf-row" style={{ justifyContent: "space-between" }}>
                <span>
                    <span className={`vc-mf-pill ${j.status === "done" ? "ok" : j.status === "error" ? "bad" : ""}`}>{j.status}</span>{" "}
                    <b style={{ fontSize: 13 }}>{j.kind}</b> <span className="vc-mf-sub">{j.stage}</span>
                </span>
                <span className="vc-mf-row">
                    {j.status === "running" && <Button size="small" variant="dangerSecondary" onClick={() => api().cancelJob(j.id)}>Cancel</Button>}
                    <Button size="small" variant="secondary" onClick={() => setShowLog(v => !v)}>{showLog ? "Hide log" : "Log"}</Button>
                </span>
            </div>
            {j.status === "running" && <div className="vc-mf-bar" style={{ marginTop: 6 }}><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
            {j.error && <div className="vc-mf-err" style={{ marginTop: 4 }}>{j.error}{j.hint && <div className="vc-mf-hint">→ {j.hint}</div>}</div>}
            {j.outputs.map(o => (
                <div key={o.path} style={{ marginTop: 6 }}>
                    <div className="vc-mf-sub"><b style={{ color: "var(--text-normal)" }}>{o.name}</b> · {humanBytes(o.size)}</div>
                    <OutputActions file={o} channelId={channelId} onPaint={onPaint} />
                </div>
            ))}
            {j.outputs.length > 1 && (
                <div className="vc-mf-row" style={{ marginTop: 6 }}>
                    <Button size="small" onClick={() => uploadToChannel(j.outputs, channelId).then(left => left && toast(`${left} file(s) left — upload them in another message`, false)).catch(fail)}>Upload all here</Button>
                    <Button size="small" variant="secondary" onClick={() => api().saveAllTo(j.outputs.map(o => o.path)).then(c => c && toast(`Saved ${c} files`)).catch(fail)}>Save all…</Button>
                </div>
            )}
            {showLog && <pre style={{ fontFamily: "var(--font-code)", fontSize: 11, maxHeight: 160, overflow: "auto", background: "#0b0b0b", padding: 6, borderRadius: 6, whiteSpace: "pre-wrap" }}>{j.log.join("\n")}</pre>}
        </div>
    );
}

function useJobs() {
    const [jobs, setJobs] = useState<JobStatus[]>([]);
    useEffect(() => {
        let alive = true;
        const seen = new Set<string>();
        const tick = async () => {
            try {
                const list = await api().listJobs();
                if (!alive) return;
                for (const j of list) {
                    if (j.status === "done" && !seen.has(j.id)) {
                        seen.add(j.id);
                        j.outputs.forEach(o => addItem(o, "output", j.kind));
                    }
                }
                setJobs(list);
            } catch { /* native gone */ }
        };
        // mark already finished jobs as seen without re-adding their outputs twice
        api().listJobs().then(l => l.forEach(j => j.status === "done" && seen.add(j.id))).finally(tick);
        const t = setInterval(tick, 500);
        return () => { alive = false; clearInterval(t); };
    }, []);
    return jobs;
}

/* ---------------- tabs ---------------- */

type LimitMode = "channel" | "none" | "custom";

function useLimit(channelId?: string) {
    const [mode, setMode] = useState<LimitMode>("channel");
    const [mb, setMb] = useState("10");
    const channel = limitFor(channelId);
    const bytes = mode === "channel" ? Math.floor(channel * 0.98) : mode === "custom" ? Math.max(0.05, Number(mb) || 0) * 1048576 : undefined;
    const ui = (
        <label>Size limit
            <div className="vc-mf-row" style={{ flexWrap: "nowrap" }}>
                <select value={mode} onChange={e => setMode(e.currentTarget.value as LimitMode)}>
                    <option value="channel">Fit this channel ({humanBytes(channel)})</option>
                    <option value="custom">Custom…</option>
                    <option value="none">No limit (quality)</option>
                </select>
                {mode === "custom" && <input type="number" min={0.05} step={0.5} value={mb} onChange={e => setMb(e.currentTarget.value)} style={{ width: 80 }} aria-label="MB" />}
            </div>
        </label>
    );
    return { bytes, ui, mode };
}

function NumField({ label, value, onChange, step = 0.1, min = 0, placeholder }: { label: string; value?: number; onChange(v?: number): void; step?: number; min?: number; placeholder?: string; }) {
    return (
        <label>{label}
            <input type="number" step={step} min={min} value={value ?? ""} placeholder={placeholder}
                onChange={e => { const v = e.currentTarget.value; onChange(v === "" ? undefined : Number(v)); }} />
        </label>
    );
}

function EditPanel({ item, edit, setEdit, mediaRef }: { item: MediaItem; edit: EditOptions; setEdit(e: EditOptions): void; mediaRef: React.MutableRefObject<HTMLMediaElement | null>; }) {
    const p = item.probe;
    const set = (patch: Partial<EditOptions>) => setEdit({ ...edit, ...patch });
    const here = () => mediaRef.current ? Math.round(mediaRef.current.currentTime * 100) / 100 : undefined;
    const W = p?.video?.width ?? 0, H = p?.video?.height ?? 0;
    const cropPreset = (ar: number | null) => {
        if (!ar || !W || !H) return set({ crop: undefined });
        let w = W, h = Math.round(W / ar);
        if (h > H) { h = H; w = Math.round(H * ar); }
        set({ crop: { w, h, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2) } });
    };
    return (
        <div className="vc-mf-col">
            {!!p?.duration && (
                <div className="vc-mf-grid">
                    <div><NumField label={`Start (of ${fmtTime(p.duration)})`} value={edit.start} onChange={v => set({ start: v })} placeholder="0" />
                        <Button size="min" variant="secondary" onClick={() => set({ start: here() })}>⟵ playhead</Button></div>
                    <div><NumField label="End" value={edit.end} onChange={v => set({ end: v })} placeholder={String(Math.round(p.duration * 10) / 10)} />
                        <Button size="min" variant="secondary" onClick={() => set({ end: here() })}>⟵ playhead</Button></div>
                    <NumField label="Screenshot at (s)" value={edit.at} onChange={v => set({ at: v })} />
                    <label>Speed
                        <select value={edit.speed ?? 1} onChange={e => set({ speed: Number(e.currentTarget.value) === 1 ? undefined : Number(e.currentTarget.value) })}>
                            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(s => <option key={s} value={s}>{s}×</option>)}
                        </select>
                    </label>
                </div>
            )}
            {p?.video && (
                <div className="vc-mf-grid">
                    <label>Crop
                        <select value={edit.crop ? "custom" : "none"} onChange={e => {
                            const v = e.currentTarget.value;
                            cropPreset(v === "none" ? null : v === "custom" ? W / Math.max(1, H) : Number(v));
                        }}>
                            <option value="none">None</option>
                            <option value="1">Square 1:1 (center)</option>
                            <option value={16 / 9}>16:9</option>
                            <option value={9 / 16}>9:16 (vertical)</option>
                            <option value={4 / 3}>4:3</option>
                            <option value="custom">Custom…</option>
                        </select>
                    </label>
                    <label>Max size
                        <select value={edit.maxSide ?? 0} onChange={e => set({ maxSide: Number(e.currentTarget.value) || undefined })}>
                            {[0, 2560, 1920, 1280, 854, 640, 480, 320, 256, 128].map(s => <option key={s} value={s}>{s ? `${s}px` : "Original"}</option>)}
                        </select>
                    </label>
                    <label>FPS
                        <select value={edit.fps ?? 0} onChange={e => set({ fps: Number(e.currentTarget.value) || undefined })}>
                            {[0, 60, 30, 24, 20, 15, 12, 10].map(s => <option key={s} value={s}>{s || "Original"}</option>)}
                        </select>
                    </label>
                    <label>Rotate
                        <select value={edit.rotate ?? 0} onChange={e => set({ rotate: (Number(e.currentTarget.value) || undefined) as any })}>
                            {[0, 90, 180, 270].map(s => <option key={s} value={s}>{s}°</option>)}
                        </select>
                    </label>
                </div>
            )}
            {edit.crop && (
                <div className="vc-mf-grid">
                    {(["x", "y", "w", "h"] as const).map(k => (
                        <NumField key={k} label={`Crop ${k}`} step={2} value={edit.crop![k]} onChange={v => set({ crop: { ...edit.crop!, [k]: v ?? 0 } })} />
                    ))}
                </div>
            )}
            <div className="vc-mf-grid">
                {p?.video && <label>Caption<input type="text" value={edit.caption?.text ?? ""} placeholder="text on top of the video"
                    onChange={e => set({ caption: e.currentTarget.value ? { text: e.currentTarget.value, position: edit.caption?.position ?? "bottom" } : undefined })} /></label>}
                {edit.caption && <label>Caption at<select value={edit.caption.position} onChange={e => set({ caption: { ...edit.caption!, position: e.currentTarget.value as any } })}><option value="top">Top</option><option value="bottom">Bottom</option></select></label>}
                {!!p?.duration && <NumField label="Fade in (s)" value={edit.fadeIn} onChange={v => set({ fadeIn: v })} />}
                {!!p?.duration && <NumField label="Fade out (s)" value={edit.fadeOut} onChange={v => set({ fadeOut: v })} />}
                {p?.audio && <label>Volume
                    <select value={edit.volume ?? 1} onChange={e => set({ volume: Number(e.currentTarget.value) === 1 ? undefined : Number(e.currentTarget.value) })}>
                        {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(s => <option key={s} value={s}>{Math.round(s * 100)}%</option>)}
                    </select></label>}
            </div>
            <div className="vc-mf-row">
                {p?.audio && p.video && <label className="inline"><input type="checkbox" checked={!!edit.mute} onChange={e => set({ mute: e.currentTarget.checked || undefined })} /> Mute</label>}
                {p?.audio && <label className="inline"><input type="checkbox" checked={!!edit.loudnorm} onChange={e => set({ loudnorm: e.currentTarget.checked || undefined })} /> Normalize loudness</label>}
                {!!p?.duration && <label className="inline"><input type="checkbox" checked={!!edit.reverse} onChange={e => set({ reverse: e.currentTarget.checked || undefined })} /> Reverse</label>}
                {p?.video && <label className="inline"><input type="checkbox" checked={!!edit.flipH} onChange={e => set({ flipH: e.currentTarget.checked || undefined })} /> Mirror</label>}
                {p?.video && <label className="inline"><input type="checkbox" checked={!!edit.flipV} onChange={e => set({ flipV: e.currentTarget.checked || undefined })} /> Flip</label>}
                <Button size="min" variant="secondary" onClick={() => setEdit({})}>Reset edits</Button>
            </div>
        </div>
    );
}

function ConvertTab({ targets, channelId, mediaRef, presetTarget }: { targets: MediaItem[]; channelId?: string; mediaRef: React.MutableRefObject<HTMLMediaElement | null>; presetTarget?: Target; }) {
    const [target, setTarget] = useState<Target>(presetTarget ?? "auto");
    const [edit, setEdit] = useState<EditOptions>({});
    const [codec, setCodec] = useState("auto");
    const [quality, setQuality] = useState(70);
    const [showEdit, setShowEdit] = useState(false);
    const limit = useLimit(channelId);
    const item = targets[0];
    const isAsset = ["emoji", "sticker", "soundboard", "screenshot", "avatar"].includes(target);
    useEffect(() => setEdit({}), [item?.id]);
    if (!item) return <div className="vc-mf-hint">Pick a file on the left.</div>;

    const go = () => {
        for (const t of targets) {
            const spec: JobSpec = {
                op: "convert", input: t.file.path, target, edit: targets.length === 1 ? edit : undefined,
                maxBytes: isAsset ? undefined : limit.bytes, videoCodec: codec as any, quality
            };
            api().startJob(spec).catch(fail);
        }
        toast(`Started ${targets.length} job(s)`);
    };

    return (
        <div className="vc-mf-col">
            <div className="vc-mf-grid">
                <label>Make
                    <select value={target} onChange={e => setTarget(e.currentTarget.value as Target)}>
                        {TARGET_GROUPS.map(([g, opts]) => <optgroup key={g} label={g}>{opts.map(([v, l]) => <option key={g + v} value={v}>{l}</option>)}</optgroup>)}
                    </select>
                </label>
                {!isAsset && limit.ui}
                {!isAsset && ["auto", "mp4", "webm", "mkv"].includes(target) && item.probe?.video && !item.probe.isImage && (
                    <label>Video codec
                        <select value={codec} onChange={e => setCodec(e.currentTarget.value)}>
                            <option value="auto">Auto (plays everywhere)</option><option value="h264">H.264</option><option value="vp9">VP9</option>
                            <option value="hevc">HEVC (small, not inline)</option><option value="av1">AV1 (small, slow)</option><option value="copy">Copy (no re-encode)</option>
                        </select>
                    </label>
                )}
                {!isAsset && limit.mode === "none" && <label>Quality {quality}<input type="range" min={10} max={100} value={quality} onChange={e => setQuality(Number(e.currentTarget.value))} /></label>}
                {target === "sticker" && item.probe && !item.probe.isImage && (
                    <label>Sticker type<select value={edit.stickerFormat ?? "apng"} onChange={e => setEdit({ ...edit, stickerFormat: e.currentTarget.value as any })}>
                        <option value="apng">APNG</option><option value="gif">GIF</option></select></label>
                )}
            </div>
            {targets.length === 1 && (
                <>
                    <div className="vc-mf-row">
                        <Button size="small" variant="secondary" onClick={() => setShowEdit(v => !v)} aria-expanded={showEdit}>
                            {showEdit ? "▾" : "▸"} Edit & clip {Object.values(edit).some(v => v != null) ? <span className="vc-mf-pill hot">on</span> : null}
                        </Button>
                        <span className="vc-mf-hint">trim · crop · resize · speed · caption · fades · volume · reverse</span>
                    </div>
                    {showEdit && <EditPanel item={item} edit={edit} setEdit={setEdit} mediaRef={mediaRef} />}
                </>
            )}
            {targets.length > 1 && <div className="vc-mf-hint">{targets.length} files checked: each gets the same format and limit (edits apply to single files).</div>}
            <div className="vc-mf-row">
                <Button onClick={go}>{targets.length > 1 ? `Convert ${targets.length} files` : target === "auto" ? "Make it Discord-ready" : "Convert"}</Button>
                <span className="vc-mf-hint">
                    {target === "auto" && "video → MP4 H.264 · animation → GIF · image → JPEG/PNG · audio → MP3; two-pass to hit the limit"}
                    {target === "emoji" && "square, transparent padding, shrinks fps/colours until it fits"}
                    {target === "sticker" && "320×320, ≤5 s animation"}
                    {target === "soundboard" && "first 5.2 s from Start, loudness-normalised"}
                </span>
            </div>
        </div>
    );
}

function SplitTab({ item, channelId }: { item?: MediaItem; channelId?: string; }) {
    const [mode, setMode] = useState<"size" | "duration" | "count">("size");
    const [value, setValue] = useState("");
    const [exact, setExact] = useState(false);
    const limit = useLimit(channelId);
    if (!item) return <div className="vc-mf-hint">Pick a video, GIF or audio file.</div>;
    const d = item.probe?.duration ?? 0;
    const go = () => {
        const v = mode === "size" ? (limit.bytes ?? 0) : Number(value);
        if (!(v > 0)) return fail(mode === "size" ? "pick a size limit" : "enter a number");
        api().startJob({ op: "split", input: item.file.path, mode, value: v, exact, maxBytes: mode === "size" ? limit.bytes : undefined }).then(() => toast("Splitting…")).catch(fail);
    };
    return (
        <div className="vc-mf-col">
            <div className="vc-mf-grid">
                <label>Split by
                    <select value={mode} onChange={e => setMode(e.currentTarget.value as any)}>
                        <option value="size">Size (each part fits)</option><option value="duration">Length of each part</option><option value="count">Number of parts</option>
                    </select>
                </label>
                {mode === "size" ? limit.ui : <label>{mode === "duration" ? "Seconds per part" : "Parts"}<input type="number" min={mode === "count" ? 2 : 1} value={value} onChange={e => setValue(e.currentTarget.value)} /></label>}
            </div>
            {mode !== "size" && <label className="inline"><input type="checkbox" checked={exact} onChange={e => setExact(e.currentTarget.checked)} /> Exact cut points (re-encode; otherwise cuts on keyframes, instant)</label>}
            <div className="vc-mf-row">
                <Button onClick={go} disabled={!d}>Split</Button>
                {!!d && mode !== "size" && Number(value) > 0 && <span className="vc-mf-hint">≈ {mode === "count" ? `${fmtTime(d / Number(value))} each` : `${Math.ceil(d / Number(value))} parts`}</span>}
                {!d && <span className="vc-mf-hint">This file has no duration.</span>}
            </div>
        </div>
    );
}

function JoinTab({ checked, setOrder }: { checked: MediaItem[]; setOrder(ids: string[]): void; }) {
    const [target, setTarget] = useState<"auto" | "mp4" | "webm" | "gif" | "mp3" | "opus" | "wav">("auto");
    const [imgDur, setImgDur] = useState(3);
    const move = (i: number, d: number) => {
        const ids = checked.map(c => c.id);
        const j = i + d;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        setOrder(ids);
    };
    return (
        <div className="vc-mf-col">
            <div className="vc-mf-hint">Tick files on the left (☑), order them here. Videos, GIFs, stills and audio can be mixed; sizes are matched to the first video.</div>
            {checked.map((c, i) => (
                <div key={c.id} className="vc-mf-row">
                    <span className="vc-mf-pill">{i + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.file.name}</span>
                    <Button size="min" variant="secondary" onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                    <Button size="min" variant="secondary" onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                </div>
            ))}
            <div className="vc-mf-grid">
                <label>Output<select value={target} onChange={e => setTarget(e.currentTarget.value as any)}>
                    <option value="auto">Auto</option><option value="mp4">MP4</option><option value="webm">WebM</option><option value="gif">GIF</option>
                    <option value="mp3">MP3 (audio only)</option><option value="opus">Opus</option><option value="wav">WAV</option></select></label>
                <NumField label="Still images last (s)" value={imgDur} onChange={v => setImgDur(v ?? 3)} />
            </div>
            <Button disabled={checked.length < 2} onClick={() => api().startJob({ op: "join", inputs: checked.map(c => c.file.path), target, imageDuration: imgDur })
                .then(() => toast("Joining…")).catch(fail)}>Join {checked.length} files</Button>
        </div>
    );
}

function FxTab({ item, tools }: { item?: MediaItem; tools: ToolStatus[]; }) {
    const [fx, setFx] = useState<any>({ normalize: true });
    const [target, setTarget] = useState<"mp3" | "opus" | "wav" | "flac">("mp3");
    const sox = tools.find(t => t.name === "sox");
    const set = (k: string, v: any) => setFx({ ...fx, [k]: v });
    if (sox && !sox.path) return <div className="vc-mf-hint">Audio FX use SoX, which isn't installed: <code>{sox.hint}</code></div>;
    if (!item) return <div className="vc-mf-hint">Pick a file with sound.</div>;
    return (
        <div className="vc-mf-col">
            <div className="vc-mf-row">
                {[["normalize", "Normalize"], ["trimSilence", "Trim silence"], ["echo", "Echo"], ["reverse", "Reverse"]].map(([k, l]) => (
                    <label key={k} className="inline"><input type="checkbox" checked={!!fx[k]} onChange={e => set(k, e.currentTarget.checked)} /> {l}</label>
                ))}
            </div>
            <div className="vc-mf-grid">
                <NumField label="Pitch (semitones)" step={1} min={-24} value={fx.pitch != null ? fx.pitch / 100 : undefined} onChange={v => set("pitch", v != null ? v * 100 : undefined)} />
                <NumField label="Tempo (keep pitch)" step={0.05} value={fx.tempo} onChange={v => set("tempo", v)} placeholder="1" />
                <NumField label="Speed (nightcore)" step={0.05} value={fx.speed} onChange={v => set("speed", v)} placeholder="1" />
                <NumField label="Reverb 0–100" step={5} value={fx.reverb} onChange={v => set("reverb", v)} />
                <NumField label="Bass dB" step={1} min={-20} value={fx.bass} onChange={v => set("bass", v)} />
                <NumField label="Treble dB" step={1} min={-20} value={fx.treble} onChange={v => set("treble", v)} />
                <label>Output<select value={target} onChange={e => setTarget(e.currentTarget.value as any)}><option value="mp3">MP3</option><option value="opus">Opus</option><option value="wav">WAV</option><option value="flac">FLAC</option></select></label>
            </div>
            <div className="vc-mf-row">
                <Button onClick={() => api().startJob({ op: "audiofx", input: item.file.path, fx, target }).then(() => toast("Processing…")).catch(fail)}>Apply</Button>
                <Button size="small" variant="secondary" onClick={() => setFx({ speed: 1.25, pitch: 0, normalize: true })}>Nightcore</Button>
                <Button size="small" variant="secondary" onClick={() => setFx({ speed: 0.85, reverb: 60, normalize: true })}>Slowed + reverb</Button>
                <Button size="small" variant="secondary" onClick={() => setFx({ bass: 12, normalize: true })}>Bass boost</Button>
            </div>
        </div>
    );
}

function DownloadTab({ channelId, initialUrl }: { channelId?: string; initialUrl?: string; }) {
    const [url, setUrl] = useState(initialUrl ?? "");
    const [mode, setMode] = useState<"discord" | "best" | "audio" | "video720">("discord");
    const [playlist, setPlaylist] = useState(false);
    const limit = limitFor(channelId);
    return (
        <div className="vc-mf-col">
            <label>Link (YouTube, TikTok, X, Reddit, Twitch clips, SoundCloud, … anything yt-dlp knows)
                <input type="text" value={url} placeholder="https://…" onChange={e => setUrl(e.currentTarget.value)} />
            </label>
            <div className="vc-mf-grid">
                <label>Get<select value={mode} onChange={e => setMode(e.currentTarget.value as any)}>
                    <option value="discord">Discord-ready MP4 (fits {humanBytes(limit)})</option><option value="video720">Video ≤720p</option>
                    <option value="best">Best quality</option><option value="audio">Audio only (MP3)</option></select></label>
                <label className="inline" style={{ alignSelf: "end" }}><input type="checkbox" checked={playlist} onChange={e => setPlaylist(e.currentTarget.checked)} /> Whole playlist</label>
            </div>
            <div className="vc-mf-row">
                <Button disabled={!/^https?:\/\//.test(url)} onClick={() => api().startJob({ op: "download", url, mode, maxBytes: mode === "discord" ? Math.floor(limit * 0.98) : undefined, playlist })
                    .then(() => toast("Downloading…")).catch(fail)}>Download</Button>
                <Button size="small" variant="secondary" disabled={!/^https?:\/\//.test(url)} onClick={() => api().play("mpv", url, {}).catch(fail)}>Stream in mpv</Button>
                <Button size="small" variant="secondary" disabled={!/^https?:\/\//.test(url)} onClick={() => api().play("vlc", url, {}).catch(fail)}>Stream in VLC</Button>
            </div>
        </div>
    );
}

function PlayTab({ item }: { item?: MediaItem; }) {
    const [player, setPlayer] = useState<"mpv" | "vlc">("mpv");
    const [st, setSt] = useState<PlayerStatus | null>(null);
    const [opts, setOpts] = useState({ loop: false, ontop: false, fullscreen: false });
    useEffect(() => {
        let alive = true;
        const t = setInterval(() => api().playerStatus(player).then(s => alive && setSt(s)).catch(() => { }), 1000);
        return () => { alive = false; clearInterval(t); };
    }, [player]);
    const cmd = (c: any, a?: number) => api().playerCommand(player, c, a).catch(fail);
    return (
        <div className="vc-mf-col">
            <div className="vc-mf-row">
                <select value={player} onChange={e => setPlayer(e.currentTarget.value as any)} style={{ width: 120 }} aria-label="Player"><option value="mpv">mpv</option><option value="vlc">VLC</option></select>
                {(["loop", "ontop", "fullscreen"] as const).map(k => (
                    <label key={k} className="inline"><input type="checkbox" checked={opts[k]} onChange={e => setOpts({ ...opts, [k]: e.currentTarget.checked })} /> {k === "ontop" ? "on top" : k}</label>
                ))}
            </div>
            <div className="vc-mf-row">
                <Button disabled={!item} onClick={() => item && api().play(player, item.file.path, opts).catch(fail)}>Play selected</Button>
                <Button size="small" variant="secondary" disabled={!item || !st?.running} onClick={() => item && api().play(player, item.file.path, { append: true }).catch(fail)}>Queue</Button>
            </div>
            <div className="vc-mf-card">
                <div className="vc-mf-row" style={{ justifyContent: "space-between" }}>
                    <b style={{ fontSize: 13 }}>{st?.running ? st.title ?? "playing" : `${player} not running`}</b>
                    {st?.running && <span className="vc-mf-sub">{fmtTime(st.position)} / {fmtTime(st.duration)} · vol {Math.round(st.volume ?? 0)}%</span>}
                </div>
                {st?.running && st.duration ? <div className="vc-mf-bar" style={{ margin: "6px 0" }}><i style={{ width: `${Math.min(100, ((st.position ?? 0) / st.duration) * 100)}%` }} /></div> : null}
                <div className="vc-mf-row">
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("prev")} aria-label="Previous">⏮</Button>
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("seek", -10)} aria-label="Back 10 seconds">−10s</Button>
                    <Button size="small" disabled={!st?.running} onClick={() => cmd("toggle")} aria-label="Play or pause">{st?.paused ? "▶" : "⏸"}</Button>
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("seek", 10)} aria-label="Forward 10 seconds">+10s</Button>
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("next")} aria-label="Next">⏭</Button>
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("volume", -10)} aria-label="Volume down">🔉</Button>
                    <Button size="small" variant="secondary" disabled={!st?.running} onClick={() => cmd("volume", 10)} aria-label="Volume up">🔊</Button>
                    <Button size="small" variant="dangerSecondary" disabled={!st?.running} onClick={() => cmd("quit")}>Close</Button>
                </div>
            </div>
        </div>
    );
}

export async function openInPaint(file?: FileInfo) {
    try {
        let f = file;
        if (f && f.size > 1.4 * 1024 * 1024) {
            showToast({ text: "Shrinking the image for Paint…", variant: "default" });
            const s = await runJob({ op: "convert", input: f.path, target: "png", edit: { maxSide: 1600 }, maxBytes: 1.3 * 1024 * 1024 });
            if (s.status !== "done" || !s.outputs[0]) throw new Error(s.error ?? "could not shrink the image");
            f = s.outputs[0];
        }
        await api().openPaint(f?.path);
    } catch (e) { fail(e); }
}

function PaintTab({ item }: { item?: MediaItem; }) {
    const isImg = !!item && (item.probe?.isImage || item.file.mime.startsWith("image/"));
    return (
        <div className="vc-mf-col">
            <div className="vc-mf-hint">
                Win95-style MS Paint in its own window — <b>JSPaint</b> by Isaiah Odhner (MIT, jspaint.app). Draw, then grab the canvas back
                here to turn it into an emoji, sticker, upload or anything else.
            </div>
            <div className="vc-mf-row">
                <Button onClick={() => openInPaint()}>Open Paint</Button>
                <Button variant="secondary" disabled={!isImg} onClick={() => openInPaint(item!.file)}>Open selected image</Button>
                <Button variant="positive" onClick={() => api().grabPaint().then(f => { addItem(f, "paint"); toast("Canvas added to the list"); }).catch(fail)}>Grab canvas</Button>
            </div>
        </div>
    );
}

function ToolsTab({ tools, refresh }: { tools: ToolStatus[]; refresh(): void; }) {
    return (
        <div className="vc-mf-col">
            {tools.map(t => (
                <div key={t.name} className="vc-mf-card" style={{ padding: 8 }}>
                    <div className="vc-mf-row" style={{ justifyContent: "space-between" }}>
                        <span><b>{t.name}</b>{" "}
                            <span className={`vc-mf-pill ${t.path ? "ok" : "bad"}`}>{t.path ? t.source : "missing"}</span>{" "}
                            <span className="vc-mf-sub">{t.version ?? ""}</span></span>
                        {t.installable && (
                            <Button size="small" variant={t.path ? "secondary" : "primary"} onClick={() => api().installTool(t.name).then(() => toast(`Installing ${t.name}… (watch Jobs below)`)).catch(fail)}>
                                {t.path && t.source === "managed" ? "Update" : t.path ? "Install portable copy" : "Install"}
                            </Button>
                        )}
                    </div>
                    <div className="vc-mf-sub"><code>{t.path ?? t.hint}</code></div>
                </div>
            ))}
            <div className="vc-mf-row">
                <Button size="small" variant="secondary" onClick={refresh}>Re-detect</Button>
                <span className="vc-mf-hint">Custom paths: plugin settings. Portable copies are checked against the release's SHA-256 list.</span>
            </div>
        </div>
    );
}

export function useTools() {
    const [tools, setTools] = useState<ToolStatus[]>([]);
    const load = (refresh = false) => api().tools(refresh).then(setTools).catch(() => setTools([]));
    useEffect(() => { load(); }, []);
    return { tools, refresh: () => load(true) };
}

/* ---------------- studio ---------------- */

export interface StudioProps {
    channelId?: string;
    tab?: Tab;
    target?: Target;
    url?: string;
    focus?: string;
}

function Studio({ modalProps, channelId, tab: tab0, target, url, focus }: StudioProps & { modalProps: any; }) {
    const list = useItems();
    const jobs = useJobs();
    const { tools, refresh } = useTools();
    const [tab, setTab] = useState<Tab>(tab0 ?? "convert");
    const [activeId, setActiveId] = useState<string | null>(focus ?? list[0]?.id ?? null);
    const [checked, setChecked] = useState<string[]>([]);
    const [drag, setDrag] = useState(false);
    const [link, setLink] = useState("");
    const mediaRef = React.useRef<HTMLMediaElement | null>(null);
    const fileRef = React.useRef<HTMLInputElement>(null);

    const active = list.find(i => i.id === activeId) ?? list[0] ?? null;
    const checkedItems = checked.map(id => list.find(i => i.id === id)).filter(Boolean) as MediaItem[];
    const convertTargets = checkedItems.length > 1 ? checkedItems : active ? [active] : [];
    const missing = tools.filter(t => (t.name === "ffmpeg" || t.name === "ffprobe") && !t.path);
    useEffect(() => { if (focus) setActiveId(focus); }, [focus]);

    const addFiles = async (files: File[]) => {
        for (const f of files) {
            try { setActiveId((await addFromFile(f, "file")).id); } catch (e) { fail(e); }
        }
    };

    const tabs: Array<[Tab, string]> = [
        ["convert", "Convert & edit"], ["split", "Split"], ["join", `Join${checkedItems.length ? ` (${checkedItems.length})` : ""}`], ["fx", "Audio FX"],
        ["download", "Download"], ["play", "Play"], ["paint", "Paint"], ["tools", `Tools${missing.length ? " ⚠" : ""}`]
    ];

    return (
        <Modal {...modalProps} size="xxl" title="MediaForge" subtitle="re-encode · clip · split · join · assets · download · play · paint">
            <div className="vc-mf" style={{ padding: "4px 0 12px" }}>
                <div className="vc-mf-col">
                    <div
                        className={`vc-mf-drop ${drag ? "on" : ""}`}
                        onDragOver={e => { e.preventDefault(); setDrag(true); }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={e => { e.preventDefault(); e.stopPropagation(); setDrag(false); addFiles([...e.dataTransfer.files]); }}
                    >
                        Drop files here
                        <div className="vc-mf-row" style={{ justifyContent: "center", marginTop: 6 }}>
                            <Button size="small" onClick={() => api().pickFiles(true).then(fs => fs.forEach(f => setActiveId(addItem(f, "file").id))).catch(fail)}>Open…</Button>
                            <Button size="small" variant="secondary" onClick={() => fileRef.current?.click()}>Browse</Button>
                        </div>
                        <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={e => { const fs = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; addFiles(fs); }} />
                    </div>
                    <div className="vc-mf-row" style={{ flexWrap: "nowrap" }}>
                        <input type="text" placeholder="Paste a file link…" value={link} onChange={e => setLink(e.currentTarget.value)} aria-label="File link" />
                        <Button size="small" variant="secondary" disabled={!/^https?:\/\//.test(link)} onClick={() => addFromUrl(link, undefined, "link").then(i => { setActiveId(i.id); setLink(""); }).catch(fail)}>Add</Button>
                    </div>
                    <div className="vc-mf-list" role="listbox" aria-label="Media">
                        {list.length === 0 && <div className="vc-mf-hint">Nothing here yet. Right-click a message → MediaForge, drop files, or download a link.</div>}
                        {list.map(i => (
                            <div key={i.id} className="vc-mf-item" role="option" tabIndex={0} aria-selected={i.id === active?.id}
                                onClick={() => setActiveId(i.id)} onKeyDown={e => (e.key === "Enter" || e.key === " ") && setActiveId(i.id)}>
                                <input type="checkbox" aria-label={`select ${i.file.name}`} checked={checked.includes(i.id)} onClick={e => e.stopPropagation()}
                                    onChange={e => setChecked(e.currentTarget.checked ? [...checked, i.id] : checked.filter(c => c !== i.id))} />
                                <div style={{ minWidth: 0 }}>
                                    <b title={i.file.name}>{i.file.name}</b>
                                    <div className="vc-mf-sub">{i.origin} · {describe(i)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    {list.length > 0 && (
                        <div className="vc-mf-row">
                            {active && <Button size="min" variant="secondary" onClick={() => removeItem(active.id)}>Remove</Button>}
                            <Button size="min" variant="secondary" onClick={() => setChecked(checked.length ? [] : list.map(i => i.id))}>{checked.length ? "Uncheck all" : "Check all"}</Button>
                            <Button size="min" variant="dangerSecondary" onClick={() => { clearItems(); setChecked([]); }}>Clear</Button>
                        </div>
                    )}
                </div>

                <div className="vc-mf-col">
                    {missing.length > 0 && (
                        <div className="vc-mf-card" style={{ borderColor: "#750f0f" }}>
                            <b>ffmpeg is missing.</b> <span className="vc-mf-hint">Almost everything here needs it.</span>{" "}
                            <Button size="small" onClick={() => api().installTool("ffmpeg").then(() => toast("Installing ffmpeg…")).catch(fail)}>Install ffmpeg</Button>
                        </div>
                    )}
                    <Preview item={active} mediaRef={mediaRef} />
                    {active && <div className="vc-mf-sub"><b style={{ color: "var(--text-normal)" }}>{active.file.name}</b> · {describe(active)}{active.probe?.video ? ` · ${active.probe.video.codec}` : ""}{active.probe?.audio ? ` · ${active.probe.audio.codec}` : ""}</div>}
                    {active && <OutputActions file={active.file} channelId={channelId} onPaint={f => openInPaint(f)} />}
                    <div className="vc-mf-tabs" role="tablist">
                        {tabs.map(([id, label]) => <button key={id} className="vc-mf-tab" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
                    </div>
                    <div className="vc-mf-card">
                        {tab === "convert" && <ConvertTab targets={convertTargets} channelId={channelId} mediaRef={mediaRef} presetTarget={target} />}
                        {tab === "split" && <SplitTab item={active ?? undefined} channelId={channelId} />}
                        {tab === "join" && <JoinTab checked={checkedItems} setOrder={setChecked} />}
                        {tab === "fx" && <FxTab item={active ?? undefined} tools={tools} />}
                        {tab === "download" && <DownloadTab channelId={channelId} initialUrl={url} />}
                        {tab === "play" && <PlayTab item={active ?? undefined} />}
                        {tab === "paint" && <PaintTab item={active ?? undefined} />}
                        {tab === "tools" && <ToolsTab tools={tools} refresh={refresh} />}
                    </div>
                    {jobs.length > 0 && <div className="vc-mf-col"><b style={{ fontSize: 13 }}>Jobs</b>{jobs.slice(0, 8).map(j => <JobCard key={j.id} j={j} channelId={channelId} onPaint={f => openInPaint(f)} />)}</div>}
                </div>
            </div>
        </Modal>
    );
}

export function openStudio(props: StudioProps = {}) {
    openModal(m => <Studio modalProps={m} {...props} />);
}

/* ---------------- oversize upload prompt ---------------- */

function OversizeModal({ modalProps, files, channelId, limit, splitIfNeeded }: { modalProps: any; files: File[]; channelId: string; limit: number; splitIfNeeded: boolean; }) {
    const big = files.filter(f => f.size > limit);
    const [state, setState] = useState<"ask" | "work" | "done">("ask");
    const [status, setStatus] = useState<string>("");
    const [progress, setProgress] = useState(0);
    const signal = React.useRef({ cancelled: false });

    const shrink = async () => {
        setState("work");
        try {
            const outs = await shrinkFiles(files, limit, splitIfNeeded, (msg, p) => { setStatus(msg); setProgress(p); }, signal.current);
            if (signal.current.cancelled) return;
            const left = await uploadToChannel(outs, channelId);
            if (left) toast(`${left} part(s) left over (10 per message) — find them in MediaForge`, false);
            setState("done");
            modalProps.onClose();
        } catch (e) {
            fail(e);
            setState("ask");
        }
    };

    return (
        <Modal {...modalProps} size="md" title="Too big for this channel"
            subtitle={`Limit here: ${humanBytes(limit)}`}
            actions={state === "ask" ? [
                { text: "Shrink & upload", variant: "primary", onClick: shrink },
                { text: "Open in MediaForge", variant: "secondary", onClick: async () => { modalProps.onClose(); for (const f of files) await addFromFile(f, "upload").catch(fail); openStudio({ channelId }); } },
                { text: "Upload anyway", variant: "secondary", onClick: () => { modalProps.onClose(); uploadRaw(files, channelId); } }
            ] : [{ text: "Cancel", variant: "critical-primary", onClick: () => { signal.current.cancelled = true; modalProps.onClose(); } }]}>
            <div className="vc-mf" style={{ display: "block", minHeight: 0 }}>
                {big.map(f => <div key={f.name + f.size} className="vc-mf-row"><span className="vc-mf-pill bad">{humanBytes(f.size)}</span> {f.name}</div>)}
                {state === "ask" && <div className="vc-mf-hint" style={{ marginTop: 8 }}>
                    MediaForge re-encodes to fit (two-pass MP4 / GIF / JPEG / MP3, picks resolution and frame rate itself){splitIfNeeded ? "; when even that can't fit, it splits into parts" : ""}.
                </div>}
                {state === "work" && <div style={{ marginTop: 10 }}><div className="vc-mf-sub">{status}</div><div className="vc-mf-bar" style={{ marginTop: 6 }}><i style={{ width: `${Math.round(progress * 100)}%` }} /></div></div>}
            </div>
        </Modal>
    );
}

/** Hand files to Discord's own uploader (it shows its own "too large" error). */
export function uploadRaw(files: File[], channelId: string) {
    UploadHandler.promptToUpload(files, ChannelStore.getChannel(channelId), DraftType.ChannelMessage);
}

export async function shrinkFiles(files: File[], limit: number, splitIfNeeded: boolean, onStatus: (msg: string, p: number) => void, signal: { cancelled: boolean; }) {
    const outs: FileInfo[] = [];
    for (let i = 0; i < files.length && !signal.cancelled; i++) {
        const f = files[i];
        const prefix = files.length > 1 ? `${i + 1}/${files.length} · ` : "";
        if (f.size <= limit) {
            const info = await api().writeTemp(f.name, new Uint8Array(await f.arrayBuffer()));
            outs.push(info);
            continue;
        }
        onStatus(`${prefix}reading ${f.name}`, 0);
        const item = await addFromFile(f, "upload");
        const tick = (s: JobStatus) => onStatus(`${prefix}${s.stage}`, s.progress);
        let s = await runJob({ op: "convert", input: item.file.path, target: "auto", maxBytes: Math.floor(limit * 0.98) }, tick, signal);
        if (s.status === "error" && splitIfNeeded && /split/i.test(s.hint ?? "")) {
            onStatus(`${prefix}too long — splitting into parts`, 0);
            s = await runJob({ op: "split", input: item.file.path, mode: "size", value: Math.floor(limit * 0.98), maxBytes: Math.floor(limit * 0.98) }, tick, signal);
        }
        if (s.status !== "done") throw new Error(`${f.name}: ${s.error ?? s.status}${s.hint ? ` (${s.hint})` : ""}`);
        outs.push(...s.outputs);
    }
    return outs;
}

export function openOversize(files: File[], channelId: string, limit: number, splitIfNeeded: boolean) {
    openModal(m => <OversizeModal modalProps={m} files={files} channelId={channelId} limit={limit} splitIfNeeded={splitIfNeeded} />);
}
