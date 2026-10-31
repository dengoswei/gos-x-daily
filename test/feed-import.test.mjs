import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFeedDocument, verifyDocumentFiles, mergeFeedDocuments, validateFeedConfig } from '../feed-import.mjs';
import { fetchFeeds } from '../tools/fetch-feeds.mjs';
import { collectionFromBrowserArtifacts } from '../browser-artifacts.mjs';
import { makeRuntime } from '../runtime.mjs';
import { composePrompt } from '../digest.mjs';
import { main } from '../cli.mjs';

// All feed documents in this file are synthetic fixtures, never live reads.
const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Synthetic</title>
<item><title><![CDATA[Fresh <b>post</b> &amp; more]]></title><link>https://blog.example/posts/fresh?utm_source=rss</link>
<pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate><description>&lt;p&gt;Body with &amp;amp; entity &#8212; and &#x2019;quote&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;</description></item>
<item><title>Older</title><link>https://blog.example/posts/older</link><dc:date>2026-10-16T08:00:00Z</dc:date><description>older body</description></item>
<item><title>Stale</title><link>https://blog.example/posts/stale</link><pubDate>Mon, 12 Oct 2026 12:00:00 GMT</pubDate></item>
<item><title>Undated</title><guid isPermaLink="true">https://blog.example/posts/undated</guid><content:encoded><![CDATA[<div>Encoded body</div>]]></content:encoded></item>
</channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Synthetic releases</title>
<entry><title>v1.2.0</title><link rel="related" href="https://code.example/related"/><link rel="alternate" type="text/html" href="https://code.example/releases/tag/v1.2.0"/>
<updated>2026-10-16T20:00:00Z</updated><content type="html">&lt;ul&gt;&lt;li&gt;Faster kernels&lt;/li&gt;&lt;/ul&gt;</content></entry>
</feed>`;
const papers = JSON.stringify([{ title: 'Paper A', publishedAt: '2026-10-10T00:00:00.000Z',
  paper: { id: '2610.00001', title: 'Paper A', summary: 'Summary <i>A</i>', publishedAt: '2026-10-10T04:00:00.000Z', submittedOnDailyAt: '2026-10-16T00:00:00.000Z' } }]);
const feeds = [
  { name: 'Synthetic RSS', url: 'https://blog.example/feed.xml', kind: 'rss', maxItems: 2 },
  { name: 'Synthetic Atom', url: 'https://code.example/releases.atom', kind: 'atom', maxItems: 5 },
  { name: 'Synthetic Papers', url: 'https://papers.example/api/daily', kind: 'hf-daily-papers', maxItems: 5 },
  { name: 'Synthetic Missing', url: 'https://missing.example/feed', kind: 'rss', maxItems: 5 },
];
const runtime = makeRuntime({ lookbackHours: 48, sources: { blogs: [], xiaohongshuProfiles: [], feeds } }, { runId: 'synthetic-feed-test' });
const shot = Buffer.from('synthetic screenshot fixture; not browser evidence');
const shotSha = createHash('sha256').update(shot).digest('hex');
const capturedAt = '2026-10-17T01:00:00.000Z';
const evidence = (id, url) => ({ id, url, kind: 'screenshot', capturedAt, path: `evidence/${id}.png`, sha256: shotSha });
const post = (id, url) => ({ url, text: 'SYNTHETIC technical post, not live evidence', publishedAt: '2026-10-16T12:00:00Z', links: [] });
const browserBundle = () => ({ schemaVersion: 1, transport: 'gos-supported-browser', startedAt: '2026-10-17T00:30:00.000Z', capturedAt,
  evidence: [evidence('following', 'https://x.com/home'), evidence('karpathy', 'https://x.com/karpathy')],
  feeds: { xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'following', items: [post('1', 'https://x.com/synthetic/status/1')] }] },
    karpathy: { status: 'ok', pages: [{ evidenceId: 'karpathy', items: [post('2', 'https://x.com/karpathy/status/2')] }] } } });
const collection = () => collectionFromBrowserArtifacts(runtime, browserBundle());
const sha = text => createHash('sha256').update(text).digest('hex');

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-feeds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'feeds'));
  const docs = [[feeds[0], 'feed-1.xml', rss], [feeds[1], 'feed-2.xml', atom], [feeds[2], 'feed-3.json', papers]];
  const bundle = { schemaVersion: 1, transport: 'fetched-documents', startedAt: '2026-10-17T00:40:00.000Z', fetchedAt: '2026-10-17T00:41:00.000Z',
    documents: docs.map(([feed, file, body], index) => {
      fs.writeFileSync(path.join(dir, 'feeds', file), body);
      return { id: `feed-${index + 1}`, feed: feed.name, url: feed.url, path: `feeds/${file}`, sha256: sha(body), fetchedAt: '2026-10-17T00:40:30.000Z', contentType: 'application/xml' };
    }) };
  return { dir, bundle };
}

test('RSS, Atom and daily-papers documents parse to plain text with explicit dates', () => {
  const items = parseFeedDocument(rss, 'rss');
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Fresh post & more');
  assert.equal(items[0].text, 'Body with & entity — and ’quote');
  assert.equal(items[0].publishedAt, '2026-10-16T12:00:00.000Z');
  assert.equal(items[1].publishedAt, '2026-10-16T08:00:00.000Z');
  assert.equal(items[3].url, 'https://blog.example/posts/undated');
  assert.equal(items[3].publishedAt, null);
  assert.equal(items[3].text, 'Encoded body');
  const [release] = parseFeedDocument(atom, 'atom');
  assert.equal(release.url, 'https://code.example/releases/tag/v1.2.0');
  assert.equal(release.text, 'Faster kernels');
  const [paper] = parseFeedDocument(papers, 'hf-daily-papers');
  assert.equal(paper.url, 'https://huggingface.co/papers/2610.00001');
  assert.equal(paper.text, 'Summary A');
  assert.equal(paper.publishedAt, '2026-10-16T00:00:00.000Z');
  assert.equal(paper.paperPublishedAt, '2026-10-10T04:00:00.000Z');
  const long = parseFeedDocument(`<rss><item><title>t</title><link>https://a.example/x</link><description>${'x'.repeat(9000)}</description></item></rss>`, 'rss');
  assert.equal(long[0].text.length, 4000);
});

