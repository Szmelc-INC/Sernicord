# Sernicord plugins

Each subdirectory is a Vencord-style userplugin. `./sernicord` copies them into
`<target>/src/userplugins/` before build / watch / inject.

Conventions:

- Folder name = plugin id path (e.g. `helloDev/`)
- Entry: `index.ts` or `index.tsx`
- Use `definePlugin` from `@utils/types`
- Keep secrets out of plugin source (no tokens, no personal IDs hard-coded for your main account)

Bundled plugins:

| Plugin | Role |
| --- | --- |
| `helloDev` | Minimal reload-friendly stub |
| `localArchive` | Local channel/DM/server archive tooling |
| `secureChat` | Shared-passphrase AES-GCM encrypt/decrypt + blacklist |
| `omniSearch` | One field across servers/channels/friends/messages/plugins/settings |
| `profileVault` | Save/favorite/switch settings+plugins+themes profiles |
| `botLens` | Browse as a **bot** via API GUI (does not swap your user login) |
| `embedForge` | Webhook embeds / link buttons / markdown cards (`/embed`) |
| `secretSentinel` | Local-only watcher for tokens/keys/emails + custom patterns |
| `megaDrop` | Huge files via bashupload or peer chunk threads |
| `bad2YouBad4Me` | Tolerator-T1000 — Laundry day: LLM dark-comedy wordsmith (OpenAI-compatible/local or Anthropic) + keyword swaps for your own messages; bulk rewrite / purge / fixed-text replace by keyword list or LLM flag (channel / server / DMs / everywhere), dry run, undo log, ZIP backup |
| `szmelc` | Szmelc™ — OG szmelc mode (dirty-cyan palette on neutral dark, watermark, branded title) + the **szmelc** tab in Vencord settings listing all Sernicord plugins and themes |
| `discloudStorage` | Turn a server into your private cloud: chunked uploads to a storage channel + JSON index your bots can read; download/delete from the settings panel, context menus and `/discloud` |
| `allMyGifs` | Bulk-manage favorite gifs: dump all into a channel as URLs or files (`/gifdump`), suck every gif from a channel into favorites (`/gifcollect`), manage list in settings |
| `fullCyberJacket` | Hate-speech / threat / self-harm / extremism finder for a user (every shared server + DMs), a server or a channel; beats leet, homoglyphs, spacing, zero-width; group words only count next to an aggravator; review modal with jump links, ZIP export, optional webhook digest. Never calls the report API |
| `messageOps` | Message range ops: mark the first and last message by ID (right-click → MessageOps), filter by authors / text or `/regex/` / attachments / bots / pins, then Preview, Export ZIP (with files), Copy, Move or Delete. Copy / Move go to one target channel as native forward, repost (re-uploaded files) or webhook clone with the original name + avatar (webhook auto-created); consecutive messages of one author are merged into one post. Requests follow Discord's `X-RateLimit-*` headers (per-bucket queues, a 429 never fails a message, adaptive pacing for limits the headers don't show); posts and deletes run in parallel; fail-closed Move (a source is deleted only after its copy landed); safety ZIP before Move / Delete; confirm dialog instead of dry run; `/msgops` |

Local-only experiments can live directly under a cloned target’s `src/userplugins/`;
only what you put here is meant for the public Sernicord repo.
