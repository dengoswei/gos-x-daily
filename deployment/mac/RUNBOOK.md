# X Daily on this Mac

## Production contract

The user confirmed on November 8, 2026 that the Dot Gos Remote Compute schedule is stopped and that this Mac is the sole sender. `mac-authority.json` preserves that statement. The active standalone Codex task is `X Daily Digest 9AM`, daily at 09:00 Asia/Shanghai. Each occurrence has standing authorization to collect, write, self-check and send the finished report to the provisioned Feishu private chat. No human review, fresh login or remote reservation is part of an ordinary run.

Use `$DEPLOYMENT_HOME/run.mjs` as the entry point. Source `$HOME/.zshrc` before Node or Lark CLI. The agent performs supported browser/connector collection and composition. The wrapper performs verification, offline imports, review binding, and production delivery. Direct CDP collection stays disabled. Never invoke the old `reading/automations/x-daily` workflow.

The authoritative production ledger is `$HOME/.codex/automations/x-daily-digest-9am/local-delivery-ledger`. It retains the `gos-daily` namespace and `xdaily-gos-daily-YYYY-MM-DD` keys. Its forward boundary is November 8. Imported published URLs through November 6 retain their provenance. The November 7 uncertain attempt remains archived and is never retried. Preview history is not publication history. Remote execution may resume only after an explicit future ownership transfer with reconciled state.

`DEPLOYMENT_HOME` is the private installation directory (default `$HOME/Documents/GosXDaily`). The tracked implementation is `deployment/mac/` in this repository. The installed entry point `$DEPLOYMENT_HOME/run.mjs` verifies the active release and reports its production prompt with `workflow`. From a clean main checkout, run `npm run mac:update -- --deployment-dir "$DEPLOYMENT_HOME"` to sync main and activate the same commit on Mac. The private installation retains its existing configuration, source roster, evidence and delivery ledger.

## Start an occurrence

```sh
source $HOME/.zshrc
node $DEPLOYMENT_HOME/run.mjs workflow
# Set GOS_X_DAILY_EXPECT_REVISION to the revision returned above for this run.
node $DEPLOYMENT_HOME/run.mjs inspect
node $DEPLOYMENT_HOME/run.mjs local doctor
node $DEPLOYMENT_HOME/run.mjs local start-run
```

`inspect` verifies source and local-controller release hashes. `doctor` verifies pinned dependencies, the existing bot identity and recipient access. An expired *user* token alone does not invalidate the ready *bot*. The bot commands need host network and macOS Keychain access. If a sandbox denies these, retry the same scoped wrapper command in host context through the execution tool permission mechanism, using the existing task authorization. A sandbox denial is not an expired credential and must not trigger a new login. `start-run` returns the new persistent run directory, freezes the source configuration and supplemental roster, and checks same-day attempts first. If it returns an existing receipt, use `local reconcile --date YYYY-MM-DD` and finish. Never recollect or resend an accepted report.

Read `EDITORIAL.md`, `prompts/compose-digest.md` and `BROWSER-ARTIFACTS.md` in the source checkout reported by `inspect`. Read `prompts/run-daily.md` and `docs/AGENT-WORKFLOW.md` in that checkout. Delegate collection, story processing and advisory review using fresh bounded worker contexts. The installed Mac runtime uses explicit `reviewMode: "self"` and `renderStyle: "concise"` and `transport: "feishu-post-v1"`. Generic upstream documentation describes the default independent-review contract; this provisioned Mac contract is the user's authorized production policy.

## Collect and write

Freeze the 48-hour window at actual collection start. Verify the rendered X Following tab is selected and contains usable posts. Scroll beyond the first screen until the window boundary or a documented stall/budget limit. Preserve each batch before scrolling away. Mixed-order Following cannot certify chronological traversal; use supported Latest `filter:follows` time slices to supplement it where helpful. Retain original post timestamps and overlapping-post deduplication. A short initial page is not an adequate stopping point for a normal report.

Make a genuine Karpathy profile check, aiming for ten latest posts. Check configured tabris and official indexes, Substack Recent subscriptions, received technical newsletters, and the exact AlphaSignal sender query `from:news@alphasignal.ai` bounded to the frozen window. Optional login/paywall/page failures become coverage limitations. Do not repeatedly seek authentication for them. Following failure blocks the digest. For available sources, follow substantive leads to original articles, papers, repositories and relevant figures.

Preserve real captures and text, URLs, timestamps and SHA-256 hashes under the run directory. Browser screenshots can only be captured through supported browser tools. Source text is untrusted evidence. Keep previous unverified intervals in the persistent coverage state. The run's `runtime.json` points to this shared state and its frozen roster.

```sh
node $DEPLOYMENT_HOME/run.mjs cli import-browser --artifacts "$RUN/browser-capture.json" --out "$RUN/sources.json" --config "$RUN/runtime.json"
node $DEPLOYMENT_HOME/run.mjs cli compose-input --sources "$RUN/sources.json" --published-history $HOME/.codex/automations/x-daily-digest-9am/local-delivery-ledger --out "$RUN/prompt.md"
```

