# Mac X Daily controller task

This is the versioned production procedure. The scheduler supplies the existing
private deployment entry point and the user's standing authorization. This file
does not create a schedule or grant new access. Use Asia/Shanghai throughout.

## Start and delegate

Source the user's shell configuration before Node or Lark CLI. Use only the
provisioned `DEPLOYMENT_HOME/run.mjs` entry point. Read
`deployment/mac/RUNBOOK.md`, `EDITORIAL.md`, `prompts/compose-digest.md`,
`BROWSER-ARTIFACTS.md` and `docs/AGENT-WORKFLOW.md` from the verified checkout.
Run `inspect`, `local doctor`, and `local start-run`. If today's receipt exists,
run `local reconcile --date YYYY-MM-DD` and return it without collection or send.
Bot operations require host network and macOS Keychain access. If sandbox access
fails, retry the same scoped wrapper command in host context under the standing
authorization. Do not log a ready bot in again because of a sandbox denial or an
expired user-token timestamp.

Use real subagents with fresh contexts for independent source groups and story
processing. Pass worker prompts, relevant paths, frozen scope and explicit user
constraints, not the entire parent chat. Parallelize independent connector reads
and owned browser tabs; serialize any shared tab/app surface. If a tool is not
available in a worker, retain one capture owner and parallelize offline work.
Workers save complete evidence/results to disk and return compact handoffs only.
Checkpoint each bounded batch. Do not accumulate raw captures, whole articles or
large review records in the coordinator context.

## Collect and process

Freeze the actual source roster and rolling 48-hour window at collection start.
Use supported authorized browser/connector access and current provisioned
sessions. No direct CDP, profile/cookie copying or routine authentication prompts.
Require selected usable X Following, scroll beyond the first screen through the
target period or a documented stall/budget limit, and supplement mixed order with
bounded Latest filter:follows time slices when useful. Make a genuine Karpathy
latest-post check. Check configured tabris, received technical newsletters
including the exact `from:news@alphasignal.ai` query, Substack Recent subscriptions
and official sources. Empty/unavailable Following blocks publication. Optional
failures are explicit limitations, not evidence of no new material.

Workers preserve actual captures, URLs, original publication/observation times,
read depth and hashes. The coordinator imports with `cli import-browser` and
`cli import-feed` when applicable, using the returned run's `runtime.json` so
coverage advances in the persistent local state. Use the existing authoritative
local delivery ledger as `--published-history` for `cli compose-input` and
`cli worker-input`. Save the full composition input to disk; read only the worker
coordinator manifest/indexes in the main context. Consider every observed
candidate and relevant supplemental lead. Context batches are not article quotas.
Keep failed reads and unverified 24h/48h intervals explicit.

Assign story workers to read the original article/paper/repository and meaningful
figures. They return source-backed evidence, candidate leads and unresolved
questions. Deduplicate across sources and published URLs; a repeat
is eligible as 跟进 only with a specific new fact. Keep publication dates of old
work. Do not import preview history as publication history, discard uncertain
attempts, invoke a retired workspace workflow or change sending identity.

## Write and review with the configured API key

If `inspect` reports a configured `model.apiDraft`, write worker packets to
`RUN/packets` and run `local draft --run RUN` through the provisioned wrapper.
It uses the configured screening model and GPT-6.1 Sol for story drafts and
composition, all with high reasoning. A provider failure is a run failure unless the unchanged partial
output can be completed with `--resume`. A structurally rejected draft requires
diagnosis before a new attempt. Use the draft as leads for original-source checks.
Prepare `canonical-materials.json`, `collection-coverage.md` and the explicit
`api-final-input.json` projection described in the Mac runbook. Include enough
verbatim public source text to verify dates, mechanisms, results, comparisons and
limitations. Keep private Gmail bodies, screenshots, credentials and identifiers
out of that projection. Corroborate private leads with public originals or record
the limitation and omit unsupported items.

Run `local finalize --run RUN`. Sol High writes the terminal digest and
dispositions, then a fresh reader first reconstructs the prose without evidence
and checks it against evidence in a second call. The actual API author reviews
every unit, audit, render and native payload by continuing its author transcript
with `sourceBlind: false`. Only use the returned `publication` path after both
passes succeed. Do not edit the generated report or synthesize an approval.
Unresolved API or evidence failures block this route; report them rather than
quietly replacing the writer or reviewer. Record usage from both stage logs.

If no API key file is configured, use the host author workflow below.

## Host author workflow without a configured API key

Produce a substantive Chinese report without an arbitrary story or sentence
quota. Every item has one clear main idea; explain the concrete problem,
mechanism and supported conclusion with the connective reasoning a reader needs.
Use a useful example when a mechanism would otherwise remain opaque. Distinguish
author claims, observations and limitations. Keep comparisons fair without burying
the explanation under numbers and caveats. Use compact native post rows, bold
idea-led titles and source links together at the end. Separate a short reader
collection note from the detailed audit. Candidate inclusion counts are not final
article counts.

Use a fresh reader worker for selected stories or batches to detect missing
reasoning. Give final prose first, persist its reconstruction, then supply sources
for fidelity checking. Record actual identity and source exposure; advisory
reports do not replace the author's required self-check or create independence
by changing names. Resolve findings before final review.

Create `publication.json` with `reviewMode: "self"`, `renderStyle: "concise"`,
`transport: "feishu-post-v1"`, actual author identity and the existing ledger.
Generate `review.pending.json` via `cli review-input`. The actual final author
checks every item, original evidence, dates, limits, audit, final Markdown and
exact serialized native post. Inspect text/link row grouping as well as text
completeness: a matching text hash alone does not certify layout. Record real
check times, substantive reconstruction and fidelity findings with source paths.
Use the same author/reviewer identity and `sourceBlind: false`; never fabricate
independence or run synthetic approval helpers. Rebuild bindings after changed
bytes and recheck affected units. Run `cli validate-publication`.

## Publish once and finish

Immediately after successful author self-check, use
`local publish --publication PUBLICATION` using the path from finalization (or
the host-authored `RUN/publication.json` when no API key is configured). Only this controller checks
sole Mac ownership, current recipient history, exact reviewed payload, target,
canonical date key and durable attempt, sends once and verifies readback. API
acceptance with pending readback requires reconciliation only. An uncertain
attempt requires evidence-based reconciliation: never reset the ledger, invent a
new key, change bot or retry blindly.

Return the Feishu message link/ID and a concise outcome, or a precise operational
failure. Update the automation's private memory with actual run path, coverage
limits and receipt. Do not write to Obsidian/Space, sync Notion, change schedules
or send test messages. Offline tests belong to code maintenance, not daily runs.
