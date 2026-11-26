/*
 * MediaForge planner tests: pure argv checks, then (when ffmpeg is on PATH) real encodes of
 * generated samples through every plan type, with the same attempt ladder the runner uses.
 * Run: node --experimental-strip-types --no-warnings scripts/test-mediaforge-planner.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Plan, Probe } from "../plugins/mediaForge/planner.ts";
import { join } from "node:path";

import {
    budgetFor, canStreamCopyJoin, drawtextValue, ffconcatLine, LIMITS, parseProbe, planAudioFx, planConvert,
    PlanError, planDownload, planJoin, planSplit, splitPoints, uploadLimit
} from "../plugins/mediaForge/planner.ts";

let pass = 0;
function t(name: string, fn: () => void) { fn(); pass++; console.log("ok -", name); }

const fakeVideo = (over: Partial<Probe> = {}): Probe => ({
    path: "/w/in.mp4", name: "in.mp4", size: 80 * 1048576, duration: 120, format: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264", width: 1920, height: 1080, fps: 60, pixFmt: "yuv420p", alpha: false, frames: 7200 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2, bitrate: 128 }, isImage: false, isAnimated: false, ...over
});

/* ---------------- pure ---------------- */

t("upload limits", () => {
    assert.equal(uploadLimit(0, 0), 10 * 1048576);
    assert.equal(uploadLimit(2, 0), 500 * 1048576);
    assert.equal(uploadLimit(0, 3), 100 * 1048576);
    assert.equal(uploadLimit(3, 2), 50 * 1048576);
});

t("budget shrinks with attempts and refuses hopeless cases", () => {
    const a = budgetFor(10 * 1048576, 60, true, 1920, 60, 0)!;
    const b = budgetFor(10 * 1048576, 60, true, 1920, 60, 2)!;
    assert.ok(a.videoKbps > b.videoKbps);
    assert.ok(a.side <= 1280 && a.fps === 30);
    assert.equal(budgetFor(1 * 1048576, 3600, true, 1920, 30, 0), null);
});

t("size-limited video plans two passes with a bitrate", () => {
    const p = planConvert({ input: fakeVideo(), target: "auto", maxBytes: 10 * 1048576, outDir: "/w", baseName: "x" })!;
    assert.equal(p.steps.length, 2);
    assert.ok(p.steps[0].args.includes("-pass") && p.steps[1].args.includes("libx264"));
    assert.ok(p.steps[1].args.includes("+faststart"));
    assert.deepEqual(p.outputs, ["/w/x.mp4"]);
});

t("too long for the limit throws with a split hint", () => {
    assert.throws(() => planConvert({ input: fakeVideo({ duration: 7200 }), target: "mp4", maxBytes: 1048576, outDir: "/w", baseName: "x" }),
        (e: unknown) => e instanceof PlanError && /split/.test(e.hint ?? ""));
});

t("edits become filters", () => {
    const p = planConvert({
        input: fakeVideo(), target: "mp4", outDir: "/w", baseName: "x",
        edit: { start: 5, end: 15, crop: { x: 0, y: 0, w: 1080, h: 1080 }, speed: 2, mute: true, caption: { text: "it's: a, test", position: "top" }, fadeOut: 1 }
    })!;
    const a = p.steps[0].args;
    assert.equal(a[a.indexOf("-ss") + 1], "5");
    assert.equal(a[a.indexOf("-t") + 1], "10");
    const vf = a[a.indexOf("-vf") + 1];
    assert.match(vf, /^crop=1080:1080:0:0,setpts=PTS\/2,/);
    assert.ok(vf.includes("drawtext=text=it\\\\\\'s\\\\: a\\, test:expansion=none"));
    assert.match(vf, /fade=t=out:st=4:d=1/);
    assert.ok(a.includes("-an"));
});

t("drawtext escaping is two-level", () => {
    assert.equal(drawtextValue("a:b"), "a\\\\:b");
    assert.equal(drawtextValue("x,y"), "x\\,y");
});

t("atempo is chained outside 0.5..2", () => {
    const p = planConvert({ input: fakeVideo(), target: "mp3", outDir: "/w", baseName: "x", edit: { speed: 3 } })!;
    const af = p.steps[0].args[p.steps[0].args.indexOf("-af") + 1];
    assert.equal(af, "atempo=2,atempo=1.5");
});

t("split points cover the whole file", () => {
    const pts = splitPoints({ input: fakeVideo(), mode: "duration", value: 50, outDir: "/w", baseName: "x" });
    assert.equal(pts.length, 3);
    assert.equal(pts[0].start, 0);
    assert.equal(pts[2].end, 120);
    // 80 MB / 120 s ≈ 5.6 Mb/s source, capped at 4.6 Mb/s for 1080p → ~16 s per 10 MB part
    const bySize = splitPoints({ input: fakeVideo(), mode: "size", value: 10 * 1048576, outDir: "/w", baseName: "x" });
    assert.equal(bySize.length, 8);
    // a huge lossless source must not explode into hundreds of tiny parts
    const lossless = splitPoints({ input: fakeVideo({ size: 2000 * 1048576, duration: 20 }), mode: "size", value: 3 * 1048576, outDir: "/w", baseName: "x" });
    assert.ok(lossless.length <= 6, `got ${lossless.length}`);
});