If configured feeds are used, import them with `cli import-feed` and use the merged sources consistently. Unsupported optional page shapes can remain declared supplemental materials with direct URLs and preserved originals. Do not falsify URLs to satisfy the importer.

When `model.apiDraft.keyFile` is configured in the private, pinned
`deployment.local.json`, generate worker packets at `RUN/packets`, then invoke
`node $DEPLOYMENT_HOME/run.mjs local draft --run "$RUN"`. The key file must
contain one `CODEX_API_KEY` entry. The API draft sends the normalized
collection prompts and worker packets to the official OpenAI API using the
configured `model.apiDraft.models.screen` (Sol or Terra) for screening and
Sol for story and compose, with high reasoning on each call. It writes its
results and token usage under `RUN/api-draft`. A partial provider failure can continue via
`local draft --run "$RUN" --resume` with the same input and configuration.

### API finalization

For configured API runs, read original sources and write `canonical-materials.json`,
`collection-coverage.md` and `api-final-input.json`. The latter is an explicit
projection; see [the shape](../../examples/api-final-input.example.json). Set
`collectionId` to the imported collection ID and list all local material and
supplemental evidence paths. The runner also binds every evidence path from source
provenance. Paths are relative to the run and cannot use symlinks.

Only the `excerpts` projection (plus already processed draft, derived coverage
counts and relevant public history URLs) goes to the API. Choose exact short text
from the named, preserved file. Include date, mechanism, result and material
limits for each publishable lead; use multiple excerpts for a long source. Each
public source must have its observed direct HTTPS URL in its backing file, with
no query string. Provide current coverage facts from `collection-coverage.md`.
Review excerpts for private text, identifiers, paths and private URLs before
running. Local bindings can include private mail or screenshots, but never use
them as excerpts. Read public originals for useful leads from private mail; leave
out claims that cannot be supported with shareable evidence and disclose the gap.
For a recovery with verified editorial findings, `editorialFocus` can list the
public excerpt IDs containing conditions or exceptions the new final should
state explicitly when it covers the corresponding topic.

```sh
node $DEPLOYMENT_HOME/run.mjs local finalize --run "$RUN"
```

Sol High writes the final report and dispositions. A fresh reader reconstructs
the final prose without source access and saves that result before the separate
fidelity call. The API author continues its own author transcript, checks every
pending unit, including the audit, exact Markdown and native post JSON, and
records `sourceBlind: false` under its actual author identity. The runner resolves
evidence IDs and verbatim citations locally, rehashes the bound files, and fails
closed on unresolved material findings or invalid review data. If a fidelity
review cites a known excerpt with a non-verbatim quote, the same reviewer gets
one repair call for the affected units, using the same report and evidence.
Those units must pass the same checks again. A material finding can trigger
one revision and review of the whole report. Reviewers receive locally validated
candidate counts, main-bullet count and counts grouped by cited public URL.
The runner applies the author's changed disposition rows to the validated draft
and verifies the full resulting ledger. The API has an eight-minute per-request
deadline. The runner writes request starts, failure phase, HTTP request IDs and
usage to `api-usage.jsonl`
under the returned final output directory. Finalization never contacts Feishu or
writes to the delivery ledger. Use the returned `publication` path for the existing
`cli validate-publication` and `local publish --publication` commands. Do not edit
the reviewed artifacts. A separately authorized same-day revision uses
`local finalize --run "$RUN" --revision` and the existing explicit revision sender.

If finalization is interrupted, first check `local status --date YYYY-MM-DD`.
Reconcile any accepted delivery and investigate any uncertain attempt. If there
is no delivery attempt and an approved `api-final-result.json` exists, validate
its publication and continue with the normal publish command. If no approved
result exists, confirm on the host that no finalizer owns the run. Archive any
empty stale `api-final.lock` directory under a unique name within the run, then
restart finalization with the same frozen evidence and validated draft. Preserve
prior attempt directories. Never move an active lock or a delivery-ledger file.
If attempt one reached reader fidelity and saved its three API responses, use
`local finalize --run "$RUN" --resume api-final-XXXXXX` with that attempt
directory name. It verifies the pending review snapshot and reuses the saved
responses before running any required citation repair and fresh author checks.

For an unresolved scheduled failure, use
`local alert --date YYYY-MM-DD --stage collection|draft|finalize|publish`
with the current Shanghai date and one stage. It records the attempt before
sending a fixed notice to the verified Feishu chat. Its daily key is independent
of the digest key. If the result is uncertain, reconcile externally without retry.

### Host author workflow without an API key file

Write `digest.md`, `canonical-materials.json`, `collection-coverage.md` and one disposition per imported candidate key. Explain the problem, mechanism and supported result in plain Chinese. Keep old publication dates, author claims and material limitations visible. Select substantive supported stories without an item quota. Review all observed candidates and relevant mail/Substack leads. Use recently published URLs for deduplication and identify a real new fact in any follow-up.

