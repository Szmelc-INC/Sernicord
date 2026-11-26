/*
 * Sernicord MediaForge — main-process side.
 * Finds or installs ffmpeg / ffprobe / sox / yt-dlp / mpv / vlc, runs jobs built by planner.ts
 * (argv arrays only, never a shell), controls mpv (JSON IPC) and VLC (local HTTP interface),
 * and hosts JSPaint in its own sandboxed window.
 * Security: the renderer sends high-level specs; every number is coerced, every input path must
 * come from this module (temp inbox, file picker, previous job output) and outputs stay in WORK.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { ChildProcess, execFile, spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent, shell } from "electron";
import { createWriteStream, existsSync, promises as fs } from "fs";
import { createConnection, createServer, Socket } from "net";
import { tmpdir } from "os";
import { basename, delimiter, dirname, join, resolve, sep } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import {
    AudioFx, ConvertSpec, EditOptions, humanBytes, isHttpUrl, LIMITS, mimeOf, parseProbe, Plan, planAudioFx, planConvert,
    planDownload, PlanError, planJoin, planSplit, Probe, safeBaseName, Target, VideoCodec
} from "./planner";

/* ------------------------------------------------------------------ paths */

const WORK = join(tmpdir(), "sernicord-mediaforge");
const INBOX = join(WORK, "inbox");
const TOOLS_DIR = join(DATA_DIR, "mediaForge-tools");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

const allowed = new Set<string>();

function under(dir: string, p: string) {
    const r = resolve(p);
    return r === resolve(dir) || r.startsWith(resolve(dir) + sep);
}

function allow(p: string) {
    allowed.add(resolve(p));
    return resolve(p);
}

function checkInput(p: unknown): string {
    if (typeof p !== "string" || !p) throw new Error("Missing input");
    const r = resolve(p);
    if (!allowed.has(r) && !under(WORK, r)) throw new Error("That file was not opened through MediaForge");
    if (!existsSync(r)) throw new Error(`File is gone: ${basename(r)}`);
    return r;
}

function cleanName(name: unknown, fallback = "media") {
    const s = String(name ?? "").split(/[\\/]/).pop() ?? "";
    const ext = (s.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "").toLowerCase();
    return `${safeBaseName(s || fallback)}${ext ? `.${ext}` : ""}`;
}

async function cleanupOld() {
    try {
        const now = Date.now();
        for (const e of await fs.readdir(WORK, { withFileTypes: true })) {
            const p = join(WORK, e.name);
            const st = await fs.stat(p).catch(() => null);
            if (st && now - st.mtimeMs > 24 * 3600_000) await fs.rm(p, { recursive: true, force: true });
        }
    } catch { /* first run */ }
}
cleanupOld();

/* ------------------------------------------------------------------ tools */

export type ToolName = "ffmpeg" | "ffprobe" | "sox" | "yt-dlp" | "mpv" | "vlc";
const TOOL_NAMES: ToolName[] = ["ffmpeg", "ffprobe", "sox", "yt-dlp", "mpv", "vlc"];

export interface ToolStatus {
    name: ToolName;
    path: string | null;
    source: "custom" | "managed" | "system" | null;
    version: string | null;
    installable: boolean;
    hint: string;
}

let overrides: Partial<Record<ToolName, string>> = {};
const resolved = new Map<ToolName, { path: string; source: ToolStatus["source"]; } | null>();
const versions = new Map<string, string | null>();

async function isExec(p: string) {
    try {
        const st = await fs.stat(p);
        if (!st.isFile()) return false;
        if (IS_WIN) return true;
        await fs.access(p, 1 /* X_OK */);
        return true;
    } catch {
        return false;
    }
}

function systemDirs() {
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/Applications/VLC.app/Contents/MacOS", "/Applications/mpv.app/Contents/MacOS");
    else if (IS_WIN) dirs.push("C:\\Program Files\\VideoLAN\\VLC", "C:\\Program Files\\mpv", "C:\\ProgramData\\chocolatey\\bin", join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links"));
    else dirs.push("/usr/bin", "/usr/local/bin", "/bin", "/snap/bin", "/var/lib/flatpak/exports/bin");
    return [...new Set(dirs)];
}

function managedPath(name: ToolName) {
    if (name === "ffmpeg" || name === "ffprobe") return join(TOOLS_DIR, "ffmpeg", name + EXE);
    if (name === "yt-dlp") return join(TOOLS_DIR, "yt-dlp" + EXE);
    return null;
}

async function findTool(name: ToolName) {
    if (resolved.has(name)) return resolved.get(name)!;
    let hit: { path: string; source: ToolStatus["source"]; } | null = null;
    const o = overrides[name];
    if (o && await isExec(o)) hit = { path: resolve(o), source: "custom" };
    if (!hit) {
        const m = managedPath(name);
        if (m && await isExec(m)) hit = { path: m, source: "managed" };
    }
    if (!hit) {
        const exe = name === "vlc" && process.platform === "darwin" ? "VLC" : name;
        for (const d of systemDirs()) {
            const p = join(d, exe + EXE);
            if (await isExec(p)) { hit = { path: p, source: "system" }; break; }
        }
    }
    resolved.set(name, hit);
    return hit;
}

async function need(name: ToolName) {
    const t = await findTool(name);
    if (!t) {
        throw new PlanError(`${name} not found`, INSTALL_HINT[name]());
    }
    return t.path;
}

const INSTALL_HINT: Record<ToolName, () => string> = {
    "ffmpeg": () => "MediaForge → Tools → Install ffmpeg (or your package manager)",
    "ffprobe": () => "comes with ffmpeg: MediaForge → Tools → Install ffmpeg",
    "yt-dlp": () => "MediaForge → Tools → Install yt-dlp",
    "sox": () => IS_WIN ? "winget install ChrisBagwell.SoX" : process.platform === "darwin" ? "brew install sox" : "pacman -S sox · apt install sox · dnf install sox",
    "mpv": () => IS_WIN ? "winget install mpv" : process.platform === "darwin" ? "brew install mpv" : "pacman -S mpv · apt install mpv · flatpak install io.mpv.Mpv",
    "vlc": () => IS_WIN ? "winget install VideoLAN.VLC" : process.platform === "darwin" ? "brew install --cask vlc" : "pacman -S vlc · apt install vlc"
};

function versionOf(path: string, name: ToolName): Promise<string | null> {
    if (versions.has(path)) return Promise.resolve(versions.get(path)!);
    const flag = name === "ffmpeg" || name === "ffprobe" ? "-version" : "--version";
    return new Promise(res => {
        execFile(path, [flag], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
            const line = String(stdout || stderr || "").split(/\r?\n/).find(Boolean)?.trim() ?? null;
            const v = err && !line ? null : line?.replace(/\s*Copyright.*$/i, "").slice(0, 80) ?? null;
            versions.set(path, v);
            res(v);
        });
    });
}

