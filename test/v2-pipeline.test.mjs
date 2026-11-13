import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ensureWorkspace,
  acquireLeaseLock,
  loadSoftHistory,
  appendSoftHistory,
  updateSourceHealth,
  buildTelemetry,
  renderTelemetryMarkdown,
  formatAlertMarkdown,
} from '../telemetry.mjs';
import {
  resolveCollectionShortlinks,
  buildContentStore,
  enrichTopicsWithFullText,
  loadTopicFullMaterial,
  buildAutoDispositions,
  isAbstractLandingUrl,
} from '../content-store.mjs';
import { modelTopic } from '../model-input.mjs';
import { parseFeedDocument, mergeFeedDocuments } from '../feed-import.mjs';
import { readFeedDom } from '../feed.mjs';
import { scoreTopicPrior, isRoboticsEmbodiedTopic, loadBacklogPool, mergeBacklogIntoTopics, saveBacklogPool } from '../curation.mjs';
import { collectionFromBrowserArtifacts } from '../browser-artifacts.mjs';
import { compactCollection } from '../compose.mjs';
import { validateDispositions, candidateEntries, candidateKeys, canonicalUrl } from '../binding.mjs';

test('auto dispositions retain cited browser-deep candidate ownership without a standalone topic card', () => {
  const url = 'https://www.example.com/article';
  const collection = { collectionId: 'synthetic-deep-owner', sources: { deepArticles: [{ url }] } };
  const section = 'Long-form / Essays';
  const markdown = `## ${section}\n\n- Article [Original](https://example.com/article)\n\n## 差异补充\nAudit`;
  const dispositions = buildAutoDispositions({ collectionId: collection.collectionId,
    candidateKeys: candidateKeys(collection), candidateEntries: candidateEntries(collection),
    topics: [], citedUrls: ['https://example.com/article'],
    bulletSectionsByUrl: new Map([[canonicalUrl(url), section]]) });
  assert.equal(dispositions.items[0].disposition, 'included');
  assert.doesNotThrow(() => validateDispositions(dispositions, collection, markdown));
});
import { makeRuntime } from '../runtime.mjs';
import { runDailyV2, validateV2Digest, selectTopicsHeuristic, buildScreenShortlist, normalizeDigestSectionOrder } from '../run-daily.mjs';
import { runEditorialBenchmarkSuite, evaluateDigestMarkdown } from '../editorial-eval.mjs';
import { frozenApiRun } from '../deployment/mac/openai-draft.mjs';
import { openRun } from '../prototype/run-packets.mjs';
import { writeWorkerPackets } from '../worker-packets.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

test('zero-bootstrap workspace initializes cleanly and lease lock reclaims dead/expired locks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ws = ensureWorkspace(dir);
  assert.ok(fs.existsSync(ws.stateDir));
  assert.ok(fs.existsSync(ws.runsDir));
  assert.ok(fs.existsSync(ws.healthFile));

  // Empty history works out of the box without init-delivery-ledger.
  const emptyHistory = loadSoftHistory(ws.historyFile, { before: '2026-11-11', days: 7 });
  assert.equal(emptyHistory.urls.size, 0);
  assert.deepEqual(emptyHistory.toRecentEntries(), []);

  // Active lock blocks a concurrent live owner; expired lock is reclaimed automatically.
  const lockFile = path.join(ws.stateDir, 'test.lock');
  let clock = Date.parse('2026-11-11T01:00:00Z');
  const first = acquireLeaseLock(lockFile, { stage: 'collect', leaseMs: 60000, now: () => clock });
  assert.equal(first.reclaimed, null);
  assert.throws(() => acquireLeaseLock(lockFile, { stage: 'other', leaseMs: 60000, now: () => clock + 1000 }), /Active lease lock/);

  // Advance past lease expiration -> reclaimed cleanly without manual cleanup.
  clock += 120000;
  const second = acquireLeaseLock(lockFile, { stage: 'recover', leaseMs: 60000, now: () => clock });
  assert.equal(second.reclaimed.reason, 'lease_expired');
  second.release();
  assert.ok(!fs.existsSync(lockFile));
});

test('rolling source health tracks consecutive failures and triggers ACTION_NEEDED with clear magnitudes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const healthFile = path.join(dir, 'source-health.json');

  const day1 = updateSourceHealth(healthFile, [
    { id: 'xFollowing', label: 'X Following', kind: 'x', status: 'partial', items: 150, observedSpanHours: 28, stopReason: 'page_budget' },
    { id: 'xhs:demo', label: '小红书 Demo', kind: 'xhs', status: 'failed', items: 0, error: 'login_required' },
    { id: 'feed:SemiAnalysis', label: 'SemiAnalysis', kind: 'feed', status: 'failed', items: 0, error: 'HTTP 403' },
  ], { date: '2026-11-10' });
  assert.equal(day1.find(r => r.id === 'feed:SemiAnalysis').consecutiveFailures, 1);

  const day2 = updateSourceHealth(healthFile, [
    { id: 'xFollowing', label: 'X Following', kind: 'x', status: 'partial', items: 180, observedSpanHours: 26, stopReason: 'page_budget' },
    { id: 'xhs:demo', label: '小红书 Demo', kind: 'xhs', status: 'failed', items: 0, error: 'login_required' },
    { id: 'feed:SemiAnalysis', label: 'SemiAnalysis', kind: 'feed', status: 'failed', items: 0, error: 'HTTP 403' },
  ], { date: '2026-11-11' });
  assert.equal(day2.find(r => r.id === 'feed:SemiAnalysis').consecutiveFailures, 2);

  // Re-running on the same date is idempotent and does not double-increment consecutive day counts.
  const day2Rerun = updateSourceHealth(healthFile, day2, { date: '2026-11-11' });
  assert.equal(day2Rerun.find(r => r.id === 'feed:SemiAnalysis').consecutiveFailures, 2);

  const telemetry = buildTelemetry({
    date: '2026-11-11',
    sources: day2Rerun,
    funnel: {
      rawItems: 240,
      dedupSkipped7d: 18,
      clusteredTopics: 140,
      screenSelectedTopics: 8,
      deepFetch: { attempted: 8, fullText: 7, snippetOnly: 1, failed: 0 },
      publishedDeepDive: 5,
      publishedQuickHits: 3,
    },
  });
  assert.equal(telemetry.overallHealth, 'ACTION_NEEDED');
  assert.ok(telemetry.recommendations.some(r => r.target === 'feed:SemiAnalysis' && /连续 2 天/.test(r.reason)));
  assert.ok(telemetry.recommendations.some(r => r.target === 'xFollowing' && /26h/.test(r.reason)));

  const panel = renderTelemetryMarkdown(telemetry);
  assert.match(panel, /### 运行自检 \[ACTION_NEEDED\]/);
  assert.match(panel, /原始入库 240 条 → 7日去重跳过 18 条 → 聚合 140 个话题 → 初筛入选 8 个 → 正文可用 7\/8/);
});