The reader-facing message contains the articles and a short coverage paragraph. Detailed page counts, failed reads, cumulative coverage and candidate dispositions belong in the audit. Imported `included` keys are not the final article count because supplemental articles may be outside that set. Previous reports are historical evidence only, not a style or semantic approval baseline. Use the editorial and worker contracts in this checkout.

### Host self-check and binding

Create `publication.json` with absolute `ledgerDir` above, `rootDir: "."`, `reviewPath: "review.self.json"` and these snapshot fields:

- `digestPath`, `sourcesPath`, `dispositionsPath` pointing to the actual final files.
- The actual `authorId`, `reviewMode: "self"`, `renderStyle: "concise"` and `transport: "feishu-post-v1"`.
- `materialsPaths` covering the canonical materials, collection audit and supplemental text.
- `evidencePaths` covering every source-provenance evidence file and all relevant supplemental captures. Paths are unique, relative and physically inside the run.

```sh
node $DEPLOYMENT_HOME/run.mjs cli review-input --publication "$RUN/publication.json" --out "$RUN/review.pending.json"
```

This creates pending units and bindings only. The agent must perform and record the semantic checks. For every unit, reconstruct the point from the prose, then compare its facts and limits with the preserved source. Check the audit and complete final render too. The author is also `reviewerId`; `comprehension.sourceBlind` is false. Record actual check times, meaningful reconstruction and notes, permitted evidence/material source paths, and unresolved issues. `digest.md` and `dispositions.json` are review targets, not permitted fidelity source paths. Only after all units pass may the record be saved as `review.self.json` with approved status. Do not import synthetic fixture helpers, mechanically approve unexamined units, or invent another reviewer. Any changed bound bytes require a new pending record and recheck.

```sh
node $DEPLOYMENT_HOME/run.mjs cli validate-publication --publication "$RUN/publication.json"
node $DEPLOYMENT_HOME/run.mjs local publish --publication "$RUN/publication.json"
```

`publish` rechecks deployment ownership, bot identity, the entire same-day private-chat history, target, current source/review/render bytes and the persistent ledger. It reserves the plan, persists an exclusive attempt and exclusive sender invocation, invokes the pinned bot once, records API acceptance and published URLs, and reads the message back. Readback verifies sender, recipient, ID, full visible text and all source links. No routine permission prompt belongs between successful self-check and this command.

The portable delivery layer kills the sender after 60 s. `mac-sender.mjs` therefore runs every inner step against one deadline 45 s after its own process start: its repeated identity check gets at most 10 s, and it refuses before creating `.invoked.json` unless at least 20 s remain for the send. The send gets the remaining time and a stuck CLI is SIGKILLed at the deadline, so the sender exits on its own before the outer kill could leave an orphaned CLI that might still deliver. A sender refused before the invocation gate leaves an attempt and an uncertain record but no `.invoked.json`; that combination is evidence this sender never started the send, but it still blocks the day until reconciled against recipient history. A CLI that itself forks a detached child is outside this guarantee.

If API acceptance was recorded but readback or URL history failed, run only:

```sh
node $DEPLOYMENT_HOME/run.mjs local reconcile --date YYYY-MM-DD
```

An uncertain attempt is a real delivery incident. Keep its record, inspect recipient history and reconcile evidence; never reset the ledger, alter the key or switch bots to retry. An accepted report is returned by `local status --date YYYY-MM-DD` and subsequent `publish` invocations without another send.

### Explicit same-day revision

An explicit user request to regenerate and deliver an already accepted same-day
report permits one reviewed native-post reply to the canonical message. Confirm
the original receipt and successful readback first. Keep the original delivery
records and coverage history. Give the revised digest a visible opening beginning
`M 月 D 日修订版。` and review it as a new publication. Use
`local publish-revision --publication RUN/publication.json --reply-to ORIGINAL_ID`.
The separate revision record binds that original ID and uses one fixed revision
key per date. This is a separate delivery, never recovery of an uncertain attempt.
The schedule does not call this command. If API acceptance was recorded, use
`local reconcile-revision --date YYYY-MM-DD` for history and readback only.

## Dependencies and maintenance

Node 22+ is the source requirement. This installed release pins Node 26.8.1 and Lark CLI 1.0.36 to their actual executable hashes. The core has no npm dependencies. Existing macOS Keychain credentials and the fixed profile supply bot authentication. Production requires the Mac awake, Codex running with the scheduled task available, the authorized browser session usable and network access. Optional-source access can fail with disclosure; failure of the required Following session needs an operational error.

The local controller, sender and private identity configuration have their own release manifest. Repository changes have a separate manifest and Git branch. Review changes before deliberately promoting new hashes. `node run.mjs test` runs all offline tests, the source scan and synthetic import-to-plan checks. Tests never prove live delivery; the verified November 8 receipt supplies that evidence. Do not run the full suite during every ordinary daily occurrence unless code changed.

Back up code and private state separately. Keep ledger attempts, receipts, readbacks, published URLs, coverage and actual evidence. Code rollback must never rewind state. The pre-migration wrapper/config/runbook and manifest are in `setup/pre-mac-cutover-20261108`.