t("copy split uses the segment muxer, size split re-encodes per part", () => {
    const c = planSplit({ input: fakeVideo(), mode: "count", value: 4, outDir: "/w", baseName: "x" });
    assert.ok("copy" in c && c.copy.steps[0].args.includes("segment"));
    const s = planSplit({ input: fakeVideo(), mode: "size", value: 10 * 1048576, outDir: "/w", baseName: "x" });
    assert.ok("parts" in s && s.parts.length === 8 && s.parts[0].maxBytes === 10 * 1048576);
});

t("ffconcat quoting", () => {
    assert.equal(ffconcatLine("/a/it's.mp4"), "file '/a/it'\\''s.mp4'");
});

t("join copy only for identical streams", () => {
    assert.ok(canStreamCopyJoin([fakeVideo(), fakeVideo({ path: "/w/b.mp4" })]));
    assert.ok(!canStreamCopyJoin([fakeVideo(), fakeVideo({ video: { ...fakeVideo().video!, width: 1280 } })]));
});

t("yt-dlp: url after --, non-http refused", () => {
    const p = planDownload({ url: "https://example.com/v?a=1", mode: "discord", maxBytes: 10 * 1048576, outDir: "/w" });
    const a = p.steps[0].args;
    assert.equal(a[a.length - 2], "--");
    assert.equal(a[a.length - 1], "https://example.com/v?a=1");
    assert.throws(() => planDownload({ url: "--exec=rm", mode: "best", outDir: "/w" }), PlanError);
    assert.throws(() => planDownload({ url: "file:///etc/passwd", mode: "best", outDir: "/w" }), PlanError);
});

