import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContentStore } from '../content-store.mjs';
import { scoreTopicPrior } from '../curation.mjs';
import { buildTelemetry, collectSourceStatuses, renderCompactTelemetryLine } from '../telemetry.mjs';
import { validateFeedConfig } from '../feed-import.mjs';
import { evaluateBulletProse } from '../editorial-eval.mjs';
import { isQuickHitEligible, selectTopicsHeuristic } from '../run-daily.mjs';

test('the fetched original behind one post is not a second share', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-quality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const article = 'https://news.example/story/unrelated-film';
  const post = url => ({ url, text: `Worth a look ${article}`, publishedAt: '2026-11-13T08:00:00Z', links: [{ text: 'story', href: article }] });
  const supplements = [{ title: 'Unrelated film', url: article, text: 'A film announcement. '.repeat(60), publishedAt: '2026-11-13T07:00:00Z', links: [] }];
  const collection = xFollowing => ({ schemaVersion: 1, collectionId: 'fan-in', date: '2026-11-14', sources: { xFollowing } });

  const single = buildContentStore(collection([post('https://x.com/someone/status/1')]), path.join(dir, 'single'), { supplements });
  assert.equal(single.topics.find(topic => topic.allObservedUrls.includes(article)).fanIn, 1);

  const shared = buildContentStore(collection([post('https://x.com/someone/status/1'), post('https://x.com/another/status/2')]),
    path.join(dir, 'shared'), { supplements });
  assert.equal(shared.topics.find(topic => topic.allObservedUrls.includes(article)).fanIn, 2);
});

test('a trusted author lifts on-topic work, not an off-topic share', () => {
  const base = { primaryUrl: 'https://x.com/karpathy/status/1', sources: ['x'], fanIn: 1 };
  const offTopic = scoreTopicPrior({ ...base, title: 'My video channel tier list', category: 'general',
    cards: [{ author: 'karpathy', kind: 'x', tldr: 'Favourite woodworking and cooking channels this year' }] });
  const onTopic = scoreTopicPrior({ ...base, title: 'LLM inference serving latency on GPU kernels', category: 'infra_eng',
    cards: [{ author: 'karpathy', kind: 'x', tldr: 'Notes on vLLM serving throughput and KV cache reuse' }] });
  assert.equal(offTopic.signals.authorTier, 'S');
  assert.equal(offTopic.signals.authorOffTopic, true);
  assert.equal(onTopic.signals.authorOffTopic, undefined);
  assert.ok(offTopic.signals.authorBoost < onTopic.signals.authorBoost / 2);
  assert.ok(onTopic.priorScore > offTopic.priorScore + 4);
});

test('a blog post without a publication date is not scored as fresh', () => {
  const blogTopic = publishedAt => ({ title: 'Lab post', category: 'essay', primaryUrl: 'https://lab.example/blog/post', sources: ['Thinking Machines'],
    fanIn: 1, publishedAt, cards: [{ author: 'Thinking Machines', kind: 'blog', tldr: 'A lab post' }] });
  const dated = scoreTopicPrior(blogTopic('2026-11-13T00:00:00Z'), undefined, { reportDate: '2026-11-14' });
  const undated = scoreTopicPrior(blogTopic(null), undefined, { reportDate: '2026-11-14' });
  assert.equal(dated.signals.ageDecay, undefined);
  assert.ok(undated.signals.ageDecay > 0);
  assert.ok(undated.priorScore < dated.priorScore);
  // A feed entry always carries its own date handling; only blog-index captures are affected.
  const undatedFeed = scoreTopicPrior({ ...blogTopic(null), cards: [{ author: 'x', kind: 'feed', tldr: 'entry' }] }, undefined, { reportDate: '2026-11-14' });
  assert.equal(undatedFeed.signals.ageDecay, undefined);
});