function installable(name: ToolName) {
    if (name === "yt-dlp") return ["linux", "win32", "darwin"].includes(process.platform);
    if (name === "ffmpeg" || name === "ffprobe") return (process.platform === "linux" || IS_WIN) && (process.arch === "x64" || process.arch === "arm64");
    return false;
}

export async function configure(_e: IpcMainInvokeEvent, paths: Partial<Record<ToolName, string>>) {
    overrides = {};
    for (const n of TOOL_NAMES) if (typeof paths?.[n] === "string" && paths[n]!.trim()) overrides[n] = paths[n]!.trim();
    resolved.clear();
}

export async function tools(_e: IpcMainInvokeEvent, refresh = false): Promise<ToolStatus[]> {
    if (refresh) { resolved.clear(); versions.clear(); }
    return Promise.all(TOOL_NAMES.map(async name => {
        const t = await findTool(name);
        return {
            name,
            path: t?.path ?? null,
            source: t?.source ?? null,
            version: t ? await versionOf(t.path, name) : null,
            installable: installable(name),
            hint: INSTALL_HINT[name]()
        };
    }));
}

/* ------------------------------------------------------------------ jobs */

export interface FileInfo { path: string; name: string; size: number; mime: string; }

export interface JobStatus {
    id: string;
    kind: string;
    status: "running" | "done" | "error" | "cancelled";
    progress: number;
    stage: string;
    outputs: FileInfo[];
    error?: string;
    hint?: string;
    log: string[];
    startedAt: number;
    endedAt?: number;
}

interface Job extends JobStatus { proc?: ChildProcess; dir: string; }

const jobs = new Map<string, Job>();

function newJob(kind: string): Job {
    const id = randomBytes(8).toString("hex");
    const job: Job = { id, kind, status: "running", progress: 0, stage: "starting", outputs: [], log: [], startedAt: Date.now(), dir: join(WORK, id) };
    jobs.set(id, job);
    // keep the registry small
    if (jobs.size > 60) for (const [k, j] of jobs) if (j.status !== "running") { jobs.delete(k); if (jobs.size <= 40) break; }
    return job;
}

function log(job: Job, line: string) {
    if (!line.trim()) return;
    job.log.push(line.slice(0, 400));
    if (job.log.length > 80) job.log.splice(0, job.log.length - 80);
}

class Cancelled extends Error { }

async function fileInfo(p: string): Promise<FileInfo> {
    const st = await fs.stat(p);
    return { path: allow(p), name: basename(p), size: st.size, mime: mimeOf(p) };
}