test('funnel expansion preserves embedded feed links, untruncated bodies, watch deep links, cross-source clusters, and sources.merged.json compatibility', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-funnel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const longBody = `<p>Deep technical analysis of speculative decoding kernels. ${'Kernel details '.repeat(400)} <a href="https://github.com/org/spec-kernel">GitHub Repo</a> and <a href="https://arxiv.org/abs/2611.09999">arXiv Paper</a>.</p>`;
  const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Eng Feed</title>
    <item><title>SpecKernel v2</title><link>https://eng.example/speckernel</link>
    <pubDate>Tue, 10 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[${longBody}]]></description></item>
  </channel></rss>`;
  const papersJson = JSON.stringify([{
    paper: {
      id: '2611.09999',
      title: 'SpecKernel: Parallel Draft Verification',
      summary: 'A fast kernel architecture.',
      publishedAt: '2026-11-09T00:00:00.000Z',
      submittedOnDailyAt: '2026-11-10T06:00:00.000Z',
      githubRepo: 'https://github.com/org/spec-kernel',
    },
  }]);

  // 1. Default parseFeedDocument stays backward-compatible, while opt-in preserves full text & links.
  const fullRss = parseFeedDocument(rssXml, 'rss', 'Eng Feed', { maxText: Infinity, includeLinks: true });
  assert.ok(fullRss[0].text.length > 5000);
  assert.equal(fullRss[0].truncated, undefined);
  assert.deepEqual(fullRss[0].links.map(l => l.href), ['https://github.com/org/spec-kernel', 'https://arxiv.org/abs/2611.09999']);

  const fullPapers = parseFeedDocument(papersJson, 'hf-daily-papers', 'HF Papers', { maxText: Infinity, includeLinks: true });
  assert.deepEqual(fullPapers[0].links.map(l => l.href), ['https://arxiv.org/abs/2611.09999', 'https://github.com/org/spec-kernel']);

  // 2. Feed-only collection works on a headless machine without browser capture.
  fs.mkdirSync(path.join(dir, 'feeds'));
  fs.writeFileSync(path.join(dir, 'feeds', 'f1.xml'), rssXml);
  fs.writeFileSync(path.join(dir, 'feeds', 'f2.json'), papersJson);
  const feedConfig = [
    { name: 'Eng Feed', url: 'https://eng.example/rss.xml', kind: 'rss', maxItems: 5 },
    { name: 'HF Papers', url: 'https://huggingface.co/api/daily_papers', kind: 'hf-daily-papers', maxItems: 5 },
  ];
  const rt = makeRuntime({ dataDir: dir, lookbackHours: 48, sources: { feeds: feedConfig, blogs: [], xiaohongshuProfiles: [] } }, { runId: 'headless-run-1' });
  const feedBundle = {
    schemaVersion: 1,
    transport: 'fetched-documents',
    startedAt: '2026-11-11T01:00:00.000Z',
    fetchedAt: '2026-11-11T01:01:00.000Z',
    documents: [
      { id: 'feed-1', feed: 'Eng Feed', url: 'https://eng.example/rss.xml', path: 'feeds/f1.xml', sha256: sha256(rssXml), fetchedAt: '2026-11-11T01:00:20.000Z', contentType: 'application/xml' },
      { id: 'feed-2', feed: 'HF Papers', url: 'https://huggingface.co/api/daily_papers', path: 'feeds/f2.json', sha256: sha256(papersJson), fetchedAt: '2026-11-11T01:00:40.000Z', contentType: 'application/json' },
    ],
  };
  const feedOnlyCollection = mergeFeedDocuments(rt, null, feedBundle, dir, { maxText: Infinity });
  assert.equal(feedOnlyCollection.stats.feeds, 2);

  // 3. Watch profile links enter deepLinkAudit, and X posts + Feed entries sharing a URL cluster together.
  const shot = Buffer.from('synthetic-shot');
  const shotHash = sha256(shot);
  const browserBundle = {
    schemaVersion: 1,
    transport: 'gos-supported-browser',
    startedAt: '2026-11-11T00:50:00.000Z',
    capturedAt: '2026-11-11T00:55:00.000Z',
    evidence: [
      { id: 'e1', kind: 'screenshot', url: 'https://x.com/home', capturedAt: '2026-11-11T00:51:00.000Z', path: 'e1.png', sha256: shotHash },
      { id: 'e2', kind: 'screenshot', url: 'https://x.com/karpathy', capturedAt: '2026-11-11T00:52:00.000Z', path: 'e2.png', sha256: shotHash },
    ],
    feeds: {
      xFollowing: {
        status: 'ok',
        view: 'following',
        pages: [{ evidenceId: 'e1', items: [{ url: 'https://x.com/alice/status/101', text: 'Great writeup on SpecKernel latency!', publishedAt: '2026-11-10T15:00:00.000Z', links: [{ href: 'https://eng.example/speckernel', text: 'blog' }] }] }],
      },
      karpathy: {
        status: 'ok',
        pages: [{ evidenceId: 'e2', items: [{ url: 'https://x.com/karpathy/status/202', text: 'New CUDA quantization benchmark out today', publishedAt: '2026-11-10T16:00:00.000Z', links: [{ href: 'https://cuda-bench.example/quant-eval', text: 'bench' }] }] }],
      },
    },
  };
  const browserCol = collectionFromBrowserArtifacts(rt, browserBundle);
  // Karpathy's link is now audited in deepLinkAudit thanks to watchProfiles inclusion + expanded technical keywords.
  assert.ok(browserCol.deepLinkAudit.some(l => l.href === 'https://cuda-bench.example/quant-eval' && l.eligible));

  const mergedCol = mergeFeedDocuments(rt, browserCol, feedBundle, dir, { maxText: Infinity });
  const compact = compactCollection(mergedCol);
  // X post x:101 and feed item https://eng.example/speckernel share a cluster!
  const sharedCluster = compact.clusters.find(c => c.url === 'https://eng.example/speckernel');
  assert.ok(sharedCluster);
  assert.deepEqual(sharedCluster.itemKeys.sort(), ['https://eng.example/speckernel', 'x:101']);

  // 4. frozenApiRun and openRun seamlessly support RUN/sources.merged.json without colliding on sources.json.
  const runsRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-v2-runs-'));
  t.after(() => fs.rmSync(runsRoot, { recursive: true, force: true }));
  const macRunDir = path.join(runsRoot, `${mergedCol.date}-test`);
  fs.mkdirSync(macRunDir, { mode: 0o700 });
  fs.writeFileSync(path.join(macRunDir, 'run.json'), JSON.stringify({ date: mergedCol.date }));
  const mergedPath = path.join(macRunDir, 'sources.merged.json');
  fs.writeFileSync(mergedPath, JSON.stringify(mergedCol, null, 2));
  writeWorkerPackets({ sourcesFile: mergedPath, outputDir: path.join(macRunDir, 'packets') });

  const apiRun = frozenApiRun(runsRoot, macRunDir);
  assert.equal(apiRun.sourcesPath, 'sources.merged.json');
  assert.equal(apiRun.sources.stats.feeds, 2);
  const opened = openRun(macRunDir);
  assert.equal(opened.collection.stats.feeds, 2);
});

test('dual-layer content store archives raw bodies, clusters across arXiv/HF/X, applies 7d soft dedup, and fetches full text on demand', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const historyFile = path.join(dir, 'published-history.jsonl');
  appendSoftHistory(historyFile, {
    date: '2026-11-08',
    urls: ['https://old-topic.example/post'],
    titles: ['Old Topic Already Covered Last Week'],
  });
  const softHistory = loadSoftHistory(historyFile, { before: '2026-11-11', days: 7 });

  const syntheticCollection = {
    schemaVersion: 1,
    collectionId: 'col-store-1',
    date: '2026-11-11',
    sources: {
      xFollowing: [
        { url: 'https://x.com/researcher/status/11', text: 'Impressive StateBench results on long-horizon state tracking!', publishedAt: '2026-11-10T10:00:00Z', links: [{ href: 'https://arxiv.org/abs/2611.12345', text: 'paper' }] },
        { url: 'https://x.com/promo/status/12', text: 'Reposting last week article', publishedAt: '2026-11-10T11:00:00Z', links: [{ href: 'https://old-topic.example/post?utm_source=x', text: 'old' }] },
      ],
      feeds: [
        { url: 'https://huggingface.co/papers/2611.12345', title: 'StateBench: Tracking State', text: 'Short abstract.', publishedAt: '2026-11-10T08:00:00Z', paperPublishedAt: '2026-11-09T00:00:00Z', feedName: 'HF Daily Papers', links: [{ href: 'https://arxiv.org/abs/2611.12345', text: 'arXiv' }] },
        { url: 'https://vendor.example/customers/hospital-case-study', title: 'Customer Story: How Hospital Signed 20k Contracts', text: 'A commercial customer case study.', publishedAt: '2026-11-10T09:00:00Z', feedName: 'Vendor Blog', links: [] },
      ],
    },
  };

  const storeDir = path.join(dir, 'store');
  const built = buildContentStore(syntheticCollection, storeDir, { softHistory });
  // 4 raw items -> 3 topics (X post + HF paper merged via shared arXiv ID 2611.12345!)
  assert.equal(built.counts.rawItems, 4);
  assert.equal(built.counts.topics, 3);
  assert.equal(built.counts.dedupSkipped7d, 1);

  const stateBenchTopic = built.topics.find(tp => tp.title.includes('StateBench'));
  assert.equal(stateBenchTopic.fanIn, 2);
  assert.deepEqual(stateBenchTopic.discussionUrls, ['https://x.com/researcher/status/11']);
  assert.equal(stateBenchTopic.dedupStatus, 'fresh');

  const caseStudyTopic = built.topics.find(tp => tp.url?.includes('customers') || tp.primaryUrl?.includes('customers'));
  assert.equal(caseStudyTopic.category, 'case_study_pr');

  // Enrich full text via mock fetch
  const fullHtml = `<html><head><title>StateBench Full Paper HTML</title></head><body><article><h1>StateBench</h1><p>${'Detailed state transition benchmark methodology and Gated DeltaNet ablations. '.repeat(30)}</p><a href="https://github.com/ai2/statebench">Code Repository</a></article></body></html>`;
  const fetchStats = await enrichTopicsWithFullText(built.topics, storeDir, {
    topicIds: [stateBenchTopic.topicId],
    fetchImpl: async () => new Response(fullHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  assert.equal(fetchStats.fullText, 1);
  assert.equal(stateBenchTopic.contentStatus, 'full_text');
  assert.ok(stateBenchTopic.allObservedUrls.includes('https://github.com/ai2/statebench'));

  const material = loadTopicFullMaterial(stateBenchTopic, storeDir);
  assert.ok(material.fetchedFullText.text.includes('Gated DeltaNet ablations'));
  assert.equal(material.observations.length, 2);
});

test('the local preview builds both tiers, refuses delivery, and records failures locally', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dataDir = path.join(dir, 'data');
  const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>AI Infra</title>
    <item><title>FlashProve: Verifiable MoE Inference</title><link>https://research.example/flashprove</link>
      <pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>${'FlashProve attaches CPU-verifiable zero-knowledge proofs to greedy MoE decoding on a single H100 at 110 tok/s. '.repeat(20)} <a href="https://github.com/example/flashprove">Code</a></p>]]></description>
    </item>
    <item><title>Workspace Sheets Beta</title><link>https://product.example/sheets-beta</link>
      <pubDate>Tue, 10 Nov 2026 11:00:00 GMT</pubDate>
      <description><![CDATA[<p>Collaborative spreadsheet editing beta for paid plans across web and desktop.</p>]]></description>
    </item>
  </channel></rss>`;

  const feedDir = path.join(dir, 'feed-bundle');
  fs.mkdirSync(path.join(feedDir, 'feeds'), { recursive: true });
  fs.writeFileSync(path.join(feedDir, 'feeds', 'feed-1.xml'), rssXml);
  const feedBundlePath = path.join(feedDir, 'feed-capture.json');
  fs.writeFileSync(feedBundlePath, JSON.stringify({
    schemaVersion: 1,
    transport: 'fetched-documents',
    startedAt: '2026-11-11T00:30:00.000Z',
    fetchedAt: '2026-11-11T00:31:00.000Z',
    documents: [{
      id: 'feed-1',
      feed: 'AI Infra',
      url: 'https://research.example/rss.xml',
      path: 'feeds/feed-1.xml',
      sha256: sha256(rssXml),
      fetchedAt: '2026-11-11T00:30:30.000Z',
      contentType: 'application/xml',
    }],
  }));

  const sourcesConfig = {
    xFollowing: false,
    watchProfiles: [],
    blogs: [],
    xiaohongshuProfiles: [],
    feeds: [{ name: 'AI Infra', url: 'https://research.example/rss.xml', kind: 'rss', maxItems: 10 }],
  };

  const modelsFile = path.join(dir, 'models.json');
  process.env.SYNTHETIC_V2_API_KEY = 'synthetic-key-value';
  t.after(() => { delete process.env.SYNTHETIC_V2_API_KEY; });
  fs.writeFileSync(modelsFile, JSON.stringify({
    roles: {
      screen: { kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model: 'synth-fast', apiKeyEnv: 'SYNTHETIC_V2_API_KEY', maxTokens: 2000 },
      compose: { kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model: 'synth-strong', apiKeyEnv: 'SYNTHETIC_V2_API_KEY', maxTokens: 4000 },
      review: { kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model: 'synth-reviewer', apiKeyEnv: 'SYNTHETIC_V2_API_KEY', maxTokens: 4000 },
    },
  }));

  // Verify jargon & hallucinated URL rejection in validateV2Digest
  const allowedSet = new Set(['https://research.example/flashprove', 'https://github.com/example/flashprove', 'https://product.example/sheets-beta']);
  assert.throws(
    () => validateV2Digest('# X AI 日报 2026-11-11\n\n## Breakthrough Research\n- **Test**：所给摘录没有单卡成本。 [原文](https://research.example/flashprove)', { date: '2026-11-11', observedUrlSet: allowedSet }),
    /leaked internal pipeline phrasing/,
  );
  assert.throws(
    () => validateV2Digest('# X AI 日报 2026-11-11\n\n## Breakthrough Research\n- **Test**：正常正文。 [原文](https://hallucinated.example/fake)', { date: '2026-11-11', observedUrlSet: allowedSet }),
    /Unobserved or hallucinated URL/,
  );


  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages?.[0]?.content ?? '';
    let replyText;
    if (sys.includes('two-stage curation & editorial selection (v2)')) {
      replyText = '```json\n{"selected":[{"topicId":"topic-0001","tier":"deep","section":"Breakthrough Research","followUp":false,"reason":"Verifiable MoE ZK proof"},{"topicId":"topic-0002","tier":"quick","section":"Quick Hits / 快讯速览","followUp":false,"reason":"Minor product beta"}]}\n```';
    } else if (sys.includes('Stage contract: source-faithful technical digest composition (v2)')) {
      replyText = [
        '```markdown',
        '# X AI 日报 2026-11-11',
        '',
        '## Breakthrough Research',
        '- **FlashProve：用零知识证明在不暴露权重的前提下核验 MoE 贪心解码来源。** 11 月 10 日发布的研究利用稀疏专家激活缩小证明开销，单张 H100 在 1,024-token 上下文下可达 110 tok/s，核验对象为计算来源而非事实正确性。 [原文](https://research.example/flashprove) · [代码](https://github.com/example/flashprove)',
        '',
        '## Quick Hits / 快讯速览',
        '- **Workspace Sheets Beta**：11 月 10 日面向付费计划开放网页与桌面端协同表格 beta。 [官方介绍](https://product.example/sheets-beta)',
        '```',
      ].join('\n');
    } else {
      replyText = '```json\n{"verdict":"pass","issues":[],"revisedMarkdown":null}\n```';
    }
    return Response.json({
      id: 'chatcmpl-synth',
      choices: [{ message: { content: replyText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    });
  };

  const result = await runDailyV2({
    dataDir,
    sourcesConfig,
    modelsFile,
    feedArtifactsPath: feedBundlePath,
    fetchFullTextOnline: false,
    runtimeHooks: { fetch: mockFetch, now: '2026-11-11T01:00:00Z' },
  });

  assert.equal(result.status, 'completed_local');
  assert.equal(result.funnel.publishedDeepDive, 1);
  assert.equal(result.funnel.publishedQuickHits, 1);
  assert.equal(result.delivery.sent, false);

  const finalDigest = fs.readFileSync(result.digestPath, 'utf8');
  assert.match(finalDigest, /## Breakthrough Research/);
  assert.match(finalDigest, /## Quick Hits \/ 快讯速览/);
  assert.ok(finalDigest.indexOf('## Quick Hits / 快讯速览') < finalDigest.indexOf('## Breakthrough Research'));
  assert.match(finalDigest, /### 运行自检 \[OK\]/);
  assert.ok(!/所给摘录/.test(finalDigest));

  // Auto-generated dispositions covers every candidate key without asking the LLM to write it!
  const autoDisp = JSON.parse(fs.readFileSync(path.join(result.runDir, 'dispositions.json'), 'utf8'));
  const mergedCol = JSON.parse(fs.readFileSync(path.join(result.runDir, 'sources.merged.json'), 'utf8'));
  const dispValidation = validateDispositions(autoDisp, mergedCol, finalDigest.split('### 运行自检')[0] + '\n## 差异补充\naudit');
  assert.equal(dispValidation.included, 2);

  await assert.rejects(runDailyV2({ allowSend: true }), /preview cannot send/);

  await assert.rejects(
    () => runDailyV2({
      dataDir,
      sourcesConfig,
      modelsFile,
      fetchFeedsOnline: false, // Neither browser nor feed artifacts supplied -> fatal empty collection
      runtimeHooks: { fetch: mockFetch, now: '2026-11-12T01:00:00Z' },
    }),
    err => {
      assert.equal(err.stage, 'collect_and_import');
      assert.match(err.alertMarkdown, /X AI 日报运行告警 2026-11-12/);
      return true;
    },
  );
});

test('Mac Codex feedback regressions: unattempted sources warn in footer, >2h X+Feed skew merges, X quote/t.co clusters, and two-step host compose works without API calls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-codex-fb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Unattempted sources (e.g., 16 feeds usable + 5 unattempted: X Following, Watch @karpathy, 3 Blogs)
  // MUST NOT display "16/16 可用 [OK]" in the footer!
  const feedRows = Array.from({ length: 16 }, (_, i) => ({ id: `feed:f${i + 1}`, label: `Feed ${i + 1}`, kind: 'feed', status: 'ok', items: 3 }));
  const unattemptedRows = [
    { id: 'xFollowing', label: 'X Following', kind: 'x', status: 'unattempted', items: 0 },
    { id: 'watch:karpathy', label: 'Watch @karpathy', kind: 'watch', status: 'unattempted', items: 0 },
    { id: 'blog:Anthropic Engineering', label: 'Anthropic Engineering', kind: 'blog', status: 'unattempted', items: 0 },
    { id: 'blog:Claude Blog', label: 'Claude Blog', kind: 'blog', status: 'unattempted', items: 0 },
    { id: 'blog:Thinking Machines', label: 'Thinking Machines', kind: 'blog', status: 'unattempted', items: 0 },
  ];
  const partialTel = buildTelemetry({
    date: '2026-11-11',
    sources: [...feedRows, ...unattemptedRows],
    funnel: { rawItems: 42, dedupSkipped7d: 0, clusteredTopics: 38, screenSelectedTopics: 11, publishedDeepDive: 7, publishedQuickHits: 4 },
  });
  assert.equal(partialTel.overallHealth, 'WARN');
  const partialFooter = renderTelemetryMarkdown(partialTel);
  assert.match(partialFooter, /### 运行自检 \[WARN\]/);
  assert.match(partialFooter, /可用 16\/21 · 已尝试 16 · 未尝试 5/);
  assert.match(partialFooter, /未尝试：X Following、Watch @karpathy、Anthropic Engineering、Claude Blog 等 5 项/);

  // 2. Morning X capture (00:50Z) + Evening Feed capture (08:50Z, 8 hours apart > 2h) merges cleanly in runDailyV2,
  // 3. X quote-tweets + t.co display/shortlinks cluster together,
  // 4. Two-step --prepare-only + --finalize-digest runs with ZERO external LLM API calls.
  const shot = Buffer.from('synthetic-mac-shot');
  const shotHash = sha256(shot);
  const browserDir = path.join(dir, 'browser');
  fs.mkdirSync(browserDir, { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'x1.png'), shot);
  fs.writeFileSync(path.join(browserDir, 'k1.png'), shot);
  const browserBundlePath = path.join(browserDir, 'browser-capture.json');
  fs.writeFileSync(browserBundlePath, JSON.stringify({
    schemaVersion: 1,
    transport: 'gos-supported-browser',
    startedAt: '2026-11-11T00:50:00.000Z',
    capturedAt: '2026-11-11T00:56:00.000Z',
    evidence: [
      { id: 'x1', kind: 'screenshot', url: 'https://x.com/home', capturedAt: '2026-11-11T00:52:00.000Z', path: 'x1.png', sha256: shotHash },
      { id: 'k1', kind: 'screenshot', url: 'https://x.com/karpathy', capturedAt: '2026-11-11T00:54:00.000Z', path: 'k1.png', sha256: shotHash },
    ],
    feeds: {
      xFollowing: {
        status: 'ok',
        view: 'following',
        pages: [{
          evidenceId: 'x1',
          items: [
            // Root announcement tweet with a t.co shortlink whose visible label shows the domain/path
            { url: 'https://x.com/lab/status/5001', text: 'Announcing KernelForge v1 for FP8 MoE!', publishedAt: '2026-11-10T22:00:00.000Z', links: [{ href: 'https://t.co/kfshort1', text: 'kernelforge.example/v1' }] },
            // Two independent tweets quoting the root announcement status 5001 -> must cluster into 1 topic!
            { url: 'https://x.com/alice/status/5002', text: 'Tested KernelForge v1 on H100, 1.4x speedup.', publishedAt: '2026-11-10T23:00:00.000Z', links: [{ href: 'https://x.com/lab/status/5001', text: 'Quote' }] },
          ],
        }],
      },
      karpathy: {
        status: 'ok',
        pages: [{
          evidenceId: 'k1',
          items: [
            { url: 'https://x.com/karpathy/status/5003', text: 'Nice clean Triton code in KernelForge.', publishedAt: '2026-11-11T00:10:00.000Z', links: [{ href: 'https://t.co/kfshort1', text: '' }] },
          ],
        }],
      },
    },
  }));

  // Evening feeds captured 8 hours later (08:55Z) mentioning https://kernelforge.example/v1
  const feedDir = path.join(dir, 'evening-feeds');
  fs.mkdirSync(path.join(feedDir, 'feeds'), { recursive: true });
  const eveningRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Infra RSS</title>
    <item><title>KernelForge v1 Technical Post</title><link>https://kernelforge.example/v1</link>
      <pubDate>Tue, 10 Nov 2026 21:30:00 GMT</pubDate>
      <description><![CDATA[<p>KernelForge fuses FP8 block scaling with persistent MoE dispatch.</p>]]></description>
    </item>
  </channel></rss>`;
  fs.writeFileSync(path.join(feedDir, 'feeds', 'f1.xml'), eveningRss);
  const feedBundlePath = path.join(feedDir, 'feed-capture.json');
  fs.writeFileSync(feedBundlePath, JSON.stringify({
    schemaVersion: 1,
    transport: 'fetched-documents',
    startedAt: '2026-11-11T08:55:00.000Z',
    fetchedAt: '2026-11-11T08:56:00.000Z',
    documents: [{
      id: 'feed-evening-1',
      feed: 'Infra RSS',
      url: 'https://kernelforge.example/rss.xml',
      path: 'feeds/f1.xml',
      sha256: sha256(eveningRss),
      fetchedAt: '2026-11-11T08:55:30.000Z',
      contentType: 'application/xml',
    }],
  }));

  const sourcesConfig = {
    watchProfiles: [{ handle: 'karpathy', name: 'Karpathy', required: true, latest: 10 }],
    blogs: [],
    xiaohongshuProfiles: [],
    feeds: [{ name: 'Infra RSS', url: 'https://kernelforge.example/rss.xml', kind: 'rss', maxItems: 5 }],
  };

  let publicArticleFetches = 0;
  const publicFetchMock = async (url, init) => {
    // Only public article fetch or t.co HEAD resolution is allowed; zero calls to api.openai.com!
    assert.ok(!String(url).includes('openai.com'));
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 301, headers: { location: 'https://kernelforge.example/v1' } });
    }
    publicArticleFetches += 1;
    return new Response(
      `<html><head><title>KernelForge v1</title></head><body><article><p>${'KernelForge FP8 persistent MoE kernel design and H100 benchmarks. '.repeat(25)}</p><a href="https://github.com/org/kernelforge">GitHub</a></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  };

  const dataDir = path.join(dir, 'data');
  // Step A: --prepare-only merges 8h-apart X + Feeds, clusters all 4 items (root X + quote X + Karpathy t.co + RSS) into 1 unified topic!
  const prepared = await runDailyV2({
    dataDir,
    sourcesConfig,
    browserArtifactsPath: browserBundlePath,
    feedArtifactsPath: feedBundlePath,
    prepareOnly: true,
    fetchFullTextOnline: true,
    runtimeHooks: { fetch: publicFetchMock, now: '2026-11-11T09:00:00Z' },
  });

  assert.equal(prepared.status, 'prepared_for_host_compose');
  assert.equal(prepared.rawItems, 4);
  assert.equal(prepared.clusteredTopics, 1, 'Root tweet, quote tweet, t.co tweet and RSS post should all cluster into 1 topic');
  assert.equal(publicArticleFetches, 1);
  assert.ok(fs.existsSync(prepared.preparedTopicsPath));
  assert.ok(fs.existsSync(prepared.composePromptPath));

  // Step B: Local host agent (e.g. Codex) writes draft.md locally, then --finalize-digest validates & wraps up!
  const hostDraftPath = path.join(prepared.runDir, 'host-draft.md');
  fs.writeFileSync(hostDraftPath, [
    '# X AI 日报 2026-11-11',
    '',
    '## Frameworks / Infra',
    '- **KernelForge v1：融合 FP8 块缩放与持久化 MoE 调度的算子库。** 11 月 10 日发布，通过单核持久化调度减少稀疏专家切换开销，社区实测 H100 端到端提速约 1.4 倍。 [原文](https://kernelforge.example/v1) · [代码](https://github.com/org/kernelforge) · [X 讨论](https://x.com/alice/status/5002)',
    '',
  ].join('\n'));

  const finalized = await runDailyV2({
    dataDir,
    sourcesConfig,
    runDir: prepared.runDir,
    finalizeDigestPath: hostDraftPath,
    runtimeHooks: { now: '2026-11-11T09:05:00Z' },
  });

  assert.equal(finalized.status, 'completed_local');
  assert.equal(finalized.overallHealth, 'WARN'); // X Following bounded capture span < 36h -> WARN
  const finalMd = fs.readFileSync(finalized.digestPath, 'utf8');
  assert.match(finalMd, /信源状态 \(3\/3 可用\)/);
  assert.match(finalMd, /原始入库 4 条 → 7日去重跳过 0 条 → 聚合 1 个话题 → 初筛入选 1 个 → 正文可用 1\/1 → 成稿 1 条/);
});

test('selection balance & Quick Hits rules: 20 HF papers never drown out Infra/Products/Essays, papers never spill into Quick Hits, t.co HEAD resolution merges X posts, and Quick Hits always renders first', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-balance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Pre-resolving distinct t.co URLs pointing to the same Latent Space essay merges two X tweets into fanIn=2 and classifies as essay!
  const col = {
    schemaVersion: 1,
    collectionId: 'balance-col-1',
    date: '2026-11-11',
    sources: {
      xFollowing: [
        { url: 'https://x.com/u1/status/1', text: 'Great latency post on token/s vs wall-clock!', publishedAt: '2026-11-10T10:00:00Z', links: [{ href: 'https://t.co/abc111', text: 'https://t.co/abc111' }] },
        { url: 'https://x.com/u2/status/2', text: 'Long reasoning tails eat throughput gains.', publishedAt: '2026-11-10T11:00:00Z', links: [{ href: 'https://t.co/xyz222', text: 'https://t.co/xyz222' }] },
        { url: 'https://x.com/u3/status/3', text: 'Claude Sheets beta launched today for collaborative editing.', publishedAt: '2026-11-10T12:00:00Z', links: [{ href: 'https://claude.example/blog/sheets-beta', text: 'blog' }] },
        { url: 'https://x.com/u4/status/4', text: 'Claude MCP Apps interactive connectors preview.', publishedAt: '2026-11-10T12:30:00Z', links: [{ href: 'https://claude.example/blog/mcp-apps-preview', text: 'blog' }] },
      ],
      feeds: [
        // 15 pure research papers from Hugging Face Daily Papers + 2 systems/quantization papers + 1 vLLM release
        ...Array.from({ length: 15 }, (_, i) => ({
          url: `https://huggingface.co/papers/2611.100${String(i).padStart(2, '0')}`,
          title: `Pure Theory Paper ${i + 1}`,
          text: 'A theoretical theorem and ablation on synthetic graphs '.repeat(8),
          publishedAt: '2026-11-10T08:00:00Z',
          feedName: 'Hugging Face Daily Papers',
          links: [{ href: `https://arxiv.org/abs/2611.100${String(i).padStart(2, '0')}`, text: 'arXiv' }],
        })),
        {
          url: 'https://huggingface.co/papers/2611.10649',
          title: 'MACaQ: Layer-wise MXFP4 Quantization on vLLM',
          text: 'MXFP4 quantization kernel benchmarked on vLLM with 2.3% overhead '.repeat(8),
          publishedAt: '2026-11-10T08:30:00Z',
          feedName: 'Hugging Face Daily Papers',
          links: [{ href: 'https://arxiv.org/abs/2611.10649', text: 'arXiv' }],
        },
        {
          url: 'https://github.com/vllm-project/vllm/releases/tag/v0.12.0',
          title: 'vLLM v0.12.0 Release Notes',
          text: 'Faster FP8 MoE kernels and pipeline parallelism improvements.',
          publishedAt: '2026-11-10T09:00:00Z',
          feedName: 'vLLM releases',
          links: [],
        },
      ],
    },
  };

  const resolved = await resolveCollectionShortlinks(col, {
    fetchImpl: async url => {
      if (url === 'https://t.co/abc111' || url === 'https://t.co/xyz222') {
        return new Response(null, { status: 301, headers: { location: 'https://www.latent.space/p/latency-tails' } });
      }
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(resolved.resolved, 2);

  const built = buildContentStore(col, path.join(dir, 'store'));
  const latentTopic = built.topics.find(tp => tp.primaryUrl === 'https://latent.space/p/latency-tails');
  assert.ok(latentTopic, 't.co shortlinks resolved to the same Latent Space essay and clustered');
  assert.equal(latentTopic.fanIn, 2);
  assert.equal(latentTopic.category, 'essay');

  // MACaQ (vLLM MXFP4 paper) is classified as infra_eng rather than swallowed into generic research!
  const macaqTopic = built.topics.find(tp => tp.title.includes('MACaQ'));
  assert.equal(macaqTopic.category, 'infra_eng');

  // 2. Heuristic selection preserves all 4 Deep Dive sections, caps Daily Papers, and puts ZERO papers in Quick Hits!
  const selected = selectTopicsHeuristic(built.topics, { maxDeep: 7, maxQuick: 4, maxPerSource: 2 });
  const deepSections = new Set(selected.filter(s => s.tier === 'deep').map(s => s.section));
  assert.ok(deepSections.has('Frameworks / Infra'));
  assert.ok(deepSections.has('Breakthrough Research'));
  assert.ok(deepSections.has('Applications / Products'));
  assert.ok(deepSections.has('Long-form / Essays'));

  const topicMap = new Map(built.topics.map(tp => [tp.topicId, tp]));
  const quickTopics = selected.filter(s => s.tier === 'quick').map(s => topicMap.get(s.topicId));
  assert.ok(quickTopics.length >= 1, 'Concise product updates enter Quick Hits');
  assert.ok(quickTopics.every(tp => tp.category !== 'paper' && !tp.sources.includes('Hugging Face Daily Papers')),
    'Research papers must never spill into Quick Hits');

  // 3. Normalize a draft with Quick Hits below the deep sections.
  const misordered = [
    '# X AI 日报 2026-11-11',
    '',
    '## Breakthrough Research',
    '- **[Research Lab · Paper 1]：核心理论发现。** 正文解释。 [论文](https://arxiv.org/abs/2611.10000)',
    '',
    '## Frameworks / Infra',
    '- **[vLLM · v0.12.0]：FP8 算子提速。** 正文解释。 [Release](https://github.com/vllm-project/vllm/releases/tag/v0.12.0)',
    '',
    '## Quick Hits / 快讯速览',
    '- **Claude MCP Apps**：网页端开放连接器预览。 [官方说明](https://claude.example/blog/mcp-apps-preview)',
  ].join('\n');
  const ordered = normalizeDigestSectionOrder(misordered);
  const infraPos = ordered.indexOf('## Frameworks / Infra');
  const researchPos = ordered.indexOf('## Breakthrough Research');
  const quickPos = ordered.indexOf('## Quick Hits / 快讯速览');
  assert.ok(quickPos >= 0 && quickPos < infraPos && infraPos < researchPos, 'Canonical order: Quick Hits -> Infra -> Research');

  // 4. Host Agent custom topic override (--selected-topics) re-runs enrichment on chosen topics cleanly.
  const runDataDir = path.join(dir, 'run-data');
  const prep1 = await runDailyV2({
    dataDir: runDataDir,
    sourcesConfig: { xFollowing: false, watchProfiles: [], blogs: [], xiaohongshuProfiles: [], feeds: [] },
    premergedSourcesPath: (() => {
      const p = path.join(dir, 'premerged.json');
      fs.writeFileSync(p, JSON.stringify(col, null, 2));
      return p;
    })(),
    prepareOnly: true,
    fetchFullTextOnline: false,
    runtimeHooks: { now: '2026-11-11T09:00:00Z' },
  });
  assert.ok(fs.existsSync(prep1.candidateTopicsPath));

  const customSelectionFile = path.join(prep1.runDir, 'host-selected.json');
  fs.writeFileSync(customSelectionFile, JSON.stringify({
    selected: [
      { topicId: latentTopic.topicId, tier: 'deep', section: 'Long-form / Essays', followUp: false, reason: 'Community-discussed latency analysis' },
    ],
  }, null, 2));

  const prep2 = await runDailyV2({
    dataDir: runDataDir,
    runDir: prep1.runDir,
    selectedTopicsPath: customSelectionFile,
    prepareOnly: true,
    fetchFullTextOnline: false,
    runtimeHooks: { now: '2026-11-11T09:02:00Z' },
  });
  assert.equal(prep2.selectedTopics, 1);
  const preparedMaterials = JSON.parse(fs.readFileSync(prep2.preparedTopicsPath, 'utf8'));
  assert.equal(preparedMaterials[0].topicId, latentTopic.topicId);
  assert.equal(preparedMaterials[0].section, 'Long-form / Essays');
});

test('4-signal prior curation & rolling evergreen backlog: social metrics parsed, Tier-S author/source outranks low-vote paper, unpicked gems persist with cached full text, accumulate cross-day signals, and surface on quieter days', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-backlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Verify readFeedDom extracts X engagement metrics (replies, reposts, likes, bookmarks, views)
  const prevDoc = globalThis.document, prevLoc = globalThis.location, prevWin = globalThis.window;
  t.after(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: prevLoc });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: prevWin });
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => [{
        innerText: 'Deep dive into KV cache paged attention latency.',
        querySelectorAll: sel => sel === 'a[href]' ? [{ innerText: 'Post', href: 'https://x.com/tri_dao/status/9001' }] : [],
        querySelector: sel => {
          if (sel === 'time') return { getAttribute: n => n === 'datetime' ? '2026-11-10T10:00:00Z' : null, closest: () => ({ href: 'https://x.com/tri_dao/status/9001' }) };
          if (sel === '[role="group"][aria-label]') return { getAttribute: () => '18 replies, 95 reposts, 620 likes, 410 bookmarks, 48.5K views' };
          return null;
        },
        closest: () => null,
      }],
      querySelector: () => null,
      body: { innerText: 'Feed' },
      documentElement: { scrollHeight: 1500 },
    },
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/home' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scrollY: 0, innerHeight: 800 } });
  const domResult = readFeedDom('x');
  assert.deepEqual(domResult.items[0].metrics, { replies: 18, reposts: 95, likes: 620, bookmarks: 410, views: 48500 });

  // 2. Verify HF Daily Papers parses upvotes, comments, and githubStars
  const [hfPaper] = parseFeedDocument(JSON.stringify([{
    numComments: 12,
    paper: { id: '2611.77777', title: 'High-Vote Paper', summary: 'Summary', upvotes: 145, githubStars: 820, submittedOnDailyAt: '2026-11-10T06:00:00Z' },
  }]), 'hf-daily-papers', 'HF', { includeLinks: true });
  assert.deepEqual(hfPaper.metrics, { upvotes: 145, comments: 12, githubStars: 820 });

  // 3. Verify 4-signal Prior Scorer: Tier-S author/blog easily outranks a 1-upvote generic Daily Paper (category neutrality!)
  const lowSignalPaper = scoreTopicPrior({
    title: 'Generic Incremental Paper',
    category: 'paper',
    primaryUrl: 'https://huggingface.co/papers/2611.00001',
    sources: ['Hugging Face Daily Papers'],
    fanIn: 1,
    metrics: { upvotes: 1 },
    cards: [{ author: 'unknown_user', tldr: 'Incremental study' }],
  });
  const tierSEssay = scoreTopicPrior({
    title: 'Why GPU Memory Bandwidth Dictates Agentic Throughput',
    category: 'essay',
    primaryUrl: 'https://semianalysis.com/p/gpu-bandwidth-agents',
    sources: ['SemiAnalysis'],
    fanIn: 2,
    metrics: { bookmarks: 120, likes: 240 },
    cards: [{ author: 'dylan522p', tldr: 'Deep hardware bottleneck breakdown' }],
  });
  assert.ok(tierSEssay.priorScore > lowSignalPaper.priorScore + 10,
    `Tier-S author/source (${tierSEssay.priorScore}) must score far above 1-upvote paper (${lowSignalPaper.priorScore})`);

  // 4. Rolling Evergreen Backlog across Busy Day 1 -> Quiet Day 2 (with signal accumulation & zero re-fetch!)
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const day1StoreDir = path.join(dir, 'day1-store');

  const day1Collection = {
    schemaVersion: 1,
    collectionId: 'day1-busy',
    date: '2026-11-10',
    sources: {
      xFollowing: [
        { url: 'https://x.com/simonw/status/701', text: 'Published a detailed breakdown on local SQLite vector indexing.', publishedAt: '2026-11-10T08:00:00Z', metrics: { likes: 180, bookmarks: 95 }, links: [{ href: 'https://simonwillison.net/2026/Nov/10/sqlite-vec', text: 'blog' }] },
        { url: 'https://x.com/karpathy/status/702', text: 'Minimal C/CUDA LLM training loop walkthrough.', publishedAt: '2026-11-10T09:00:00Z', metrics: { likes: 950, bookmarks: 600 }, links: [{ href: 'https://karpathy.example/llm-c-walkthrough', text: 'post' }] },
      ],
      feeds: [
        { url: 'https://anthropic.com/engineering/agent-sandboxes', title: 'Engineering Isolated Agent Sandboxes', text: 'Full engineering architecture post '.repeat(45), publishedAt: '2026-11-10T07:00:00Z', feedName: 'Anthropic Engineering', links: [] },
      ],
    },
  };

  const day1Built = buildContentStore(day1Collection, day1StoreDir);
  // Suppose on Day 1 layout only published Karpathy's walkthrough, leaving Simon Willison + Anthropic Engineering unpicked!
  for (const tp of day1Built.topics) tp._storeDir = day1StoreDir;
  const savedDay1 = saveBacklogPool(stateDir, {
    reportDate: '2026-11-10',
    topics: day1Built.topics,
    citedUrls: ['https://karpathy.example/llm-c-walkthrough'],
    deferredTopicIds: new Map([[day1Built.topics.find(x => x.primaryUrl.includes('anthropic.com')).topicId, 'Deferred due to tight Day 1 layout']]),
  });
  for (const tp of day1Built.topics) delete tp._storeDir;
  assert.equal(savedDay1.savedCount, 2, 'Both high-prior unpicked gems are saved into backlog-pool.json');

  // Day 2: Quiet day! Anthropic Engineering is NOT in Day 2's fresh feed at all (recalled standalone with cached full text),
  // while Simon Willison's post gets 1 new X discussion tweet on Day 2 (cross-day signal accumulation: fanIn 1 -> 2!).
  const day2StoreDir = path.join(dir, 'day2-store');
  const day2Collection = {
    schemaVersion: 1,
    collectionId: 'day2-quiet',
    date: '2026-11-11',
    sources: {
      xFollowing: [
        { url: 'https://x.com/dev_reader/status/801', text: 'Benchmarked Simon Willison sqlite-vec recipe on 5M rows, works great!', publishedAt: '2026-11-11T05:00:00Z', metrics: { likes: 45, bookmarks: 30 }, links: [{ href: 'https://simonwillison.net/2026/Nov/10/sqlite-vec', text: 'blog' }] },
      ],
      feeds: [],
    },
  };

  const day2Built = buildContentStore(day2Collection, day2StoreDir);
  const loadedPool = loadBacklogPool(stateDir, { reportDate: '2026-11-11' });
  assert.equal(loadedPool.entries.length, 2);

  const mergedStats = mergeBacklogIntoTopics(day2Built.topics, loadedPool.entries, day2StoreDir, { reportDate: '2026-11-11' });
  assert.equal(mergedStats.recalledStandalone, 1, 'Anthropic Engineering recalled standalone from backlog');
  assert.equal(mergedStats.accumulatedWithFresh, 1, 'Simon Willison post accumulated new Day 2 X observation');

  const sqliteTopic = day2Built.topics.find(tp => tp.primaryUrl.includes('simonwillison.net'));
  assert.equal(sqliteTopic.fanIn, 2, 'Cross-day fanIn accumulated from 1 to 2');
  assert.equal(sqliteTopic.metrics.bookmarks, 95, 'Peak bookmarks preserved across days');

  const anthropicTopic = day2Built.topics.find(tp => tp.primaryUrl.includes('anthropic.com/engineering'));
  assert.equal(anthropicTopic.fromBacklog, true);
  assert.equal(anthropicTopic.contentStatus, 'full_text', 'Cached full text reused without re-fetching');

  // An explicit short TTL still works for callers that configure it.
  const expiredCheck = loadBacklogPool(stateDir, { reportDate: '2026-11-19', maxAgeDays: 7 });
  assert.equal(expiredCheck.entries.length, 0);
  assert.equal(expiredCheck.expiredCount, 2);

  const lastDay = '2027-11-10';
  const yearOldPool = loadBacklogPool(stateDir, { reportDate: lastDay });
  assert.equal(yearOldPool.entries.length, 2);
  const recalled = [];
  const recallStoreDir = path.join(dir, 'year-old-store');
  mergeBacklogIntoTopics(recalled, yearOldPool.entries, recallStoreDir, { reportDate: lastDay });
  assert.ok(recalled.some(topic => !topic.deferredByLlm && topic.priorScore < 5.5));
  for (const topic of recalled) topic._storeDir = recallStoreDir;
  assert.equal(saveBacklogPool(stateDir, { reportDate: lastDay, topics: recalled }).savedCount, 2);
  const yearExpired = loadBacklogPool(stateDir, { reportDate: '2027-11-11' });
  assert.equal(yearExpired.entries.length, 0);
  assert.equal(yearExpired.expiredCount, 2);
});

