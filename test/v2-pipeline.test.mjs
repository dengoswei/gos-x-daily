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
  sendViaLarkCli,
} from '../telemetry.mjs';
import {
  buildContentStore,
  enrichTopicsWithFullText,
  loadTopicFullMaterial,
  buildAutoDispositions,
} from '../content-store.mjs';
import { parseFeedDocument, mergeFeedDocuments } from '../feed-import.mjs';
import { collectionFromBrowserArtifacts } from '../browser-artifacts.mjs';
import { compactCollection } from '../compose.mjs';
import { validateDispositions } from '../binding.mjs';
import { makeRuntime } from '../runtime.mjs';
import { runDailyV2, validateV2Digest } from '../run-daily.mjs';
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
  assert.match(panel, /原始入库 240 条 → 7日去重跳过 18 条 → 聚合 140 个话题 → 初筛入选 8 个 → 全文补齐 7\/8/);
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

test('end-to-end runDailyV2 produces two-tier digest, blocks leaked pipeline jargon, records history, and sends lark-cli alert on failure', async t => {
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

  const larkCalls = [];
  const mockSpawnSync = (executable, args) => {
    larkCalls.push({ executable, args });
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: `om_synth_${larkCalls.length}` } }) };
  };

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages?.[0]?.content ?? '';
    let replyText;
    if (sys.includes('Stage contract: topic selection (v2)')) {
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
    larkConfig: { enabled: true, executable: '/usr/local/bin/lark-cli', chatId: 'oc_synthetic_chat' },
    allowSend: true,
    runtimeHooks: { fetch: mockFetch, spawnSync: mockSpawnSync, now: '2026-11-11T01:00:00Z' },
  });

  assert.equal(result.status, 'completed_and_sent');
  assert.equal(result.funnel.publishedDeepDive, 1);
  assert.equal(result.funnel.publishedQuickHits, 1);
  assert.equal(larkCalls.length, 1);

  const finalDigest = fs.readFileSync(result.digestPath, 'utf8');
  assert.match(finalDigest, /## Breakthrough Research/);
  assert.match(finalDigest, /## Quick Hits \/ 快讯速览/);
  assert.match(finalDigest, /### 运行自检 \[OK\]/);
  assert.ok(!/所给摘录/.test(finalDigest));

  // Auto-generated dispositions covers every candidate key without asking the LLM to write it!
  const autoDisp = JSON.parse(fs.readFileSync(path.join(result.runDir, 'dispositions.json'), 'utf8'));
  const mergedCol = JSON.parse(fs.readFileSync(path.join(result.runDir, 'sources.merged.json'), 'utf8'));
  const dispValidation = validateDispositions(autoDisp, mergedCol, finalDigest.split('### 运行自检')[0] + '\n## 差异补充\naudit');
  assert.equal(dispValidation.included, 2);

  // Second run on the same day exits idempotently without re-sending.
  const secondRun = await runDailyV2({
    dataDir,
    sourcesConfig,
    modelsFile,
    feedArtifactsPath: feedBundlePath,
    fetchFullTextOnline: false,
    larkConfig: { enabled: true, executable: '/usr/local/bin/lark-cli', chatId: 'oc_synthetic_chat' },
    allowSend: true,
    runtimeHooks: { fetch: mockFetch, spawnSync: mockSpawnSync, now: '2026-11-11T02:00:00Z' },
  });
  assert.equal(secondRun.status, 'already_sent_today');
  assert.equal(larkCalls.length, 1);

  // Unrecoverable error on next day triggers guaranteed lark-cli alert card instead of silent failure!
  await assert.rejects(
    () => runDailyV2({
      dataDir,
      sourcesConfig,
      modelsFile,
      fetchFeedsOnline: false, // Neither browser nor feed artifacts supplied -> fatal empty collection
      larkConfig: { enabled: true, executable: '/usr/local/bin/lark-cli', chatId: 'oc_synthetic_chat' },
      allowSend: true,
      runtimeHooks: { fetch: mockFetch, spawnSync: mockSpawnSync, now: '2026-11-12T01:00:00Z' },
    }),
    err => {
      assert.equal(err.stage, 'collect_and_import');
      assert.equal(err.alertDelivery?.sent, true);
      assert.match(err.alertMarkdown, /X AI 日报运行告警 2026-11-12/);
      return true;
    },
  );
  assert.equal(larkCalls.length, 2);
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
  const publicFetchMock = async url => {
    // Only public article fetch is allowed; zero calls to api.openai.com!
    assert.ok(!String(url).includes('openai.com'));
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
  assert.match(finalMd, /原始入库 4 条 → 7日去重跳过 0 条 → 聚合 1 个话题 → 初筛入选 1 个 → 全文补齐 1\/1 → 成稿 1 条/);
});