test('malformed feed documents and unsafe entry URLs are rejected', () => {
  assert.throws(() => parseFeedDocument('<html><body>Just a moment...</body></html>', 'rss'), /not RSS\/Atom/);
  assert.throws(() => parseFeedDocument('<rss><item><title>x</title><link>http://a.example/x</link></item></rss>', 'rss'), /HTTPS/);
  assert.throws(() => parseFeedDocument('<rss><item><title>x</title><link>https://u:p@a.example/x</link></item></rss>', 'rss'), /HTTPS/);
  assert.throws(() => parseFeedDocument('<rss><item><title>x</title></item></rss>', 'rss'), /without a link/);
  assert.throws(() => parseFeedDocument('<rss><item><title>x</title><link>https://a.example/x</link><pubDate>someday</pubDate></item></rss>', 'rss'), /Unparseable/);
  assert.throws(() => parseFeedDocument('{"not":"array"}', 'hf-daily-papers'), /array/);
  assert.throws(() => parseFeedDocument('[{"paper":{"id":"../x"}}]', 'hf-daily-papers'), /paper id/);
  assert.throws(() => parseFeedDocument(rss, 'html'), /Unsupported/);
  assert.throws(() => validateFeedConfig({ feeds: [{ name: 'a', url: 'http://a.example', kind: 'rss', maxItems: 1 }] }), /HTTPS/);
  assert.throws(() => validateFeedConfig({ feeds: [{ name: 'a', url: 'https://a.example', kind: 'rss', maxItems: 0 }] }), /maxItems/);
  assert.throws(() => validateFeedConfig({ feeds: [feeds[0], feeds[0]] }), /unique/);
});

test('document hashing rejects tampering, missing files and path/symlink escapes', t => {
  const { dir, bundle } = fixtureDir(t);
  assert.equal(verifyDocumentFiles(bundle, dir), true);
  assert.throws(() => verifyDocumentFiles({ ...bundle, documents: [] }, dir), /required/);
  fs.writeFileSync(path.join(dir, bundle.documents[0].path), 'tampered');
  assert.throws(() => verifyDocumentFiles(bundle, dir), /hash mismatch/);
  bundle.documents[0].path = '../escape.xml';
  assert.throws(() => verifyDocumentFiles(bundle, dir), /inside the artifact/);
  bundle.documents[0].path = 'feeds/missing.xml';
  assert.throws(() => verifyDocumentFiles(bundle, dir), /ENOENT/);
  fs.symlinkSync('/etc/hostname', path.join(dir, 'feeds/escape.xml'));
  bundle.documents[0].path = 'feeds/escape.xml';
  assert.throws(() => verifyDocumentFiles(bundle, dir), /escaped/);
});

