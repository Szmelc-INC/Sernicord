/*
 * Sernicord MediaForge — pure planner: turns a high-level spec + ffprobe info into
 * ffmpeg / sox / yt-dlp argv lists. No Node / Electron / Discord imports, so it runs
 * in the main process and under plain node for tests:
 *   node --experimental-strip-types --no-warnings scripts/test-mediaforge-planner.ts
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Tool = "ffmpeg" | "ffprobe" | "sox" | "yt-dlp";

export interface VideoInfo {
    codec: string;
    width: number;
    height: number;
    fps: number;
    pixFmt: string;
    alpha: boolean;
    frames: number;
}

export interface AudioInfo {
    codec: string;
    sampleRate: number;
    channels: number;
    bitrate: number;
}

export interface Probe {
    path: string;
    name: string;
    size: number;
    /** seconds; 0 for still images */
    duration: number;
    format: string;
    video?: VideoInfo;
    audio?: AudioInfo;
    isImage: boolean;
    isAnimated: boolean;
}

export interface Step {
    tool: Tool;
    args: string[];
    label: string;
    /** output-timeline seconds, for ffmpeg -progress percentages */
    duration?: number;
}

export interface Plan {
    steps: Step[];
    outputs: string[];
    /** files the runner writes before the steps (concat lists) */
    writeFiles?: Array<{ path: string; content: string; }>;
    /** files the runner deletes afterwards */
    temp?: string[];
    /** outputs are collected from dir by prefix (segment muxer, yt-dlp) */
    collect?: { dir: string; prefix: string; };
    /** yt-dlp prints this marker before the final file path */
    printMarker?: string;
}

export type Target =
    | "auto" | "mp4" | "webm" | "mkv" | "gif" | "webp" | "apng" | "png" | "jpg"
    | "mp3" | "opus" | "m4a" | "wav" | "flac"
    | "emoji" | "sticker" | "soundboard" | "screenshot" | "avatar";

export type VideoCodec = "auto" | "h264" | "vp9" | "hevc" | "av1" | "copy";

export interface Crop { x: number; y: number; w: number; h: number; }

export interface EditOptions {
    start?: number;
    end?: number;
    crop?: Crop;
    /** fit inside a square of this size (keeps aspect) */
    maxSide?: number;
    width?: number;
    height?: number;
    fps?: number;
    speed?: number;
    reverse?: boolean;
    mute?: boolean;
    /** linear gain, 1 = unchanged */
    volume?: number;
    fadeIn?: number;
    fadeOut?: number;
    rotate?: 0 | 90 | 180 | 270;
    flipH?: boolean;
    flipV?: boolean;
    caption?: { text: string; position: "top" | "bottom"; };
    loudnorm?: boolean;
    /** screenshot timestamp (seconds, input timeline) */
    at?: number;
    /** sticker animation format */
    stickerFormat?: "apng" | "gif";
}

export interface ConvertSpec {
    input: Probe;
    target: Target;
    maxBytes?: number;
    edit?: EditOptions;
    videoCodec?: VideoCodec;
    /** 0..100, higher = better; default 70 */
    quality?: number;
    /** kbps */
    audioBitrate?: number;
    outDir: string;
    baseName: string;
    sep?: string;
}

export const LIMITS = {
    emoji: 256 * 1024,
    sticker: 512 * 1024,
    soundboard: 512 * 1024,
    soundboardSeconds: 5.2,
    avatar: 10 * 1024 * 1024
} as const;

/* ---------------------------------------------------------------- probe */

function num(v: unknown, d = 0) {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : d;
}

function rate(r: unknown) {
    if (typeof r !== "string") return 0;
    const [a, b] = r.split("/").map(Number);
    return b ? a / b : a || 0;
}

const IMAGE_CODECS = /^(png|mjpeg|jpegls|webp|bmp|tiff|gif|apng|jpeg2000|jpegxl|libjxl|av1|hevc|qoi|pam|ppm|pgm|targa|exr|psd|svg)$/;
const IMAGE_FORMATS = /(image2|png_pipe|jpeg_pipe|webp_pipe|gif|apng|bmp_pipe|tiff_pipe|jpegxl_pipe|qoi_pipe|psd_pipe|svg_pipe|pam_pipe|ppm_pipe)/;

/** Summarise `ffprobe -show_format -show_streams -of json` output. */
export function parseProbe(json: any, path: string, name: string, size: number): Probe {
    const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
    const fmt = json?.format ?? {};
    const vs = streams.find(s => s.codec_type === "video" && !(s.disposition?.attached_pic));
    const as = streams.find(s => s.codec_type === "audio");
    const format = String(fmt.format_name ?? "");
    let duration = num(fmt.duration, 0) || num(vs?.duration, 0) || num(as?.duration, 0);

    let video: VideoInfo | undefined;
    if (vs) {
        let width = num(vs.width), height = num(vs.height);
        const rot = Math.abs(num(vs.side_data_list?.find((d: any) => d.rotation != null)?.rotation, num(vs.tags?.rotate, 0))) % 360;
        if (rot === 90 || rot === 270) [width, height] = [height, width];
        const pixFmt = String(vs.pix_fmt ?? "");
        video = {
            codec: String(vs.codec_name ?? ""),
            width, height,
            fps: rate(vs.avg_frame_rate) || rate(vs.r_frame_rate),
            pixFmt,
            alpha: /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|pal8)/.test(pixFmt),
            frames: num(vs.nb_frames, 0) || num(vs.nb_read_frames, 0)
        };
    }
    const audio: AudioInfo | undefined = as ? {
        codec: String(as.codec_name ?? ""),
        sampleRate: num(as.sample_rate, 48000),
        channels: num(as.channels, 2),
        bitrate: Math.round(num(as.bit_rate, 0) / 1000)
    } : undefined;

    const codecIsImage = !!video && IMAGE_CODECS.test(video.codec);
    const formatIsImage = IMAGE_FORMATS.test(format) || /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|jxl|qoi)$/i.test(name);
    const animatedImage = !!video && (video.codec === "gif" || video.codec === "apng" || (video.codec === "webp" && video.frames > 1)) && (video.frames > 1 || duration > 0.1);
    const isImage = !!video && !audio && codecIsImage && formatIsImage && !animatedImage;
    if (isImage) duration = 0;
    return {
        path, name, size, duration, format, video, audio,
        isImage,
        isAnimated: animatedImage
    };
}

