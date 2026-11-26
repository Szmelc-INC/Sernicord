> # Sernicord 
> ### A Better Discord client, for Power Users & Power Devs
> Isolated Discord mod workspace with a universal sideloader. Default mode builds **Vencord (dev)** with every plugin under `plugins/`, injects into a **local** Discord profile, watches for changes, and launches. \
> System Discord and `~/.config/discord` stay untouched unless you deliberately pass `--system` (and confirm).
>
> [![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
> [![Arch PKGBUILD](https://img.shields.io/badge/Arch-PKGBUILD-1793d1?logo=archlinux&logoColor=white)](PKGBUILD)
> [![Nix flake](https://img.shields.io/badge/Nix-flake-5277c3?logo=nixos&logoColor=white)](flake.nix)
> [![Vencord](https://img.shields.io/badge/target-Vencord%20%7C%20Equicord-ff69b4)](https://github.com/Vendicated/Vencord)

> ### Example modules:
> <img width="543" height="346" alt="image" src="https://github.com/user-attachments/assets/cc3c1152-ce0f-4dec-a938-adbd3f7b8cb9" />
>
> ### Fire memes:
>
> <img width="300" height="501" alt="image" src="https://github.com/user-attachments/assets/f260d09d-a7bc-4b4a-8311-1f13f375f83e" />


## Install

```sh
# Arch (from the repo checkout)
makepkg -si

# Nix
nix run github:Szmelc-INC/Sernicord
nix profile install github:Szmelc-INC/Sernicord
```

Packaged installs keep the code read-only under `/usr/share/sernicord` (or the Nix store) and run from a
writable workspace at `${SERNICORD_HOME:-~/.local/share/sernicord}`, synced on every start. Shell completion
for bash, zsh and fish is installed automatically; `sernicord completion <bash|zsh|fish>` prints it.

## Quick start

```sh
./sernicord          # or: ./sernicord menu
```

First run expects:

- `git`, `node` (≥18), `pnpm`, `rsync`, `python3`, `curl`, `tar`
- Network access to fetch the official Linux Discord bootstrap into `discord-app/Discord/` (`updater_bootstrap` + `discord` launcher; `setup`/`dev` download it automatically when missing)
- Network access to clone [Vencord](https://github.com/Vendicated/Vencord) if `vencord/` is missing

Then:

1. Log in inside the **isolated** Discord window (profile lives under `data/`).
2. Edit plugins in `plugins/<Name>/` (synced into the target’s `src/userplugins/`).
3. Save → `pnpm watch` rebuilds → `Ctrl+R` in Discord.
4. Enable the plugin under **Settings → Vencord → Plugins**.

## Sideloader

```text
./sernicord [command] [options]
```

| Command | What it does |
| --- | --- |
| `dev` / default | Sync plugins → build (dev) → inject → watch → launch |
| `menu` | Interactive picker |
| `setup` | Clone target, install deps, download Discord bootstrap + client |
| `sync-plugins` | Copy `plugins/` → `<target>/src/userplugins/` |
| `build [--prod]` | One-shot build |
| `watch` | Rebuild on save |
| `inject` / `uninject` | Patch / unpatch the profile’s Discord |
| `launch` | Start isolated Discord for the profile |
| `fix` | Rebuild + reinject after Discord updates |
| `update` | `git pull` target + deps + rebuild + reinject |
| `upgrade` / `self-update` | Full auto update: pulls the Sernicord repo itself (local edits autostashed; re-runs the new script if it changed), every cloned target, deps, fetches missing Discord bootstrap/client, refreshes installed completions, syncs plugins, rebuilds, reinjects and restarts a running watch. Lists new plugins. `--no-self`, `--no-build` |
| `check` | Scan `plugins/` for removed target APIs and type-check them (`tsc`) |
| `rebuild` | Stop watch, wipe `dist/`, full build, verify every bundle exists |
| `repair` | Fix pnpm, kill stale watchers, `check`, clean rebuild, reinject |
| `reinstall` | Uninject, wipe `node_modules` + `dist/`, reinstall deps, rebuild, reinject |
| `restart` | `stop`, then `dev` |
| `logs [N]` / `logs -f` | Tail or follow the watch log |
| `doctor` | Toolchain, paths, build artifacts, pnpm, injection, privacy fences |
| `status` / `stop` / `profiles` | Inspect or shut down |
| `backup [out.zip]` | Zip configs, themes, QuickCSS, plugins + Discord session (`--full` adds caches, `--plugins-only` just `plugins/`) |
| `restore <file.zip>` | Restore a backup into the current profile (`--plugins-only` / `--data-only`) |
| `scan` | Find other Discord/Vencord/Vesktop/BetterDiscord traces on the system; import settings/themes/quickcss/cache/plugins with `--import … --from <dir>` |

Options: `--target vencord|equicord`, `--profile NAME`, `--channel stable|ptb|canary`, `--no-launch`, `--no-watch`, `--prod`, `--no-color`, `--full`, `--plugins-only`, `--data-only`, `--import`, `--from`, `--no-self`, `--no-build`, `-y`, `-f`, `--system` (dangerous). Output is colored (Szmelc palette) and honors `NO_COLOR`/`--no-color`.

### Troubleshooting

Discord shows *“A JavaScript error occurred in the main process … ENOENT … dist/renderer.js”*: the renderer
bundle failed to build, usually because a plugin uses an API the target removed (for example `Forms`, `Button.Looks`
or `Modal.ModalRoot` after Vencord 1.15.14). Run `./sernicord check` to see which plugin, then `./sernicord repair`.
`build`, `inject` and `launch` now refuse to continue while any of `patcher.js`, `preload.js`, `renderer.js` or
`renderer.css` is missing.

Examples:

```sh
./sernicord
./sernicord inject --profile alt
./sernicord update --target equicord
./sernicord fix
./sernicord repair
./sernicord check
./sernicord doctor
./sernicord backup                 # → data/backups/sernicord-backup-<date>.zip
./sernicord restore data/backups/sernicord-backup-<date>.zip
./sernicord scan                   # what other Discord/Vencord data lives here?
./sernicord scan --import themes --from ~/.config/Vencord
```

Plugin tests (no Discord needed; MediaForge also runs real ffmpeg / sox encodes when they are on PATH):

```sh
node --experimental-strip-types --no-warnings scripts/test-messageops-limiter.ts
node --experimental-strip-types --no-warnings scripts/test-mediaforge-planner.ts
```

`./dev.sh` remains a thin wrapper around `./sernicord`.

## Layout

| Path | Role | Published? |
| --- | --- | --- |
| `sernicord` | Universal sideloader | yes |
| `plugins/` | Your custom plugins (source of truth) | yes |
| `scripts/secret-scan.sh` | Pre-commit privacy guard | yes |
| `.githooks/pre-commit` | Blocks private paths/secrets | yes |
| `configs/` | Safe examples only | yes |
| `vencord/` / `equicord/` / `clients/` | Managed clones | **no** (local) |
| `discord-app/` | Official Discord bootstrap/client | **no** (local) |
| `data/` | Profiles, cookies, cache, watch logs | **no** (local) |

## Privacy (read this)

This tree is used while logged into a real Discord account. **Do not publish profile data.**

Never commit:

- `data/` (Cookies, Local Storage, LevelDB, sessions, caches)
- `discord-app/` binaries and downloaded `app-*` trees
- `vencord/` / other managed clones (`node_modules`, `dist`, nested `.git`)
- `vencord-settings-backup*.json`, live `settings.json`, tokens, `.env`, keys

Fences:

1. Fortress `.gitignore`
2. `scripts/secret-scan.sh` content + path checks
3. `.githooks/pre-commit` (enable with `git config core.hooksPath .githooks`)

```sh
./sernicord doctor    # verifies fences
```

## Plugins

Ship plugins in `plugins/<PluginName>/`. The sideloader syncs them into the active target before every build/watch/inject.

Bundled plugins:

| Plugin | Role |
| --- | --- |
| `helloDev` | Minimal reload stub |
| `localArchive` | Local archives |
| `secureChat` | E2E-ish chat encrypt/decrypt (shared passphrase) |
| `omniSearch` | Universal in-client search (`/omnisearch`) |
| `profileVault` | Favorite settings/plugins/themes profiles; lossless switching (also from the szmelc tab), JSON import/export |
| `instanceScout` | Finds other Discord / Vencord / Equicord / Vesktop / BetterDiscord / Sernicord installs (with permission); browse and import plugin sets, themes, theme links, QuickCSS / BD custom.css, or make a switchable profile from them |
| `botLens` | Bot-token API browser GUI (no user-session swap) |
| `embedForge` | Custom embeds / interactive link buttons |
| `secretSentinel` | Pattern watcher; alerts stored locally |
| `megaDrop` | Large files via bashupload or chunk threads |
| `bad2YouBad4Me` | Tolerator-T1000 — Laundry day: soften your own messages (keywords + optional LLM), live or bulk |
| `fullCyberJacket` | Finds hate speech, threats, self-harm encouragement and extremist slogans (leet / look-alike / spacing aware) in a user's or server's messages for **manual** review and reporting; never reports by itself |
| `szmelc` | Szmelc™ — OG szmelc mode for the whole client + Szmelc™ HQ (the "szmelc" settings tab): modules by category with search and quick toggles, profile switching, media tools, other installs, themes, look |
| `discloudStorage` | Turns a server into your private cloud storage (you + your bots + backups) |
| `allMyGifs` | Bulk favorite-gif manager: dump all to a channel (URLs or files) and suck a channel's gifs into favorites |
| `messageOps` | Move / copy / export / bulk-delete message ranges: first + last message by ID (right-click), author / text-or-`/regex/` / file / bot / pin filters; Preview, Export ZIP (with files), Copy, Move, Delete into one target as native forward, repost or webhook clone (original name + avatar, webhook created for you); consecutive messages of one author merged into one post; paced by Discord's rate limit headers, posts and deletes in parallel; Move deletes a source only after its copy landed; safety ZIP before Move / Delete (`/msgops`) |
| `mediaForge` | ffmpeg / sox / yt-dlp media centre: auto-fit uploads to the channel limit, clip / edit, split, join, emoji / sticker / soundboard / screenshot makers, link downloads, mpv / VLC control, Win95 Paint (`/forge`) |

Upstream Vencord gitignores `src/userplugins`; Sernicord keeps the publishable copies here instead.

## Multiple clients / profiles

- **Targets:** `--target vencord` (default) or `equicord`
- **Profiles:** `--profile NAME` → isolated dirs under `data/profiles/<NAME>/` (default profile can use the legacy `data/config/` layout when present)
- **Channels:** `--channel stable|ptb|canary` for the standalone download
- **Fix loop:** when Discord self-updates and drops the patch → `./sernicord fix`

## License

Sideloader and Sernicord packaging: use under the same spirit as Vencord — plugin code follows **GPL-3.0-or-later** (see each plugin / upstream Vencord). Upstream Vencord remains Vendicated’s project; Sernicord is a workspace + tooling layer on top.

---

> <img width="500" height="501" alt="image" src="https://github.com/user-attachments/assets/dc16b379-6518-4e3a-b002-7acf4d79b31a" />