test('backlog defaults to 1,000 candidates and retains the highest-scoring entries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-backlog-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportDate = '2026-11-12';
  const topics = Array.from({ length: 1001 }, (_, index) => ({
    topicId: `topic-${index}`,
    title: `Candidate ${index}`,
    primaryUrl: `https://engineering.example/articles/${index}`,
    priorScore: 6 + index / 1000,
  }));
  assert.equal(saveBacklogPool(dir, { reportDate, topics }).savedCount, 1000);
  const { entries } = loadBacklogPool(dir, { reportDate });
  assert.equal(entries.length, 1000);
  assert.equal(entries[0].title, 'Candidate 1000');
  assert.equal(entries.at(-1).title, 'Candidate 1');
});

test('reader domain calibration downweights robotics/embodied AI, avoids false positives, re-scores legacy backlog robotics, and caps Breakthrough Research robotics', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-domain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Robotics / VLA / Embodied AI receives explicit -3.5 penalty even if mentioning memory or RL keywords.
  const vlaPaper = scoreTopicPrior({
    title: 'Temporal Shortcut in RoboMME Memory-Augmented VLA Policies',
    category: 'paper',
    primaryUrl: 'https://huggingface.co/papers/2611.20001',
    sources: ['Hugging Face Daily Papers'],
    fanIn: 1,
    metrics: { upvotes: 60 },
    cards: [{ author: 'robotics_lab', tldr: 'Agent memory in bimanual manipulation policies fails under pause injection.' }],
  });
  assert.equal(vlaPaper.signals.domainTag, 'robotics_embodied');
  assert.equal(vlaPaper.signals.domainAdjustment, -3.5);

  const agentMemoryPaper = scoreTopicPrior({
    title: 'WikiTrace: Linking Agent Memory Rules Back to Raw Execution Trajectories',
    category: 'paper',
    primaryUrl: 'https://huggingface.co/papers/2611.20002',
    sources: ['Hugging Face Daily Papers'],
    fanIn: 1,
    metrics: { upvotes: 60 },
    cards: [{ author: 'ml_lab', tldr: 'Agent memory with verifiable tool-use trajectories reduces memory-induced degradation.' }],
  });
  assert.equal(agentMemoryPaper.signals.domainTag, 'core_ml_systems');
  assert.equal(agentMemoryPaper.signals.domainAdjustment, 1.2);
  assert.ok(agentMemoryPaper.priorScore >= vlaPaper.priorScore + 4.5,
    `Core agent/systems paper (${agentMemoryPaper.priorScore}) must clearly outrank equal-upvote VLA robotics paper (${vlaPaper.priorScore})`);

  // 2. False-positive immunity: BotPsy, robots.txt, RoBERTa, robustness are NOT misclassified as robotics.
  for (const nonRobotics of [
    { title: 'BotPsy: 0.8B Personal Assistant Model for Edge Function Calling', cards: [{ tldr: 'Qwen3.5-0.8B assistant bot' }] },
    { title: 'Respecting robots.txt in Distributed Web Crawlers', cards: [{ tldr: 'HTTP crawler politeness rules' }] },
    { title: 'Robustness of RoBERTa Under Adversarial Token Perturbations', cards: [{ tldr: 'Masked LM evaluation' }] },
  ]) {
    assert.equal(isRoboticsEmbodiedTopic(nonRobotics), false, `Should not flag "${nonRobotics.title}" as robotics`);
  }
  assert.equal(isRoboticsEmbodiedTopic({ title: '具身智能双臂机械臂仿真迁移研究', cards: [{ tldr: '灵巧手抓取策略' }] }), true);

  // 3. Legacy robotics items stored in backlog-pool.json with deferredByLlm:true lose llmCarryBonus and get -3.5 on recall.
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog-pool.json'), JSON.stringify({
    schemaVersion: 1,
    date: '2026-11-11',
    count: 1,
    items: [{
      id: 'legacy-robo-1',
      title: 'RoboScript: World In-Context Learning on RoboTwin 2.0 Bimanual Manipulation',
      author: 'lab',
      category: 'paper',
      primaryUrl: 'https://arxiv.org/abs/2611.19999',
      allObservedUrls: ['https://arxiv.org/abs/2611.19999'],
      publishedAt: '2026-11-09T00:00:00Z',
      firstSeenDate: '2026-11-10',
      fanIn: 1,
      sources: ['Hugging Face Daily Papers'],
      metrics: { upvotes: 80 },
      priorScore: 7.5,
      deferredByLlm: true,
      deferredReason: 'Legacy uncalibrated deferral',
      tldr: 'Sim-to-real bimanual manipulation rehearsal',
      modelShareable: true,
    }],
  }, null, 2));

  const loaded = loadBacklogPool(stateDir, { reportDate: '2026-11-12' });
  const topics = [{
    topicId: 'topic-fresh-rl',
    title: 'GRPO Rollout Concurrency and Verifiable Reward Scaling',
    category: 'paper',
    primaryUrl: 'https://arxiv.org/abs/2611.20100',
    allObservedUrls: ['https://arxiv.org/abs/2611.20100'],
    sources: ['Hugging Face Daily Papers'],
    fanIn: 1,
    metrics: { upvotes: 25 },
    dedupStatus: 'fresh',
    cards: [{ author: 'rl_author', tldr: 'Distributed RL rollout scheduling for reasoning models' }],
  }];
  mergeBacklogIntoTopics(topics, loaded.entries, path.join(dir, 'store'), { reportDate: '2026-11-12' });
  const recalledRobo = topics.find(tp => tp.title.includes('RoboScript'));
  const freshRl = topics.find(tp => tp.title.includes('GRPO'));
  assert.equal(recalledRobo.curationSignals.llmCarryBonus, undefined, 'Legacy deferredByLlm bonus suppressed for robotics');
  assert.equal(recalledRobo.curationSignals.domainTag, 'robotics_embodied');
  assert.ok(freshRl.priorScore > recalledRobo.priorScore, `Fresh RL paper (${freshRl.priorScore}) outranks recalled robotics paper (${recalledRobo.priorScore})`);

  // 4. Heuristic selector prefers non-robotics research first and caps robotics at <= 1 even when flooded with robotics papers.
  const floodedPool = [
    ...Array.from({ length: 4 }, (_, i) => ({
      topicId: `robo-${i + 1}`,
      title: `Humanoid Dexterous Manipulation Policy ${i + 1}`,
      category: 'paper',
      primaryUrl: `https://arxiv.org/abs/2611.3000${i}`,
      sources: [`Robotics Feed ${i + 1}`],
      priorScore: 9.0 - i * 0.2,
      dedupStatus: 'fresh',
      cards: [{ author: 'robo_lab', tldr: 'Robot arm teleoperation and sim-to-real grasping' }],
    })),
    {
      topicId: 'ml-paper-1',
      title: 'Token Pooling-Aware Multi-Vector Retrieval Training',
      category: 'paper',
      primaryUrl: 'https://arxiv.org/abs/2611.30100',
      sources: ['ML Feed'],
      priorScore: 6.5,
      dedupStatus: 'fresh',
      cards: [{ author: 'ml_researcher', tldr: 'Straight-through estimator over hierarchical token clusters' }],
    },
  ];
  const picked = selectTopicsHeuristic(floodedPool, { maxDeep: 5, maxQuick: 0, maxPerSource: 2 });
  const pickedRobotics = picked.filter(p => p.topicId.startsWith('robo-'));
  assert.ok(picked.some(p => p.topicId === 'ml-paper-1'), 'Core ML paper is selected ahead of extra robotics papers');
  assert.equal(pickedRobotics.length, 1, 'At most 1 robotics paper can enter Deep Dive even under a robotics-heavy pool');
});