/* ---------------------------------------------------------------- helpers */

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const r3 = (n: number) => String(Math.round(n * 1000) / 1000);
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export function extOf(target: Exclude<Target, "auto" | "emoji" | "sticker" | "soundboard" | "screenshot" | "avatar">) {
    return target === "opus" ? "ogg" : target;
}

/** Where `auto` lands for an input: what embeds inline in Discord. */
export function autoTarget(p: Probe): Exclude<Target, "auto" | "emoji" | "sticker" | "soundboard" | "screenshot" | "avatar"> {
    if (!p.video) return "mp3";
    if (p.isImage) return p.video.alpha ? "png" : "jpg";
    if (p.isAnimated) return "gif";
    return "mp4";
}

/** Output-timeline duration after trim + speed. */
export function editedDuration(p: Probe, e: EditOptions = {}) {
    const start = clamp(e.start ?? 0, 0, p.duration || 0);
    const end = e.end != null && e.end > start ? Math.min(e.end, p.duration || e.end) : p.duration;
    return Math.max(0, (end - start) / (e.speed && e.speed > 0 ? e.speed : 1));
}

/** Displayed size after crop / rotate / scale (even numbers). */
export function outputDims(p: Probe, e: EditOptions = {}, maxSideOverride?: number) {
    let w = p.video?.width ?? 0, h = p.video?.height ?? 0;
    if (e.crop && e.crop.w > 0 && e.crop.h > 0) {
        w = Math.min(e.crop.w, w || e.crop.w);
        h = Math.min(e.crop.h, h || e.crop.h);
    }
    if (e.rotate === 90 || e.rotate === 270) [w, h] = [h, w];
    if (e.width && e.height) return { w: even(e.width), h: even(e.height) };
    if (e.width) return { w: even(e.width), h: even(h * e.width / (w || 1)) };
    if (e.height) return { w: even(w * e.height / (h || 1)), h: even(e.height) };
    const side = maxSideOverride ?? e.maxSide;
    if (side && Math.max(w, h) > side) {
        const k = side / Math.max(w, h);
        return { w: even(w * k), h: even(h * k) };
    }
    return { w: even(w), h: even(h) };
}

/**
 * drawtext text, escaped for both ffmpeg parsing levels: first the option level
 * (key=value:…, where \\ ' : are special), then the filtergraph level (\\ ' [ ] , ;).
 * No surrounding quotes needed; % is inert because we pass expansion=none.
 */
