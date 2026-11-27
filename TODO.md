# Sernicord TODO

## Later

### DripInspector (plugin) — one-click outfits

- Right-click a user → **DripInspector**: inspect their whole look (avatar, banner, display name,
  name style / colors, profile theme colors, bio styling, avatar decoration, profile effect,
  nameplate, clan tag, pronouns, …) and copy / save / export any part or all of it.
- One click: apply a full copy of a look to **your own** profile (each part separately or all at
  once), or turn it into an **outfit profile**. Nitro-only parts (decorations, effects, banners,
  profile colors) are saved and shown, then applied only where the account can use them.
- **DripInspector Manager** UI: saved / favorite drips, tags, quick switch, import / export
  (same JSON conventions as ProfileVault), history / undo to the previous outfit.
- Explore and import new drips: from other users, and from Pinterest / GIPHY / Tenor / Canva
  connections (avatars, banners, palettes); hands media off to **MediaForge** (crop, resize,
  animate, fit to Discord limits).
- UI: minimalist but complete; keyboard and screen-reader friendly, clear previews before
  anything changes, confirm + undo for every apply, hard to misuse.
- Open questions: Discord API for profile effects / nameplates (read vs. apply), rate limits on
  profile edits, what not to copy (e.g. full impersonation of another user's name + avatar
  together should warn).

### Macros (plugin) — automation suite

- Macro manager: record, replay, edit and schedule client actions (send / edit / react, navigate,
  open UI, toggle settings, run other Sernicord commands) as named, reusable macros.
- Recorder with step list, delays, variables, conditions and loops; replay at a safe, rate-limited
  pace; dry-run preview before anything is sent.
- Triggers: keybind (via **MetaKeybinds**), slash / `:` command, schedule, message pattern, event.
- Long or bulk runs go through the **Sernicord command center** queue (pause / resume / stop).
- Import / export macros as JSON (same conventions as ProfileVault / **RAW-Manager**).

### BullshitRadar (plugin) — LLM bullshit & lie detector

- Right-click a message / thread → score it for bullshit, manipulation, contradictions, logical
  fallacies, unsupported claims and likely lies; short verdict + explained reasons + confidence.
- Runs on the same LLM backends as Bad2YouBad4Me (local / Ollama first, remote optional).
- Context-aware: compares with the author's earlier messages in the channel for contradictions.
- Clear labelling that results are heuristic opinions, never proof; nothing is posted automatically.

### MetaFolders (plugin) — dossiers on users

- Per-user "folder of folders": everything the client has seen about a user — name / avatar
  history, servers and channels in common, mutual friends, connections, activity / presence
  timeline, notable messages, notes, tags, links to other users.
- Relationship graph view; search, filters, timeline, export / import (JSON).
- Local only, built from data the client already receives; never scraped or shared. Per-user
  opt-out / wipe, retention limits, encrypted at rest (reuse SecureChat crypto).

### MetaFavorites (plugin) — favorites of everything

- Favorite anything: messages, users, channels, servers, threads, GIFs / stickers / emoji, media,
  links, settings pages, macros, searches, drips, RAW templates.
- Folders, tags, ordering, quick-access panel and `:` palette; sync with Discord's own favorites
  where possible; import / export (JSON).

### Szmelc advanced conventions (extends the Szmelc plugin)

- Custom Rich Presence profiles (RPC: name, details, state, images, buttons, timestamps) and
  custom activities, switchable per profile / schedule / keybind.
- Custom styles: Szmelc™ theme presets, per-server / per-channel CSS, quick style switcher.
- Shared Szmelc conventions (naming, colors, JSON formats) documented for all Sernicord plugins.

### MetaKeybinds (plugin) — better keybinds & actions

- Global keybind manager for any client action and any Sernicord command / macro; chords,
  per-context binds, conflict detection, import / export.
- "Panic / focus" actions: temporarily hide any window or UI (sidebars, chat, DMs, overlays) and
  show a chosen screen instead (settings, favorite channels, a MetaFavorites view); one key to
  restore.

### Sernicord command center (Centrum dowodzenia rodzynkami)

- Sernipanel like the notifications / favorites panel, but for everything Sernicord: tasks, jobs,
  logs and notifications from every plugin (LocalArchive exports, imports, MessageOps bulk
  operations, MediaForge jobs, Macros runs, any long process).
- Global background job queue: queue thousands of operations ahead, run them one by one at a safe
  rate; pause / resume / cancel per job and for the whole queue, start / stop queue, priorities,
  retries, persistence across restarts.
- Progress, ETA, history and logs per job; export / import of the queue and logs.
- Shared job API so every plugin reports through it instead of its own progress UI.

### LepszeQwesty (plugin) — better quests

- One click "watch" on a video quest: plays muted and in the background (no popups, no focus
  steal), and claims the reward when the required time is done.
- Quest list with status / time left / rewards, queue several quests, notify on completion.
- Open questions: Discord quest API and how it checks progress; ToS risk — keep it opt-in.

### Better suggestions everywhere (plugin)

- Smarter autocomplete in every input (chat, search, settings, pickers, mentions, emoji,
  commands): wildcards, regex, saved patterns, favorites first (via MetaFavorites), recent
  items, fuzzy matching.
- Shares the matcher with OmniSearch.

### PRO-MODE (plugin) — super developer mode

- Shows IDs of everything next to names or in tooltips (users, messages, channels, servers,
  roles, emoji, stickers, applications, …); click to copy.
- Right-click absolutely anything to get a full context menu: copy ID / raw JSON / mention /
  link, open in RAW-Manager, add to MetaFavorites / MetaFolders, run macros.
- Inspector overlay for stores, flux events and component props.

### RAW-Manager (plugin) — raw JSON for everything

- Read, write, edit and template the raw JSON of everything possible: messages, embeds, profiles,
  channels, roles, permissions, settings, plugin configs.
- Makes "View Raw" editable: edit and resend / re-apply with diff preview, validation and undo.
- Template library with variables (feeds EmbedForge, Macros, ProfileVault); import / export.