function runStep(job: Job, tool: string, args: string[], label: string, duration: number | undefined, onLine?: (l: string) => void): Promise<void> {
    return new Promise((res, rej) => {
        if (job.status === "cancelled") return rej(new Cancelled());
        job.stage = label;
        log(job, `$ ${basename(tool)} ${args.map(a => (a.length > 120 ? a.slice(0, 117) + "…" : a)).join(" ")}`);
        const proc = spawn(tool, args, { cwd: job.dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        job.proc = proc;
        let errTail: string[] = [];
        let outBuf = "";
        proc.stdout!.setEncoding("utf8");
        proc.stdout!.on("data", (chunk: string) => {
            outBuf += chunk;
            let i: number;
            while ((i = outBuf.indexOf("\n")) >= 0) {
                const line = outBuf.slice(0, i).trim();
                outBuf = outBuf.slice(i + 1);
                const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
                if (m && duration && duration > 0) job.progress = Math.min(0.999, Number(m[1]) / 1e6 / duration);
                const d = line.match(/^\[download\]\s+([\d.]+)%/);
                if (d) job.progress = Math.min(0.999, Number(d[1]) / 100);
                if (!/^(out_time|frame|fps|stream_|bitrate|total_size|dup_|drop_|speed|progress|out_time_ms)=/.test(line) && !d) log(job, line);
                onLine?.(line);
            }
        });
        proc.stderr!.setEncoding("utf8");
        proc.stderr!.on("data", (chunk: string) => {
            const lines = chunk.split(/\r?\n|\r/).filter(Boolean);
            errTail = [...errTail, ...lines].slice(-12);
            for (const l of lines) {
                const d = l.match(/\[download\]\s+([\d.]+)%/);
                if (d) job.progress = Math.min(0.999, Number(d[1]) / 100);
                else if (/error|warning|invalid|failed/i.test(l)) log(job, l);
            }
        });
        proc.on("error", e => { job.proc = undefined; rej(e); });
        proc.on("close", code => {
            job.proc = undefined;
            if (outBuf.trim()) onLine?.(outBuf.trim());
            if (job.status === "cancelled") return rej(new Cancelled());
            if (code === 0) return res();
            rej(new Error(`${label} failed (exit ${code}): ${errTail.slice(-4).join(" · ") || "no output"}`));
        });
    });
}

async function execPlan(job: Job, plan: Plan): Promise<string[]> {
    await fs.mkdir(job.dir, { recursive: true });
    for (const w of plan.writeFiles ?? []) {
        if (!under(WORK, w.path)) throw new Error("plan wrote outside WORK");
        await fs.writeFile(w.path, w.content, "utf8");
    }
    const printed: string[] = [];
    try {
        for (const s of plan.steps) {
            const bin = await need(s.tool);
            await runStep(job, bin, s.args, s.label, s.duration, plan.printMarker ? l => {
                const i = l.indexOf(plan.printMarker!);
                if (i >= 0) printed.push(l.slice(i + plan.printMarker!.length).trim());
            } : undefined);
        }
    } finally {
        for (const t of plan.temp ?? []) if (under(WORK, t)) await fs.rm(t, { force: true }).catch(() => { });
    }
    let outs = plan.outputs;
    if (printed.length) outs = printed;
    else if (plan.collect) {
        const names = (await fs.readdir(plan.collect.dir)).filter(n => n.startsWith(plan.collect!.prefix) && !/\.(part|ytdl|temp)$/.test(n)).sort();
        outs = names.map(n => join(plan.collect!.dir, n));
    }
    for (const o of outs) if (!under(WORK, o)) throw new Error(`output escaped WORK: ${o}`);
    return outs.filter(o => existsSync(o));
}

async function probePath(path: string): Promise<Probe> {
    const bin = await need("ffprobe");
    const json = await new Promise<string>((res, rej) => execFile(
        bin, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
        { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true },
        (err, stdout, stderr) => err ? rej(new Error(`ffprobe: ${String(stderr || err.message).split("\n")[0]}`)) : res(stdout)
    ));
    const st = await fs.stat(path);
    return parseProbe(JSON.parse(json), path, basename(path), st.size);
}

function limitFor(target: Target, maxBytes?: number) {
    if (target === "emoji") return LIMITS.emoji;
    if (target === "sticker") return LIMITS.sticker;
    if (target === "soundboard") return LIMITS.soundboard;
    if (target === "avatar") return LIMITS.avatar;
    return maxBytes;
}

/** attempt ladder: re-plan smaller until every output fits */
async function convertLadder(job: Job, spec: ConvertSpec, label = ""): Promise<string[]> {
    const limit = limitFor(spec.target, spec.maxBytes);
    let last: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
        const plan = planConvert(spec, attempt);
        if (!plan) break;
        if (attempt) log(job, `attempt ${attempt + 1}: last result ${humanBytes(Math.max(...await Promise.all(last.map(async o => (await fs.stat(o)).size))))} > ${humanBytes(limit!)}`);
        plan.steps.forEach(s => { s.label = `${label}${s.label}${attempt ? ` · try ${attempt + 1}` : ""}`; });
        const outs = await execPlan(job, plan);
        if (!limit) return outs;
        const sizes = await Promise.all(outs.map(async o => (await fs.stat(o)).size));
        if (sizes.every(s => s <= limit)) return outs;
        for (const o of last) if (!outs.includes(o)) await fs.rm(o, { force: true }).catch(() => { });
        last = outs;
    }
    if (last.length && limit) throw new PlanError(`could not get under ${humanBytes(limit)}`, "trim it, lower the resolution, or split it");
    return last;
}

/** after join / copy-split / download: re-encode any output that is still too big */
async function fitOutputs(job: Job, outs: string[], maxBytes?: number) {
    if (!maxBytes) return outs;
    const result: string[] = [];
    for (const o of outs) {
        if ((await fs.stat(o)).size <= maxBytes) { result.push(o); continue; }
        const p = await probePath(o);
        result.push(...await convertLadder(job, {
            input: p, target: "auto", maxBytes, outDir: job.dir, baseName: `${safeBaseName(p.name)}-fit`, sep
        }, "fit · "));
    }
    return result;
}

/* ---- spec sanitising (renderer input is not trusted to be well-formed) ---- */

const TARGETS: Target[] = ["auto", "mp4", "webm", "mkv", "gif", "webp", "apng", "png", "jpg", "mp3", "opus", "m4a", "wav", "flac", "emoji", "sticker", "soundboard", "screenshot", "avatar"];
const CODECS: VideoCodec[] = ["auto", "h264", "vp9", "hevc", "av1", "copy"];

function n(v: unknown, min: number, max: number): number | undefined {
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined;
}

function sanitizeEdit(e: any): EditOptions | undefined {
    if (!e || typeof e !== "object") return undefined;
    const out: EditOptions = {
        start: n(e.start, 0, 1e6),
        end: n(e.end, 0, 1e6),
        maxSide: n(e.maxSide, 16, 8192),
        width: n(e.width, 16, 8192),
        height: n(e.height, 16, 8192),
        fps: n(e.fps, 1, 120),
        speed: n(e.speed, 0.1, 16),
        volume: n(e.volume, 0, 8),
        fadeIn: n(e.fadeIn, 0, 600),
        fadeOut: n(e.fadeOut, 0, 600),
        at: n(e.at, 0, 1e6),
        reverse: !!e.reverse || undefined,
        mute: !!e.mute || undefined,
        flipH: !!e.flipH || undefined,
        flipV: !!e.flipV || undefined,
        loudnorm: e.loudnorm == null ? undefined : !!e.loudnorm,
        rotate: [90, 180, 270].includes(Number(e.rotate)) ? Number(e.rotate) as 90 | 180 | 270 : undefined,
        stickerFormat: e.stickerFormat === "gif" ? "gif" : e.stickerFormat === "apng" ? "apng" : undefined
    };
    if (e.crop && typeof e.crop === "object") {
        const c = { x: n(e.crop.x, 0, 16384), y: n(e.crop.y, 0, 16384), w: n(e.crop.w, 2, 16384), h: n(e.crop.h, 2, 16384) };
        if (c.x != null && c.y != null && c.w != null && c.h != null) out.crop = c as any;
    }
    if (e.caption && typeof e.caption.text === "string" && e.caption.text.trim()) {
        out.caption = { text: e.caption.text.slice(0, 200), position: e.caption.position === "top" ? "top" : "bottom" };
    }
    return out;
}

function sanitizeFx(fx: any): AudioFx {
    return {
        normalize: !!fx?.normalize, trimSilence: !!fx?.trimSilence, echo: !!fx?.echo, reverse: !!fx?.reverse,
        pitch: n(fx?.pitch, -2400, 2400), tempo: n(fx?.tempo, 0.25, 4), speed: n(fx?.speed, 0.25, 4),
        reverb: n(fx?.reverb, 0, 100), bass: n(fx?.bass, -20, 20), treble: n(fx?.treble, -20, 20)
    };
}

export type JobSpec =
    | { op: "convert"; input: string; target: Target; maxBytes?: number; edit?: EditOptions; videoCodec?: VideoCodec; quality?: number; audioBitrate?: number; }
    | { op: "split"; input: string; mode: "duration" | "count" | "size"; value: number; exact?: boolean; maxBytes?: number; }
    | { op: "join"; inputs: string[]; target: "auto" | "mp4" | "webm" | "gif" | "mp3" | "opus" | "wav"; imageDuration?: number; maxBytes?: number; }
    | { op: "audiofx"; input: string; fx: AudioFx; target: "mp3" | "opus" | "wav" | "flac"; }
    | { op: "download"; url: string; mode: "best" | "discord" | "audio" | "video720"; maxBytes?: number; playlist?: boolean; };

async function runJob(job: Job, spec: JobSpec) {
    const maxBytes = n((spec as any).maxBytes, 64 * 1024, 64 * 1024 ** 3);
    switch (spec.op) {
        case "convert": {
            const input = checkInput(spec.input);
            if (!TARGETS.includes(spec.target)) throw new Error(`Unknown target ${spec.target}`);
            job.stage = "probing";
            const p = await probePath(input);
            return convertLadder(job, {
                input: p, target: spec.target, maxBytes, edit: sanitizeEdit(spec.edit),
                videoCodec: CODECS.includes(spec.videoCodec as any) ? spec.videoCodec : "auto",
                quality: n(spec.quality, 0, 100), audioBitrate: n(spec.audioBitrate, 8, 512),
                outDir: job.dir, baseName: safeBaseName(p.name), sep
            });
        }
        case "split": {
            const input = checkInput(spec.input);
            const p = await probePath(input);
            const mode = spec.mode === "count" || spec.mode === "size" ? spec.mode : "duration";
            const value = n(spec.value, 0, 64 * 1024 ** 3) ?? 0;
            const plan = planSplit({ input: p, mode, value, exact: !!spec.exact, maxBytes, outDir: job.dir, baseName: safeBaseName(p.name), sep });
            if ("copy" in plan) return fitOutputs(job, await execPlan(job, plan.copy), maxBytes);
            const outs: string[] = [];
            for (let i = 0; i < plan.parts.length; i++) {
                outs.push(...await convertLadder(job, plan.parts[i], `part ${i + 1}/${plan.parts.length} · `));
            }
            return outs;
        }
        case "join": {
            if (!Array.isArray(spec.inputs) || spec.inputs.length < 2 || spec.inputs.length > 200) throw new Error("Join needs 2–200 files");
            const probes: Probe[] = [];
            for (const i of spec.inputs) probes.push(await probePath(checkInput(i)));
            const target = ["auto", "mp4", "webm", "gif", "mp3", "opus", "wav"].includes(spec.target) ? spec.target : "auto";
            const plan = planJoin({ inputs: probes, target, imageDuration: n(spec.imageDuration, 0.1, 600), outDir: job.dir, baseName: `${safeBaseName(probes[0].name)}-joined`, sep });
            return fitOutputs(job, await execPlan(job, plan), maxBytes);
        }
        case "audiofx": {
            const p = await probePath(checkInput(spec.input));
            const target = ["mp3", "opus", "wav", "flac"].includes(spec.target) ? spec.target : "mp3";
            return execPlan(job, planAudioFx(p, sanitizeFx(spec.fx), target, job.dir, safeBaseName(p.name), sep));
        }
        case "download": {
            if (typeof spec.url !== "string" || !isHttpUrl(spec.url)) throw new Error("Only http(s) links");
            const ff = await findTool("ffmpeg");
            const mode = ["best", "discord", "audio", "video720"].includes(spec.mode) ? spec.mode : "best";
            const outs = await execPlan(job, planDownload({ url: spec.url, mode, maxBytes, outDir: job.dir, ffmpegDir: ff ? dirname(ff.path) : undefined, playlist: !!spec.playlist }));
            return mode === "discord" ? fitOutputs(job, outs, maxBytes) : outs;
        }
    }
    throw new Error("Unknown job");
}

export async function startJob(_e: IpcMainInvokeEvent, spec: JobSpec): Promise<string> {
    const job = newJob(spec?.op ?? "?");
    await fs.mkdir(job.dir, { recursive: true });
    (async () => {
        try {
            const outs = await runJob(job, spec);
            job.outputs = await Promise.all(outs.map(fileInfo));
            job.status = "done";
            job.progress = 1;
            job.stage = `done · ${job.outputs.length} file(s)`;
        } catch (err) {
            if (err instanceof Cancelled || job.status === "cancelled") {
                job.status = "cancelled";
                job.stage = "cancelled";
            } else {
                job.status = "error";
                job.error = String((err as Error)?.message ?? err);
                job.hint = (err as PlanError)?.hint;
                job.stage = "failed";
                log(job, job.error);
            }
        } finally {
            job.endedAt = Date.now();
        }
    })();
    return job.id;
}

function publicJob(j: Job): JobStatus {
    const { proc, dir, ...rest } = j;
    return { ...rest, outputs: [...rest.outputs], log: rest.log.slice(-30) };
}

export async function jobStatus(_e: IpcMainInvokeEvent, id: string): Promise<JobStatus | null> {
    const j = jobs.get(id);
    return j ? publicJob(j) : null;
}

export async function listJobs(_e: IpcMainInvokeEvent): Promise<JobStatus[]> {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map(publicJob);
}

export async function cancelJob(_e: IpcMainInvokeEvent, id: string) {
    const j = jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.status = "cancelled";
    j.proc?.kill(IS_WIN ? undefined : "SIGKILL");
    return true;
}

/* ------------------------------------------------------------------ files */

export async function writeTemp(_e: IpcMainInvokeEvent, name: string, bytes: Uint8Array): Promise<FileInfo> {
    if (!(bytes instanceof Uint8Array)) throw new Error("bytes expected");
    const dir = join(INBOX, randomBytes(6).toString("hex"));
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, cleanName(name));
    await fs.writeFile(p, bytes);
    return fileInfo(p);
}