export function drawtextValue(text: string) {
    const clean = text.replace(/[\r\n\t]+/g, " ").slice(0, 200);
    const level1 = clean.replace(/[\\':]/g, "\\$&");
    return level1.replace(/[\\'[\],;]/g, "\\$&");
}

function atempoChain(speed: number) {
    const out: string[] = [];
    let s = speed;
    while (s > 2) { out.push("atempo=2"); s /= 2; }
    while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
    if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${r3(s)}`);
    return out;
}

/** -ss / -t around the input (input seeking; exact because we re-encode). */
function inputArgs(p: Probe, e: EditOptions = {}) {
    const a: string[] = [];
    const start = e.start && e.start > 0 ? e.start : 0;
    if (start) a.push("-ss", r3(start));
    if (e.end != null && e.end > start) a.push("-t", r3(e.end - start));
    if (p.isAnimated && p.video?.codec === "webp") a.push("-c:v", "libwebp");
    a.push("-i", p.path);
    return a;
}

function videoFilters(p: Probe, e: EditOptions, dims: { w: number; h: number; }, opts: { fps?: number; pad?: number; dur: number; }) {
    const f: string[] = [];
    if (e.crop && e.crop.w > 0 && e.crop.h > 0) f.push(`crop=${Math.round(e.crop.w)}:${Math.round(e.crop.h)}:${Math.round(e.crop.x)}:${Math.round(e.crop.y)}`);
    if (e.rotate === 90) f.push("transpose=1");
    else if (e.rotate === 270) f.push("transpose=2");
    else if (e.rotate === 180) f.push("transpose=1,transpose=1");
    if (e.flipH) f.push("hflip");
    if (e.flipV) f.push("vflip");
    if (e.speed && Math.abs(e.speed - 1) > 1e-3) f.push(`setpts=PTS/${r3(e.speed)}`);
    if (e.reverse) f.push("reverse");
    const fps = opts.fps ?? e.fps;
    if (fps) f.push(`fps=${r3(fps)}`);
    if (opts.pad) {
        const s = opts.pad;
        f.push(`scale=${s}:${s}:force_original_aspect_ratio=decrease:flags=lanczos`, "format=rgba", `pad=${s}:${s}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
    } else if (dims.w && dims.h && (dims.w !== p.video?.width || dims.h !== p.video?.height || e.crop || e.rotate)) {
        f.push(`scale=${dims.w}:${dims.h}:flags=lanczos`);
    }
    if (e.caption?.text) {
        const y = e.caption.position === "top" ? "h*0.04" : "h-text_h-h*0.04";
        f.push(`drawtext=text=${drawtextValue(e.caption.text)}:expansion=none:font=Sans:fontcolor=white:borderw=3:bordercolor=black:fontsize=h/10:x=(w-text_w)/2:y=${y}`);
    }
    if (e.fadeIn && e.fadeIn > 0) f.push(`fade=t=in:st=0:d=${r3(e.fadeIn)}`);
    if (e.fadeOut && e.fadeOut > 0 && opts.dur > e.fadeOut) f.push(`fade=t=out:st=${r3(opts.dur - e.fadeOut)}:d=${r3(e.fadeOut)}`);
    return f;
}

function audioFilters(e: EditOptions, dur: number) {
    const f: string[] = [];
    if (e.speed && Math.abs(e.speed - 1) > 1e-3) f.push(...atempoChain(e.speed));
    if (e.reverse) f.push("areverse");
    if (e.volume != null && Math.abs(e.volume - 1) > 1e-3) f.push(`volume=${r3(clamp(e.volume, 0, 8))}`);
    if (e.fadeIn && e.fadeIn > 0) f.push(`afade=t=in:st=0:d=${r3(e.fadeIn)}`);
    if (e.fadeOut && e.fadeOut > 0 && dur > e.fadeOut) f.push(`afade=t=out:st=${r3(dur - e.fadeOut)}:d=${r3(e.fadeOut)}`);
    if (e.loudnorm) f.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    return f;
}

export function hasEdits(e?: EditOptions) {
    return !!e && Object.values(e).some(v => v != null && v !== false && v !== 0 && v !== "");
}

const COMMON = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];

function out(spec: ConvertSpec, ext: string, suffix = "") {
    const sep = spec.sep ?? "/";
    return `${spec.outDir}${sep}${spec.baseName}${suffix}.${ext}`;
}

/** Bitrate ladder → max side for a size-targeted encode. */
export function sideForBitrate(kbps: number, srcSide: number) {
    const side = kbps >= 4000 ? 1920 : kbps >= 2200 ? 1280 : kbps >= 1100 ? 960 : kbps >= 650 ? 854 : kbps >= 380 ? 640 : kbps >= 200 ? 480 : 320;
    return Math.min(side, srcSide || side);
}

export interface Budget { videoKbps: number; audioKbps: number; side: number; fps?: number; }

/** Split a byte budget into video + audio bitrates for `dur` seconds. */
export function budgetFor(maxBytes: number, dur: number, hasAudio: boolean, srcSide: number, srcFps: number, attempt = 0): Budget | null {
    if (dur <= 0) return null;
    const totalKbps = (maxBytes * 8 * 0.93 * Math.pow(0.88, attempt)) / dur / 1000 - 8; // container overhead
    const audioKbps = !hasAudio ? 0 : totalKbps > 1200 ? 128 : totalKbps > 400 ? 96 : totalKbps > 160 ? 64 : 32;
    const videoKbps = Math.floor(totalKbps - audioKbps);
    if (videoKbps < 40) return null;
    const side = sideForBitrate(videoKbps, srcSide);
    const fps = videoKbps < 250 && srcFps > 24 ? 20 : videoKbps < 1500 && srcFps > 30 ? 30 : undefined;
    return { videoKbps, audioKbps, side, fps };
}

export class PlanError extends Error {
    hint?: string;
    constructor(message: string, hint?: string) {
        super(message);
        this.hint = hint;
    }
}

/* ---------------------------------------------------------------- convert */

/**
 * Plan one conversion. `attempt` 0..3 makes size-limited encodes progressively smaller;
 * returns null when there is nothing smaller left to try.
 */
export function planConvert(spec: ConvertSpec, attempt = 0): Plan | null {
    const p = spec.input;
    const e = { ...(spec.edit ?? {}) };
    let target = spec.target;

    switch (target) {
        case "emoji": return planEmojiSticker(spec, "emoji", attempt);
        case "sticker": return planEmojiSticker(spec, "sticker", attempt);
        case "soundboard": return planSoundboard(spec, attempt);
        case "screenshot": return planScreenshot(spec);
        case "avatar": return planAvatar(spec, attempt);
    }
    if (target === "auto") target = autoTarget(p);

    if (!p.video && ["mp4", "webm", "mkv", "gif", "webp", "apng", "png", "jpg"].includes(target)) {
        throw new PlanError(`${p.name} has no picture`, "pick an audio format");
    }
    if (["mp3", "opus", "m4a", "wav", "flac"].includes(target)) return planAudio(spec, target as any, attempt);
    if (target === "gif") return planGif(spec, attempt);
    if (target === "png" || target === "jpg" || target === "webp" || target === "apng") {
        if (p.isImage || target === "png" || target === "jpg") return planImage(spec, target === "apng" ? "png" : target, attempt);
        return planAnimatedWebpApng(spec, target, attempt);
    }
    return planVideo(spec, target as "mp4" | "webm" | "mkv", attempt);
}

function planVideo(spec: ConvertSpec, target: "mp4" | "webm" | "mkv", attempt: number): Plan | null {
    const p = spec.input;
    const e = spec.edit ?? {};
    const dur = editedDuration(p, e);
    const hasAudio = !!p.audio && !e.mute;
    const srcSide = Math.max(p.video!.width, p.video!.height);
    let codec = spec.videoCodec && spec.videoCodec !== "auto" ? spec.videoCodec : target === "webm" ? "vp9" : "h264";
    if (target === "webm" && (codec === "h264" || codec === "hevc")) codec = "vp9";
    const o = out(spec, target);
    const passlog = `${spec.outDir}${spec.sep ?? "/"}${spec.baseName}-pass`;

    if (codec === "copy") {
        if (attempt > 0) return null;
        const a = [...COMMON, ...inputArgs(p, e), "-map", "0", "-c", "copy"];
        if (target === "mp4") a.push("-movflags", "+faststart");
        a.push(o);
        return { steps: [{ tool: "ffmpeg", args: a, label: "remux", duration: dur }], outputs: [o] };
    }

    let budget: Budget | null = null;
    if (spec.maxBytes) {
        if (p.size <= spec.maxBytes && attempt === 0 && !hasEdits(spec.edit) && /mp4|mov/.test(p.format) && p.video!.codec === "h264" && (!p.audio || p.audio.codec === "aac")) {
            // already a Discord-friendly file under the limit: just remux with faststart
            const a = [...COMMON, "-i", p.path, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", o];
            return { steps: [{ tool: "ffmpeg", args: a, label: "remux", duration: dur }], outputs: [o] };
        }
        budget = budgetFor(spec.maxBytes, dur, hasAudio, srcSide, p.video!.fps, attempt);
        if (!budget) {
            if (attempt > 0) return null;
            throw new PlanError(
                `${Math.round(dur)}s does not fit in ${(spec.maxBytes / 1048576).toFixed(1)} MB at a watchable bitrate`,
                "split it into parts (Split → by size) or trim it"
            );
        }
    } else if (attempt > 0) return null;

    const dims = outputDims(p, e, budget?.side);
    const vf = videoFilters(p, e, dims, { fps: budget?.fps, dur });
    const af = audioFilters(e, dur);
    const q = clamp(spec.quality ?? 70, 0, 100);

    const venc: string[] = [];
    if (codec === "h264") venc.push("-c:v", "libx264", "-preset", dur > 600 ? "faster" : "medium", "-pix_fmt", "yuv420p", "-profile:v", "high");
    else if (codec === "hevc") venc.push("-c:v", "libx265", "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1");
    else if (codec === "av1") venc.push("-c:v", "libsvtav1", "-preset", "8", "-pix_fmt", "yuv420p");
    else venc.push("-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p");

    const rateArgs = budget
        ? ["-b:v", `${budget.videoKbps}k`, "-maxrate", `${Math.round(budget.videoKbps * 1.5)}k`, "-bufsize", `${budget.videoKbps * 2}k`]
        : codec === "h264" ? ["-crf", String(Math.round(35 - q * 0.17))]
            : codec === "hevc" ? ["-crf", String(Math.round(37 - q * 0.17))]
                : codec === "av1" ? ["-crf", String(Math.round(45 - q * 0.2))]
                    : ["-crf", String(Math.round(45 - q * 0.17)), "-b:v", "0"];

    const aenc = !hasAudio ? ["-an"]
        : target === "webm" ? ["-c:a", "libopus", "-b:a", `${budget?.audioKbps ?? spec.audioBitrate ?? 128}k`]
            : ["-c:a", "aac", "-b:a", `${budget?.audioKbps ?? spec.audioBitrate ?? 160}k`, "-ac", "2"];
    const mux = target === "mp4" ? ["-movflags", "+faststart"] : [];
    const filt = [...(vf.length ? ["-vf", vf.join(",")] : []), ...(hasAudio && af.length ? ["-af", af.join(",")] : [])];
    const map = ["-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : [])];

    if (budget) {
        // two-pass: hits the byte budget much more precisely than one pass
        const nullOut = ["-f", "null", "-"];
        const pass1 = [...COMMON, ...inputArgs(p, e), "-map", "0:v:0", ...(vf.length ? ["-vf", vf.join(",")] : []), ...venc, ...rateArgs, "-pass", "1", "-passlogfile", passlog, "-an", ...nullOut];
        const pass2 = [...COMMON, ...inputArgs(p, e), ...map, ...filt, ...venc, ...rateArgs, "-pass", "2", "-passlogfile", passlog, ...aenc, ...mux, o];
        return {
            steps: [
                { tool: "ffmpeg", args: pass1, label: `analyse (${budget.videoKbps} kb/s, ${dims.w}×${dims.h})`, duration: dur },
                { tool: "ffmpeg", args: pass2, label: `encode ${target} ${dims.w}×${dims.h}`, duration: dur }
            ],
            outputs: [o],
            temp: [`${passlog}-0.log`, `${passlog}-0.log.mbtree`, `${passlog}-0.log.temp`, `${passlog}-0.log.mbtree.temp`]
        };
    }
    const a = [...COMMON, ...inputArgs(p, e), ...map, ...filt, ...venc, ...rateArgs, ...aenc, ...mux, o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `encode ${target} ${dims.w}×${dims.h}`, duration: dur }], outputs: [o] };
}

const GIF_LADDER: Array<{ side: number; fps: number; colors: number; }> = [
    { side: 480, fps: 15, colors: 256 },
    { side: 400, fps: 12, colors: 192 },
    { side: 320, fps: 10, colors: 128 },
    { side: 240, fps: 10, colors: 96 },
    { side: 200, fps: 8, colors: 64 }
];

function gifChain(pre: string[], side: number, fps: number, colors: number, square?: number) {
    const scale = square
        ? `scale=${square}:${square}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${square}:${square}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
        : `scale='min(${side},iw)':-2:flags=lanczos`;
    const head = [...pre, `fps=${fps}`, scale].join(",");
    return `[0:v]${head},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff:reserve_transparent=1[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle:alpha_threshold=128`;
}

function planGif(spec: ConvertSpec, attempt: number, square?: number, fpsCap?: number): Plan | null {
    const p = spec.input;
    const e = spec.edit ?? {};
    const rung = spec.maxBytes ? GIF_LADDER[attempt] : attempt === 0 ? { side: e.maxSide ?? 480, fps: e.fps ?? Math.min(20, Math.round(p.video?.fps || 15)), colors: 256 } : null;
    if (!rung) return null;
    const dur = editedDuration(p, e);
    const dims = outputDims(p, e);
    const pre = videoFilters(p, { ...e, fps: undefined, fadeIn: e.fadeIn, fadeOut: e.fadeOut }, { w: 0, h: 0 }, { dur });
    // videoFilters adds scale only when dims are non-zero; we pass 0 and scale in gifChain
    const fps = Math.min(rung.fps, fpsCap ?? 99, Math.round(p.video?.fps || rung.fps) || rung.fps);
    const side = Math.min(rung.side, Math.max(dims.w, dims.h) || rung.side);
    const o = out(spec, "gif");
    const a = [...COMMON, ...inputArgs(p, e), "-filter_complex", gifChain(pre, side, fps, rung.colors, square), "-loop", "0", o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `gif ${square ?? side}px ${fps}fps ${rung.colors}c`, duration: dur }], outputs: [o] };
}

function planImage(spec: ConvertSpec, target: "png" | "jpg" | "webp", attempt: number): Plan | null {
    const p = spec.input;
    const e = spec.edit ?? {};
    if (!spec.maxBytes && attempt > 0) return null;
    const qBase = clamp(spec.quality ?? 85, 1, 100);
    const shrink = [1, 0.8, 0.62, 0.48, 0.36][attempt];
    if (shrink == null) return null;
    let t = target;
    // a too-big PNG gets one lossless try, then becomes WebP (keeps alpha) or JPEG
    if (spec.maxBytes && attempt >= 1 && t === "png") t = p.video?.alpha ? "webp" : "jpg";
    const base = outputDims(p, e);
    const dims = attempt <= 1 ? base : { w: even(base.w * shrink), h: even(base.h * shrink) };
    const vf = videoFilters(p, e, dims, { dur: 0 });
    if (t === "jpg") vf.push("format=yuvj420p");
    const q = clamp(Math.round(qBase - attempt * 8), 30, 100);
    const enc = t === "jpg" ? ["-c:v", "mjpeg", "-q:v", String(Math.round(2 + (100 - q) / 10))]
        : t === "webp" ? ["-c:v", "libwebp", "-quality", String(q), "-compression_level", "6"]
            : ["-c:v", "png", "-compression_level", "9", "-pred", "mixed"];
    const ss = e.at != null ? ["-ss", r3(e.at)] : [];
    const o = out(spec, t);
    const a = [...COMMON, ...ss, "-i", p.path, ...(vf.length ? ["-vf", vf.join(",")] : []), "-frames:v", "1", "-update", "1", ...enc, o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `${t} ${dims.w}×${dims.h} q${q}` }], outputs: [o] };
}

function planAnimatedWebpApng(spec: ConvertSpec, target: "webp" | "apng", attempt: number, square?: number, fpsCap?: number): Plan | null {
    const p = spec.input;
    const e = spec.edit ?? {};
    const ladder = [{ side: 512, fps: 20 }, { side: 400, fps: 15 }, { side: 320, fps: 12 }, { side: 256, fps: 10 }, { side: 200, fps: 8 }];
    const rung = spec.maxBytes || square ? ladder[attempt] : attempt === 0 ? { side: e.maxSide ?? 640, fps: e.fps ?? 20 } : null;
    if (!rung) return null;
    const dur = editedDuration(p, e);
    const fps = Math.min(rung.fps, fpsCap ?? 99, Math.round(p.video?.fps || rung.fps) || rung.fps);
    const dims = outputDims(p, e, rung.side);
    const vf = videoFilters(p, e, dims, { fps, dur, pad: square });
    const enc = target === "webp"
        ? ["-c:v", "libwebp_anim", "-quality", String(70 - attempt * 10), "-loop", "0", "-pix_fmt", "yuva420p"]
        : ["-c:v", "apng", "-plays", "0", "-f", "apng", "-pred", "mixed"];
    const o = out(spec, target === "apng" ? "png" : "webp");
    const a = [...COMMON, ...inputArgs(p, e), "-vf", vf.join(","), "-an", ...enc, o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `${target} ${square ?? dims.w}px ${fps}fps`, duration: dur }], outputs: [o] };
}

function planAudio(spec: ConvertSpec, target: "mp3" | "opus" | "m4a" | "wav" | "flac", attempt: number): Plan | null {
    const p = spec.input;
    const e = spec.edit ?? {};
    if (!p.audio) throw new PlanError(`${p.name} has no audio`);
    const dur = editedDuration(p, e);
    let kbps = spec.audioBitrate ?? (target === "opus" ? 128 : 192);
    if (spec.maxBytes) {
        if (target === "wav" || target === "flac") target = "mp3";
        const fit = Math.floor((spec.maxBytes * 8 * 0.95 * Math.pow(0.88, attempt)) / Math.max(dur, 0.1) / 1000);
        if (fit < 24) {
            if (attempt > 0) return null;
            throw new PlanError(`${Math.round(dur)}s of audio does not fit in ${(spec.maxBytes / 1048576).toFixed(1)} MB`, "split it or trim it");
        }
        kbps = Math.min(target === "opus" ? 192 : 320, fit);
    } else if (attempt > 0) return null;
    const af = audioFilters(e, dur);
    const enc = target === "mp3" ? ["-c:a", "libmp3lame", "-b:a", `${kbps}k`]
        : target === "opus" ? ["-c:a", "libopus", "-b:a", `${kbps}k`]
            : target === "m4a" ? ["-c:a", "aac", "-b:a", `${kbps}k`, "-movflags", "+faststart"]
                : target === "flac" ? ["-c:a", "flac"]
                    : ["-c:a", "pcm_s16le"];
    const o = out(spec, extOf(target));
    const a = [...COMMON, ...inputArgs(p, e), "-vn", "-map", "0:a:0", ...(af.length ? ["-af", af.join(",")] : []), ...enc, o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `${target} ${target === "wav" || target === "flac" ? "lossless" : `${kbps} kb/s`}`, duration: dur }], outputs: [o] };
}

function planEmojiSticker(spec: ConvertSpec, kind: "emoji" | "sticker", attempt: number): Plan | null {
    const p = spec.input;
    if (!p.video) throw new PlanError(`${p.name} has no picture`);
    const side = kind === "emoji" ? 128 : 320;
    const max = kind === "emoji" ? LIMITS.emoji : LIMITS.sticker;
    const s: ConvertSpec = { ...spec, maxBytes: max, baseName: `${spec.baseName}-${kind}` };
    const animated = !p.isImage;
    if (!animated) {
        if (attempt > 2) return null;
        const e = spec.edit ?? {};
        const vf = videoFilters(p, e, { w: 0, h: 0 }, { dur: 0, pad: side });
        const o = out(s, "png");
        const ss = e.at != null ? ["-ss", r3(e.at)] : [];
        // attempt 1+: quantise to a palette so a noisy photo still fits
        const enc = attempt === 0 ? ["-c:v", "png", "-compression_level", "9"] : ["-c:v", "png", "-compression_level", "9", "-pix_fmt", "pal8"];
        const a = [...COMMON, ...ss, "-i", p.path, "-vf", vf.join(","), "-frames:v", "1", "-update", "1", ...enc, o];
        return { steps: [{ tool: "ffmpeg", args: a, label: `${kind} ${side}px png` }], outputs: [o] };
    }
    const e = { ...(spec.edit ?? {}) };
    if (kind === "sticker" && editedDuration(p, e) > 5) e.end = (e.start ?? 0) + 5 * (e.speed ?? 1);
    const sp = { ...s, edit: e };
    if (kind === "sticker" && (spec.edit?.stickerFormat ?? "apng") === "apng") return planAnimatedWebpApng(sp, "apng", attempt, side, 20);
    const rung = GIF_LADDER[attempt];
    if (!rung) return null;
    return planGif({ ...sp, maxBytes: max }, attempt, side, kind === "emoji" ? 20 : 15);
}

function planSoundboard(spec: ConvertSpec, attempt: number): Plan | null {
    const p = spec.input;
    if (!p.audio) throw new PlanError(`${p.name} has no audio`);
    const e = { ...(spec.edit ?? {}) };
    const start = e.start ?? 0;
    if (editedDuration(p, e) > LIMITS.soundboardSeconds) e.end = start + LIMITS.soundboardSeconds * (e.speed ?? 1);
    if (e.loudnorm == null) e.loudnorm = true;
    const kbps = [128, 96, 64, 48][attempt];
    if (!kbps) return null;
    const dur = editedDuration(p, e);
    const af = audioFilters(e, dur);
    const o = out({ ...spec, baseName: `${spec.baseName}-sound` }, "mp3");
    const a = [...COMMON, ...inputArgs(p, e), "-vn", "-map", "0:a:0", "-af", [...af, "aresample=48000"].join(","), "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-ac", "2", o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `soundboard ${r3(dur)}s ${kbps} kb/s`, duration: dur }], outputs: [o] };
}

function planScreenshot(spec: ConvertSpec): Plan {
    const p = spec.input;
    if (!p.video) throw new PlanError(`${p.name} has no picture`);
    const e = spec.edit ?? {};
    const at = clamp(e.at ?? e.start ?? 0, 0, Math.max(0, (p.duration || 0) - 0.05));
    const dims = outputDims(p, e);
    const vf = videoFilters(p, { ...e, speed: undefined, reverse: undefined, fadeIn: undefined, fadeOut: undefined }, dims, { dur: 0 });
    const o = out({ ...spec, baseName: `${spec.baseName}-${r3(at).replace(".", "_")}s` }, "png");
    const a = [...COMMON, "-ss", r3(at), "-i", p.path, ...(vf.length ? ["-vf", vf.join(",")] : []), "-frames:v", "1", "-update", "1", o];
    return { steps: [{ tool: "ffmpeg", args: a, label: `screenshot @ ${r3(at)}s` }], outputs: [o] };
}

function planAvatar(spec: ConvertSpec, attempt: number): Plan | null {
    const p = spec.input;
    if (!p.video) throw new PlanError(`${p.name} has no picture`);
    const side = Math.min(1024, p.video.width, p.video.height) || 512;
    const e = spec.edit ?? {};
    const sq = Math.min(p.video.width, p.video.height);
    const crop = e.crop ?? { w: sq, h: sq, x: Math.round((p.video.width - sq) / 2), y: Math.round((p.video.height - sq) / 2) };
    const s: ConvertSpec = { ...spec, baseName: `${spec.baseName}-avatar`, maxBytes: LIMITS.avatar, edit: { ...e, crop, maxSide: Math.min(side, 512) } };
    return p.isImage ? planImage(s, "png", attempt) : planGif(s, attempt);
}

/* ---------------------------------------------------------------- split / join */

export interface SplitSpec {
    input: Probe;
    mode: "duration" | "count" | "size";
    value: number;
    /** re-encode every part at exact cut points (always on for GIF / size mode) */
    exact?: boolean;
    maxBytes?: number;
    outDir: string;
    baseName: string;
    sep?: string;
}

export interface SplitPart { start: number; end: number; }

export function splitPoints(spec: SplitSpec): SplitPart[] {
    const d = spec.input.duration;
    if (!(d > 0)) throw new PlanError(`${spec.input.name} has no duration to split`);
    let n: number;
    if (spec.mode === "count") n = Math.max(1, Math.floor(spec.value));
    else if (spec.mode === "duration") n = Math.max(1, Math.ceil(d / Math.max(0.5, spec.value) - 1e-6));
    else {
        const max = spec.value > 0 ? spec.value : spec.maxBytes ?? 0;
        if (!max) throw new PlanError("split by size needs a size limit");
        // parts are re-encoded to the budget, so size them for a good bitrate, not the raw input size
        const v = spec.input.video;
        const side = v ? Math.max(v.width, v.height) : 0;
        const goodKbps = !v || spec.input.isImage ? 192 : (side >= 1600 ? 4500 : side >= 1100 ? 2500 : side >= 700 ? 1400 : 900) + (spec.input.audio ? 128 : 0);
        const srcKbps = (spec.input.size * 8) / d / 1000;
        const kbps = Math.max(64, Math.min(srcKbps, goodKbps));
        const partSeconds = (max * 8 * 0.9) / (kbps * 1000);
        n = Math.max(1, Math.min(Math.ceil(spec.input.size / (max * 0.85)), Math.ceil(d / partSeconds - 1e-6)));
    }
    if (n > 500) throw new PlanError(`that would be ${n} parts`, "pick a longer part length");
    const len = d / n;
    return Array.from({ length: n }, (_, i) => ({ start: i * len, end: i === n - 1 ? d : (i + 1) * len }));
}

/** Split: one Plan (stream-copy segment muxer) or a list of convert specs (exact). */
export function planSplit(spec: SplitSpec): { copy: Plan; } | { parts: ConvertSpec[]; } {
    const p = spec.input;
    const parts = splitPoints(spec);
    const pad = String(parts.length).length < 2 ? 2 : String(parts.length).length;
    const target: Target = autoTarget(p);
    const exact = spec.exact || spec.mode === "size" || p.isAnimated || !p.video;
    if (!exact) {
        const ext = /webm/.test(p.format) ? "webm" : /matroska/.test(p.format) ? "mkv" : /mov|mp4/.test(p.format) ? "mp4" : "mkv";
        const sep = spec.sep ?? "/";
        const prefix = `${spec.baseName}-part`;
        const len = parts[0].end - parts[0].start;
        const o = `${spec.outDir}${sep}${prefix}%0${pad}d.${ext}`;
        const a = [...COMMON, "-i", p.path, "-map", "0", "-c", "copy", "-f", "segment", "-segment_time", r3(len), "-reset_timestamps", "1", "-segment_start_number", "1", o];
        return { copy: { steps: [{ tool: "ffmpeg", args: a, label: `split ${parts.length} parts (copy)`, duration: p.duration }], outputs: [], collect: { dir: spec.outDir, prefix } } };
    }
    const perPartMax = spec.mode === "size" ? (spec.value > 0 ? spec.value : spec.maxBytes) : spec.maxBytes;
    return {
        parts: parts.map((pt, i) => ({
            input: p,
            target,
            maxBytes: perPartMax,
            edit: { start: pt.start, end: pt.end },
            outDir: spec.outDir,
            baseName: `${spec.baseName}-part${String(i + 1).padStart(pad, "0")}`,
            sep: spec.sep
        }))
    };
}

export interface JoinSpec {
    inputs: Probe[];
    target: "auto" | "mp4" | "webm" | "gif" | "mp3" | "opus" | "wav";
    /** seconds each still image is shown */
    imageDuration?: number;
    outDir: string;
    baseName: string;
    sep?: string;
}

/** Same codecs + size + rate → the concat demuxer can join without re-encoding. */
export function canStreamCopyJoin(inputs: Probe[]) {
    if (inputs.length < 2) return false;
    const [a] = inputs;
    return inputs.every(p =>
        !p.isImage && !p.isAnimated && p.format === a.format &&
        !!p.video === !!a.video && !!p.audio === !!a.audio &&
        (!a.video || (p.video!.codec === a.video.codec && p.video!.width === a.video.width && p.video!.height === a.video.height && Math.abs(p.video!.fps - a.video.fps) < 0.01 && p.video!.pixFmt === a.video.pixFmt)) &&
        (!a.audio || (p.audio!.codec === a.audio.codec && p.audio!.sampleRate === a.audio.sampleRate && p.audio!.channels === a.audio.channels))
    );
}

/** ffconcat list line: the demuxer wants single-quoted paths with ' written as '\'' */
export function ffconcatLine(path: string) {
    return `file '${path.replace(/'/g, "'\\''")}'`;
}

export function planJoin(spec: JoinSpec): Plan {
    const ins = spec.inputs;
    if (ins.length < 2) throw new PlanError("pick at least two files to join");
    const sep = spec.sep ?? "/";
    const anyVideo = ins.some(p => p.video);
    let target = spec.target;
    if (target === "auto") target = !anyVideo ? "mp3" : ins.every(p => p.isAnimated || p.isImage) ? "gif" : "mp4";
    const audioOnly = target === "mp3" || target === "opus" || target === "wav";
    const ext = target === "opus" ? "ogg" : target;
    const o = `${spec.outDir}${sep}${spec.baseName}.${ext}`;

    const sameExt = (p: Probe) => (/mp4|mov/.test(p.format) && ext === "mp4") || (/webm/.test(p.format) && ext === "webm");
    if (!audioOnly && target !== "gif" && canStreamCopyJoin(ins) && sameExt(ins[0])) {
        const list = `${spec.outDir}${sep}${spec.baseName}-list.ffconcat`;
        const content = ["ffconcat version 1.0", ...ins.map(p => ffconcatLine(p.path))].join("\n") + "\n";
        const total = ins.reduce((s, p) => s + p.duration, 0);
        const a = [...COMMON, "-f", "concat", "-safe", "0", "-i", list, "-map", "0", "-c", "copy", ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), o];
        return { steps: [{ tool: "ffmpeg", args: a, label: `join ${ins.length} (copy)`, duration: total }], outputs: [o], writeFiles: [{ path: list, content }], temp: [list] };
    }

    const imgDur = clamp(spec.imageDuration ?? 3, 0.1, 600);
    const first = ins.find(p => p.video && !p.isImage)?.video ?? ins.find(p => p.video)?.video;
    const W = even(Math.min(first?.width ?? 1280, target === "gif" ? 480 : 1920));
    const H = even((first?.height ?? 720) * W / (first?.width || W));
    const FPS = target === "gif" ? 12 : Math.min(60, Math.round(first?.fps || 30) || 30);
    const args: string[] = [...COMMON];
    const chains: string[] = [];
    const pads: string[] = [];
    let idx = 0;
    let total = 0;
    for (const p of ins) {
        const d = p.isImage ? imgDur : p.duration;
        total += d;
        if (p.isImage) args.push("-loop", "1", "-t", r3(imgDur), "-i", p.path);
        else args.push("-i", p.path);
        const vi = idx++;
        let ai = vi;
        if (!audioOnly && !p.audio) {
            args.push("-f", "lavfi", "-t", r3(d), "-i", "anullsrc=r=48000:cl=stereo");
            ai = idx++;
        }
        const k = pads.length / (audioOnly ? 1 : 2);
        if (!audioOnly) {
            if (p.video) {
                chains.push(`[${vi}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${k}]`);
            } else {
                chains.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${r3(d)},format=yuv420p[v${k}]`);
            }
            chains.push(`[${ai}:a]aresample=48000,aformat=channel_layouts=stereo[a${k}]`);
            pads.push(`[v${k}]`, `[a${k}]`);
        } else {
            if (!p.audio) throw new PlanError(`${p.name} has no audio`);
            chains.push(`[${vi}:a]aresample=48000,aformat=channel_layouts=stereo[a${k}]`);
            pads.push(`[a${k}]`);
        }
    }
    const n = ins.length;
    let graph: string;
    if (audioOnly) graph = `${chains.join(";")};${pads.join("")}concat=n=${n}:v=0:a=1[ao]`;
    else if (target === "gif") graph = `${chains.join(";")};${pads.join("")}concat=n=${n}:v=1:a=1[vc][ac];[vc]split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[pl];[s1][pl]paletteuse=dither=bayer:bayer_scale=4[vo]`;
    else graph = `${chains.join(";")};${pads.join("")}concat=n=${n}:v=1:a=1[vo][ao]`;
    args.push("-filter_complex", graph);
    if (audioOnly) {
        args.push("-map", "[ao]", ...(target === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k"] : target === "opus" ? ["-c:a", "libopus", "-b:a", "128k"] : ["-c:a", "pcm_s16le"]));
    } else if (target === "gif") {
        args.push("-map", "[vo]", "-loop", "0");
    } else {
        args.push("-map", "[vo]", "-map", "[ao]");
        if (target === "webm") args.push("-c:v", "libvpx-vp9", "-row-mt", "1", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k");
        else args.push("-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart");
    }
    args.push(o);
    return { steps: [{ tool: "ffmpeg", args, label: `join ${n} → ${target} ${audioOnly ? "" : `${W}×${H}`}`.trim(), duration: total }], outputs: [o] };
}

/* ---------------------------------------------------------------- sox audio FX */

export interface AudioFx {
    normalize?: boolean;
    trimSilence?: boolean;
    /** cents, e.g. 300 = +3 semitones */
    pitch?: number;
    /** tempo factor without pitch change */
    tempo?: number;
    reverb?: number;
    bass?: number;
    treble?: number;
    echo?: boolean;
    reverse?: boolean;
    /** classic "nightcore": speed + pitch together */
    speed?: number;
}

export function soxEffects(fx: AudioFx): string[] {
    const e: string[] = [];
    if (fx.trimSilence) e.push("silence", "1", "0.05", "0.5%", "reverse", "silence", "1", "0.05", "0.5%", "reverse");
    if (fx.speed && Math.abs(fx.speed - 1) > 1e-3) e.push("speed", r3(clamp(fx.speed, 0.25, 4)));
    if (fx.pitch) e.push("pitch", String(Math.round(clamp(fx.pitch, -2400, 2400))));
    if (fx.tempo && Math.abs(fx.tempo - 1) > 1e-3) e.push("tempo", "-s", r3(clamp(fx.tempo, 0.25, 4)));
    if (fx.bass) e.push("bass", r3(clamp(fx.bass, -20, 20)));
    if (fx.treble) e.push("treble", r3(clamp(fx.treble, -20, 20)));
    if (fx.echo) e.push("echo", "0.8", "0.88", "60", "0.4");
    if (fx.reverb) e.push("reverb", String(Math.round(clamp(fx.reverb, 0, 100))));
    if (fx.reverse) e.push("reverse");
    if (fx.normalize) e.push("norm", "-1");
    return e;
}

export function planAudioFx(input: Probe, fx: AudioFx, target: "mp3" | "opus" | "wav" | "flac", outDir: string, baseName: string, sep = "/"): Plan {
    if (!input.audio) throw new PlanError(`${input.name} has no audio`);
    const effects = soxEffects(fx);
    if (!effects.length) throw new PlanError("pick at least one effect");
    const a = `${outDir}${sep}${baseName}-fx-in.wav`;
    const b = `${outDir}${sep}${baseName}-fx-out.wav`;
    const o = `${outDir}${sep}${baseName}-fx.${extOf(target)}`;
    const enc = target === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k"] : target === "opus" ? ["-c:a", "libopus", "-b:a", "128k"] : target === "flac" ? ["-c:a", "flac"] : ["-c:a", "pcm_s16le"];
    return {
        steps: [
            { tool: "ffmpeg", args: [...COMMON, "-i", input.path, "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", a], label: "decode", duration: input.duration },
            { tool: "sox", args: ["-V2", a, b, ...effects], label: `sox ${effects.filter(x => /^[a-z]+$/.test(x)).join(" ")}` },
            { tool: "ffmpeg", args: [...COMMON, "-i", b, ...enc, o], label: `encode ${target}` }
        ],
        outputs: [o],
        temp: [a, b]
    };
}

/* ---------------------------------------------------------------- yt-dlp */

export interface DownloadSpec {
    url: string;
    mode: "best" | "discord" | "audio" | "video720";
    maxBytes?: number;
    outDir: string;
    ffmpegDir?: string;
    playlist?: boolean;
}

export const YTDLP_MARKER = "SFOUT:";

export function isHttpUrl(u: string) {
    try {
        const x = new URL(u);
        return x.protocol === "https:" || x.protocol === "http:";
    } catch {
        return false;
    }
}

export function planDownload(spec: DownloadSpec): Plan {
    if (!isHttpUrl(spec.url)) throw new PlanError("only http(s) links can be downloaded");
    const prefix = `dl-${Date.now().toString(36)}`;
    const a = [
        "--newline", "--no-colors", "--no-mtime", "--restrict-filenames",
        spec.playlist ? "--yes-playlist" : "--no-playlist",
        "-P", spec.outDir,
        "-o", `${prefix}-%(title).70B [%(id)s].%(ext)s`,
        "--print", `after_move:${YTDLP_MARKER}%(filepath)s`
    ];
    if (spec.ffmpegDir) a.push("--ffmpeg-location", spec.ffmpegDir);
    if (spec.mode === "audio") a.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    else if (spec.mode === "discord") {
        a.push("-f", "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4");
        if (spec.maxBytes) a.push("-S", `filesize~${Math.max(1, Math.floor(spec.maxBytes / 1048576))}M`);
    } else if (spec.mode === "video720") a.push("-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4");
    else a.push("--merge-output-format", "mkv");
    a.push("--", spec.url);
    return { steps: [{ tool: "yt-dlp", args: a, label: `yt-dlp ${spec.mode}` }], outputs: [], collect: { dir: spec.outDir, prefix }, printMarker: YTDLP_MARKER };
}

/* ---------------------------------------------------------------- misc */

/** Discord upload limit (bytes) for a premium type + guild boost tier. */
export function uploadLimit(premiumType: number | null | undefined, guildTier: number | null | undefined) {
    const MB = 1024 * 1024;
    const user = premiumType === 2 ? 500 * MB : premiumType === 1 || premiumType === 3 ? 50 * MB : 10 * MB;
    const guild = guildTier === 3 ? 100 * MB : guildTier === 2 ? 50 * MB : 10 * MB;
    return Math.max(user, guild);
}

export function mimeOf(path: string) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return ({
        mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
        gif: "image/gif", png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
        mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac"
    } as Record<string, string>)[ext] ?? "application/octet-stream";
}

export function humanBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
}

export function safeBaseName(name: string) {
    const base = name.replace(/\.[^.]{1,8}$/, "").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").replace(/^[-.]+/, "");
    return (base || "media").slice(0, 60);
}