t("probe parsing: rotation, images, animation", () => {
    const v = parseProbe({
        format: { format_name: "mov,mp4", duration: "10" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", pix_fmt: "yuv420p", side_data_list: [{ rotation: -90 }] }]
    }, "/a", "a.mp4", 1);
    assert.equal(v.video!.width, 1080);
    assert.ok(Math.abs(v.video!.fps - 29.97) < 0.01);
    const img = parseProbe({ format: { format_name: "png_pipe" }, streams: [{ codec_type: "video", codec_name: "png", width: 10, height: 10, pix_fmt: "rgba" }] }, "/b", "b.png", 1);
    assert.ok(img.isImage && img.video!.alpha && img.duration === 0);
    const gif = parseProbe({ format: { format_name: "gif", duration: "2" }, streams: [{ codec_type: "video", codec_name: "gif", width: 10, height: 10, nb_frames: "20", pix_fmt: "bgra" }] }, "/c", "c.gif", 1);
    assert.ok(gif.isAnimated && !gif.isImage);
});

/* ---------------- real encodes ---------------- */

const have = (b: string) => spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0 || spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0;

if (!have("ffmpeg") || !have("ffprobe")) {
    console.log("skip - real encodes (ffmpeg/ffprobe not on PATH)");
} else {
    const dir = mkdtempSync(join(tmpdir(), "mf-test-"));
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    const probe = (path: string): Probe => {
        const json = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]).toString());
        return parseProbe(json, path, path.split("/").pop()!, statSync(path).size);
    };
    const run = (plan: Plan) => {
        for (const w of plan.writeFiles ?? []) writeFileSync(w.path, w.content);
        for (const s of plan.steps) {
            const r = spawnSync(s.tool, s.args, { encoding: "utf8" });
            if (r.status !== 0) throw new Error(`${s.label} failed:\n${(r.stderr || "").split("\n").slice(-8).join("\n")}\nargs: ${JSON.stringify(s.args)}`);
        }
        for (const f of plan.temp ?? []) rmSync(f, { force: true });
        if (plan.collect) return readdirSync(plan.collect.dir).filter(n => n.startsWith(plan.collect!.prefix)).sort().map(n => join(plan.collect!.dir, n));
        return plan.outputs;
    };
    /** same ladder as the native runner */
    const convert = (spec: Parameters<typeof planConvert>[0]) => {
        for (let attempt = 0; attempt < 6; attempt++) {
            const plan = planConvert(spec, attempt);
            if (!plan) break;
            const outs = run(plan);
            const limit = spec.maxBytes ?? (spec.target === "emoji" ? LIMITS.emoji : spec.target === "sticker" ? LIMITS.sticker : spec.target === "soundboard" ? LIMITS.soundboard : 0);
            if (!limit || outs.every(o => statSync(o).size <= limit)) return { outs, attempt };
        }
        throw new Error(`${spec.target}: nothing fits`);
    };

    const vid = join(dir, "src.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
        "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-b:a", "192k", "-shortest", vid]);
    const vid2 = join(dir, "src2.webm");
    ff(["-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=24", "-t", "3", "-c:v", "libvpx-vp9", "-deadline", "realtime", vid2]);
    const img = join(dir, "pic.png");
    ff(["-f", "lavfi", "-i", "testsrc2=size=1600x900", "-frames:v", "1", img]);
    const wav = join(dir, "tone.wav");
    ff(["-f", "lavfi", "-i", "sine=frequency=330:duration=8", wav]);

    const V = probe(vid), V2 = probe(vid2), I = probe(img), A = probe(wav);
    console.log(`  samples: ${(V.size / 1048576).toFixed(1)} MB video, ${I.video!.width}px png, ${A.duration}s wav`);
    const base = { outDir: dir, sep: "/" };

    t("real: shrink a video to 2 MB", () => {
        const { outs, attempt } = convert({ ...base, input: V, target: "auto", maxBytes: 2 * 1048576, baseName: "small" });
        const p = probe(outs[0]);
        assert.ok(p.size <= 2 * 1048576 && p.video!.codec === "h264" && p.audio!.codec === "aac");
        console.log(`    → ${(p.size / 1048576).toFixed(2)} MB ${p.video!.width}×${p.video!.height} after ${attempt + 1} attempt(s)`);
    });
    t("real: clip + crop + caption + speed", () => {
        const { outs } = convert({ ...base, input: V, target: "mp4", baseName: "clip", edit: { start: 2, end: 6, crop: { x: 280, y: 0, w: 720, h: 720 }, caption: { text: "szmelc: it's, [ok]; 100% \\ done", position: "bottom" }, speed: 2 } });
        const p = probe(outs[0]);
        assert.equal(p.video!.width, 720);
        assert.ok(Math.abs(p.duration - 2) < 0.3, `duration ${p.duration}`);
    });
    t("real: gif under 1 MB", () => {
        const { outs } = convert({ ...base, input: V, target: "gif", maxBytes: 1048576, baseName: "g", edit: { end: 4 } });
        assert.ok(statSync(outs[0]).size <= 1048576 && probe(outs[0]).isAnimated);
    });
    t("real: emoji (static + animated), sticker (apng), avatar", () => {
        const s = convert({ ...base, input: I, target: "emoji", baseName: "e" }).outs[0];
        const sp = probe(s);
        assert.ok(sp.video!.width === 128 && sp.video!.height === 128 && sp.size <= LIMITS.emoji);
        const a = convert({ ...base, input: V, target: "emoji", baseName: "ea", edit: { end: 3 } }).outs[0];
        assert.ok(statSync(a).size <= LIMITS.emoji && probe(a).video!.width === 128);
        const st = convert({ ...base, input: V, target: "sticker", baseName: "st", edit: { end: 2 } }).outs[0];
        assert.ok(statSync(st).size <= LIMITS.sticker && probe(st).video!.width === 320);
        const av = convert({ ...base, input: I, target: "avatar", baseName: "av" }).outs[0];
        const avp = probe(av);
        assert.equal(avp.video!.width, avp.video!.height);
    });
    t("real: soundboard ≤ 5.2 s / 512 KB, screenshot", () => {
        const s = probe(convert({ ...base, input: V, target: "soundboard", baseName: "sb" }).outs[0]);
        assert.ok(s.duration <= LIMITS.soundboardSeconds + 0.1 && s.size <= LIMITS.soundboard);
        const sh = probe(convert({ ...base, input: V, target: "screenshot", baseName: "sh", edit: { at: 3 } }).outs[0]);
        assert.ok(sh.isImage && sh.video!.width === 1280);
    });
    t("real: image shrink to 100 KB", () => {
        const { outs } = convert({ ...base, input: I, target: "auto", maxBytes: 100 * 1024, baseName: "imgs" });
        assert.ok(statSync(outs[0]).size <= 100 * 1024);
    });
    t("real: split copy + exact by size", () => {
        const c = planSplit({ ...base, input: V, mode: "count", value: 3, baseName: "sp" });
        assert.ok("copy" in c);
        assert.ok(run(c.copy).length >= 2);
        const s = planSplit({ ...base, input: V, mode: "size", value: 1048576, baseName: "sz" });
        assert.ok("parts" in s);
        for (const part of s.parts) assert.ok(statSync(convert(part).outs[0]).size <= 1048576);
    });
    t("real: join mixed (video + other video + still image) and audio-only", () => {
        const o = run(planJoin({ ...base, inputs: [V, V2, I], target: "auto", imageDuration: 1, baseName: "joined" }))[0];
        const p = probe(o);
        assert.ok(Math.abs(p.duration - 16) < 0.6, `duration ${p.duration}`);
        const copyJoin = run(planJoin({ ...base, inputs: [V, V], target: "mp4", baseName: "jcopy" }))[0];
        assert.ok(Math.abs(probe(copyJoin).duration - 24) < 0.6);
        const aj = probe(run(planJoin({ ...base, inputs: [A, V], target: "mp3", baseName: "ja" }))[0]);
        assert.ok(Math.abs(aj.duration - 20) < 0.6 && !aj.video);
    });
    if (have("sox")) {
        t("real: sox fx (normalize + pitch + reverb)", () => {
            const o = run(planAudioFx(A, { normalize: true, pitch: 300, reverb: 40 }, "mp3", dir, "fx"))[0];
            assert.ok(existsSync(o) && probe(o).audio);
        });
    } else console.log("skip - sox fx (sox not on PATH)");
    rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed`);
