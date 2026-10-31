# Gos X Daily

可移植、可审阅的中文 AI 日报工作流：来源证据 → 草稿 → **独立理解度 / 忠实度审阅** → 精确版本绑定 → 防重复投递。

This repository contains source code, editorial rules, schemas and synthetic tests.
It does **not** contain a logged-in browser, private email, live evidence, delivery
history, credentials, a model client, or a scheduled production deployment.

## Start on another machine / agent

Requires **Node.js 22+** and Git. No npm dependencies or install scripts.
Core offline commands run on Linux/macOS; Windows core support is unverified.

```sh
git clone https://github.com/dengoswei/gos-x-daily.git
cd gos-x-daily
npm test
npm run check
npm run inspect
npm run test:synthetic
```

`test:synthetic` exercises import → prompt → supplemental material → test-only
review fixture → offline delivery plan, in a temporary directory. It **does not
collect real sources, perform semantic review, authenticate, or send**. Synthetic
approval helpers live only under `test/` and must never approve a real digest.

Next read [AGENTS.md](AGENTS.md), [EDITORIAL.md](EDITORIAL.md), the
[runbook](docs/RUNBOOK.md), and [browser artifact schema](BROWSER-ARTIFACTS.md).

## What runs automatically, and what does not

| Stage | In this repository | Required outside this CLI |
|---|---|---|
| Browser capture | Offline `import-browser` adapter with evidence/hash checks | Authorized browser tools, actual selected X Following, screenshots/transcription, genuine Karpathy attempt |
| Sources | Thread/quote context, ranking, rolling coverage accounting | Relevant Gmail/primary article reads, canonical materials and provenance |
| Writing | `compose-input`, editorial prompts, structural digest validation | Authorized writer/model; it must explicitly read supplemental materials |
| Review | Pending review generation and exact artifact/render binding | Genuinely independent reviewer: blind comprehension first, source fidelity second |
| Delivery | Offline plan, explicit send gates, durable attempt/receipt ledger | Verified Lark runtime, bot/recipient, credentials and authority to send |
| Scheduling | None | A separately configured controller/scheduler; clone does not activate it |

`collector.mjs` retains a **conditional direct-CDP collector**. It requires a
separately provisioned, authorized loopback browser and remains disabled by default.
It is not an automatic driver for a managed CUA browser and is not a claim of
current live selector compatibility. Do not expose debugging ports or copy profiles.

## Configuration

```sh
cp config/runtime.example.json config/runtime.local.json
cp config/sources.json config/sources.local.json
# Set runtime.local.json sourcesFile to "sources.local.json".
node cli.mjs inspect-config --config config/runtime.local.json
```

- Relative `dataDir` is resolved against the repository root, not your shell cwd.
  Choose an absolute private data directory if storing state outside the checkout.
- `sourcesFile` resolves relative to the runtime config file. Public example blog
  sources are included; add private/personal profiles only in your ignored local file.
- `rootDir` / `ledgerDir` in publication JSON resolve relative to that JSON file;
  snapshot paths and `reviewPath` are relative to `rootDir`.
- Default lookback is explicitly 48 hours in the example. Library callers default
  to 24 hours; inspect the actual runtime. Digest date uses Asia/Shanghai.
- Collection and Lark delivery are disabled. `CHANGE-ME` is not a verified deployment.
  See [Lark integration](docs/LARK.md) before configuring it.

## Repository map

- `cli.mjs`: offline entry points plus separately gated collection / send.
- `browser-artifacts.mjs`, `thread-discovery.mjs`: evidence imports and thread context.
- `coverage.mjs`, `feed.mjs`: bounded scans, deduplication and honest coverage gaps.
- `digest.mjs`, `review.mjs`, `delivery-ledger.mjs`: writing/review/delivery contracts.
- `collector.mjs`, `ocr.mjs`: optional direct-CDP / local Tesseract path.
- `prompts/`, `EDITORIAL.md`: user-owned composition and independent review rules.
- `examples/`: deliberately incomplete path templates, **not evidence or approval**.
- `test/`: synthetic, no-production-network regression tests.

## Safety and portability boundaries

No all-posts/full-recall guarantee: observations, queued items and unscanned hours
are different quantities. Hashes prove byte identity, not semantic truth. Never
manufacture approval, infer novelty from missing history, or automatically retry
an uncertain send. Keep secrets, mail, screenshots, logs and state out of Git,
even in a private repository. See [SECURITY.md](SECURITY.md).

Offline tests do not establish live login, capture quality, semantic review,
Lark acceptance, recipient-read status, or scheduler wiring. Those must be verified
for each deployment. Code backup is not a backup of private publication history. Publishing this repo
does not modify an existing deployment or make it automatically follow `main`;
see the runbook for explicit version promotion.

No license has been selected. Source is published for the owner's requested
review and operation workflow. [Provenance](docs/PROVENANCE.md).
The package.json `private: true` prevents accidental npm publication; it does not
control GitHub repository visibility.
