/*
 * Sernicord FullCyberJacket — evasion-aware detector (pure, no Discord imports; testable in node)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CATEGORIES, Category, Confidence, Entry, LEXICON, Tier } from "./lexicon";

export interface Hit {
    ruleId: string;
    cat: Category;
    tier: Tier;
    policy: string;
    detail: string;
    /** Exact text as written in the message. */
    raw: string;
    /** De-obfuscated reading of `raw` ("n1gg@" → "nigga"). */
    canonical: string;
    evasion: boolean;
    conf: Confidence;
    /** Aggravator that turned a group / ambiguous term into a hit. */
    context?: string;
    start: number;
    end: number;
}

export interface DetectOptions {
    categories?: Partial<Record<Category, boolean>>;
    /** Max distance in words between a group term and an aggravator. */
    window?: number;
    skipQuotes?: boolean;
    allowlist?: string[];
}

/* ---------- normalization ---------- */

// Invisible / zero-width / bidi code points used to split words past filters (ranges, inclusive).
const INVISIBLE: [number, number][] = [
    [0x00AD, 0x00AD], [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180E, 0x180E],
    [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF],
    [0xFFA0, 0xFFA0], [0xE0000, 0xE007F]
];
const invisible = (cp: number) => INVISIBLE.some(([a, b]) => cp >= a && cp <= b);

// Lowercase look-alikes from Cyrillic, Greek and IPA blocks.
const CONFUSABLES: Record<string, string> = {
    "а": "a", "в": "b", "е": "e", "ё": "e", "з": "3", "и": "u", "к": "k", "м": "m", "н": "h", "о": "o", "п": "n",
    "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ь": "b", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d",
    "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l", "ɡ": "g", "ɑ": "a", "ɩ": "i", "ʀ": "r", "ᴀ": "a", "ʙ": "b", "ᴄ": "c",
    "ᴅ": "d", "ᴇ": "e", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o",
    "ᴘ": "p", "ꞯ": "q", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
    "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
    "χ": "x", "γ": "y", "ω": "w",
    "ł": "l", "đ": "d", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i", "ŀ": "l",
    "’": "'", "‘": "'", "`": "'", "´": "'"
};

export interface Normalized {
    text: string;
    /** For every char of `text`, the [start, end) range in the raw string it came from. */
    from: number[];
    to: number[];
}

// Links, mentions, channels, roles, custom emoji and timestamps are not speech.
const NON_SPEECH = /https?:\/\/\S+|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::\w)?>/g;

function blank(s: string, re: RegExp) {
    return s.replace(re, m => " ".repeat(m.length));
}

export function normalize(raw: string, skipQuotes = false): Normalized {
    let src = blank(raw, NON_SPEECH);
    if (skipQuotes) src = src.replace(/^>{1,3} .*$/gm, m => " ".repeat(m.length));

    let text = "";
    const from: number[] = [];
    const to: number[] = [];
    let i = 0;
    for (const ch of src) {
        const len = ch.length;
        if (!invisible(ch.codePointAt(0)!)) {
            // NFKD folds fullwidth / math-bold / circled letters and splits diacritics off.
            const lower = ch.toLowerCase();
            let out = CONFUSABLES[lower];
            if (out == null) {
                out = lower.normalize("NFKD").replace(/\p{M}/gu, "");
                out = [...out].map(c => CONFUSABLES[c.toLowerCase()] ?? c.toLowerCase()).join("");
            }
            for (const o of out) {
                text += o;
                from.push(i);
                to.push(i + len);
            }
        }
        i += len;
    }
    return { text, from, to };
}

/* ---------- pattern compiler ---------- */

const LEET: Record<string, string> = {
    a: "a4@^", b: "b8", c: "c(", e: "e3€", g: "g96", i: "i1!|l", l: "l1|i", o: "o0", s: "s5$", t: "t7+", z: "z2"
};
const DELEET: Record<string, string> = {
    "4": "a", "@": "a", "^": "a", "8": "b", "(": "c", "3": "e", "€": "e", "9": "g", "6": "g",
    "1": "i", "!": "i", "|": "i", "0": "o", "5": "s", "$": "s", "7": "t", "+": "t", "2": "z"
};

