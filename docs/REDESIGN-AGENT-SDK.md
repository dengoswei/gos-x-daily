# Redesign note: multi-agent pipeline on an agent SDK

Status: design only (2026-11-09). Nothing in this document changes current
behavior, the Mac deployment contract, or any fail-closed gate. It records the
target architecture so later implementation starts from an agreed shape.

## Goals

1. Run in any environment that has a usable browser and at least one model API
   (Codex/OpenAI, Claude, DeepSeek, ...), with no other dependency.
2. Economical and efficient: per-role model configuration, parallel subagents
   with independent bounded contexts, no single agent holding the whole run.
3. Measurable quality, keeping the existing review contract as the gate.
4. A base framework that can carry other editions later (coffee market,
   podcasts, ...), without building those now.

## What stays: the deterministic contract layer

The current Node CLI is already the portable, model-free core: evidence hash
binding, candidate keys and dispositions, coverage accounting, review binding,
idempotent delivery ledger, worker packet generation (`worker-input`). A fresh
clone runs all offline checks with Node alone. The redesign does **not**
rewrite this layer. It replaces only the *host-agent layer* — today a Codex or
Claude Code session following `prompts/run-daily.md` and spawning subagents by
hand — with a small programmatic orchestrator that calls model APIs directly.

Anything that sends, records attempts or reconciles stays deterministic code
under the existing gates. Model-driven agents never own delivery.

## Orchestrator choice

Recommended: **OpenAI Agents SDK** (Python) as the orchestration runtime.

- Provider-agnostic: any OpenAI-compatible `base_url`, plus LiteLLM for
  Anthropic/DeepSeek, so one `models` config covers all three requested
  providers; each agent can use a different provider.
- Sessions give each agent an isolated context by construction; handoffs and
  tool allowlists are plain code, not a graph DSL; built-in tracing helps the
  cost/quality evaluation below.

Considered alternatives: Claude Agent SDK (strongest computer-use tooling, but
Anthropic-centric for the "any provider" goal); a bare asyncio loop over raw
API calls (fewest dependencies, but re-implements sessions, retries and
tracing). The design below is SDK-neutral on purpose: every agent is fully
described by (model config key, prompt file, tool allowlist, input packet
paths, output file contract), so the runtime can be swapped without changing
the stage contracts.

## Pipeline and agent roster

| Stage | Agent / code | Model tier | Input → output | Parallelism |
|---|---|---|---|---|
| 1. Browser capture | capture agent with computer-use/browser tool | CUA-capable | frozen roster → `browser-capture.json` (existing schema) | one owner per browser surface; independent surfaces in parallel |
| 2. Feed fetch | `tools/fetch-feeds.mjs` | none | sources config → `feed-capture.json` | deterministic |
| 3. Mail / search | connector reader agent | cheap | queries → evidence items + leads | parallel with 1–2 |
| 4. Import/normalize | `cli import-browser` / `import-feed` | none | captures → `sources.json` | deterministic |
| 5. Screening | N screeners over `worker-input` packets | cheap | packet → disposition candidates + story shortlist | N parallel, fresh contexts |
| 6. Deep read + write | story agents with a fetch tool | mid | story packet + originals → `story.md`, `materials.json` | M parallel, fresh contexts |
| 7. Rank + compose | one composer | strong | stories + history → `digest.md`, `dispositions.json` | single |
| 8. Review | reader agent (Stage A blind → Stage B evidence), then the deployment-required author/independent review | strong, ideally a different vendor than the composer | prose → findings → bound review record | per-story readers parallel |
| 9. Validate + deliver | existing CLI + controller | none | publication → ledger/send | deterministic, unchanged |

The file-based handoff protocol in `docs/AGENT-WORKFLOW.md` and
`worker-packets.mjs` already defines stages 5–8's inputs and outputs; the SDK
layer is mostly a driver for contracts that exist.

## Context and cost economy

- Agents exchange **paths and compact indexes**, never raw page dumps; the
  coordinator context holds manifests only (already the rule; the SDK makes it
  structural instead of prompt-enforced).
