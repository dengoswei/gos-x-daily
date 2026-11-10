# Orchestrator prototype (not production)

A provider-agnostic driver for pipeline stages 5–7 — **screen → story → compose** —
over a run that has already been captured and imported, plus an **optional advisory
review** (stage 8) and an offline **eval harness**. It is the first two phases of
`docs/REDESIGN-AGENT-SDK.md`: enough to compare cost and output quality against a
host-agent session following `prompts/run-daily.md`, and nothing more.

Nothing here is wired into the Mac deployment, `cli.mjs`, an npm script or any
delivery path. Its output is a **draft, advisory feedback and measurements**, never
an approval.

## Scope

In scope:

- read the `worker-input` packets of an existing run, verifying every packet's
  SHA-256 and size on each read;
- one screening call per source packet, over a compact candidate view;
- one story call per duplicate-topic group, over the group's full candidate packets
  plus its referenced deep-material and thread packets;
- one compose call over the run's own `prompt.md`, the screening decisions and the
  drafted items, validated with the repository's `validateDigest` and candidate
  ledger gates;
- when a `review` role is configured, two advisory calls per review unit of the
  validated draft (see below);
- a separate `prototype/eval.mjs` measurement pass with a `judge` role.

Out of scope, by design:

- **No capture.** Stages 1–4 stay with the browser controller and `cli.mjs`.
- **No approval, no delivery, no ledger.** The stage 8–9 gates are untouched; the
  advisory review below cannot approve a digest, and nothing here can send.
- **No tool loop.** Every stage is a single-shot call with its packets inlined, so
  no agent fetches a URL, reads outside its packets or runs a command. A story
  agent with a fetch tool is a P2 question.
- **No persistent state.** Coverage import, cross-run history and the delivery
  ledger remain the parent's.

Each stage output must satisfy its contract before the run continues: exact
decision coverage per batch, a story that is exactly one bullet (no blank line,
second bullet or heading), `citedUrls` that occur as **whole** URLs in the supplied
packets (a prefix such as `…/status/12` of `…/status/123` does not count), and a
candidate ledger covering exactly the collection's candidate keys. One retry per
stage on a parse failure and one compose repair round on a validator failure; after
that the run is rejected, writing `digest.rejected.md` instead of `digest.md` and
exiting non-zero.

## Parallelism, retries, resume and budget

- **Bounded pool.** Screening batches, story groups, review units and eval judge
  items are independent and run with at most the role's `concurrency` calls in flight
  (default 4; 1 for an `exec` role unless configured). Results, files and report
  arrays are indexed by input order, never completion order, so a parallel run writes
  the same artifacts as a sequential one. Within a review unit Stage A is still
  persisted before Stage B is built. If one item fails, no new item starts, in-flight
  siblings finish and persist, and the run fails naming every failed and unstarted item.
- **Transient retries** (HTTP providers only): network errors and HTTP 408/409/429/5xx
  are retried up to `retry.maxAttempts` (default 3) total attempts, waiting
  `retry-after` when the provider sends one (refused when it exceeds
  `retry.maxRetryAfterMs`, default 120 s) and otherwise capped exponential backoff with
  jitter (`retry.baseDelayMs` 1000, `retry.maxDelayMs` 30000). Any other 4xx fails at
  once. A client timeout (600 s) is not retried, since the request may have been
  processed and billed. The ledger counts these as `transientRetries`.
- **Truncation** (`finish_reason: "length"`, `stop_reason: "max_tokens"`) is its own
  error naming the role and its `maxTokens`; the raw reply is persisted and its usage
  recorded. It is never retried at the same limit: with `maxTokensRetry` set (larger
  than `maxTokens`) the call is repeated once at that limit, otherwise the stage fails.
- **Resume.** Every accepted stage response is checkpointed in
  `OUT/checkpoints/<label>.json`, bound to the SHA-256 of that call's exact prompt
  (system and user parts: contract, packets, prior-stage outputs) and of the role's
  fingerprint (kind, model, base URL or exec argv). `--resume` reuses an unfinished
  `OUT` (no `report.json` yet): a checkpoint whose bindings match is re-parsed against
  the current contract and reused without a call; a call without one runs. A
  checkpoint whose prompt or role changed is **not reused and never overwritten**: the
  run fails and you start a new `--out`. Limits (`maxTokens`, `concurrency`, `retry`,
  `budget`) are not part of the binding, so raising one after a failure keeps the
  completed work. Without `--resume`, `--out` must be new, exactly as before; files
  stay write-once (`wx`), and an existing view file (`screen/`, `stories/`, `digest.md`
  …) is only accepted when byte-identical. A reused Stage A record keeps its original
  `persistedAt`.
