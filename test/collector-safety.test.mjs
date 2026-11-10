import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBlogArticle, fetchPublicResource, readBounded, deepReadResult, profileItemsFromFeedPage } from '../collector.mjs';

// Synthetic pages and mocked fetch only; nothing here touches the network or a browser.
const claim = 'Tiny models score <10% on X while humans score >90%';

test('blog extraction strips tags before decoding entities exactly once', () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Article","headline":"Latency <5 ms","datePublished":"2026-10-16T00:00:00Z"}</script></head>
    <body><nav>Menu &lt;skip&gt;</nav><article><h2>Result</h2><p>Tiny models score &lt;10% on X while humans score &gt;90%</p>
    <p>Escaped markup &amp;lt;b&amp;gt; stays literal</p><script>bad()</script></article><footer>foot</footer></body></html>`;
  const article = extractBlogArticle(html, { url: 'https://blog.example/a', title: 'fallback' });
  assert.equal(article.title, 'Latency <5 ms');
  assert.equal(article.publishedAt, '2026-10-16T00:00:00Z');
  assert.equal(article.content, `Result ${claim} Escaped markup &lt;b&gt; stays literal`);
  assert.equal(article.truncated, undefined);
  const long = extractBlogArticle(`<main>${'word '.repeat(4000)}</main>`, { url: 'https://blog.example/b' });
  assert.equal(long.content.length, 12000);
  assert.equal(long.truncated, true);
  const started = performance.now();
  extractBlogArticle(`${'<article '.repeat(40000)}${'<h1>'.repeat(40000)}${'<script type="application/ld+json">'.repeat(10000)}`, { url: 'https://blog.example/c' });
  assert.ok(performance.now() - started < 1000);
});

const response = (status, { body = '', headers = {} } = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers });

test('page-derived fetches refuse private hosts on every redirect hop and bound bodies', async () => {
  const seen = [];
  const routes = {
    'https://blog.example/ok': () => response(200, { body: 'fine' }),
    'https://blog.example/hop': () => response(302, { headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    'https://blog.example/loop': () => response(302, { headers: { location: '/hop2' } }),
    'https://blog.example/hop2': () => response(307, { headers: { location: 'https://127.0.0.1:9449/json/list' } }),
    'https://blog.example/huge': () => response(200, { body: new Uint8Array(2048) }),
    'https://blog.example/declared': () => response(200, { body: 'x', headers: { 'content-length': '999999' } }),
  };
  const fetchFn = async (url, options) => { seen.push(url); assert.equal(options.redirect, 'manual'); return routes[url](); };
  const ok = await fetchPublicResource(fetchFn, 'https://blog.example/ok');
  assert.equal(ok.bytes.toString(), 'fine');
  await assert.rejects(fetchPublicResource(fetchFn, 'https://blog.example/hop'), /insecure_protocol/);
  await assert.rejects(fetchPublicResource(fetchFn, 'https://blog.example/loop'), /ip_literal_host/);
  for (const url of ['http://127.0.0.1:9449/json/list', 'https://[::1]/', 'https://router.local/x', 'https://intranet/x']) {
    await assert.rejects(fetchPublicResource(fetchFn, url), /Refusing/);
  }
  assert.ok(!seen.some(url => /127\.0\.0\.1|169\.254|::1|\.local|intranet/.test(url)), seen.join(' '));
  await assert.rejects(fetchPublicResource(fetchFn, 'https://blog.example/huge', {}, { maxBytes: 1024 }), /exceeds 1024/);
  await assert.rejects(fetchPublicResource(fetchFn, 'https://blog.example/declared', {}, { maxBytes: 1024 }), /exceeds/);
  assert.equal((await readBounded(response(200, { body: 'abc' }), 3)).toString(), 'abc');
});

test('deep reads keep text only when the final page is still public HTTPS', () => {
  const link = { href: 'https://short.example/x', text: 'Synthetic research' };
  const page = { title: 'T', url: 'https://research.example/paper', text: 'body', truncated: false };
  assert.equal(deepReadResult(link, page), page);
  for (const url of ['http://127.0.0.1:9449/json/list', 'https://169.254.169.254/', 'http://research.example/', 'chrome-error://chromewebdata/']) {
    const result = deepReadResult(link, { ...page, url });
    assert.equal(result.text, undefined);
    assert.match(result.error, /refused URL/);
    assert.equal(result.url, link.href);
  }
});

test('watch profile items come from readFeedDom output: URL-keyed, dated, truncation flagged', () => {
  const warnings = [];
  const items = [
    { url: 'https://x.com/karpathy/status/2', text: 'long post', publishedAt: '2026-10-16T12:00:00.000Z', truncated: true, links: [] },
    { url: 'https://x.com/karpathy/status/1', text: 'undated', publishedAt: null, truncated: false, links: [] },
    { url: 'https://x.com/karpathy/status/0', text: 'beyond limit', publishedAt: null, truncated: false, links: [] },
  ];
  const kept = profileItemsFromFeedPage({ items, blocked: null, loading: false, empty: false, atEnd: false }, 2, 'Karpathy', warnings);
  assert.deepEqual(kept.map(item => item.url), ['https://x.com/karpathy/status/2', 'https://x.com/karpathy/status/1']);
  assert.equal(kept[0].truncated, true);
  assert.ok(warnings.some(warning => /1 post\(s\) truncated/.test(warning)));
  assert.ok(warnings.some(warning => /1 post\(s\) lack an observed date/.test(warning)));
  assert.deepEqual(profileItemsFromFeedPage({ items, blocked: 'login_required' }, 2, 'Karpathy', warnings), []);
  assert.ok(warnings.includes('Karpathy profile unavailable: login_required'));
  assert.deepEqual(profileItemsFromFeedPage(null, 2, 'Karpathy', warnings), []);
});
