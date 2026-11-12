# Funnel, Two-Stage Curation & Rolling Backlog Design (v2)

## 1. Design Philosophy & Core Shift

Earlier iterations of `gos-x-daily` spent disproportionate prompt and engineering budgets on rigid compliance artifacts (200+ hand-written `dispositions.json` rows, 4-round self-review loops, 8-character verbatim substring checks, and binary SHA256 environment locks). That compliance pressure caused two systemic failure modes:
1. **Selection distortion**: Models favored clean corporate product announcements over messy X practitioner threads, screenshots, or papers with query-bearing URLs; or, under naive category weights, allowed a single high-volume feed (`Hugging Face Daily Papers`) to crowd out Infra, Products, and Long-form essays.
2. **Defensive boilerplate prose**: Every item adopted repetitive negative framing ("做 A 而不是 B"), tacked strawman disclaimers onto routine product updates, and leaked internal pipeline jargon ("所给摘录没有……").

The **v2 architecture (`run-daily.mjs`, `content-store.mjs`, `curation.mjs`, `telemetry.mjs`)** shifts engineering effort back to **information recall, curation taste, evergreen retention, zero-bootstrap portability, and reader-facing clarity**.

---

## 2. End-to-End Pipeline Overview

```text
[Browser X + Watch]   [15+ RSS / HF Papers / Releases]   [Mail / Supplements]
         │                           │                            │
         └───────────────────────────┼────────────────────────────┘
                                     ▼
            1. Pre-Clustering Shortlink Resolution (`t.co` -> canonical URL)
                                     │
                                     ▼
            2. Dual-Layer Content Store (`RUN/store/`)
               ├── L0 Raw Archive (`store/raw/`): untruncated full text & observations
               ├── L1 Index Cards (`store/cards/`): entities, social metrics, TL;DR
               └── Cross-Source Topics (`store/topics/`): unified arXiv + Blog + X threads
                                     │
      ┌──────────────────────────────┴──────────────────────────────┐
      ▼                                                             ▼
[7-Day Soft Dedup (`published-history.jsonl`)]      [Merge Rolling Backlog (`backlog-pool.json`)]
  - Seen URL/title without new fact -> skip           - Accumulate fresh X fanIn & upvotes on slow-burn gems
  - Verified new release/benchmark -> `跟进｜`         - Recall unpicked high-value items from busy days
                                     │
                                     ▼
            3. Stage 1 Objective Prior Scoring (`config/taste.json` + `curation.mjs`)
               S_prior = W_author + W_source + W_social + W_backlog_carry - P_noise - D_age
               (Category NEVER determines quality score; it only routes display sections)
                                     │
                                     ▼
            4. Stage 2 Editorial Value Assessment (`prompts/v2-select-topics.md`)
               Evaluates Top ~45 shortlist on:
               (a) Novel Insight  (b) Empirical Engineering Lesson  (c) Consequential Judgment
               ├── `deep` (5–8 items) -> Full-text fetch (`enrichTopicsWithFullText`) -> Deep Dive
               ├── `quick` (0–5 items) -> Concise releases / product betas ONLY -> Quick Hits (first)
               └── `deferred` -> High-value runners-up saved back into `backlog-pool.json`
                                     │
                                     ▼
            5. Source-Faithful Composition + Single-Pass Review + Telemetry Self-Check
               ├── Deterministic URL allowlist gate + pipeline-jargon blocker (`validateV2Digest`)
               ├── Canonical section ordering (`Quick Hits / 快讯速览` first when present)
               └── `telemetry.json` + `### 运行自检` footer + local failure diagnostics
