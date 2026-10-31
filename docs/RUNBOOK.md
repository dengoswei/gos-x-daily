# Portable controller runbook

Run from the repository root. This is a deployment procedure, not authorization
to collect private data or send messages. No command below fabricates source facts.

## 1. Isolate local state

Copy the runtime/source examples as described in README. Keep `collectionEnabled`
and `lark.enabled` false while setting up. Choose a private data directory and a
unique deployment ID. Do not copy another machine's credentials/browser profile.
Keep existing history intact: a missing receipt does not establish no prior send.

For a genuinely new delivery ledger, choose its real forward-only date boundary,
check no existing state or uncertain historical send overlaps, then initialize once:

```sh
node cli.mjs init-delivery-ledger --directory /private/xdaily/delivery-ledger --not-before-date YYYY-MM-DD --created-by ACTUAL_CONTROLLER_ID
```

Dates use Asia/Shanghai. Never reset/recreate a ledger to bypass an attempt guard.
Source code and private state need separate authorized durable backups.

## 2. Capture genuine sources

A controller must use its current authorized browser tools. Confirm X Following
is selected in the rendered UI; its URL can still display For you. Preserve usable
posts and a genuine attempt at each configured watch account (default: Karpathy). Add configured official blogs/Xiaohongshu,
optional Substack and relevant received Gmail. Record unavailable sources honestly.

Choose a new private run directory. Save actual screenshots and truthful text,
URLs, source times and capture times. Pin the horizon to real collection start.
Follow BROWSER-ARTIFACTS.md, including evidence paths/SHA-256 and thread/quote
schema. Unknown times remain null. A screenshot is not proof of complete recall.

```sh
RUN=/private/xdaily/runs/UNIQUE_RUN_ID
node cli.mjs import-browser --artifacts "$RUN/browser-capture.json" --out "$RUN/sources.json" --config config/runtime.local.json
node cli.mjs compose-input --sources "$RUN/sources.json" --out "$RUN/prompt.md"
```

These are offline commands. Import verifies evidence bytes, writes sources and
updates this deployment's coverage state. Outputs use exclusive creation.
`collect` is a different, conditional direct-CDP route, not a CUA driver.

## 2b. Fetch and import feeds

`tools/fetch-feeds.mjs` is a network tool; the CLI is not. It downloads only the
public feeds listed under `feeds` in the sources file (HTTPS only, at most 3 HTTPS
redirects, 20 s and 8 MiB per feed) and records each failure in the bundle.
Run it before or after the browser capture: its `startedAt` must lie within
2 hours of the browser `capturedAt` either way. Write into the same run
directory as `browser-capture.json` so all evidence paths share one base.

```sh
node tools/fetch-feeds.mjs --sources config/sources.local.json --out "$RUN"
node cli.mjs import-feed --artifacts "$RUN/feed-capture.json" --sources "$RUN/sources.json" --out "$RUN/sources.merged.json" --config config/runtime.local.json
node cli.mjs compose-input --sources "$RUN/sources.merged.json" --out "$RUN/prompt.md"
```

Import re-verifies every document hash, keeps items published within the
configured lookback before the fetch `startedAt` (undated items are kept and
counted in a warning), caps each feed at `maxItems`, and adds each document to
`provenance.evidence` as `fetched_document`. A configured feed without a document
is a warning; a document for an unconfigured feed is an error. Feed entries are
publisher statements, not independently verified facts.

When feeds were imported, the merged file is the collection for everything that
follows: use it for `compose-input --sources`, `prepare-delivery --sources` and as
`sourcesPath` in `publication.json`. Candidate keys, dispositions and the URL gate
are all computed from that one file; pointing them at the pre-merge `sources.json`
makes every feed key unknown and every cited feed URL unobserved.

## 3. Preserve and read supplemental materials

Gmail is controller work: there is no Gmail import command. Save only relevant
received body/text plus message/source ID, direct URL, received/publication/read
time and full-body/excerpt limits. Save primary texts and meaningful images when
needed. Do not export mailbox dumps or unrelated personal content.