test('telemetry separates a dead feed from a quiet one and an empty blog from an unattempted one', () => {
  const collection = {
    collectedAt: '2026-11-14T10:00:00Z', sources: { xFollowing: [], blogs: [] }, warnings: [],
    checks: {
      feeds: {
        'Dead Feed': { attempted: true, items: 0, status: 'ok', newestEntryAt: '2025-09-16T00:00:00Z' },
        'Quiet Author': { attempted: true, items: 0, status: 'ok', newestEntryAt: '2026-07-04T00:00:00Z', staleAfterDays: 365 },
        'Fresh Feed': { attempted: true, items: 2, status: 'ok', newestEntryAt: '2026-11-13T00:00:00Z' },
      },
      blogs: { 'Moved Blog': { attempted: true, items: 0, status: 'no_candidates' } },
    },
  };
  const configuredSources = { xFollowing: false,
    feeds: [{ name: 'Dead Feed' }, { name: 'Quiet Author' }, { name: 'Fresh Feed' }],
    blogs: [{ name: 'Moved Blog' }, { name: 'Never Opened' }] };
  const rows = collectSourceStatuses(collection, { configuredSources });
  const row = id => rows.find(entry => entry.id === id);
  assert.equal(row('feed:Dead Feed').newestEntryAgeDays, 424);
  assert.equal(row('blog:Moved Blog').status, 'empty');
  assert.equal(row('blog:Never Opened').status, 'unattempted');

  const telemetry = buildTelemetry({ date: '2026-11-14', sources: rows });
  const stale = telemetry.recommendations.find(entry => entry.target === 'stale_feeds');
  assert.match(stale.reason, /Dead Feed（最新条目距今 424 天）/);
  assert.doesNotMatch(stale.reason, /Quiet Author|Fresh Feed/);
  const unattempted = telemetry.recommendations.find(entry => entry.target === 'unattempted_sources');
  assert.match(unattempted.reason, /Never Opened/);
  assert.doesNotMatch(unattempted.reason, /Moved Blog/);
});

test('feed config rejects a non-positive staleness threshold', () => {
  const feed = { name: 'Feed', url: 'https://feed.example/rss.xml', kind: 'rss', maxItems: 3 };
  assert.doesNotThrow(() => validateFeedConfig({ feeds: [{ ...feed, staleAfterDays: 365 }] }));
  for (const staleAfterDays of [0, -1, 1.5, '30']) {
    assert.throws(() => validateFeedConfig({ feeds: [{ ...feed, staleAfterDays }] }), /staleAfterDays/);
  }
});

test('compact telemetry line summarizes OK vs WARN cleanly and prose evaluator catches mistranslated 重数量化', () => {
  const okLine = renderCompactTelemetryLine(buildTelemetry({
    date: '2026-11-14',
    sources: [{ id: 'feed:OpenAI', label: 'OpenAI News', kind: 'feed', status: 'ok', items: 2 }],
    funnel: { rawItems: 10, clusteredTopics: 8, publishedDeepDive: 5, publishedQuickHits: 3, publishedTotal: 8 },
  }));
  assert.match(okLine, /^本次采集范围与运行自检 \[OK\]：可用信源 1\/1/);
  assert.ok(!okLine.includes('关注：'));

  const warnLine = renderCompactTelemetryLine(buildTelemetry({
    date: '2026-11-14',
    sources: [
      { id: 'feed:OpenAI', label: 'OpenAI News', kind: 'feed', status: 'ok', items: 2 },
      { id: 'blog:Missing', label: 'Missing Blog', kind: 'blog', status: 'unattempted', items: 0 },
    ],
    funnel: { rawItems: 10, clusteredTopics: 8, publishedDeepDive: 5, publishedQuickHits: 3, publishedTotal: 8 },
  }));
  assert.match(warnLine, /^本次采集范围与运行自检 \[WARN\]：.*关注：.*Missing Blog/);

  const badBullet = '- **[Test · Quant]：通过重数量化保持期望一致的反向训练配方。** 11 月 14 日发布，面向 Inkling 2 Small 模型，对转置张量做反量化后再以随机舍入转换至 MXFP8，在 8 张 GPU 上相比全 MXFP8 预训练提速 8%，计算效率开销约 2%，验证于标准 MoE 负载下。 [原文](https://example.invalid/quant)';
  const evalRes = evaluateBulletProse(badBullet, { tier: 'deep' });
  assert.equal(evalRes.passed, false);
  assert.ok(evalRes.issues.includes('mistranslated_jargon(重数量化)'));
});

