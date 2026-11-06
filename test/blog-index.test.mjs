import test from 'node:test';
import assert from 'node:assert/strict';
import { filterIndexLinks, indexLinksFromHtml } from '../collector.mjs';

// Synthetic index pages; no live page is fetched or rendered here.
const thinkingMachines = { name: 'Thinking Machines', type: 'html-index', indexUrl: 'https://thinkingmachines.ai/blog/', articleBaseUrl: 'https://thinkingmachines.ai/blog/', maxArticles: 3 };
const staticIndex = `<html><head><link rel="alternate" type="application/rss+xml" href="/blog/index.xml"></head><body><nav><a href="/">Home</a><a href="/blog/">Blog</a><a href="https://thinkingmachines.ai/blog">Blog</a></nav>
<a href="defeating-nondeterminism/">Defeating Nondeterminism</a>
<a href="/blog/lora-without-regret/">LoRA Without Regret</a>
<a href='/blog/lora-without-regret/#comments'>Comments</a>
<a href="https://thinkingmachines.ai/blog/modular-manifolds/?utm_source=x">Modular Manifolds</a>
<a href="https://other.example/blog/elsewhere/">Elsewhere</a>
<a href="http://thinkingmachines.ai/blog/insecure/">Insecure</a>
<a href="/blog/on-policy-distillation/">On-Policy Distillation</a></body></html>`;

test('static index with relative hrefs yields deduped article links under the base, capped', () => {
  const links = filterIndexLinks(indexLinksFromHtml(staticIndex), thinkingMachines);
  assert.deepEqual(links.map(link => link.url), [
    'https://thinkingmachines.ai/blog/defeating-nondeterminism/',
    'https://thinkingmachines.ai/blog/lora-without-regret/',
    'https://thinkingmachines.ai/blog/modular-manifolds/',
  ]);
  assert.ok(links.every(link => link.source === 'blog' && link.name === 'Thinking Machines'));
  const all = filterIndexLinks(indexLinksFromHtml(staticIndex), { ...thinkingMachines, maxArticles: 10 });
  assert.equal(all.length, 4);
  const pattern = filterIndexLinks(indexLinksFromHtml(staticIndex), { ...thinkingMachines, maxArticles: 10, articlePattern: '^/blog/lora-' });
  assert.deepEqual(pattern.map(link => link.url), ['https://thinkingmachines.ai/blog/lora-without-regret/']);
});

test('rendered anchors keep their text; a client-rendered shell with no article links yields none', () => {
  const engineering = { name: 'Anthropic Engineering', type: 'html-index', indexUrl: 'https://www.anthropic.com/engineering', articleBaseUrl: 'https://www.anthropic.com/engineering/', maxArticles: 3 };
  const rendered = [{ href: 'https://www.anthropic.com/engineering/synthetic-post', text: '  Synthetic\n post ' }, { href: 'https://www.anthropic.com/engineering', text: 'Engineering' }];
  assert.deepEqual(filterIndexLinks(rendered, engineering), [{ source: 'blog', name: 'Anthropic Engineering', title: 'Synthetic post', url: 'https://www.anthropic.com/engineering/synthetic-post' }]);
  const shell = `<html><head><script src="/_next/static/app.js"></script></head><body><a href="/">Home</a><a href="/engineering">Engineering</a><a href="/news/x">News</a><div id="root"></div></body></html>`;
  assert.deepEqual(filterIndexLinks(indexLinksFromHtml(shell), engineering), []);
  assert.deepEqual(filterIndexLinks([{ href: 'not a url::' }, null, {}], engineering), []);
});