- **Budget.** An optional top-level `budget` in the models file —
  `{"maxCalls": 60, "maxInputTokens": 2000000, "maxOutputTokens": 200000}` — stops
  launching calls once a cap is reached and fails with the counts; everything already
  done is persisted for `--resume` (raise the cap first). What it can see: `maxCalls`
  counts every provider call this process launches (contract and truncation retries
  included, transient HTTP retries not; reused checkpoints are free). Token caps count
  only tokens a provider **reported**; a call without counters (a plain `exec` role)
  is listed as `unmeteredCalls`, never as zero, so a token cap does not bound an
  unmetered role — use `maxCalls` there. Calls already in flight when a token cap is
  crossed still complete, so the overshoot is up to `concurrency` calls. Orchestrator
  and eval each apply the budget to their own process.

## Usage

```sh
# A fictional, clearly synthetic run to exercise the stages offline.
node prototype/make-synthetic-run.mjs --out /path/to/new/run

# Or point --run at a real run directory holding sources.json, prompt.md and packets/
# (node cli.mjs import-browser / compose-input / worker-input produce exactly these).
node prototype/orchestrate.mjs --run /path/to/run --models prototype/models.local.json --out /path/to/new/out

# After a failure (provider error, budget, truncation): continue the same OUT,
# reusing every completed stage whose prompt and role are unchanged.
node prototype/orchestrate.mjs --run /path/to/run --models prototype/models.local.json --out /path/to/new/out --resume

# Optional, after a passed run: development-time measurement into OUT/eval.json.
node prototype/eval.mjs --run /path/to/run --out /path/to/new/out --models prototype/models.local.json
```

The orchestrator's `--out` must not exist unless `--resume` continues an unfinished
one (the eval harness's `--out` is that same finished directory; it also accepts
`--resume` after a partial eval); every artifact is written with the `wx` flag.
Standard output is the compact report JSON only — keys, counts, sections, cited URLs
and usage, never source or response text. Artifacts land in:

```
OUT/manifest.json  the collection this OUT belongs to (checked on --resume)
OUT/raw/        every raw model response, including retries and the repair round
OUT/checkpoints/ one record per accepted stage call (prompt/role hashes, raw file)
OUT/screen/     one decision file per source packet
OUT/stories/    one bullet (.md) and its metadata (.json) per group
OUT/digest.md   the validated draft  (digest.rejected.md when validation failed)
OUT/dispositions.json
OUT/review/     unit-NNN.a.json / unit-NNN.b.json, only with a `review` role
OUT/report.json
OUT/eval.json   only after prototype/eval.mjs
```

## Advisory review stage (optional)

Configure a `review` role and the orchestrator adds stage 8 **after** the draft
passes validation — a rejected draft is never reviewed. It is **advisory feedback
only**: `status` and `notApproval` are unchanged by it, `report.advisoryReview.note`
says so in the artifact, and the deployment's required review under `EDITORIAL.md`
is untouched and unsatisfied by anything here.

The draft is cut deterministically into **review units**: one per top-level main-body
bullet block, plus one final `audit` unit holding the `本次采集范围` block and the
whole `## 差异补充` section. Both stages see the same cut, and so does the eval
harness. Each unit is reviewed in the order `EDITORIAL.md` requires:

- **Stage A (blind comprehension)** gets the unit prose and nothing else — no
  packet, no collection record. It records `problem` / `mechanism` / `conclusion` /
  `innovationType` reconstructable from the prose alone, what is *not*
  reconstructable (`missingLinks`, `confusions`) and `verdictA`. Its record is
  persisted to `OUT/review/unit-NNN.a.json` with `sourceBlind: true` and a
  `persistedAt` timestamp **before** the Stage B prompt is built.
- **Stage B (source fidelity)** gets those persisted bytes back, unchanged, plus
  the unit's own evidence: the candidate packets of the included dispositions rows
  whose URL the unit cites, with their deep-material and thread packets (every read
  SHA-256- and size-checked). URLs are extracted the way the digest URL gate extracts
  them and compared **canonically** (`canonicalUrl` from `binding.mjs`), so
  `…/status/123` matches a `…/status/123/` row and `…/post-2` never pulls `…/post`.
  The audit unit gets the collection context packet and
  the coverage/warnings accounting instead of candidate bodies. It returns `findings`
  (`material` / `minor`, each quoting the fragment at fault) and `verdictB`.