test('merge filters to the lookback window, caps newest first and records provenance without mutating input', t => {
  const { dir, bundle } = fixtureDir(t);
  bundle.failures = [];
  const input = collection();
  const before = JSON.stringify(input);
  const merged = mergeFeedDocuments(runtime, input, bundle, dir);
  assert.equal(JSON.stringify(input), before);
  for (const key of ['collectionId', 'date', 'digestMarker', 'collectedAt']) assert.equal(merged[key], input[key]);
  const rssItems = merged.sources.feeds.filter(item => item.feedName === 'Synthetic RSS');
  assert.deepEqual(rssItems.map(item => item.url), ['https://blog.example/posts/fresh?utm_source=rss', 'https://blog.example/posts/older']);
  assert.ok(merged.warnings.includes('Synthetic RSS capped at 2 items'));
  assert.deepEqual(Object.keys(rssItems[0]).sort(), ['evidenceId', 'feedName', 'links', 'publishedAt', 'source', 'text', 'title', 'url']);
  assert.equal(rssItems[0].source, 'feed');
  assert.equal(rssItems[0].evidenceId, 'feed-1');
  assert.equal(merged.stats.feeds, merged.sources.feeds.length);
  assert.equal(merged.stats.feeds, 4);
  assert.deepEqual(merged.checks.feeds['Synthetic Missing'], { attempted: false, items: 0, status: 'not_fetched' });
  assert.deepEqual(merged.checks.feeds['Synthetic Atom'], { attempted: true, items: 1, status: 'ok' });
  assert.ok(merged.warnings.includes('Synthetic Missing was not fetched in this run'));
  const fetched = merged.provenance.evidence.filter(entry => entry.kind === 'fetched_document');
  assert.deepEqual(fetched.map(entry => entry.id), ['feed-1', 'feed-2', 'feed-3']);
  assert.deepEqual(Object.keys(fetched[0]).sort(), ['capturedAt', 'id', 'kind', 'path', 'sha256', 'url']);
  assert.equal(merged.provenance.evidence.length, input.provenance.evidence.length + 3);
  assert.ok(composePrompt(merged).includes('Faster kernels'));

  const bare = collection(); delete bare.provenance;
  assert.equal(mergeFeedDocuments(runtime, bare, bundle, dir).provenance.evidence.length, 3);
  const undated = mergeFeedDocuments(makeRuntime({ lookbackHours: 48, sources: { feeds: [{ ...feeds[0], maxItems: 10 }] } }, { runId: 'synthetic-undated' }), collection(),
    { ...bundle, documents: [bundle.documents[0]] }, dir);
  assert.equal(undated.sources.feeds.at(-1).publishedAt, null);
  assert.ok(undated.warnings.some(warning => warning.includes('1 item(s) lack publication dates')));
});

test('merge rejects unconfigured, duplicate, out-of-run and mismatched feed captures', t => {
  const { dir, bundle } = fixtureDir(t);
  const cases = [
    [b => { b.documents[0].feed = 'Unknown'; }, /unconfigured feed/],
    [b => { b.documents[1].feed = b.documents[0].feed; }, /Duplicate document/],
    [b => { b.documents[1].id = b.documents[0].id; }, /duplicate feed document ID/],
    [b => { b.documents[0].id = 'following'; }, /duplicate feed document ID/],
    [b => { b.documents[0].url = 'https://blog.example/other.xml'; }, /does not match configured feed/],
    [b => { b.documents[0].fetchedAt = '2026-10-17T02:00:00Z'; }, /outside this fetch run/],
    [b => { b.startedAt = '2026-10-17T03:30:00Z'; b.fetchedAt = '2026-10-17T03:31:00Z'; }, /within two hours/],
    [b => { b.startedAt = '2026-10-16T22:00:00Z'; }, /within two hours|one run/],
    [b => { b.transport = 'gos-supported-browser'; }, /schema\/transport/],
    [b => { b.failures = [{ feed: 'Unknown', error: 'x' }]; }, /unconfigured feed/],
    [b => { b.failures = [{ feed: feeds[0].name, error: 'x' }]; }, /both fetched and failed/],
    [b => { b.documents = []; }, /required/],
  ];
  for (const [change, pattern] of cases) {
    const copy = structuredClone(bundle); change(copy);
    assert.throws(() => mergeFeedDocuments(runtime, collection(), copy, dir), pattern);
  }
  const twice = mergeFeedDocuments(runtime, collection(), bundle, dir);
  assert.throws(() => mergeFeedDocuments(runtime, twice, bundle, dir), /already contains/);
  const failed = mergeFeedDocuments(runtime, collection(), { ...bundle, failures: [{ feed: 'Synthetic Missing', url: feeds[3].url, error: 'HTTP 503' }] }, dir);
  assert.deepEqual(failed.checks.feeds['Synthetic Missing'], { attempted: true, items: 0, status: 'fetch_failed' });
  assert.ok(failed.warnings.includes('Synthetic Missing fetch failed: HTTP 503'));
});

