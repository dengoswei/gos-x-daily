import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractThreadDiscoveries } from '../thread-discovery.mjs';
import { collectionFromBrowserArtifacts, verifyEvidenceFiles } from '../browser-artifacts.mjs';
import { makeRuntime } from '../runtime.mjs';

// All content, dates, identities, and screenshot bytes below are SYNTHETIC.
const screenshot = Buffer.from('SYNTHETIC screenshot bytes; not live evidence');
const sha256 = createHash('sha256').update(screenshot).digest('hex');
const capturedAt = '2026-10-30T03:05:00.000Z';
const evidence = (id, url) => ({ id, url, kind: 'screenshot', capturedAt, path: `evidence/${id}.png`, sha256 });
const post = (author, id, extra = {}) => ({ url: `https://x.com/${author}/status/${id}`, text: 'SYNTHETIC AI research context', publishedAt: '2026-10-29T13:00:00Z', ...extra });
const oldQuote = () => ({ url: 'https://x.com/old_author/status/100', text: 'SYNTHETIC Goodfire interpretability mechanism', publishedAt: '2026-10-15T10:00:00Z', links: [{ href: 'https://research.example/old-primary', text: 'AI research full text' }] });
const discovery = () => ({ schemaVersion: 1, pages: [{ evidenceId: 'thread', items: [
  post('root_author', '200'),
  post('cross_author', '201', { quotedPosts: [oldQuote()], links: [{ href: 'https://arxiv.org/abs/2601.00001' }] }),
] }] });
const fixture = () => ({
  schemaVersion: 1, transport: 'gos-supported-browser', startedAt: '2026-10-30T03:00:00.000Z', capturedAt,
  evidence: [evidence('following', 'https://x.com/home'), evidence('karpathy', 'https://x.com/karpathy'), evidence('thread', 'https://x.com/root_author/status/200')],
  feeds: {
    xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'following', items: [post('feed_author', '300')] }] },
    karpathy: { status: 'ok', pages: [{ evidenceId: 'karpathy', items: [post('karpathy', '301')] }] },
  }, threadDiscovery: discovery(),
});
const runtime = () => makeRuntime({ sources: { blogs: [], xiaohongshuProfiles: [] } }, { runId: 'SYNTHETIC-thread-test' });
const convert = bundle => collectionFromBrowserArtifacts(runtime(), bundle);

test('cross-author replies and all thread observations survive without same-author filtering', () => {
  const bundle = fixture();
  bundle.threadDiscovery.pages[0].items.push(post('another_author', '202'));
  bundle.threadDiscovery.pages.push({ evidenceId: 'thread', items: [post('cross_author', '201')] });
  const result = convert(bundle);
  assert.deepEqual(result.sources.threadContexts.map(item => item.authorHandle), ['root_author', 'cross_author', 'another_author', 'cross_author']);
  assert.equal(result.stats.threadObservations, 4);
  assert.equal(result.stats.xFollowing, 1);
  assert.equal(result.stats.freshXFollowing, 1);
});

test('old quote found in fresh discussion keeps three independent timestamps and discovery status', () => {
  const result = convert(fixture());
  const context = result.sources.threadContexts[1], quote = context.quotedPosts[0];
  assert.equal(context.publishedAt, '2026-10-29T13:00:00.000Z');
  assert.equal(quote.publishedAt, '2026-10-15T10:00:00.000Z');
  assert.equal(context.observedAt, capturedAt); assert.equal(quote.observedAt, capturedAt);
  assert.equal(context.dateStatus, 'in_window'); assert.equal(quote.discoveryOnly, true);
  const article = result.deepLinkAudit.find(link => link.href === 'https://research.example/old-primary');
  assert.equal(article.eligible, true); assert.equal(article.readStatus, 'not_read');
  assert.equal(article.discoveryContext.inWindowDiscussion, true);
  assert.equal(article.discoveryContext.quotedPublishedAt, quote.publishedAt);
  assert.equal(article.discoveryContext.contextPublishedAt, context.publishedAt);
  assert.ok(result.coverage.reports.xFollowing.every(report => report.scanned === false));
  assert.ok(!result.sources.xFollowing.some(item => item.url === quote.url));
});

