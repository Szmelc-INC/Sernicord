# FullCyberJacket

Finds messages that break Discord's rules on **Hateful Conduct**, **Violent Speech**, **Self-Harm** encouragement
and **Violent Extremism**, including the usual ways people dodge filters. It then lines them up for you to review
and report **by hand**.

> **Hard rule:** FullCyberJacket never calls Discord's reporting endpoints, has no "report all" button and never
> fills in a report for you. Every finding is a jump link. You read it in context, then right-click → Report in
> Discord's own dialog. Discord's Trust & Safety reviews reports by hand. One accurate report per real violation
> works. Automated or bulk reports from one account read as report abuse.

## What it scans

| Scope | How |
| --- | --- |
| User, this channel | Discord search with `author_id` |
| User, this server / server by ID | Guild search with `author_id` |
| User, everywhere | Every server you share (from their profile, falls back to all your servers) plus your DMs and group DMs with them |
| Everyone, this channel / server | Channel history, 100 per page (slow on big servers) |

You can start a scan from the settings panel, from the right-click menu on a user, message or server, or with
`/cyberjacket scope:<channel|server|everywhere> [user]`. Review the results with `/cyberjacket-results`.

## Detection

Text is normalized before matching:

- zero-width, soft-hyphen and bidi characters are removed (`nig​ger`)
- NFKD folds fullwidth, math-bold and circled letters (`ｎｉｇｇｅｒ`)
- diacritics are stripped and Cyrillic, Greek and IPA look-alikes are folded (`nіgga` with a Cyrillic `і`)
- links, mentions, custom emoji and (optionally) quoted lines are ignored

Each lexicon entry compiles into a fuzzy regex that accepts:

- leet substitutions (`4/@ → a`, `1/!/| → i`, `3 → e`, `0 → o`, `5/$ → s`, `7/+ → t`, `9/6 → g`)
- repeated letters (`niiiggaaa`)
- punctuation between letters (`n.i.g.g.a`, `n-i-g-g-a`)
- fully spaced-out words (`n i g g e r`)

Word boundaries are Unicode-aware, so `Nigeria`, `kniga`, `snigger` and `niggardly` do not match.

Entries come in tiers, which keeps the reports accurate:

| Tier | Counts when | Examples |
| --- | --- | --- |
| `slur` | always | n-word, `czarnuch`, `ciapaty`, `kike`, `faggot`, `ty pedale` |
| `ctx` | near an aggravator | `pedały`, `chink`, `parch`, `retard` |
| `group` | near an aggravator | `Żydzi`, `Jews`, `murzyni`, `geje`, `muzułmanie`, `Ukraińcy` |
| `aggr` | never alone | `jebać`, `wypierdalać`, `do gazu`, `wymordować`, `podludzie`, `vermin`, `kill` |
| `phrase` | always | threats (`zabiję cię`, `I'll kill you`), self-harm encouragement (`kys`, `idź się powieś`), extremism (`heil hitler`, `1488`, Holocaust denial) |

So `historia Żydów`, `cmentarz żydowski`, `jebać poniedziałki` and `pedałować na rowerze` are not hits, while
`jebać żydów`, `żydzi do gazu` and `jebane pedały` are. When the aggravator is a call for violence, the finding is
tagged `Hateful Conduct + Violent Speech`.

Each finding records:

- the policy and reason
- the exact text as written and its decoded reading (`n1gg@ → nigga`), with an **evasion** flag
- the aggravator that triggered it
- a confidence level
- author, place, time and a jump link

Known limits:

- Context is word-level, not semantic. A history lesson that says "Żydów mordowano w komorach gazowych" is a
  group + aggravator hit, so read every finding before you report it.
- Multi-word phrases spelled out letter by letter are not matched.
- Images, attachments and embeds are not scanned.
- Threads are only covered by the server-wide search, not by the every-author history walk.

## Settings

- **Categories**: each policy area can be switched off. Disability slurs are off by default because most are used
  as casual insults.
- **Minimum confidence** and the **context window** (in words) for group and ambiguous terms.
- **Custom rules**, one per line, using the lexicon syntax: `stem(a|y|)` for suffixes, `stem*` for an open tail,
  `word word` for a phrase, optionally followed by `=> category tier`. Example: `someword(s|) => hate_race slur`.
- **Allowlist**: phrases that never count, e.g. `niger river`.
- **Webhook** (optional): the webhook URL of a private log channel you own. Findings are posted there as embeds,
  automatically while scanning or on demand. The text sits behind a spoiler, is masked, or is plain. Your own
  account posts nothing.

## Review and export

The review modal filters by status (new / reported / dismissed), category and author. Each row offers:

- **Jump**
- **Copy link**
- **Mark reported**
- **Dismiss (false positive)**

Results persist locally (last 5000). **Export ZIP** saves `findings.json`, `findings.csv` and `links.txt` (link,
policy, author, place and time per finding). This is useful for handing evidence to server staff or for a single
consolidated ticket at dis.gd/report.
