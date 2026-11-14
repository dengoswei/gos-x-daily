import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContentStore } from '../content-store.mjs';
import { scoreTopicPrior } from '../curation.mjs';
import { buildTelemetry, collectSourceStatuses } from '../telemetry.mjs';
import { validateFeedConfig } from '../feed-import.mjs';

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
