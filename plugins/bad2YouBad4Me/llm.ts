/*
 * Sernicord Bad2YouBad4Me — LLM client (OpenAI-compatible or Anthropic)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Style, systemPrompt } from "./prompts";

export type Provider = "openai" | "anthropic";

export interface LlmConfig {
    provider: Provider;
    baseUrl: string;
    apiKey: string;
    model: string;
    style: Style;
    extraPrompt: string;
    timeoutMs: number;
}

export interface Verdict {
    verdict: "rewrite" | "keep" | "flag";
    text: string;
    reason: string;
}

function parseVerdict(raw: string): Verdict {
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    try {
        const v = JSON.parse(json);
        if (v.verdict === "rewrite" && typeof v.text === "string" && v.text.trim())
            return { verdict: "rewrite", text: v.text.trim(), reason: String(v.reason ?? "") };
        if (v.verdict === "flag") return { verdict: "flag", text: "", reason: String(v.reason ?? "hard limit") };
        return { verdict: "keep", text: "", reason: String(v.reason ?? "") };
    } catch {
        // Model ignored the JSON contract; treat as no-op instead of posting garbage.
        return { verdict: "keep", text: "", reason: "unparseable model reply" };
    }
}

export async function rewrite(cfg: LlmConfig, message: string): Promise<Verdict> {
    const system = systemPrompt(cfg.style, cfg.extraPrompt);
    const base = cfg.baseUrl.replace(/\/$/, "");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);

    try {
        if (cfg.provider === "anthropic") {
            const res = await fetch(`${base}/v1/messages`, {
                method: "POST",
                signal: ctl.signal,
                headers: {
                    "content-type": "application/json",
                    "x-api-key": cfg.apiKey,
                    "anthropic-version": "2023-06-01",
                    "anthropic-dangerous-direct-browser-access": "true"
                },
                body: JSON.stringify({
                    model: cfg.model,
                    max_tokens: 1024,
                    system,
                    messages: [{ role: "user", content: message }]
                })
            });
            if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
            const body = await res.json();
            return parseVerdict(body.content?.map((c: any) => c.text ?? "").join("") ?? "");
        }

        const headers: Record<string, string> = { "content-type": "application/json" };
        if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
        const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            signal: ctl.signal,
            headers,
            body: JSON.stringify({
                model: cfg.model,
                temperature: 0.8,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: message }
                ]
            })
        });
        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
        const body = await res.json();
        return parseVerdict(body.choices?.[0]?.message?.content ?? "");
    } finally {
        clearTimeout(timer);
    }
}
