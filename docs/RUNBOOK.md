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
posts and a genuine Karpathy attempt. Add configured official blogs/Xiaohongshu,
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

## 3. Preserve and read supplemental materials

Gmail is controller work: there is no Gmail import command. Save only relevant
received body/text plus message/source ID, direct URL, received/publication/read
time and full-body/excerpt limits. Save primary texts and meaningful images when
needed. Do not export mailbox dumps or unrelated personal content.

Create canonical materials mapping each item/candidate to real files, hashes,
source dates, central claim, method/result and limitations. Screen all observed
candidates and preserve dispositions. `compose-input` includes source JSON only:
the writer and reviewer must explicitly read all supplemental files too.

## 4. Draft, freeze and independently review

Write digest.md under EDITORIAL.md. No quota; explain actual method/conclusion,
not merely settings/metrics. Preserve material limitations in the final render.
Use `examples/publication.example.json` as a path template. Replace every placeholder
with actual paths/identity, including the exact already-initialized ledgerDir
(not a new sibling directory); list all materials and **every** screenshot, relevant
mail body and primary text relied on. Nested material references are not discovered
automatically. Avoid dangling unlisted evidence references.

```sh
node cli.mjs review-input --publication "$RUN/publication.json" --out "$RUN/review.pending.json"
```

This creates pending fields, never approval. Assign a genuinely independent
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
node cli.mjs prepare-delivery --sources "$RUN/sources.json" --digest "$RUN/digest.md" --publication "$RUN/publication.json" --out "$RUN/delivery.json" --config config/runtime.local.json
```

Preparation never sends. The separate `send` command also requires explicit
`--allow-send`, `X_DAILY_ALLOW_SEND=1`, matching verified target, exact unchanged
publication/review, and a forward ledger. See CLI help; do not run it without actual
send authority. No automatic retry: timeout/process failure/missing or malformed
confirmation may mean uncertain delivery. Reconcile externally before any retry.
Preserve API message IDs; acceptance is not proof the user read the report.

## 6. Schedule only after integration verification

The repository creates no schedule. Verify one real complete controller run,
then configure any separately authorized scheduler with explicit timezone, private
state location, concurrency control, failure handling and independent review steps.
Report capture, semantic review, prepared plan, API acceptance and scheduling as
separate milestones. Never claim "only credentials remain" before verifying the
other integration boundaries.