```

---

## 3. Dual-Layer Content Archive & Cross-Source Clustering (`content-store.mjs`)

To ensure zero data loss at ingestion while keeping screening lightweight and final writing accurate:

1. **Untruncated Ingestion & Link Recovery**:
   - `feed-import.mjs` preserves full article/description bodies (`maxText: Infinity` in v2) and extracts embedded `<a href>` links from RSS/Atom HTML as well as `arXiv`, `GitHub`, and `upvotes` fields from Hugging Face Daily Papers.
   - `resolveCollectionShortlinks` resolves `t.co` `HEAD` redirects prior to clustering so multiple X posts sharing the same blog or paper via distinct `t.co` wrappers merge into a single topic (`fanIn >= 2`).
   - X quote-tweets (`x-status:<id>`) and Watch account posts (`@karpathy`, etc.) participate in topic clustering and deep-link auditing.
2. **L0 Raw Layer (`store/raw/`) vs. L1 Card Layer (`store/cards/`)**:
   - **L0 (`store/raw/`)**: Stores full untruncated source text, thread observations, and on-demand fetched HTML/article text (`store/raw/fetched/`).
   - **L1 (`store/cards/` & `store/topics/`)**: Compact JSON cards carrying `canonicalUrl`, `outboundUrls`, `contentStatus` (`full_text | abstract_only | snippet_only | paywalled`), `entities`, `metrics`, `category`, and `tldr`.
3. **Topical Routing Categories (Display Only)**:
   - `infra_eng` / `open_source` $\rightarrow$ `## Frameworks / Infra` (includes systems, compiler, `vLLM`/`SGLang`/`PyTorch`, and quantization/kernel papers such as MXFP4);
   - `paper` $\rightarrow$ `## Breakthrough Research`;
   - `product` / `general` $\rightarrow$ `## Applications / Products` (or `## Quick Hits / 快讯速览`);
   - `essay` $\rightarrow$ `## Long-form / Essays` (`Substack`, `Latent Space`, `Interconnects`, `SemiAnalysis`, `Chips and Cheese`, etc.);
   - `case_study_pr` $\rightarrow$ Commercial customer case studies (penalized and excluded by default).

---

## 4. Two-Stage Curation Rules (`config/taste.json` & `curation.mjs`)

### Rule 0: Category Neutrality
An item's format or category (`paper` vs `essay` vs `X thread`) **never** grants a quality advantage. A mediocre arXiv paper scores lower than an insightful practitioner postmortem or a high-signal researcher thread.

### Stage 1: Objective 4-Signal Prior Score ($S_{\text{prior}}$)

Configured declaratively in `config/taste.json`:

$$S_{\text{prior}} = W_{\text{author}} + W_{\text{source}} + W_{\text{social}} + W_{\text{carry}} - P_{\text{noise}} - D_{\text{age}}$$

1. **Author Confidence ($W_{\text{author}}$)**:
   - **Tier-S (`+6.0`)**: Known high-signal researchers, systems authors, and essayists (e.g., `karpathy`, `srush_nlp`, `tri_dao`, `simonw`, `emollick`, `natolambert`, `rasbt`, `cHHillee`, `lianminzheng`, `woosuk_k`, `lilianweng`, etc.). Guaranteed entry into Stage 2 review even for standalone text threads.
   - **Tier-A (`+3.5`)**: Official lab/framework accounts (`OpenAI`, `AnthropicAI`, `GoogleDeepMind`, `Alibaba_Qwen`, `deepseek_ai`, `vllm_project`, `lmsysorg`, `PyTorch`).
2. **Source Signal-to-Noise Ratio ($W_{\text{source}}$)**:
   - **Tier-S (`+5.0`, low-frequency, high-density)**: `Anthropic Engineering`, `Thinking Machines`, `Lilian Weng`, `SemiAnalysis`, `Chips and Cheese`, `Interconnects`, `Ahead of AI`, `Latent Space`, `simonwillison.net`, `oneusefulthing.org`, `pragmaticengineer.com`.
   - **Tier-A (`+3.0`, official primary releases)**: `OpenAI News`, `Google DeepMind blog`, `Claude Blog`, `Qwen blog`, `PyTorch blog`, `vLLM releases`, `SGLang releases`, `Hugging Face blog`.
   - **Tier-B (`+1.0`, high-volume aggregators)**: `Hugging Face Daily Papers`, `smol.ai AI News`, generic `arxiv.org` — low base prior; must earn promotion through social/upvote signals or strong Stage 2 substance.
3. **Social & Community Endorsement ($W_{\text{social}}$, log-scaled)**:
   - **In-network `fanIn`**: `+2.8` per additional independent X post/source sharing the same subject (capped at 4 extra posts) — the strongest signal within a curated following graph.
   - **X Native Metrics** (`readFeedDom`): Log-scaled weighted engagement (`bookmarks * 4 + reposts * 3 + replies * 2 + likes + views / 500`), prioritizing bookmarks and reposts over raw likes.
   - **Community Upvotes / Stars**: Log-scaled `upvotes` and `numComments` on HF Daily Papers plus `githubStars`.
4. **Noise Penalties ($P_{\text{noise}}$)**:
   - Commercial customer case studies (`-8.0`) and hiring/giveaway/webinar promos (`-6.0`).

### Stage 2: LLM Qualitative Editorial Assessment (`prompts/v2-select-topics.md`)