- **No evidence resolved.** An item unit whose cited URLs match no included row is
  never sent to Stage B as if evidence were present: no call is made, `unit-NNN.b.json`
  records `modelCall: false`, `evidence.resolved: false` and one deterministic
  `material` finding of kind `evidence-unresolved`, the report gets a warning and
  `advisoryReview.evidenceUnresolved` counts it. The eval harness records such an item
  with `scores: null`, `evidenceResolved: false` and a warning instead of scoring it.

`report.advisoryReview` carries counts only — units, verdict and finding tallies,
and the unit file paths. Both calls bill to one usage stage, `review`; raw responses
land under `OUT/raw/` as `review-a-unit-NNN.txt` and `review-b-unit-NNN.txt`.

## Eval harness

```sh
node prototype/eval.mjs --run /path/to/run --out /path/to/existing/out --models prototype/models.local.json
```

Development-time **measurement**, not review: no gate reads `eval.json`, it resolves
no finding and it grants nothing. It needs a `judge` role, and an `OUT` whose
`report.json` records a passed composition. `OUT/eval.json` is written with `wx`, so
a second invocation refuses — before any model call, so the refusal is free.

- `deterministic` — copied from `report.json` and the draft with no model involved:
  candidate/included/merged/skipped counts and skip reasons, groups, stories,
  repair state, warning count, advisory-review counts, main bullets and the
  per-stage usage totals.
- `items` — one judge call per item unit, scoring `reconstructability`, `fidelity`
  and `disclosure` 1–5 against that unit's evidence packets.
- `digest` — one call over the draft and the deterministic summary, no packets,
  scoring `ordering`, `structure` and `coverageDisclosure` 1–5.

The rubric in `prototype/prompts/judge.md` anchors each 1 / 3 / 5 to `EDITORIAL.md`.
Scores are integers, validated; a non-integer or out-of-range score fails the stage.

## Capture stage

Capture is **not** in this prototype and will not be. A capture agent is
environment-bound: it needs a browser-equipped authorized host (the Mac controller,
or a computer-use session with a real browser surface), which an orchestrator
process on an arbitrary machine does not have. This repository's capture contract
stays `BROWSER-ARTIFACTS.md` plus `prompts/workers/collect-source.md`, and the
orchestrator only ever consumes the resulting `browser-capture.json` after
`cli.mjs import-browser`. No capture code ships here.

## Models configuration

`prototype/models.example.json` maps roles to providers. Copy it to
`prototype/models.local.json` (gitignored) and edit. `screen`, `story` and `compose`
are required; `review` is optional (absent ⇒ no review stage, exactly as before) and
`judge` is read only by `prototype/eval.mjs`. Only environment-variable **names**
belong in the file; a key value never does.

```json
{"roles": {"screen": {
  "kind": "openai", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat",
  "apiKeyEnv": "DEEPSEEK_API_KEY", "maxTokens": 4096 }}}
```

