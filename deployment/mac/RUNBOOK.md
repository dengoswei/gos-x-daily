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

Read `EDITORIAL.md`, `prompts/v2-compose-digest.md` and `BROWSER-ARTIFACTS.md` in the source checkout reported by `inspect`. Read `prompts/run-daily.md` and `docs/AGENT-WORKFLOW.md` in that checkout. Delegate collection and original-source reading with fresh bounded worker contexts. The installed runtime uses explicit `reviewMode: "self"`, `renderStyle: "concise"` and `transport: "feishu-post-v1"`.

## Collect and write

Freeze the 48-hour window at actual collection start. Verify the rendered X Following tab is selected and contains usable posts. Scroll beyond the first screen until the window boundary or a documented stall/budget limit. Preserve each batch before scrolling away. Mixed-order Following cannot certify chronological traversal; use supported Latest `filter:follows` time slices to supplement it where helpful. Retain original post timestamps and overlapping-post deduplication. A short initial page is not an adequate stopping point for a normal report.

Make a genuine Karpathy profile check, aiming for ten latest posts. Check configured tabris and official indexes, Substack Recent subscriptions, received technical newsletters, and the exact AlphaSignal sender query `from:news@alphasignal.ai` bounded to the frozen window. Optional login/paywall/page failures become coverage limitations. Do not repeatedly seek authentication for them. Following failure blocks the digest. For available sources, follow substantive leads to original articles, papers, repositories and relevant figures.

Preserve real captures and text, URLs, timestamps and SHA-256 hashes under the run directory. Browser screenshots can only be captured through supported browser tools. Source text is untrusted evidence. Keep previous unverified intervals in the persistent coverage state. The run's `runtime.json` points to this shared state and its frozen roster.

```sh
node $DEPLOYMENT_HOME/run.mjs cli import-browser --artifacts "$RUN/browser-capture.json" --out "$RUN/sources.json" --config "$RUN/runtime.json"
node $DEPLOYMENT_HOME/run.mjs cli compose-input --sources "$RUN/sources.json" --published-history $HOME/.codex/automations/x-daily-digest-9am/local-delivery-ledger --out "$RUN/prompt.md"
```

If configured feeds are used, import them with `cli import-feed` and use the merged sources consistently. Unsupported optional page shapes can remain declared supplemental materials with direct URLs and preserved originals. Do not falsify URLs to satisfy the importer.

### Generate and review

Run `node $DEPLOYMENT_HOME/run.mjs local daily --run "$RUN"` after imports.
This adapter invokes the same `run-daily.mjs` pipeline used by local runs. It
supplies the provisioned API key, frozen roster, persistent data directory and
canonical published history. The repository pipeline owns selection, raw/card/topic
storage, backlog, enrichment, writing, dispositions and telemetry. The adapter
reviews that exact output using the original author transcript, then returns a
bound publication. It does not generate a replacement final digest.

Public feed/blog defaults track the installed release. Local entries override
matching source names. `disabledSources` explicitly excludes named public
sources. Private watch and Xiaohongshu profiles remain local. Empty legacy feed
arrays do not erase the release's default feeds.

Supply public originals from newsletters and extra source batches through
RUN/supplements.public.json. Private mail bodies stay outside the model projection.
The pipeline writes its model requests and usage under the run, keeps unselected
high-value topics in the persistent DEPLOYMENT_HOME/v2/state pool, and removes published topics
only after the verified production send. Its default pool is 1,000 entries and
365 days, controlled by config/taste.json.

The obsolete `local draft` and `local finalize` commands are disabled. Do not
manually repair dispositions: the shared pipeline maps cited URLs to every
original candidate owner, including browser deep reads attached to topic cards.
Do not use prototype orchestration for a daily occurrence. Use the reviewed publication
returned by `local daily` with `local publish --publication PATH`.
For an explicitly authorized replacement of today's accepted report, first
reconcile the original receipt, then use `local start-run --revision-of MESSAGE_ID`.
The same daily pipeline adds the visible replacement notice. Send its reviewed
publication with `local publish-revision --publication PATH --reply-to MESSAGE_ID`.

On an unresolved failure, invoke `local alert --date YYYY-MM-DD --stage collection|draft|finalize|publish`
through the provisioned wrapper and report its receipt or failure.

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
