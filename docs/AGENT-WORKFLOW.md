# Bounded-context X Daily workflow

## Current Mac production contract

The user-authorized production path is `local deliver --run RUN`. It uses the
shared v2 screen, compose and single-pass review stages, then binds and sends the
result with the existing ledger and readback. `prompts/v2-review-digest.md` owns
editorial review. The former four-call `openai-final.mjs` path is retired from
production; historical independent/self-review descriptions below apply only to
legacy records and portable callers. The coordinating agent collects/imports
inputs and waits for delivery, without adding semantic review or routine approval.
Model roles can be provisioned in `deployment.local.json` via `model.modelsFile`,
using the repository provider schema with required screen/compose/review roles.



Read [the production task prompt](../prompts/run-daily.md) and the deployment
runbook first. The host agent supplies subagents and authorized browser/connector tools. The CLI
does not start models or grant access. Use the deployment's established wrapper,
runtime, identity and delivery ledger. Current Mac production retains author
self-review; an optional reader worker is additional feedback, not a substitute
identity or automatic approval.

## Ownership and handoffs

The coordinator owns the run, frozen source roster/time window, task assignments,
cross-source deduplication, final digest, coverage audit, publication/review files
and delivery. Workers own separate assigned run subdirectories. Workers never
write shared coverage state, publication files, receipts or delivery history and
never send messages, authenticate, change schedules or change sending identity.
Only the coordinator invokes imports with the run runtime and the sole sender.

Start workers with fresh context (`fork_turns: none` where supported). Give them
the applicable worker prompt, frozen task metadata and relevant file paths;
do not copy the entire chat or run history. Explicitly include user constraints
and the authorized tools/sources they need: fresh context does not inherit them.

Use the available concurrency limit. Parallelize independent connectors or
separate owned tabs. One worker at a time owns a shared browser tab/app surface;
record its owner and release it before handoff. If the browser tool cannot be
used independently by workers, appoint one capture worker and parallelize
offline reading, selection and writing. Never open a direct CDP route, copy a
profile or bypass an unavailable provisioned session for concurrency.

## 1. Collect source batches

Assign meaningful source groups (for example X Following/watch accounts, received
newsletters, Substack, official indexes), not one agent per post. Give each worker
a deadline and stopping checkpoint. The X assignment must verify selected usable
Following, traverse beyond the first screen, preserve mixed-order limitations,
and perform the configured latest-post checks. Optional failures remain in the
source roster; required Following failure blocks the report.

Use `prompts/workers/collect-source.md`. Save actual captures and hashes before
navigating away. Worker results include all observed candidates and their reading
status, source timestamps, coverage bounds, failures and remaining work. The
coordinator receives only the summary/index path and exceptional findings. It
merges capture records without rewriting original observations or adding
overlapping counts, then runs `import-browser` / `import-feed` as applicable.

## 2. Partition evidence without dropping candidates

Run `compose-input` with the authoritative published-history ledger and save its
full output to `RUN/prompt.md`. Do not print or read that file wholesale in the
coordinator. Generate bounded worker packets using the wrapper's offline CLI:

```sh
node WRAPPER cli worker-input --sources RUN/sources.json \
  --published-history LEDGER --out RUN/worker-input
```

Replace placeholders with the actual deployment paths; this is not a second
production entry point. Read `RUN/worker-input/coordinator.json`. Its `indexPages`
and `sourcePackets` descriptors contain relative paths, SHA-256 and byte lengths;
`context`, `history`, `supplementalIndex` and `inventory` point to the remaining
manifest files. Index pages contain no article bodies; titles over 180 characters
are marked `titleTruncated`. The default 24-key page is a context batch size, not
an item quota. Visit every page and supplemental lead.

Assign every key exactly once for initial screening. Source-screening packets
list each key's candidate packet and story packet; candidate packets preserve
all observations, story packets carry relevant materials and shared-link leads.
Use these paths for complete text and alternate observations, and retain source
file hash bindings. A packet is a routing aid, not new original evidence or
semantic proof. The CLI writes these files; the host coordinator actually spawns
and assigns the workers.

Screening may identify cross-source duplicates or supplemental original articles.
The coordinator owns final merges by published/canonical URLs. Send each selected
story's relevant source packets and original evidence paths to its article worker.
An assigned key may be skipped only with a recorded reason; no tail truncation,
top-N cutoff or exhausted context can silently remove the rest. Finish a bounded
batch, persist it, and reassign the remaining batch with a fresh worker.

## 3. Read and write by story

Use `prompts/workers/write-story.md`. A story worker reads original articles,
papers/repos and relevant figures before supporting substantive claims. It owns
one story or a small coherent batch, not the whole digest. Save under its assigned
directory:

