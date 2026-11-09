# X Daily on this Mac

## Production contract

The user confirmed on November 8, 2026 that the Dot Gos Remote Compute schedule is stopped and that this Mac is the sole sender. `mac-authority.json` preserves that statement. The active standalone Codex task is `X Daily Digest 9AM`, daily at 09:00 Asia/Shanghai. Each occurrence has standing authorization to collect, write, self-check and send the finished report to the provisioned Feishu private chat. No human review, fresh login or remote reservation is part of an ordinary run.

Use `$DEPLOYMENT_HOME/run.mjs` as the entry point. Source `$HOME/.zshrc` before Node or Lark CLI. The agent performs supported browser/connector collection and composition. The wrapper performs verification, offline imports, review binding, and production delivery. Direct CDP collection stays disabled. Never invoke the old `reading/automations/x-daily` workflow.

The authoritative production ledger is `$HOME/.codex/automations/x-daily-digest-9am/local-delivery-ledger`. It retains the `gos-daily` namespace and `xdaily-gos-daily-YYYY-MM-DD` keys. Its forward boundary is November 8. Imported published URLs through November 6 retain their provenance. The November 7 uncertain attempt remains archived and is never retried. Preview history is not publication history. Remote execution may resume only after an explicit future ownership transfer with reconciled state.

`DEPLOYMENT_HOME` is the private installation directory (default `$HOME/Documents/GosXDaily`). The tracked implementation is `deployment/mac/` in this repository. The only installed executable entry point is `$DEPLOYMENT_HOME/run.mjs`, a small hash-checked bootstrap pointing to that checkout. `source-repo.local.json` records the absolute source checkout locally. Credentials, source roster, evidence and delivery state never belong in Git.

## Start an occurrence

```sh
source $HOME/.zshrc
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

Write `digest.md`, `canonical-materials.json`, `collection-coverage.md` and one disposition per imported candidate key. Explain the problem, mechanism and supported result in plain Chinese. Keep old publication dates, author claims and material limitations visible. Select substantive supported stories without an item quota. Review all observed candidates and relevant mail/Substack leads. Use recently published URLs for deduplication and identify a real new fact in any follow-up.

The reader-facing message contains the articles and a short coverage paragraph. Detailed page counts, failed reads, cumulative coverage and candidate dispositions belong in the audit. Imported `included` keys are not the final article count because supplemental articles may be outside that set. Previous reports are historical evidence only, not a style or semantic approval baseline. Use the editorial and worker contracts in this checkout.

## Self-check and bind

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

If API acceptance was recorded but readback or URL history failed, run only:

```sh
node $DEPLOYMENT_HOME/run.mjs local reconcile --date YYYY-MM-DD
```

An uncertain attempt is a real delivery incident. Keep its record, inspect recipient history and reconcile evidence; never reset the ledger, alter the key or switch bots to retry. An accepted report is returned by `local status --date YYYY-MM-DD` and subsequent `publish` invocations without another send.

## Dependencies and maintenance

Node 22+ is the source requirement. This installed release pins Node 26.8.1 and Lark CLI 1.0.36 to their actual executable hashes. The core has no npm dependencies. Existing macOS Keychain credentials and the fixed profile supply bot authentication. Production requires the Mac awake, Codex running with the scheduled task available, the authorized browser session usable and network access. Optional-source access can fail with disclosure; failure of the required Following session needs an operational error.

The local controller, sender and private identity configuration have their own release manifest. Repository changes have a separate manifest and Git branch. Review changes before deliberately promoting new hashes. `node run.mjs test` runs all offline tests, the source scan and synthetic import-to-plan checks. Tests never prove live delivery; the verified November 8 receipt supplies that evidence. Do not run the full suite during every ordinary daily occurrence unless code changed.

Back up code and private state separately. Keep ledger attempts, receipts, readbacks, published URLs, coverage and actual evidence. Code rollback must never rewind state. The pre-migration wrapper/config/runbook and manifest are in `setup/pre-mac-cutover-20261108`.