export async function fetchToTemp(_e: IpcMainInvokeEvent, url: string, name?: string): Promise<FileInfo> {
    if (!isHttpUrl(url)) throw new Error("Only http(s) links");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${new URL(url).hostname}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 4 * 1024 ** 3) throw new Error("File is larger than 4 GB");
    const dir = join(INBOX, randomBytes(6).toString("hex"));
    await fs.mkdir(dir, { recursive: true });
    const guess = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
    const p = join(dir, cleanName(guess, "download"));
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(p));
    return fileInfo(p);
}

export async function pickFiles(e: IpcMainInvokeEvent, multi = true): Promise<FileInfo[]> {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
        title: "Open media for MediaForge",
        properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
        filters: [
            { name: "Media", extensions: ["mp4", "mkv", "webm", "mov", "avi", "m4v", "gif", "png", "jpg", "jpeg", "webp", "avif", "heic", "bmp", "tiff", "mp3", "ogg", "opus", "wav", "flac", "m4a", "aac"] },
            { name: "All files", extensions: ["*"] }
        ]
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(p => { allow(p); return fileInfo(p); }));
}

export async function probe(_e: IpcMainInvokeEvent, path: string): Promise<Probe> {
    return probePath(checkInput(path));
}

export async function readBytes(_e: IpcMainInvokeEvent, path: string): Promise<Uint8Array> {
    const p = checkInput(path);
    const st = await fs.stat(p);
    if (st.size > 1024 ** 3) throw new Error("Larger than 1 GB; save it instead");
    return new Uint8Array(await fs.readFile(p));
}