The top ~45 candidates ranked by $S_{\text{prior}}$ are evaluated by the LLM (or local Host Agent in `--prepare-only` mode) on three editorial criteria:
1. **Novel Insight (重要新见解)**: Counter-intuitive findings, newly explained mechanisms, or resolved paradoxes.
2. **Empirical & Engineering Lesson (一手经验)**: Firsthand training/serving/production trade-offs, ablations, failure modes, and measured costs (distinguishing primary work from secondhand recaps).
3. **Consequential Judgment (重要判断)**: High-leverage architectural directions, major open-weight releases, or rigorous evaluation benchmarks.

### Strict `Deep Dive` vs. `Quick Hits` Boundary
- **`Deep Dive` (`tier: "deep"`, 5–8 items)**: Items whose value requires unpacking `obstacle -> concrete mechanism -> experimental setup & boundary`. Diversity guard caps any single feed (e.g., Daily Papers) at 2–3 items when other strong sources exist.
- **`Quick Hits / 快讯速览` (`tier: "quick"`, 0–5 items, rendered first)**: **Strictly** for items whose entire value fits in 1–2 crisp sentences without methodological exposition (routine product betas, UI connectors, minor SDK/framework point releases). **Research papers are never dumped into Quick Hits as overflow.**

---

## 5. Rolling High-Value Backlog Pool (`state/backlog-pool.json`)

Daily news volume is bursty: a major conference or release day may produce 15+ genuinely worthwhile pieces, while a weekend may have only 3. Without cross-day memory, items #9–#15 vanish once the 48-hour capture window slides forward.

### Lifecycle Rules (`curation.mjs`)
1. **Selective Admission**: After daily composition, unpicked topics that were either explicitly marked `deferred` by the Stage 2 editor or scored $S_{\text{prior}} \ge 5.5$ (`minPriorScoreToEnter`) are persisted into `state/backlog-pool.json` (capped at `maxPoolSize = 1000`). Low-signal noise is discarded immediately.
2. **Zero-Refetch Full-Text Caching**: Any full article body already fetched or extracted for a backlog candidate is copied into `state/backlog-articles/<hash>.txt` and reused automatically on subsequent runs.
3. **Cross-Day Signal Accumulation**: If a slow-burn essay or paper in the backlog receives new X discussions or higher upvotes tomorrow, `mergeBacklogIntoTopics` merges the new observations into the existing topic, increments `fanIn`, updates peak `metrics`, and resets age decay (`refreshedToday = true`) — naturally boosting slow-burn gems to the top.
4. **Daily Ranking Decay and One-Year Retention**: Unrefreshed backlog items lose `dailyDecay = 0.6` ranking points per day. The admission threshold applies on entry. Admitted items remain eligible for retention up to `maxAgeDays = 365`, subject to the capacity limit and removal when cited or matched in recent publication history. Recalled items older than 48 hours carry the `补读｜` prefix with their original publication date.

---

## 6. Zero-Bootstrap Portability, Resilience & Self-Check Telemetry (`telemetry.mjs`)

1. **Zero Chicken-and-Egg Dependencies**:
   - `ensureWorkspace(dataDir)` initializes `state/published-history.jsonl`, `state/source-health.json`, `state/backlog-pool.json`, `state/delivery-receipts.jsonl`, and `runs/` automatically on first run.
   - Runs cleanly on headless Linux boxes (feeds/papers only, no browser required), on Mac with local Host Agent two-step mode (`--prepare-only` $\rightarrow$ `--finalize-digest` with zero external API calls on private timelines), or fully automated via `--models`.
2. **Graceful Degradation & Local Failure Diagnostics**:
   - Lease locks (`acquireLeaseLock`) automatically reclaim dead PIDs or expired leases.
   - Individual feed timeouts, paywalls, or cross-hour X/Feed capture skews (`maxSkewHours = 48`) degrade gracefully instead of aborting the run.
   - An unrecoverable preview failure records a local diagnostic. The Mac production controller owns scheduled failure notifications and Feishu delivery.
3. **Quantified Self-Check Footer (`### 运行自检 [OK | WARN | ACTION_NEEDED]`)**:
   - Reports exact `usable / configured` sources and explicitly names any `unattempted` or `failed` sources (with consecutive failure days tracked in `source-health.json`).
   - Prints full funnel visibility: `原始入库 -> 遗珠池召回/累加 -> 7日去重跳过 -> 话题聚合 -> 初筛入选 -> 全文补齐 -> 成稿（深度 + 快讯，含捞回遗珠） -> 遗珠池留存`.