test('multiple quoted posts and unknown references are retained without inferred dates or content', () => {
  const bundle = fixture();
  bundle.threadDiscovery.pages[0].items[1].publishedAt = null;
  bundle.threadDiscovery.pages[0].items[1].quotedPosts.push({ url: null, text: null, publishedAt: null,
    links: [{ href: 'https://arxiv.org/abs/2602.00002' }], unresolvedReason: 'SYNTHETIC quoted card hidden behind unavailable content' });
  bundle.threadDiscovery.pages[0].items[1].unresolvedReferences = [
    { text: 'SYNTHETIC missing referenced paper', reason: 'Exact URL was not visible' },
    { url: 'https://t.co/synthetic', text: 'SYNTHETIC unresolved short link', reason: 'Destination not opened' },
  ];
  const result = convert(bundle), context = result.sources.threadContexts[1];
  assert.equal(context.dateStatus, 'unknown'); assert.equal(context.publishedAt, null);
  assert.equal(context.quotedPosts.length, 2); assert.equal(context.quotedPosts[1].publishedAt, null);
  assert.equal(context.quotedPosts[1].text, null); assert.equal(context.quotedPosts[1].referenceStatus, 'unresolved');
  assert.equal(result.stats.threadQuotedPosts, 2); assert.equal(result.stats.unresolvedThreadReferences, 3);
  assert.equal(context.unresolvedReferences[0].url, null);
  assert.ok(result.deepLinkAudit.some(link => link.href === 'https://arxiv.org/abs/2602.00002'));
  assert.ok(result.deepLinkAudit.some(link => link.href === 'https://t.co/synthetic'));
  assert.ok(result.warnings.some(warning => warning.includes('3 thread/quote')));
});

test('older thread context is retained but never promoted to an in-window discussion', () => {
  const bundle = fixture(); bundle.threadDiscovery.pages[0].items[1].publishedAt = '2026-10-10T12:00:00Z';
  const result = convert(bundle);
  assert.equal(result.sources.threadContexts[1].dateStatus, 'outside_window');
  assert.equal(result.deepLinkAudit.find(link => link.href === 'https://research.example/old-primary').discoveryContext.inWindowDiscussion, false);
  assert.ok(result.coverage.reports.xFollowing.every(report => !report.scanned));
});

test('thread evidence must reference the actual local screenshot bytes and an X thread page', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-thread-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'evidence'));
  const bundle = fixture();
  for (const entry of bundle.evidence) fs.writeFileSync(path.join(root, entry.path), screenshot);
  assert.equal(verifyEvidenceFiles(bundle, root), true);
  assert.equal(convert(bundle).stats.threadObservations, 2);
  fs.writeFileSync(path.join(root, 'evidence/thread.png'), 'tampered');
  assert.throws(() => verifyEvidenceFiles(bundle, root), /hash mismatch/);
  for (const change of [
    b => { b.threadDiscovery.pages[0].evidenceId = 'missing'; },
    b => { b.evidence[2].url = 'https://x.com/home'; },
    b => { b.evidence[2].url = 'https://x.com.evil.example/root/status/200'; },
    b => { b.evidence[2].kind = 'transcription'; },
  ]) { const bad = fixture(); change(bad); assert.throws(() => convert(bad)); }
});

test('unsafe links, malformed objects, unversioned formats, and timestamp conflation fail closed', () => {
  const cases = [
    b => { b.threadDiscovery.schemaVersion = 2; },
    b => { delete b.threadDiscovery.schemaVersion; },
    b => { b.threadDiscovery.pages[0].items[0].observedAt = '2026-10-15T10:00:00Z'; },
    b => { b.threadDiscovery.pages[0].items[0].verified = true; },
    b => { b.threadDiscovery.pages[0].items[1].quotedPosts[0].quotedPosts = [oldQuote()]; },
    b => { b.threadDiscovery.pages[0].items[1].quotedPosts[0].url = null; b.threadDiscovery.pages[0].items[1].quotedPosts[0].text = null; },
    b => { b.threadDiscovery.pages[0].items[0].links = [{ href: 'javascript:alert(1)' }]; },
    b => { b.threadDiscovery.pages[0].items[0].links = [{ href: 'https://user:secret@example.com/article' }]; },
    b => { b.threadDiscovery.pages[0].items[1].quotedPosts[0].links = [{ href: 'http://example.com/insecure' }]; },
    b => { b.threadDiscovery.pages[0].items[0].url = 'https://x.com/a/status/1/unverified'; },
    b => { b.threadDiscovery.pages[0].items[0].publishedAt = '2026-10-30T05:00:00Z'; },
    b => { b.threadDiscovery.pages[0].items[1].quotedPosts[0].publishedAt = '2026-10-31T05:00:00Z'; },
    b => { b.threadDiscovery.pages[0].items[0].publishedAt = '2026-10-29'; },
    b => { b.threadDiscovery.pages[0].items = {}; },
  ];
  for (const change of cases) { const bad = fixture(); change(bad); assert.throws(() => convert(bad)); }
});

test('standalone extractor always reports discovery-only incomplete coverage and rejects getters', () => {
  const evidenceFor = (id, predicate) => {
    const entry = evidence('thread', 'https://x.com/root_author/status/200');
    assert.equal(id, 'thread'); assert.ok(predicate(new URL(entry.url))); return entry;
  };
  const options = { evidenceFor, window: { start: '2026-10-28T03:00:00Z', end: '2026-10-30T03:00:00Z' } };
  assert.deepEqual(extractThreadDiscoveries(discovery(), options).coverage, { scanned: false, reason: 'thread_discovery_not_interval_traversal' });
  const bad = discovery();
  Object.defineProperty(bad.pages[0].items[0], 'text', { get() { throw new Error('getter must never run'); } });
  assert.throws(() => extractThreadDiscoveries(bad, options), /Unsupported thread item field/);
});