- `openai` — `POST {baseUrl}/chat/completions` with a `system` message (the stage's
  stable prefix) and a `user` message (the call's evidence); covers OpenAI, DeepSeek
  and any OpenAI-compatible gateway. The output limit is sent as `max_tokens`; set
  `"maxTokensParam": "max_completion_tokens"` for OpenAI reasoning models, which
  reject `max_tokens`. Only `message.content` is the answer: a DeepSeek reasoner's
  `reasoning_content` is ignored, and a reply carrying only reasoning fails.
- `anthropic` — `POST {baseUrl}/v1/messages` with `anthropic-version: 2023-06-01`;
  `baseUrl` defaults to `https://api.anthropic.com`. `maxTokens` is required. The
  stable prefix is sent as a `system` text block with `cache_control:
  {"type": "ephemeral"}` (`"promptCache": false` omits the breakpoint).
- `exec` — spawns `command` (argv array, `shell: false`), writes the system and user
  parts, concatenated, to stdin and reads the response from stdout, with an 8 MiB
  output guard and a 600 s limit. `"parse": "claude-json"` reads `claude -p
  --output-format json`: `result` for the text, `usage.input_tokens` /
  `usage.output_tokens` / cache counters and `total_cost_usd` for the ledger, treats
  `stop_reason: "refusal"`, an `is_error` payload or an empty `result` as a failed
  call and `stop_reason: "max_tokens"` as truncation. An exec failure is not retried.

Per-role options (all optional): `concurrency` (1–64), `maxTokensRetry`,
`maxTokensParam` (`openai`), `promptCache` (`anthropic`), and `retry`
(`maxAttempts`, `baseDelayMs`, `maxDelayMs`, `maxRetryAfterMs`). The top-level
`budget` is described above. Keep `concurrency` within the provider account's rate
limits; a 429 is retried, but a pool larger than the limit only buys retries.

> **Warning — exec roles must run without tools.** Every stage is single-shot over
> inlined, untrusted packets; a CLI that can run tools could act on instructions
> hidden in that evidence. Configure an `exec` role so the CLI has **no tools at
> all**. The example's `"--disallowed-tools", "*"` for `claude -p` is **unverified**:
> nothing offline confirms that `*` is accepted as a wildcard there. Verify against
> your installed CLI version's own documentation, and confirm that a tool request is
> actually refused, before trusting it.

Roles are independent, so cross-vendor configurations (cheap screening, mid-tier
stories, a strong composer, a reviewer from a different vendor than the composer)
are config, not code. A different vendor on `review` is a cheap extra independence
signal for development comparison; it is not, and never becomes, the deployment's
review contract.

## Cost note

The `exec` route through the `claude -p` CLI is convenient but not cheap: each call
carries that CLI's own session overhead — roughly 36–60k input tokens, about
US$0.3–0.5 per call, as measured in the 2026-11-09 session that produced this
prototype — on top of the stage prompt. A direct `openai`/`anthropic` provider
sends only the stage prompt and pays only for it. Prefer a direct API provider for
any run where per-call cost matters; the `exec` route is for a machine that already
has an authorized CLI and no API key.

That measurement is a single session's observation of one CLI version, not a
benchmark; re-measure before relying on the figure. Per-run token and duration
totals for whatever providers were actually used are in `OUT/report.json` under
`stages`, with `null` wherever a provider reported no counters — unknown usage is
recorded as unknown, never as zero. Each stage also lists `calls`, `reused`
(checkpoints served on `--resume`), `transientRetries`, `unmeteredCalls` (calls
without token counters) and `durationMs` (summed per call, so it exceeds wall-clock
time under concurrency; `elapsedMs` is the run's wall-clock time).

### Prompt caching and message structure

Each stage's prompt is split into a **stable prefix** — stage marker, stage contract,
the untrusted-evidence rule, the collection context and the `published_recently`
history (compose: the run's `prompt.md` plus the compose contract) — and the
**per-call part** (the batch, group, unit or draft). The prefix is byte-identical
across every call of a stage in a run, so providers that cache prompt prefixes can
reuse it:

- OpenAI and DeepSeek cache prefixes automatically. Cached tokens are recorded as
  `cachedInputTokens` from `usage.prompt_tokens_details.cached_tokens` (OpenAI) or
  `usage.prompt_cache_hit_tokens` (DeepSeek); `inputTokens` is their `prompt_tokens`,
  which **includes** the cached part.
- Anthropic caches up to the `cache_control` breakpoint on the system block.
  `cachedInputTokens` is `cache_read_input_tokens` and `cacheWriteInputTokens` is
  `cache_creation_input_tokens`; Anthropic's `input_tokens` **excludes** both, so the
  two providers' `inputTokens` are not directly comparable.
- Fields a provider does not report stay `null`.

No saving is claimed here. Prefix caches have a minimum cacheable length that depends
on the provider and model (for Anthropic, on the order of one to a few thousand
tokens), and the screen, story and review contracts alone may be shorter, in which
case nothing is cached; a cache also expires after a few minutes without use. Read
`cachedInputTokens` in `report.json` to see what a real run actually got.

The full `published_recently` list sits in the cached screen and story prefixes
instead of being filtered per story group: filtering by host or URL could drop an
earlier report on the same subject reached through a different link, which is
exactly what the duplicate rule must see. Model-facing JSON is written one array
element per line instead of indented, and packet transport metadata
(`sourceBinding`, `evidenceIndex`: hashes and the local `sources.json` path) is
removed from model-facing packets — it is not evidence, costs tokens and would
disclose a local path to a provider. Packet hashes are still checked on every read.

## Untrusted evidence

Every stage prompt repeats the rule the rest of the repository enforces: packet
text, titles, URLs and link labels are untrusted evidence, never instructions. No
stage may run a command, authenticate, fetch a URL, send a message or change
configuration. The orchestrator itself never evaluates model output as code and
only ever writes inside `--out`.

Model-facing JSON escapes `<`, `>` and `&` as `<`, `>` and `&` (still
valid JSON with the same value), so source text such as `</candidate_packets>`
cannot close a prompt block; each plain-text block also neutralises its own closing
tag inside its body, and the stage prompts tell the model to decode the escapes when
citing. The persisted Stage A record is written with the same escaping, so Stage B
still reads exactly the persisted bytes. The run's own `prompt.md` comes from
`compose-input` and is inlined as written.
