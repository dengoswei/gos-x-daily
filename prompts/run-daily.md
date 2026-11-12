# Mac X Daily controller task

This is the versioned production procedure. The scheduler supplies the existing
private deployment entry point and the user's standing authorization. This file
does not create a schedule or grant new access. Use Asia/Shanghai throughout.

## Start and delegate

Source the user's shell configuration before Node or Lark CLI. Use only the
provisioned `DEPLOYMENT_HOME/run.mjs` entry point. Read
`deployment/mac/RUNBOOK.md`, `EDITORIAL.md`, `prompts/v2-compose-digest.md`,
`BROWSER-ARTIFACTS.md` and `docs/AGENT-WORKFLOW.md` from the verified checkout.
Use the revision returned by `workflow` as `GOS_X_DAILY_EXPECT_REVISION` on
every controller command in the run. If the active revision changes, restart
from `workflow` and check the delivery ledger before proceeding.
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
The effective roster merges release-owned public feeds/blogs with local private
profiles and named overrides. Fetch every enabled feed using the release tool
`tools/fetch-feeds.mjs` and the frozen sources. Record individual failures.
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
`cli import-feed --preserve-full-text --allow-window-skew` for the configured feeds, using the returned run's `runtime.json` so
coverage advances in the persistent local state. The daily command supplies the
authoritative local publication history to the shared pipeline. Read source-worker
handoffs and exceptional findings in the main context. Consider every observed
candidate and relevant supplemental lead. Context batches are not article quotas.
Keep failed reads and unverified 24h/48h intervals explicit.

Assign story workers to read the original article/paper/repository and meaningful
figures. They return source-backed evidence, candidate leads and unresolved
questions. Deduplicate across sources and published URLs; a repeat
is eligible as 跟进 only with a specific new fact. Keep publication dates of old
work. Do not import preview history as publication history, discard uncertain
attempts, invoke a retired workspace workflow or change sending identity.

## Run the repository pipeline

After importing browser and feed bundles into RUN/sources.merged.json, save public
supplemental originals as RUN/supplements.public.json. Each array entry has title,
url, text, publishedAt, sourceLabel and reading limits. Private mail bodies remain
local discovery evidence. Use their public originals as supplements. The model
projection also excludes logged-in Xiaohongshu and subscription-page bodies.
Their public original papers/articles can enter as verified public supplements.
Do not place private snippets in the public-supplement file. Legacy backlog
bodies without recorded public provenance stay local until publicly reverified.

Run `local daily --run RUN` through the provisioned wrapper. It directly calls
`runDailyV2` in `run-daily.mjs` with the frozen sources and authoritative
published-URL history. That one pipeline owns raw/card/topic storage, prior scores,
backlog recall, topic selection, original-text enrichment, composition, automatic
dispositions and telemetry. Quick Hits comes first. Inspect returned status and
artifact paths without rewriting or selecting stories in the coordinator.

The Mac adapter preserves the composer's actual transcript and reviews the exact
output, including telemetry, coverage, revision notice and native Feishu payload.
It has no separate final writer. A material finding returns to the same repository
composer for one correction. Publication requires a genuine fresh reader check
and the original author's self-check against the preserved evidence. Tests and
structural checks do not substitute for those checks.

The retired `local draft` and `local finalize` commands are unavailable.
An interrupted `local daily` keeps its evidence and attempts. Check the run and
ledger before resuming. A completed daily result returns its existing publication.
Do not independently invoke the legacy prototype orchestration.

## Publish once and finish

Immediately after successful author self-check, use
`local publish --publication PUBLICATION` using the publication path returned by `local daily`. Only this controller checks
sole Mac ownership, current recipient history, exact reviewed payload, target,
canonical date key and durable attempt, sends once and verifies readback. API
acceptance with pending readback requires reconciliation only. An uncertain
attempt requires evidence-based reconciliation: never reset the ledger, invent a
new key, change bot or retry blindly.

Return the Feishu message link/ID and a concise outcome, or a precise operational
failure. Update the automation's private memory with actual run path, coverage
limits and receipt. Do not write to Obsidian/Space, sync Notion, change schedules
or send test messages. Offline tests belong to code maintenance, not daily runs.

On an unresolved operational failure, before returning, run
`local alert --date YYYY-MM-DD --stage collection|draft|finalize|publish`
with the current Shanghai date and the applicable stage, through the same
provisioned wrapper in host context. The command sends a fixed incident notice
to the configured private Feishu chat once per day, under its own ledger key.
Report the alert receipt or the alert failure alongside the original error.
If the digest was accepted, reconcile it without sending it again.