const classEsc = (s: string) => s.replace(/[\\\][^-]/g, "\\$&");
const SEP_CHARS = "._\\-*~'\"^,\\\\/·•:;";
const SEP_OPT = `[${SEP_CHARS}]{0,2}`;
const SEP_REQ = `[\\s${SEP_CHARS}]+`;
const WORD_GAP = `[\\s${SEP_CHARS}!?]+`;

function atom(c: string): string {
    if (c === "'") return "'?";
    const cls = LEET[c];
    if (cls) return `[${classEsc(cls)}]`;
    return /[a-z0-9]/.test(c) ? c : `\\${c}`;
}

/** Expand "a(b|c)d" style groups and top-level "|" into plain variants. */
export function expand(pat: string): string[] {
    let depth = 0;
    for (let i = 0; i < pat.length; i++) {
        if (pat[i] === "(") depth++;
        else if (pat[i] === ")") depth--;
        else if (pat[i] === "|" && depth === 0) return [...expand(pat.slice(0, i)), ...expand(pat.slice(i + 1))];
    }
    const open = pat.indexOf("(");
    if (open < 0) return [pat];
    depth = 0;
    let close = open;
    for (; close < pat.length; close++) {
        if (pat[close] === "(") depth++;
        else if (pat[close] === ")" && --depth === 0) break;
    }
    const opts: string[] = [];
    let last = open + 1;
    depth = 0;
    for (let i = open + 1; i < close; i++) {
        if (pat[i] === "(") depth++;
        else if (pat[i] === ")") depth--;
        else if (pat[i] === "|" && depth === 0) {
            opts.push(pat.slice(last, i));
            last = i + 1;
        }
    }
    opts.push(pat.slice(last, close));
    const head = pat.slice(0, open), tail = pat.slice(close + 1);
    return opts.flatMap(o => expand(head + o + tail));
}

function runs(word: string): [string, number][] {
    const out: [string, number][] = [];
    for (const c of word) {
        if (out.length && out[out.length - 1][0] === c) out[out.length - 1][1]++;
        else out.push([c, 1]);
    }
    return out;
}

/** Compact form: optional separators between letters, any repeats ("n.1.g.g@", "niiiggggaaa"). */
function compactWord(word: string): string {
    const open = word.endsWith("*");
    const body = open ? word.slice(0, -1) : word;
    const parts = runs(body).map(([c, k]) => {
        const a = atom(c);
        if (c === "'") return a;
        return k === 1 ? `${a}+` : `(?:${a}${SEP_OPT}){${k - 1}}${a}+`;
    });
    return parts.join(SEP_OPT) + (open ? "\\p{L}*" : "");
}

/** Spaced-out form: every letter separated ("n i g g a", "n-i-g-g-a"). */
function spacedWord(word: string): string | null {
    if (word.endsWith("*") || word.includes("'") || word.length < 3) return null;
    return [...word].map(atom).join(SEP_REQ);
}

function variantSource(v: string): string[] {
    const words = v.trim().split(/\s+/);
    const out = [words.map(compactWord).join(WORD_GAP)];
    if (words.length === 1) {
        const s = spacedWord(words[0]);
        if (s) out.push(s);
    }
    return out;
}

export interface CompiledEntry extends Entry {
    re: RegExp;
}

export function compileEntry(e: Entry): CompiledEntry {
    const variants = expand(e.pat)
        .map(v => v.trim())
        .filter(Boolean)
        // Longest first so "niggas" wins over "nigga".
        .sort((a, b) => b.length - a.length);
    const body = [...new Set(variants.flatMap(variantSource))].join("|");
    return { ...e, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "gu") };
}

/**
 * Custom rules, one per line:
 *   pattern                       → custom slur (always a hit)
 *   pattern => category tier      → e.g. "someword(s|) => hate_race slur"
 */
export function parseCustom(src: string): Entry[] {
    const tiers = new Set<Tier>(["slur", "ctx", "group", "aggr", "phrase"]);
    return src.split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#"))
        .map((l, i) => {
            const [pat, meta = ""] = l.split("=>").map(s => s.trim());
            const [cat, tier] = meta.split(/\s+/);
            return {
                id: `custom.${i + 1}`,
                cat: (cat && cat in CATEGORIES ? cat : "custom") as Category,
                tier: (tiers.has(tier as Tier) ? tier : "slur") as Tier,
                pat: normalize(pat).text
            };
        });
}

/* ---------- detection ---------- */

let compiledFor = "";
let compiled: CompiledEntry[] = [];