Create canonical materials mapping each item/candidate to real files, hashes,
source dates, central claim, method/result and limitations. `compose-input` includes
source JSON only: the writer and reviewer must explicitly read all supplemental
files too.

Every supplemental source the digest may cite (a Gmail newsletter, a manually read
primary source) must carry its direct `url` in `canonical-materials.json`: a saved
body often does not contain its own URL. The URL gate accepts a digest main-body
URL only if it appears in the collection file (`sourcesPath`) or in the text of a declared material or
evidence file (`.txt/.md/.json/.jsonl/.html/.xml`); anything else is rejected as
unobserved, with up to three observed URLs on the same host as a hint. Comparison
ignores `utm_*`/click-tracking parameters, `www.`, host case and a trailing `/`.

## 4. Draft, freeze and independently review

Write digest.md under EDITORIAL.md. No quota; explain actual method/conclusion,
not merely settings/metrics. Preserve material limitations in the final render.

Section rules: the digest needs the `# X AI 日报 YYYY-MM-DD` title, the collection
marker, at least one `##` main section with a bullet carrying a direct URL, and a
`## 差异补充` audit section. The validator does not pin main section names (the
prompt's section list stays the editorial default); every main-body bullet
(`-`, `*` or numbered) needs a URL. A `##` main section with no line containing a URL
is left out of the rendered message, so do not write placeholder sections; its text
is still a review unit because review units come from digest.md, not the render.

Repeats: to show the writer what recent reports already carried, pass the same
`ledgerDir` named in `publication.json` to `compose-input`:

```sh
node cli.mjs compose-input --sources "$RUN/sources.merged.json" --published-history "$LEDGER" --out "$RUN/prompt.md"
```

The prompt then lists `date  url` for reports dated in the seven days before this
one. Cite such a URL again only as an item labelled `跟进` that states a new fact;
otherwise skip the candidate as `duplicate_topic`. A repeat is a warning
(`validation.repeatedUrls` in `prepare-delivery`), never a rejection.

Next to it write `dispositions.json`: one row per candidate key listed at the end
of the `compose-input` prompt (`schemaVersion: 1`, the collection's `collectionId`):

```json
{ "schemaVersion": 1, "collectionId": "ACTUAL-COLLECTION-ID", "items": [
  { "key": "x:123", "disposition": "included", "section": "Breakthrough Research", "url": "https://..." },
  { "key": "x:456", "disposition": "merged", "mergedInto": "x:123" },
  { "keys": ["x:789", "blog:https://..."], "disposition": "skipped", "reason": "low_signal" } ] }
```

`included` needs the `##` section it appears under and a URL cited in the main
body; `merged` must point at an included key; `skipped` takes one reason of
`off_topic|promotion|duplicate_topic|outside_window|low_signal|unreadable|other`
and an optional `note`. Citing a candidate's own URL (post, blog, deep-read or
note URL) requires that candidate to be `included`; any other cited URL (a link
inside a post, a supplement) only has to be observed. Missing, duplicate or
unknown keys fail.
Use `examples/publication.example.json` as a path template. Replace every placeholder
with actual paths/identity, including `dispositionsPath` and the exact
already-initialized ledgerDir (not a new sibling directory); list all materials
(including `canonical-materials.json`) and **every** screenshot, relevant
mail body and primary text relied on. Nested material references are not discovered
automatically. Avoid dangling unlisted evidence references.

```sh
node cli.mjs review-input --publication "$RUN/publication.json" --out "$RUN/review.pending.json"
```

This first runs the URL and dispositions gates, then creates pending fields, never
approval. The review binds the dispositions file and the rendered message, which
ends with a `候选处置` count line. Assign a genuinely independent
reviewer. Blind comprehension comes first; fidelity against preserved evidence
comes second. Review each required unit, the source/coverage audit and exact
rendered text. Fix material findings in every affected copy and create a fresh
review for changed bytes. Never transfer old approval to new content.

After real review, save the final approved record at reviewPath, then:

```sh
node cli.mjs validate-publication --publication "$RUN/publication.json"
```

This checks structure/completeness/hash bindings, not reviewer honesty or factual
truth. The controller owns real reviewer independence and semantic quality.

## 5. Plan and separately authorize delivery

Verify the Lark bot, exact recipient and local credential/runtime configuration
through authorized means. Use docs/LARK.md; do not ask for secrets in chat. Only
then enable the verified local Lark target and prepare offline:

```sh
node cli.mjs prepare-delivery --sources "$RUN/sources.merged.json" --digest "$RUN/digest.md" --publication "$RUN/publication.json" --out "$RUN/delivery.json" --config config/runtime.local.json
```

Preparation re-runs the URL and dispositions gates, requires `dispositionsPath`
and renders the same message as `review-input`; editing `dispositions.json` after
approval invalidates the review. Preparation never sends. The separate `send`
command also requires explicit `--allow-send`, `X_DAILY_ALLOW_SEND=1`, matching
verified target, exact unchanged publication/review, and a forward ledger. See CLI help; do not run it without actual
send authority. No automatic retry: timeout/process failure/missing or malformed
confirmation may mean uncertain delivery. Reconcile externally before any retry.
Preserve API message IDs; acceptance is not proof the user read the report.

After an accepted, receipted send, `send` appends one line to
`<ledgerDir>/published-urls.jsonl`:
`{"date":"YYYY-MM-DD","idempotencyKey":"xdaily-...","urls":["<canonical URL>",...],"recordedAt":"ISO"}`
with the canonical main-body URLs of the plan (`plan.publishedUrls`). The file is
append-only (mode 0600, fsynced) and never rewritten. If the append fails the send
still reports `sent_api_accepted`, with `publishedUrlsRecorded: false` and a
`publishedUrlsWarning`; nothing is retried. `prepare-delivery` reads the same file,
so a corrupt line blocks preparation until it is repaired by hand, and a history line
added between preparation and send invalidates the plan (prepare again).

## 6. Schedule only after integration verification

The repository creates no schedule. Verify one real complete controller run,
then configure any separately authorized scheduler with explicit timezone, private
state location, concurrency control, failure handling and independent review steps.
Report capture, semantic review, prepared plan, API acceptance and scheduling as
separate milestones. Never claim "only credentials remain" before verifying the
other integration boundaries.

## 7. Review changes and promote a version deliberately

The repository is the portable source baseline, not automatic deployment wiring.
Publishing or updating `main` does not change an already-running installation.
Keep its sent publication packs, credentials, delivery ledger and scheduler intact.

On another machine/agent, clone the repo, read AGENTS.md, create a working branch,
review the diff and run `npm test`, `npm run check`, and `npm run test:synthetic`.
Use synthetic fixtures for code review; never commit private source captures or
production state. Prefer a reviewed pull request for subsequent improvements.

For a separately authorized production upgrade:

1. Choose an exact reviewed commit with passing CI; record its SHA in private
   deployment metadata. Do not silently run an unreviewed moving `main` checkout.
2. Check out that commit in a new release directory, run the offline checks, and
   configure private runtime/source paths outside tracked files. Re-verify local
   browser/model/Lark capabilities instead of assuming the old machine's sessions.
3. Preserve the existing verified delivery ledger and idempotency namespace when
   upgrading the same deployment. Do not initialize a new empty ledger, migrate
   uncertain receipts, replay old packs, or copy credentials through Git.
4. Quiesce the old controller only under deployment authority, so old and new
   versions cannot concurrently send. Change the scheduler/release pointer only
   after the configured workflow and genuine independent-review handoff are checked.
5. Verify one authorized forward-run outcome. Retain the prior release for code
   rollback, but never roll back delivery attempts/receipts or reset their guards.

Local tests, a public source commit and CI success establish source verification,
not successful production promotion. Report the deployed SHA and live-run evidence
separately; if no promotion occurred, say so explicitly.
