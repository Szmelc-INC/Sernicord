/*
 * Sernicord FullCyberJacket — message sources (Discord search / channel history)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, RestAPI } from "@webpack/common";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
        try {
            return await fn();
        } catch (e: any) {
            const status = Number(e?.status ?? 0);
            if (status === 429 && tries < 8) {
                await sleep(Math.min(Number(e?.body?.retry_after ?? 2), 120) * 1000 + 250);
                continue;
            }
            if ((status === 0 || status >= 500) && tries < 3) {
                await sleep(800 * (tries + 1));
                continue;
            }
            throw e;
        }
    }
}

export type Source =
    | { kind: "guild-search"; id: string; label: string; channelId?: string; }
    | { kind: "channel-search"; id: string; label: string; }
    | { kind: "history"; id: string; label: string; };

export interface Bounds {
    authorId?: string;
    minId?: string;
    maxId?: string;
    delayMs: number;
    abort: () => boolean;
}

// Text, announcement, voice-chat and thread channels carry messages.
const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12]);

export function guildChannels(guildId: string): Source[] {
    return Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId) ?? {})
        .filter((c: any) => MESSAGE_CHANNEL_TYPES.has(c.type))
        .map((c: any) => ({ kind: "history" as const, id: c.id, label: `#${c.name}` }));
}

export function privateChannelsWith(userId: string): Source[] {
    return ChannelStore.getSortedPrivateChannels()
        .filter((c: any) => (c.recipients ?? []).includes(userId))
        .map((c: any) => ({ kind: "channel-search" as const, id: c.id, label: c.name || (c.type === 1 ? "DM" : "group DM") }));
}

/** Servers you share with the user; falls back to every server you are in. */
export async function mutualGuilds(userId: string): Promise<Source[]> {
    const all = GuildStore.getGuilds();
    try {
        const { body } = await withRetry(() => RestAPI.get({
            url: `/users/${userId}/profile`,
            query: { with_mutual_guilds: true, with_mutual_friends_count: false }
        }));
        const ids: string[] = (body?.mutual_guilds ?? []).map((g: any) => g.id);
        if (ids.length) return ids.map(id => ({ kind: "guild-search" as const, id, label: all[id]?.name ?? id }));
    } catch {
        // Profile can be hidden (no mutual friend / blocked); searching every server still works.
    }
    return Object.values(all).map((g: any) => ({ kind: "guild-search" as const, id: g.id, label: g.name }));
}

// Discord search returns 25 hits per page; page backwards with max_id so the 10k offset cap never bites.
async function* search(src: Source, b: Bounds) {
    let { maxId } = b;
    const seen = new Set<string>();
    const url = src.kind === "guild-search" ? `/guilds/${src.id}/messages/search` : `/channels/${src.id}/messages/search`;
    while (!b.abort()) {
        const query: Record<string, string> = { include_nsfw: "true" };
        if (b.authorId) query.author_id = b.authorId;
        if (src.kind === "guild-search" && src.channelId) query.channel_id = src.channelId;
        if (maxId) query.max_id = maxId;
        if (b.minId) query.min_id = b.minId;
        const res: any = await withRetry(() => RestAPI.get({ url, query }));
        if (res.status === 202) {
            // Index still building on Discord's side.
            await sleep((Number(res.body?.retry_after) || 2) * 1000);
            continue;
        }
        const hits: any[] = (res.body?.messages ?? []).map((group: any[]) => group.find(m => m.hit) ?? group[0]);
        const fresh = hits.filter(m => m && !seen.has(m.id));
        if (!fresh.length) return;
        for (const m of fresh) {
            seen.add(m.id);
            yield m;
        }
        maxId = String(fresh.reduce((a, m) => (BigInt(m.id) < a ? BigInt(m.id) : a), BigInt(fresh[0].id)) - 1n);
        await sleep(b.delayMs);
    }
}

// Plain history, 100 per page, newest first. Used when there is no author to search for.
async function* history(src: Source, b: Bounds) {
    let before = b.maxId;
    while (!b.abort()) {
        const query: Record<string, string | number> = { limit: 100 };
        if (before) query.before = before;
        const res: any = await withRetry(() => RestAPI.get({ url: `/channels/${src.id}/messages`, query }));
        const page: any[] = res.body ?? [];
        if (!page.length) return;
        for (const m of page) {
            if (b.minId && BigInt(m.id) <= BigInt(b.minId)) return;
            if (!b.authorId || m.author?.id === b.authorId) yield m;
        }
        before = page[page.length - 1].id;
        if (page.length < 100) return;
        await sleep(Math.max(300, b.delayMs / 2));
    }
}

export function messages(src: Source, b: Bounds): AsyncGenerator<any> {
    return src.kind === "history" ? history(src, b) : search(src, b);
}