- `story.md`: final Chinese prose and direct source links.
- `materials.json`: source URLs/dates, evidence paths/hashes, what was read, claim
  support and material limitations, plus the specific new fact for a follow-up.
- `dispositions.json`: included/merged/skipped recommendations for assigned keys.
- `handoff.json`: status, core idea, output paths, unresolved issues and read gaps.

These are intermediate worker files; the coordinator normalizes them into the
existing canonical materials and disposition contracts. No worker can mark a
source fully read merely because another worker summarized it. Keep uncertain
claims out of the final story until resolved. Do not make worker packet fields
or review checklists visible as headings in every reader-facing item.

## 4. Assemble and review

In Mac production, workers preserve public originals as supplemental evidence.
The coordinator invokes `local daily`, which calls `run-daily.mjs` for selection,
enrichment, composition and telemetry. The Mac adapter constructs the review
projection from the selected original material and reviews the exact output with
the composer's recorded transcript. Findings return to the same composer for a
correction. The coordinator does not write a second final report. The command
returns a reviewed publication for the sole sender. The host-authored procedure
below is for explicitly configured non-Mac deployments.

The coordinator reads all selected `story.md` files, compact findings and the
candidate/disposition indexes. It loads original evidence selectively for issues
and for its required final author fidelity check, one review unit at a time.
Do not concatenate all captured pages, article bodies and review JSON into the
main chat. Persist review findings immediately and return only path/status/error
summaries from shell commands.

Optional reader workers use `prompts/workers/review-story.md` in fresh contexts.
Stage A supplies final prose only. They persist their reconstruction and missing
links before Stage B supplies evidence paths. Report actual worker identity,
assignment, timestamps and source exposure honestly. If a worker already knows
the evidence, it cannot claim source blindness. Its findings can inform the
author's self-review but must not be copied as the author's own reconstruction.

For Mac `reviewMode: self`, the actual final author still checks every pending
unit, audit and exact final payload, with the same author/reviewer identity and
`sourceBlind: false`. Independent production mode requires its separately
configured real assignment and evidence; a fresh name is insufficient. Workers
never call synthetic approval helpers. Resolve every material finding, regenerate
pending bindings after changed bytes, and repeat affected checks.

Review layout independently of evidence completeness: links must stay together,
separators must not become standalone blocks, and item/section spacing must be
compact. During maintenance inspect offline preview fixtures and disclose the
limits of that preview. In production do not send a test message. Validate final
publication, then let the one existing controller publish/reconcile under its
unchanged idempotency and uncertain-attempt rules.

## Handoff size and recovery

Worker tool calls save full records to disk and print only compact metadata.
Return roughly one short paragraph plus file paths, key counts, blockers and
needed decisions; a long evidence dump defeats delegation. This is a handoff
budget, never a limit on source coverage, article depth or report length.

On timeout or context pressure, checkpoint completed keys, unfinished keys,
evidence paths and last observed timestamp. The coordinator either resumes that
bounded batch or assigns it to a fresh worker. Never rerun a successful send,
discard an uncertain attempt, or silently turn unfinished reads into exclusions.

## Example: explain the mechanism before the benchmark

The following is an editorial illustration derived from the DSpine paper and
Tencent model card, not a new daily item or an independent reproduction. Its
older publication date and current-release distinction must still be verified
against a real run before reuse. A factual example is not a fixed length template.

> **DSpine：让并行草稿中的后一个 token，更早知道前一个位置在预测什么。** 投机解码先由小模型提出多个候选 token，再由大模型一次验证。并行起草虽然省去了逐个生成的等待，却容易让不同位置提出互不相容的续写；验证按前缀进行，前面一处没通过，后面的候选也就用不上。DSpine 把这种依赖传递放进草稿网络内部：每一层把前一个位置的预测特征注入相邻的后一个位置，让后者在后续层中据此调整。各位置仍在同一层并行更新，信息沿网络深度逐步传播，不需要等前一个位置生成最终 token。腾讯此次公开了配套 Qwen3.8-27B 的草稿权重；模型卡在 WorkBuddy Code 低推理强度回放、并发 8 的配置下，报告总吞吐约为 686 token/s，DFlash2 配置约为 590 token/s。这是两套完整配置的比较：草稿块长分别为 16 和 8，不能把差值全部归因于这一机制。方法论文已于 9 月 28 日首发。 [模型卡](https://huggingface.co/tencent/Qwen3.8-27B-DSpine-b16) · [方法论文](https://arxiv.org/html/2609.36173)

The example spends its extra sentences on the missing dependency/parallelism
connection. It keeps one useful result and its confounder rather than listing
every runtime setting. Local private captures remain outside Git.