export async function saveAs(e: IpcMainInvokeEvent, path: string, suggested?: string): Promise<string | null> {
    const p = checkInput(path);
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const defaultPath = join(app.getPath("downloads"), cleanName(suggested || basename(p)));
    const r = await (win ? dialog.showSaveDialog(win, { defaultPath }) : dialog.showSaveDialog({ defaultPath }));
    if (r.canceled || !r.filePath) return null;
    await fs.copyFile(p, r.filePath);
    return r.filePath;
}

export async function saveAllTo(e: IpcMainInvokeEvent, paths: string[]): Promise<number> {
    const files = paths.map(checkInput);
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = { title: "Save into folder", properties: ["openDirectory", "createDirectory"] };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || !r.filePaths[0]) return 0;
    for (const f of files) await fs.copyFile(f, join(r.filePaths[0], basename(f)));
    return files.length;
}

export async function reveal(_e: IpcMainInvokeEvent, path: string) {
    shell.showItemInFolder(checkInput(path));
}

export async function openDefault(_e: IpcMainInvokeEvent, path: string) {
    return shell.openPath(checkInput(path));
}

/* ------------------------------------------------------------------ installs */

interface Asset { file: string; base: string; sums: string; }

function assetFor(name: "ffmpeg" | "yt-dlp"): Asset | null {
    const a = process.arch, pl = process.platform;
    if (name === "yt-dlp") {
        const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
        const file = pl === "win32" ? "yt-dlp.exe" : pl === "darwin" ? "yt-dlp_macos" : a === "arm64" ? "yt-dlp_linux_aarch64" : a === "x64" ? "yt-dlp_linux" : null;
        return file ? { file, base, sums: "SHA2-256SUMS" } : null;
    }
    const base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
    const tag = pl === "linux" ? (a === "x64" ? "linux64" : a === "arm64" ? "linuxarm64" : null) : pl === "win32" ? (a === "x64" ? "win64" : a === "arm64" ? "winarm64" : null) : null;
    if (!tag) return null;
    return { file: `ffmpeg-master-latest-${tag}-gpl.${pl === "win32" ? "zip" : "tar.xz"}`, base, sums: "checksums.sha256" };
}