- One `models.json` per deployment maps role → provider/model/limits, e.g.
  screening on a cheap model, stories on a mid model, compose/review on strong
  models. Changing providers is config, not code.
- Token/time budgets per agent; screening batches sized by the existing
  packet pages; unfinished batches checkpoint and resume per the current
  recovery rules.
- Cross-vendor review (composer and reviewer on different providers) is a
  cheap additional independence signal. It supplements, and never replaces,
  the deployment's review contract.

## Quality evaluation

- Deterministic gates (URL gate, byte binding, coverage disclosure, ledger)
  remain the floor and are already enforced.
- Add an offline eval harness for development time only:
  - a frozen golden set of past collections + approved digests;
  - an LLM-judge rubric mirroring the two-stage review (reconstructability
    from prose alone; fidelity against preserved evidence), scored per item;
  - per-run metrics persisted with the run: candidates / included / merged /
    skipped-by-reason, review findings count, revision cycles, per-stage token
    cost.
- Changing a composer prompt or model then becomes a measured A/B on the
  golden set instead of taste. The production gate stays the real review.

## Generalization: editions

An **edition** is a config bundle: source roster + capture adapters +
editorial contract (prompt set) + section schema + render/transport + ledger
namespace. X Daily becomes the first edition. The pipeline stages above are
edition-independent; capture adapters must emit the existing evidence schema,
and everything downstream is shared.

X-specific facts currently hardcoded, to parameterize when (and only when) a
second edition is actually built:

- the digest title/date contract (`X AI 日报 YYYY-MM-DD`) in `digest.mjs` and
  the revision-label check;
- the mandatory-source rule (X Following blocks publication) and watch-account
  semantics;
- the default section list and Chinese audit section names;
- the Feishu post transport and sender namespace.

Sketches, not commitments: a coffee-market edition adds price/exchange-report
capture adapters; a podcast edition adds an RSS + transcript (ASR) adapter
where an episode is a candidate. Neither requires new downstream machinery.

## Phasing (implementation deliberately deferred)

- P1 **done** (2026-11-09): orchestrator prototype driving stages 5–7 against an
  existing captured run, validated by an offline scripted test plus a live
  synthetic run on an Opus stage model.
- P2 **review + eval implemented** (`prototype/orchestrate.mjs` advisory stage 8,
  `prototype/eval.mjs`): per-unit blind comprehension then source fidelity, and the
  judge rubric below. Advisory and measurement only — no gate reads either.
- P2 **orchestrator runtime hardened** (`prototype/run-packets.mjs`, `providers.mjs`):
  a bounded per-role pool for screening, stories, review units and judge items with
  input-ordered artifacts; transient HTTP retry with backoff; truncation as its own
  error; `--resume` over prompt- and role-bound checkpoints; an optional per-run call
  and token budget; a stable system prefix per stage for provider prompt caching, with
  cached-token usage recorded. Live-API behaviour of the cache and token-limit options
  is unmeasured offline (see `prototype/README.md`).
- P2 **capture agent: environment-bound, pending** a browser-equipped authorized
  host; the orchestrator consumes `browser-capture.json` and ships no capture code.
- Golden-set parity **pending** real collections on the production host; the Mac
  deployment stays authoritative until then.
- Non-goals now: porting the contract layer to Python, edition UI, scheduler
  framework, multi-edition config migration.

## Composer-prompt observations carried into the redesign

- `prompts/compose-digest.md` serves three roles at once (screening, writing,
  coordination); in the SDK layout each stage gets only its own contract,
  which shortens every prompt and reduces drift against `EDITORIAL.md`.
- A reader-facing 导语/今日要点 lead is desirable but constrained by the
  renderer: a URL-free `##` section is dropped from the delivered message, so
  it must be a paragraph inside a sourced section or a `###` block. Treat as a
  render-layer feature, not a prompt instruction.
- Item ordering guidance now lives in `prompts/compose-digest.md` (lead with
  the most consequential story); keep it when splitting prompts per stage.