export function getCompiled(custom = ""): CompiledEntry[] {
    if (compiledFor === custom && compiled.length) return compiled;
    compiledFor = custom;
    compiled = [];
    for (const e of [...LEXICON, ...parseCustom(custom)]) {
        try {
            compiled.push(compileEntry(e));
        } catch {
            // A broken custom pattern must not take down the whole lexicon.
        }
    }
    return compiled;
}

export function deleet(s: string): string {
    return [...s]
        .map(c => DELEET[c] ?? c)
        .join("")
        .replace(/[^\p{L}\p{N}' ]+/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function mask(word: string): string {
    return word.split(" ").map(w => (w.length <= 2 ? w : w[0] + "*".repeat(w.length - 2) + w[w.length - 1])).join(" ");
}

type Match = { e: CompiledEntry; start: number; end: number; tok: number; };

function tokenIndex(text: string): (pos: number) => number {
    const starts: number[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) starts.push(m.index);
    return pos => {
        let lo = 0, hi = starts.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= pos) {
                ans = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return ans;
    };
}

// Only case and Polish diacritics folded: anything else that differs from the canonical reading is evasion.
const plainLower = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");

export function detect(raw: string, opts: DetectOptions = {}, custom = ""): Hit[] {
    if (!raw?.trim()) return [];
    const norm = normalize(raw, opts.skipQuotes);
    const { text } = norm;
    const tok = tokenIndex(text);
    const window = opts.window ?? 6;
    const enabled = (c: Category) => opts.categories?.[c] !== false;

    const matches: Match[] = [];
    for (const e of getCompiled(custom)) {
        if (e.tier !== "aggr" && !enabled(e.cat)) continue;
        e.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = e.re.exec(text))) {
            if (!m[0]) {
                e.re.lastIndex++;
                continue;
            }
            matches.push({ e, start: m.index, end: m.index + m[0].length, tok: tok(m.index) });
        }
    }

    const aggrs = matches.filter(m => m.e.tier === "aggr");
    const allow = (opts.allowlist ?? []).map(a => normalize(a).text.trim()).filter(Boolean);
    const allowed = (s: number, e: number) => allow.some(a => {
        for (let i = text.indexOf(a); i >= 0; i = text.indexOf(a, i + 1))
            if (i <= s && i + a.length >= e) return true;
        return false;
    });

    const hits: Hit[] = [];
    for (const m of matches) {
        if (m.e.tier === "aggr") continue;
        let context: string | undefined;
        let violent = false;
        if (m.e.tier === "group" || m.e.tier === "ctx") {
            const near = aggrs.filter(a =>
                (a.end <= m.start || a.start >= m.end) && Math.abs(a.tok - m.tok) <= window);
            if (!near.length) continue;
            violent = near.some(a => a.e.violent);
            context = text.slice(near[0].start, near[0].end);
        }
        if (allowed(m.start, m.end)) continue;

        const rawStart = norm.from[m.start];
        const rawEnd = norm.to[m.end - 1];
        const rawSpan = raw.slice(rawStart, rawEnd);
        const normSpan = text.slice(m.start, m.end);
        // Digit patterns ("1488") are literal; single-word entries lose the gaps of "n i g g a".
        let canonical = /\d/.test(m.e.pat) ? normSpan : deleet(normSpan);
        if (!/\s/.test(m.e.pat)) canonical = canonical.replace(/\s+/g, "");
        const meta = CATEGORIES[m.e.cat];
        hits.push({
            ruleId: m.e.id,
            cat: m.e.cat,
            tier: m.e.tier,
            policy: violent ? `${meta.policy} + Violent Speech` : meta.policy,
            detail: violent ? `${meta.detail}, with a call for violence` : meta.detail,
            raw: rawSpan,
            canonical,
            evasion: canonical !== plainLower(rawSpan).replace(/\s+/g, " ").trim() || (!/\d/.test(m.e.pat) && /[^\p{L}\s']/u.test(normSpan)),
            conf: m.e.conf ?? (m.e.tier === "slur" || m.e.tier === "phrase" ? "high" : "medium"),
            context: context && deleet(context),
            start: rawStart,
            end: rawEnd
        });
    }

    // Drop hits fully covered by a longer one ("gas the jews" swallows the "jews" group hit).
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    return hits.filter((h, i) => !hits.some((o, j) => j !== i && o.start <= h.start && o.end >= h.end && (o.end - o.start > h.end - h.start || j < i)));
}