test('inline URLs in supplement/article bodies enter observedUrls, stale watch tweets decay, and Good/Bad editorial benchmark passes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-v2-eval-suite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Plain-text URLs inside a supplement body enter card.outboundUrls -> topic.allObservedUrls -> validateV2Digest allowlist!
  const inlineScriptUrl = 'https://raw.githubusercontent.com/huggingface/sentence-transformers/main/examples/multi_vector_encoder/training/token_pooling/training_cached_contrastive.py';
  const built = buildContentStore(
    { schemaVersion: 1, collectionId: 'inline-url-col', date: '2026-11-12', sources: {} },
    path.join(dir, 'store'),
    {
      supplements: [{
        title: 'Token Pooling-Aware Training',
        url: 'https://huggingface.co/blog/token-pooling',
        text: `Full training recipe and script at ${inlineScriptUrl}.`,
        publishedAt: '2026-11-11T10:00:00Z',
        links: [],
      }],
    },
  );
  assert.ok(built.topics[0].allObservedUrls.includes(inlineScriptUrl), 'Inline body URL must be registered as observed');

  // 2. Stale watch-profile tweet from months ago receives publication-age decay and never outranks fresh technical items.
  const staleWatch = scoreTopicPrior({
    title: 'Andrej Karpathy @karpathy · Jun 13 In awe of SpaceX',
    category: 'general',
    primaryUrl: 'https://x.com/karpathy/status/1',
    publishedAt: '2026-06-13T17:45:00Z',
    sources: ['watch:@karpathy'],
    fanIn: 1,
    metrics: { likes: 5000, bookmarks: 800 },
    cards: [{ author: 'karpathy', tldr: 'Months-old tweet' }],
  }, undefined, { reportDate: '2026-11-12' });
  const freshTheory = scoreTopicPrior({
    title: 'Scaling Laws and Optimization Dynamics Under Synthetic Data',
    category: 'paper',
    primaryUrl: 'https://arxiv.org/abs/2611.99999',
    publishedAt: '2026-11-11T08:00:00Z',
    sources: ['Hugging Face Daily Papers'],
    fanIn: 1,
    metrics: { upvotes: 35 },
    cards: [{ author: 'theory_lab', tldr: 'Training dynamics and generalization' }],
  }, undefined, { reportDate: '2026-11-12' });
  assert.equal(staleWatch.signals.ageDecay, 15);
  assert.equal(freshTheory.signals.domainTag, 'intelligence_theory');
  assert.ok(freshTheory.priorScore > staleWatch.priorScore,
    `Fresh training-theory paper (${freshTheory.priorScore}) must outrank 5-month-old watch tweet (${staleWatch.priorScore})`);

  // 3. Good/Bad benchmark dataset (`examples/editorial-eval-cases.json`) passes 100% of assertions!
  const bench = runEditorialBenchmarkSuite();
  assert.equal(bench.allPassed, true, JSON.stringify(bench.results.filter(r => !r.passed), null, 2));
  assert.ok(bench.total >= 9);

  // 4. Digest-level evaluator catches excess robotics + strawman tails on uncalibrated drafts.
  const badDigestEval = evaluateDigestMarkdown([
    '# X AI 日报 2026-11-12',
    '',
    '## Breakthrough Research',
    '- **[Lab A · Robo1]：双臂机器人抓取策略。** 11 月 10 日发布，在机械臂仿真环境中训练动作策略，成功率从 50% 提升到 80%，覆盖 50 项双臂操作任务与随机化照明条件，并在真机上做了初步演示。这只是功能开放，不代表效果已验证。 [论文](https://arxiv.org/abs/2611.00011)',
    '- **[Lab B · Robo2]：人形机器人全身运动控制。** 11 月 10 日发布，在四足与人形机器人仿真中引入全身控制奖励，成功率提升 15 个百分点，覆盖楼梯与复杂地形测试，验证了多关节协同稳定性与零样本抗扰能力。 [论文](https://arxiv.org/abs/2611.00012)',
  ].join('\n'));
  assert.equal(badDigestEval.digestPassed, false);
  assert.equal(badDigestEval.deepRoboticsCount, 2);
  assert.ok(badDigestEval.digestIssues.some(i => i.startsWith('excess_robotics_in_deep')));
});