async function download(job: Job, url: string, dest: string) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get("content-length") || 0);
    let got = 0;
    const hash = createHash("sha256");
    const src = Readable.fromWeb(res.body as any);
    src.on("data", (c: Buffer) => {
        got += c.length;
        hash.update(c);
        if (total) job.progress = Math.min(0.95, got / total);
        job.stage = `downloading ${humanBytes(got)}${total ? ` / ${humanBytes(total)}` : ""}`;
        if (job.status === "cancelled") src.destroy(new Cancelled());
    });
    await pipeline(src, createWriteStream(dest));
    return hash.digest("hex");
}

async function expectedSum(asset: Asset) {
    const res = await fetch(asset.base + asset.sums, { redirect: "follow" });
    if (!res.ok) throw new Error(`could not fetch ${asset.sums} (HTTP ${res.status})`);
    const line = (await res.text()).split(/\r?\n/).find(l => l.trim().endsWith(asset.file) && /^[a-f0-9]{64}\s/i.test(l.trim()));
    if (!line) throw new Error(`${asset.file} is not listed in ${asset.sums}`);
    return line.trim().split(/\s+/)[0].toLowerCase();
}

async function findFile(root: string, name: string, depth = 4): Promise<string | null> {
    if (depth < 0) return null;
    for (const e of await fs.readdir(root, { withFileTypes: true })) {
        const p = join(root, e.name);
        if (e.isFile() && e.name === name) return p;
        if (e.isDirectory()) {
            const hit = await findFile(p, name, depth - 1);
            if (hit) return hit;
        }
    }
    return null;
}

async function install(job: Job, name: "ffmpeg" | "yt-dlp") {
    const asset = assetFor(name);
    if (!asset) throw new PlanError(`no ${name} build for ${process.platform}/${process.arch}`, INSTALL_HINT[name]());
    await fs.mkdir(TOOLS_DIR, { recursive: true });
    job.stage = "checking release";
    const want = await expectedSum(asset);
    const tmp = join(job.dir, asset.file);
    await fs.mkdir(job.dir, { recursive: true });
    const got = await download(job, asset.base + asset.file, tmp);
    if (got !== want) throw new Error(`checksum mismatch for ${asset.file} (got ${got.slice(0, 12)}…, want ${want.slice(0, 12)}…)`);
    log(job, `sha256 ok ${want}`);
    if (name === "yt-dlp") {
        const dest = managedPath("yt-dlp")!;
        await fs.copyFile(tmp, dest + ".new");
        if (!IS_WIN) await fs.chmod(dest + ".new", 0o755);
        await fs.rename(dest + ".new", dest);
    } else {
        job.stage = "unpacking";
        const out = join(job.dir, "x");
        await fs.mkdir(out, { recursive: true });
        await new Promise<void>((res, rej) => execFile("tar", ["-xf", tmp, "-C", out], { windowsHide: true, timeout: 300_000 }, err => err ? rej(new Error(`unpack failed: ${err.message} (needs tar${IS_WIN ? "" : " + xz"})`)) : res()));
        const dir = join(TOOLS_DIR, "ffmpeg");
        await fs.mkdir(dir, { recursive: true });
        for (const b of ["ffmpeg", "ffprobe"]) {
            const f = await findFile(out, b + EXE);
            if (!f) throw new Error(`${b}${EXE} missing in the archive`);
            await fs.copyFile(f, join(dir, b + EXE + ".new"));
            if (!IS_WIN) await fs.chmod(join(dir, b + EXE + ".new"), 0o755);
            await fs.rename(join(dir, b + EXE + ".new"), join(dir, b + EXE));
        }
    }
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => { });
    resolved.clear();
    versions.clear();
}

export async function installTool(_e: IpcMainInvokeEvent, name: ToolName): Promise<string> {
    const which = name === "ffprobe" ? "ffmpeg" : name;
    if (which !== "ffmpeg" && which !== "yt-dlp") throw new PlanError(`${name} has no portable build to fetch`, INSTALL_HINT[name]());
    const job = newJob(`install ${which}`);
    (async () => {
        try {
            await install(job, which);
            job.status = "done";
            job.progress = 1;
            job.stage = `${which} installed`;
        } catch (err) {
            job.status = job.status === "cancelled" ? "cancelled" : "error";
            job.error = String((err as Error)?.message ?? err);
            job.hint = (err as PlanError)?.hint;
            job.stage = "failed";
        } finally {
            job.endedAt = Date.now();
        }
    })();
    return job.id;
}