test('fetch tool follows bounded HTTPS redirects, records failures and its bundle imports offline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'run');
  const sources = { feeds: [...feeds,
    { name: 'Downgrade', url: 'https://downgrade.example/feed', kind: 'rss', maxItems: 5 },
    { name: 'Loop', url: 'https://loop.example/feed', kind: 'rss', maxItems: 5 },
    { name: 'Html', url: 'https://html.example/feed', kind: 'rss', maxItems: 5 },
    { name: 'Huge', url: 'https://huge.example/feed', kind: 'rss', maxItems: 5 }] };
  const bodies = { 'https://blog.example/feed.xml': rss, 'https://code.example/releases/final.atom': atom, 'https://papers.example/api/daily': papers, 'https://html.example/feed': '<html>blocked</html>' };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === 'https://code.example/releases.atom') return new Response(null, { status: 301, headers: { location: '/releases/final.atom' } });
    if (url === 'https://downgrade.example/feed') return new Response(null, { status: 302, headers: { location: 'http://downgrade.example/feed' } });
    if (url.startsWith('https://loop.example/')) return new Response(null, { status: 307, headers: { location: `${url}x` } });
    if (url === 'https://missing.example/feed') return new Response('gone', { status: 404 });
    if (url === 'https://huge.example/feed') return new Response(new Uint8Array(9 * 1024 * 1024), { status: 200 });
    return new Response(bodies[url], { status: 200, headers: { 'content-type': 'application/xml' } });
  };
  let tick = Date.parse('2026-10-17T00:40:00.000Z');
  const result = await fetchFeeds(sources, out, { fetchImpl, clock: () => new Date(tick += 1000) });
  assert.equal(result.documents, 3);
  const bundle = JSON.parse(fs.readFileSync(path.join(out, 'feed-capture.json'), 'utf8'));
  assert.deepEqual(bundle.failures.map(f => [f.feed, /HTTP 404|non-HTTPS|redirects|not RSS|exceeds/.test(f.error)]),
    [['Synthetic Missing', true], ['Downgrade', true], ['Loop', true], ['Html', true], ['Huge', true]]);
  assert.equal(bundle.documents[1].finalUrl, 'https://code.example/releases/final.atom');
  await assert.rejects(fetchFeeds(sources, out, { fetchImpl }), /Refusing to replace/);

  fs.mkdirSync(path.join(out, 'evidence'));
  const browser = browserBundle();
  for (const entry of browser.evidence) fs.writeFileSync(path.join(out, entry.path), shot);
  fs.writeFileSync(path.join(out, 'browser-capture.json'), JSON.stringify(browser));
  const configFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(path.join(dir, 'sources.local.json'), JSON.stringify({ blogs: [], xiaohongshuProfiles: [], feeds: sources.feeds }));
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: path.join(dir, 'data'), lookbackHours: 48, sourcesFile: 'sources.local.json' }));
  const previousFetch = globalThis.fetch, previousWebSocket = globalThis.WebSocket;
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  globalThis.WebSocket = class { constructor() { throw new Error('browser connection forbidden'); } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.WebSocket = previousWebSocket; });
  await main(['import-browser', '--artifacts', path.join(out, 'browser-capture.json'), '--out', path.join(out, 'sources.json'), '--config', configFile]);
  const args = ['import-feed', '--artifacts', path.join(out, 'feed-capture.json'), '--sources', path.join(out, 'sources.json'), '--out', path.join(out, 'sources.merged.json'), '--config', configFile];
  const imported = await main(args);
  assert.equal(imported.status, 'feed_documents_imported');
  assert.equal(imported.stats.feeds, 4);
  assert.ok(imported.warnings.some(warning => warning.startsWith('Loop fetch failed')));
  await assert.rejects(main(args), /EEXIST/);
  fs.writeFileSync(path.join(out, 'feeds/feed-1.xml'), 'tampered');
  fs.rmSync(path.join(out, 'sources.merged.json'));
  await assert.rejects(main(args), /hash mismatch/);
  assert.equal(fs.existsSync(path.join(out, 'sources.merged.json')), false);
});

test('feed fetch started after the browser capture is accepted within two hours', t => {
  const { dir, bundle } = fixtureDir(t);
  bundle.startedAt = '2026-10-17T02:30:00.000Z'; bundle.fetchedAt = '2026-10-17T02:31:00.000Z';
  for (const document of bundle.documents) document.fetchedAt = '2026-10-17T02:30:30.000Z';
  assert.ok(mergeFeedDocuments(runtime, collection(), bundle, dir).stats.feeds > 0);
});