test('Nov 13 Codex failure regressions: HF/arXiv abstract pages never masquerade as full_text, arXiv /html/ upgrades cleanly with /abs/ fallback, and X span telemetry never claims continuous coverage', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-nov13-regressions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(isAbstractLandingUrl('https://huggingface.co/papers/2611.13766'), true);
  assert.equal(isAbstractLandingUrl('https://arxiv.org/abs/2611.13766'), true);
  assert.equal(isAbstractLandingUrl('https://arxiv.org/html/2611.13766v1'), false);
  assert.equal(isAbstractLandingUrl('https://pytorch.org/blog/helion/'), false);

  // 1. Paper A has /html/ available -> upgrades to full_text; Paper B returns 404 on /html/ and falls back to /abs/ -> stays abstract_only even if >1200 chars of chrome!
  const topics = [
    {
      topicId: 'paper-html-ok',
      title: 'Paper With HTML Full Text',
      category: 'paper',
      primaryUrl: 'https://huggingface.co/papers/2611.10001',
      allObservedUrls: ['https://huggingface.co/papers/2611.10001'],
      contentStatus: 'abstract_only',
      cards: [{ kind: 'feed', url: 'https://huggingface.co/papers/2611.10001', contentStatus: 'abstract_only', sourceLabel: 'HF' }],
    },
    {
      topicId: 'fame-qp-abstract-only',
      title: 'FAME-QP: Dense QP Solver',
      category: 'paper',
      fetchedArticle: { url: 'https://huggingface.co/papers/2611.13766', contentStatus: 'full_text', modelShareable: true },
      primaryUrl: 'https://huggingface.co/papers/2611.13766',
      allObservedUrls: ['https://huggingface.co/papers/2611.13766'],
      contentStatus: 'full_text',
      cards: [{ kind: 'feed', url: 'https://huggingface.co/papers/2611.13766', contentStatus: 'abstract_only', sourceLabel: 'HF' }],
    },
  ];
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });

  const stats = await enrichTopicsWithFullText(topics, dir, {
    fetchImpl: async url => {
      if (url === 'https://arxiv.org/html/2611.10001') {
        return new Response(`<html><body><article>${'Full theorem proof and experimental setup. '.repeat(50)}</article></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url === 'https://arxiv.org/html/2611.13766') {
        return new Response('Not Found', { status: 404 });
      }
      if (url === 'https://arxiv.org/abs/2611.13766') {
        return new Response(`<html><body><main>${'Abstract and long author/navigation metadata on landing page. '.repeat(40)}</main></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(stats.fullText, 1);
  assert.equal(stats.snippetOnly, 1);
  assert.equal(topics[0].contentStatus, 'full_text');
  assert.equal(topics[1].contentStatus, 'abstract_only', 'Landing /abs/ page must never be promoted to full_text');

  // modelTopic projection must also preserve abstract_only rather than blindly overwriting with full_text!
  const projectedOk = modelTopic(topics[0]);
  const projectedAbs = modelTopic(topics[1]);
  assert.equal(projectedOk.contentStatus, 'full_text');
  assert.equal(projectedAbs.contentStatus, 'abstract_only');

  // 2. X Following partial span telemetry wording states observed span + unverified traversal, never "仅覆盖近 Xh".
  const tel = buildTelemetry({
    date: '2026-11-13',
    sources: [{ id: 'xFollowing', label: 'X Following', kind: 'x', status: 'partial', items: 12, observedSpanHours: 20.6, stopReason: 'bounded_browser_capture' }],
    funnel: { rawItems: 12, clusteredTopics: 10, screenSelectedTopics: 4, publishedDeepDive: 3, publishedQuickHits: 1 },
  });
  const xWarn = tel.recommendations.find(r => r.target === 'xFollowing');
  assert.ok(xWarn);
  assert.ok(!xWarn.reason.includes('仅覆盖近'), `Must not claim continuous coverage: ${xWarn.reason}`);
  assert.match(xWarn.reason, /观察帖子时间跨度约 20\.6h.*非连续完整遍历/);
});

test('model projection rejects stale explicit full-text labels on paper landing pages', () => {
  const url = 'https://huggingface.co/papers/2611.13766';
  const projected = modelTopic({
    primaryUrl: url,
    cards: [{ kind: 'feed', url, contentStatus: 'abstract_only' }],
    fetchedArticle: { url, modelShareable: true, contentStatus: 'full_text', charCount: 4000 },
  });
  assert.equal(projected.contentStatus, 'abstract_only');
  assert.equal(projected.fetchedArticle.contentStatus, 'abstract_only');
});

test('arXiv server errors preserve failure status instead of falling back to an abstract', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-arxiv-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const urls = [];
  const topics = [{ topicId: 'paper-error', primaryUrl: 'https://arxiv.org/abs/2611.13766',
    allObservedUrls: [], contentStatus: 'abstract_only', cards: [] }];
  const stats = await enrichTopicsWithFullText(topics, dir, { fetchImpl: async url => {
    urls.push(url);
    return new Response('Unavailable', { status: 503 });
  } });
  assert.deepEqual(urls, ['https://arxiv.org/html/2611.13766']);
  assert.equal(stats.failed, 1);
  assert.equal(stats.fullText, 0);
});

test('original-source enrichment uses bounded parallel requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-parallel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let active = 0, peak = 0;
  const topics = Array.from({ length: 7 }, (_, index) => ({ topicId: 'parallel-' + index,
    primaryUrl: 'https://example.com/article-' + index, allObservedUrls: [], contentStatus: 'snippet_only' }));
  const stats = await enrichTopicsWithFullText(topics, dir, { concurrency: 3, fetchImpl: async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return new Response('<article>' + 'Synthetic article text. '.repeat(100) + '</article>');
  } });
  assert.equal(peak, 3);
  assert.equal(stats.fullText, 7);
});