/* ------------------------------------------------------------------ players */

export type Player = "mpv" | "vlc";

export interface PlayerStatus {
    player: Player;
    running: boolean;
    title?: string;
    position?: number;
    duration?: number;
    paused?: boolean;
    volume?: number;
}

let mpv: { proc: ChildProcess; ipc: string; } | null = null;
let vlc: { proc: ChildProcess; port: number; pass: string; } | null = null;

function checkTarget(t: unknown) {
    if (typeof t !== "string" || !t) throw new Error("Nothing to play");
    if (isHttpUrl(t)) return t;
    return checkInput(t);
}

function freePort(): Promise<number> {
    return new Promise((res, rej) => {
        const s = createServer();
        s.once("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as any).port;
            s.close(() => res(port));
        });
    });
}

function mpvRequest(command: unknown[]): Promise<any> {
    if (!mpv) return Promise.reject(new Error("mpv is not running"));
    const ipc = mpv.ipc;
    return new Promise((res, rej) => {
        const id = Math.floor(Math.random() * 1e9);
        const sock: Socket = createConnection(ipc);
        let buf = "";
        const timer = setTimeout(() => { sock.destroy(); rej(new Error("mpv did not answer")); }, 2500);
        sock.setEncoding("utf8");
        sock.on("connect", () => sock.write(JSON.stringify({ command, request_id: id }) + "\n"));
        sock.on("data", (d: string) => {
            buf += d;
            for (const line of buf.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.request_id === id) {
                        clearTimeout(timer);
                        sock.end();
                        return msg.error && msg.error !== "success" ? rej(new Error(msg.error)) : res(msg.data);
                    }
                } catch { /* partial line */ }
            }
        });
        sock.on("error", e => { clearTimeout(timer); rej(e); });
    });
}

async function vlcRequest(query: string) {
    if (!vlc) throw new Error("VLC is not running");
    const res = await fetch(`http://127.0.0.1:${vlc.port}/requests/status.json${query ? `?${query}` : ""}`, {
        headers: { Authorization: `Basic ${Buffer.from(`:${vlc.pass}`).toString("base64")}` }
    });
    if (!res.ok) throw new Error(`VLC HTTP ${res.status}`);
    return res.json();
}

export interface PlayOptions { start?: number; loop?: boolean; ontop?: boolean; fullscreen?: boolean; append?: boolean; }

export async function play(_e: IpcMainInvokeEvent, player: Player, target: string, opts: PlayOptions = {}) {
    const t = checkTarget(target);
    const start = n(opts.start, 0, 1e6);
    if (player === "mpv") {
        if (mpv && opts.append) {
            await mpvRequest(["loadfile", t, "append-play"]);
            return;
        }
        if (mpv) {
            await mpvRequest(["loadfile", t, "replace"]);
            if (start) await mpvRequest(["set_property", "time-pos", start]);
            return;
        }
        const bin = await need("mpv");
        const ipc = IS_WIN ? `\\\\.\\pipe\\sernicord-mpv-${randomBytes(4).toString("hex")}` : join(WORK, `mpv-${randomBytes(4).toString("hex")}.sock`);
        await fs.mkdir(WORK, { recursive: true });
        const yt = await findTool("yt-dlp");
        const args = [
            `--input-ipc-server=${ipc}`, "--force-window=yes", "--keep-open=yes", "--idle=once", "--title=${media-title} — Sernicord",
            ...(yt ? [`--script-opts=ytdl_hook-ytdl_path=${yt.path}`] : []),
            ...(start ? [`--start=${start}`] : []),
            ...(opts.loop ? ["--loop-file=inf"] : []),
            ...(opts.ontop ? ["--ontop"] : []),
            ...(opts.fullscreen ? ["--fullscreen"] : []),
            "--", t
        ];
        const proc = spawn(bin, args, { detached: false, stdio: "ignore", windowsHide: false });
        mpv = { proc, ipc };
        proc.on("exit", () => { if (mpv?.proc === proc) mpv = null; });
        proc.on("error", () => { if (mpv?.proc === proc) mpv = null; });
        return;
    }
    if (vlc && opts.append) {
        await vlcRequest(`command=in_enqueue&input=${encodeURIComponent(t)}`);
        return;
    }
    if (vlc) {
        await vlcRequest(`command=in_play&input=${encodeURIComponent(t)}`);
        return;
    }
    const bin = await need("vlc");
    const port = await freePort();
    const pass = randomBytes(12).toString("hex");
    // targets are http(s) URLs or absolute paths, so they can never look like an option
    const args = [
        "--extraintf=http", "--http-host=127.0.0.1", `--http-port=${port}`, `--http-password=${pass}`,
        ...(start ? [`--start-time=${start}`] : []),
        ...(opts.loop ? ["--loop"] : []),
        ...(opts.ontop ? ["--video-on-top"] : []),
        ...(opts.fullscreen ? ["--fullscreen"] : []),
        t
    ];
    const proc = spawn(bin, args, { stdio: "ignore" });
    vlc = { proc, port, pass };
    proc.on("exit", () => { if (vlc?.proc === proc) vlc = null; });
    proc.on("error", () => { if (vlc?.proc === proc) vlc = null; });
}