test('content store isolates cross-linking newsletters/sponsors and does not let tweets or short captures forge full_text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-clustering-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const urlA = 'https://newsletter.example/p/software-factories';
  const urlB = 'https://blog.example/p/benchmark-noise-floor';
  const sponsorUrl = 'https://turbopuffer.com/pragmatic';
  const shortDeepUrl = 'https://short-deep.example/p/teaser';

  const collection = {
    schemaVersion: 1,
    collectionId: 'cluster-guard',
    date: '2026-11-19',
    sources: {
      feeds: [
        {
          feedName: 'Pragmatic',
          url: urlA,
          title: 'Software factories',
          text: 'A 189-char teaser introducing software factories before paywall.',
          publishedAt: '2026-11-19T06:00:00Z',
          links: [{ text: 'noise floor', href: urlB }, { text: 'sponsor', href: sponsorUrl }],
        },
        {
          feedName: 'Level5',
          url: urlB,
          title: 'Noise floor',
          text: 'Detailed methodology across 2400 runs comparing BF16 vs FP8. '.repeat(35),
          publishedAt: '2026-11-19T05:00:00Z',
          links: [{ text: 'factories', href: urlA }, { text: 'sponsor', href: sponsorUrl }],
        },
      ],
      xFollowing: [
        {
          url: 'https://x.com/gergely/status/1',
          text: `My new post on software factories ${urlA} explores PRs.\n`.repeat(30)
            + `\nBrought to you by:\n• Turbopuffer — ${sponsorUrl}\n`,
          publishedAt: '2026-11-19T07:00:00Z',
          links: [{ text: 'post', href: urlA }, { text: 'Turbopuffer', href: sponsorUrl }],
        },
        {
          url: 'https://x.com/other/status/2',
          text: `Check this teaser ${shortDeepUrl}`,
          publishedAt: '2026-11-19T07:30:00Z',
          links: [{ text: 'teaser', href: shortDeepUrl }],
        },
      ],
      deepArticles: [
        { url: shortDeepUrl, sourceHref: shortDeepUrl, text: 'Short 31-char cookie gate page.' },
      ],
    },
  };

  const { topics } = buildContentStore(collection, dir, {
    supplements: [{ url: sponsorUrl, title: 'Turbopuffer Sponsor', text: 'Sponsor full text. '.repeat(80), links: [] }],
  });

  const topicA = topics.find(t => t.primaryUrl === urlA);
  const topicB = topics.find(t => t.primaryUrl === urlB);
  const topicShort = topics.find(t => t.primaryUrl === shortDeepUrl);
  assert.ok(topicA, 'newsletter A stays its own topic');
  assert.ok(topicB, 'newsletter B stays its own topic');
  assert.notEqual(topicA.topicId, topicB.topicId);
  assert.ok(topicA.cards.every(c => c.url !== sponsorUrl), 'sponsor supplement must not merge into newsletter A');
  const xCardA = topicA.cards.find(c => c.kind === 'x');
  assert.ok(xCardA && !xCardA.outboundUrls.includes(sponsorUrl), 'sponsor footer URL stripped from X card');
  assert.equal(topicA.contentStatus, 'snippet_only', 'long X post does not hide snippet_only article status');
  assert.equal(topicShort.contentStatus, 'snippet_only', '31-char deep capture cannot be labeled full_text');
});

test('isQuickHitEligible and selectTopicsHeuristic enforce strict 0-2 flagship Quick Hits bar', () => {
  assert.equal(isQuickHitEligible({ title: 'Fix KV cache bug', category: 'open_source', primaryUrl: 'https://github.com/sgl-project/sglang/pull/1234', sources: ['sglang'] }), false);
  assert.equal(isQuickHitEligible({ title: 'vLLM v0.12.1-rc1', category: 'open_source', primaryUrl: 'https://github.com/vllm-project/vllm/releases/tag/v0.12.1rc1', sources: ['vLLM'] }), false);
  assert.equal(isQuickHitEligible({ title: 'Random benchmark hype post', category: 'general', primaryUrl: 'https://x.com/someone/status/123', sources: ['x'] }), false);
  assert.equal(isQuickHitEligible({ title: 'OpenAI GPT-6 Release', category: 'product', primaryUrl: 'https://openai.com/index/gpt-6', sources: ['OpenAI News'] }), true);

  const mk = (id, title, url) => ({
    topicId: id, title, primaryUrl: url, priorScore: 10, dedupStatus: 'fresh', contentStatus: 'full_text',
    category: 'product', sources: ['OpenAI News'], cards: [{ author: 'OpenAI', tldr: title }],
  });
  const selection = selectTopicsHeuristic([
    mk('d1', 'Deep 1', 'https://a.example/1'), mk('d2', 'Deep 2', 'https://a.example/2'),
    mk('d3', 'Deep 3', 'https://a.example/3'), mk('d4', 'Deep 4', 'https://a.example/4'),
    mk('d5', 'Deep 5', 'https://a.example/5'),
    mk('q1', 'Gemini 4 API Launch', 'https://blog.google/gemini-4'),
    mk('q2', 'Qwen 3.6 Open Weights Release', 'https://qwenlm.github.io/qwen-3.6'),
    mk('q3', 'Claude 5 GA Release', 'https://anthropic.com/claude-5'),
  ], { maxDeep: 5 });
  const quickCount = selection.filter(item => item.tier === 'quick').length;
  assert.ok(quickCount <= 2, 'maxQuick defaults to 2');
});