export type PlayerCommand = "toggle" | "stop" | "seek" | "volume" | "next" | "prev" | "quit";

export async function playerCommand(_e: IpcMainInvokeEvent, player: Player, cmd: PlayerCommand, arg?: number) {
    const v = n(arg, -1e6, 1e6) ?? 0;
    if (player === "mpv") {
        if (!mpv) throw new Error("mpv is not running");
        switch (cmd) {
            case "toggle": return mpvRequest(["cycle", "pause"]);
            case "stop": return mpvRequest(["stop"]);
            case "seek": return mpvRequest(["seek", v, "relative"]);
            case "volume": return mpvRequest(["add", "volume", v]);
            case "next": return mpvRequest(["playlist-next"]);
            case "prev": return mpvRequest(["playlist-prev"]);
            case "quit": return mpvRequest(["quit"]);
        }
    }
    if (!vlc) throw new Error("VLC is not running");
    switch (cmd) {
        case "toggle": return vlcRequest("command=pl_pause");
        case "stop": return vlcRequest("command=pl_stop");
        case "seek": return vlcRequest(`command=seek&val=${encodeURIComponent(`${v >= 0 ? "+" : ""}${Math.round(v)}s`)}`);
        case "volume": return vlcRequest(`command=volume&val=${encodeURIComponent(`${v >= 0 ? "+" : ""}${Math.round(v * 2.56)}`)}`);
        case "next": return vlcRequest("command=pl_next");
        case "prev": return vlcRequest("command=pl_previous");
        case "quit": vlc.proc.kill(); vlc = null; return;
    }
}

export async function playerStatus(_e: IpcMainInvokeEvent, player: Player): Promise<PlayerStatus> {
    try {
        if (player === "mpv") {
            if (!mpv) return { player, running: false };
            const [title, position, duration, paused, volume] = await Promise.all(
                ["media-title", "time-pos", "duration", "pause", "volume"].map(p => mpvRequest(["get_property", p]).catch(() => undefined))
            );
            return { player, running: true, title, position, duration, paused, volume };
        }
        if (!vlc) return { player, running: false };
        const s = await vlcRequest("");
        const meta = s?.information?.category?.meta ?? {};
        return { player, running: true, title: meta.title ?? meta.filename, position: s.time, duration: s.length, paused: s.state !== "playing", volume: Math.round((s.volume ?? 0) / 2.56) };
    } catch {
        return { player, running: player === "mpv" ? !!mpv : !!vlc };
    }
}

/* ------------------------------------------------------------------ paint */

let paintWin: BrowserWindow | null = null;
const PAINT_ORIGIN = "https://jspaint.app";

export async function openPaint(_e: IpcMainInvokeEvent, imagePath?: string) {
    let hash = "";
    if (imagePath) {
        const p = checkInput(imagePath);
        const st = await fs.stat(p);
        if (st.size > 1.4 * 1024 * 1024) throw new PlanError("image is too big to hand to Paint", "shrink it first (Convert → png/jpg, max side 1600)");
        hash = `#load:data:${mimeOf(p)};base64,${(await fs.readFile(p)).toString("base64")}`;
    }
    if (paintWin && !paintWin.isDestroyed()) {
        if (hash) await paintWin.loadURL(`${PAINT_ORIGIN}/${hash}`);
        paintWin.show();
        paintWin.focus();
        return;
    }
    paintWin = new BrowserWindow({
        width: 1180, height: 820, title: "Paint — Sernicord MediaForge", autoHideMenuBar: true, backgroundColor: "#008080",
        webPreferences: { partition: "persist:sernicord-paint", sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    const wc = paintWin.webContents;
    wc.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    wc.on("will-navigate", (ev, url) => { if (!url.startsWith(PAINT_ORIGIN + "/")) ev.preventDefault(); });
    wc.session.on("will-download", (_ev, item) => {
        const dir = join(WORK, "paint");
        require("fs").mkdirSync(dir, { recursive: true });
        const p = join(dir, cleanName(item.getFilename(), "paint.png"));
        item.setSavePath(p);
        item.once("done", (_x, state) => { if (state === "completed") allow(p); });
    });
    paintWin.on("closed", () => { paintWin = null; });
    await paintWin.loadURL(`${PAINT_ORIGIN}/${hash}`);
}

/** Copy the current JSPaint canvas into a PNG in WORK. */
export async function grabPaint(_e: IpcMainInvokeEvent): Promise<FileInfo> {
    if (!paintWin || paintWin.isDestroyed()) throw new Error("Paint is not open");
    const url: unknown = await paintWin.webContents.executeJavaScript(`(() => {
        const cs = [...document.querySelectorAll("canvas")];
        const c = document.querySelector("canvas.main-canvas") || cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return c ? c.toDataURL("image/png") : null;
    })()`, true);
    if (typeof url !== "string" || !url.startsWith("data:image/png;base64,")) throw new Error("Could not read the Paint canvas");
    const dir = join(WORK, "paint");
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, `paint-${Date.now()}.png`);
    await fs.writeFile(p, Buffer.from(url.slice("data:image/png;base64,".length), "base64"));
    return fileInfo(p);
}

export async function paintOpen(_e: IpcMainInvokeEvent) {
    return !!paintWin && !paintWin.isDestroyed();
}
