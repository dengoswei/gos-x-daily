// SYNTHETIC ONLY: offline URL-binding and candidate-ledger gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalUrl, digestUrls, candidateKeys, observedUrls, validateUrlBinding, validateDispositions } from '../binding.mjs';
import { validateDigest, larkMarkdown } from '../digest.mjs';

const collection = {
  collectionId: 'SYNTHETIC-binding', digestMarker: '<!-- x-daily-collection: SYNTHETIC-binding -->', date: '2026-10-31',
  stats: { xFollowing: 2 },
  sources: {
    xFollowing: [
      { url: 'https://x.com/writer/status/111', text: 'SYNTHETIC', links: [{ href: 'https://www.example.org/paper/?utm_source=x' }] },
      { url: 'https://x.com/writer/status/222', text: 'SYNTHETIC duplicate' },
    ],
    karpathy: [{ url: 'https://x.com/karpathy/status/333', text: 'SYNTHETIC' }],
    blogs: [{ url: 'https://blog.example.org/post-a', text: 'SYNTHETIC' }],
    deepArticles: [{ url: 'https://example.org/deep', sourceHref: 'https://t.co/abc', text: 'SYNTHETIC' }],
    xiaohongshu: [{ notes: [{ url: 'https://www.xiaohongshu.com/explore/n1', links: [{ href: 'https://arxiv.org/abs/2601.00001' }] }] }],
    threadContexts: [{ url: 'https://x.com/other/status/444', links: [], quotedPosts: [{ url: 'https://x.com/q/status/555', links: [{ href: 'https://quoted.example.org/' }] }],
      unresolvedReferences: [{ url: 'https://ref.example.org/x' }] }],
  },
  deepLinkAudit: [{ href: 'https://audit.example.org/a', originalHref: 'https://t.co/zzz' }],
};
const digest = urls => `# X AI 日报 2026-10-31\n${collection.digestMarker}\n\n## Frameworks / Infra\n${urls.map(u => `- SYNTHETIC item. ${u}`).join('\n')}\n\n## Breakthrough Research\nNone.\n\n## Applications / Products\nNone.\n\n## 差异补充\nAudit cites https://unobserved.example.org/audit-only which is not checked.\n`;
const ledger = items => ({ schemaVersion: 1, collectionId: collection.collectionId, items });
const allSkipped = ['x:222', 'x:333', 'blog:https://blog.example.org/post-a', 'deep:https://example.org/deep', 'xhs:https://www.xiaohongshu.com/explore/n1'];

function workspace(t, files = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-SYNTHETIC-binding-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
    fs.writeFileSync(path.join(rootDir, name), text);
  }
  return rootDir;
}

test('canonical form ignores tracking params, trailing slash, www and host case', () => {
  const expected = canonicalUrl('https://example.org/paper');
  for (const variant of ['https://www.example.org/paper/', 'https://EXAMPLE.org/paper?utm_source=x&utm_medium=y', 'https://www.Example.org/paper/#section'])
    assert.equal(canonicalUrl(variant), expected);
  assert.notEqual(canonicalUrl('https://example.org/paper?id=2'), expected);
  assert.deepEqual(digestUrls('- a https://a.example/x.\n- b [S](https://b.example/y)，\n## 差异补充\nhttps://c.example/z'), ['https://a.example/x', 'https://b.example/y']);
});

test('candidate keys cover every candidate group once and skip thread contexts', () => {
  assert.deepEqual(candidateKeys(collection), ['x:111', ...allSkipped]);
  assert.deepEqual(candidateKeys({ sources: { xFollowing: [{ url: 'https://x.com/a/status/1' }], karpathy: [{ url: 'https://x.com/a/status/1' }] } }), ['x:1']);
  assert.throws(() => candidateKeys({ sources: { blogs: [{ text: 'no url' }] } }), /no URL/);
});

test('URL binding accepts collection URLs and their variants, rejects fabricated ones with a same-host hint', t => {
  const observed = observedUrls({ collection, rootDir: workspace(t) });
  for (const url of ['https://example.org/paper', 'https://audit.example.org/a', 'https://quoted.example.org', 'https://ref.example.org/x', 'https://arxiv.org/abs/2601.00001', 'https://t.co/abc'])
    assert.ok(observed.collection.has(canonicalUrl(url)), url);
  assert.deepEqual(validateUrlBinding(digest(['https://www.example.org/paper/?utm_campaign=z', 'https://x.com/writer/status/111']), observed),
    { checked: 2, matchedCollection: 2, matchedMaterials: 0 });
  assert.throws(() => validateUrlBinding(digest(['https://example.org/invented']), observed),
    /^Error: Digest URL not observed in collection or declared materials: https:\/\/example\.org\/invented \(observed on the same host: https:\/\/example\.org\/paper, https:\/\/example\.org\/deep\)$/);
  assert.throws(() => validateUrlBinding(digest(['https://nowhere.example.net/a']), observed), /same host: none\)/);
});

test('URL present only in a declared materials JSON url field is accepted; undeclared or binary files are not read', t => {
  const rootDir = workspace(t, {
    'canonical-materials.json': JSON.stringify({ items: [{ source: 'gmail', url: 'https://newsletter.example.net/p/issue-9' }] }),
    'mail/body.png': 'https://binary.example.net/hidden',
  });
  const markdown = digest(['https://newsletter.example.net/p/issue-9/']);
  assert.throws(() => validateUrlBinding(markdown, observedUrls({ collection, rootDir })), /not observed/);
  const observed = observedUrls({ collection, rootDir, materialsPaths: ['canonical-materials.json'], evidencePaths: ['mail/body.png'] });
  assert.deepEqual(validateUrlBinding(markdown, observed), { checked: 1, matchedCollection: 0, matchedMaterials: 1 });
  assert.throws(() => validateUrlBinding(digest(['https://binary.example.net/hidden']), observed), /not observed/);
  assert.throws(() => observedUrls({ collection, rootDir, materialsPaths: ['../outside.json'] }), /safe relative/);
});

test('dispositions: complete ledger with batch keys and merges passes and reports counts', t => {
  const markdown = digest(['https://x.com/writer/status/111', 'https://newsletter.example.net/p/1']);
  const rootDir = workspace(t, { 'm.md': 'Received at https://newsletter.example.net/p/1.' });
  const observed = observedUrls({ collection, rootDir, materialsPaths: ['m.md'] });
  const value = ledger([
    { key: 'x:111', disposition: 'included', section: 'Frameworks / Infra', url: 'https://x.com/writer/status/111' },
    { key: 'x:222', disposition: 'merged', mergedInto: 'x:111' },
    { keys: allSkipped.slice(1), disposition: 'skipped', reason: 'low_signal' },
  ]);
  assert.deepEqual(validateDispositions(value, collection, markdown, observed), { candidates: 6, included: 1, merged: 1, skipped: 4,
    skippedReasons: { low_signal: 4 }, supplementUrls: ['https://newsletter.example.net/p/1'] });
  const result = validateDigest(markdown, collection, { observed, dispositions: value });
  assert.equal(result.urlBinding.matchedMaterials, 1); assert.equal(result.dispositions.included, 1);
  assert.match(larkMarkdown(markdown, collection, { dispositions: value }), /\n候选处置：共 6 条候选，收录 1 条，合并 1 条，跳过 4 条。\n$/);
  assert.equal(larkMarkdown(markdown, collection), larkMarkdown(markdown, collection, {}));
});

test('dispositions: each malformed ledger is rejected', () => {
  const markdown = digest(['https://x.com/writer/status/111', 'https://example.org/paper']);
  const included = { key: 'x:111', disposition: 'included', section: 'Frameworks / Infra', url: 'https://x.com/writer/status/111' };
  const paper = { key: 'deep:https://example.org/deep', disposition: 'included', section: 'Frameworks / Infra', url: 'https://example.org/paper' };
  const rest = { keys: allSkipped.filter(key => !key.startsWith('deep:')), disposition: 'skipped', reason: 'off_topic' };
  assert.equal(validateDispositions(ledger([included, paper, rest]), collection, markdown).included, 2);
  const cases = [
    [ledger([included, paper, { ...rest, keys: rest.keys.slice(1) }]), /Missing disposition/],
    [ledger([included, paper, rest, { key: 'x:999', disposition: 'skipped', reason: 'other' }]), /Unknown disposition key: x:999/],
    [ledger([included, paper, rest, { key: 'x:111', disposition: 'skipped', reason: 'other' }]), /Duplicate/],
    [ledger([{ ...included, url: 'https://x.com/writer/status/999' }, paper, rest]), /not cited in the digest/],
    [ledger([{ ...included, section: '' }, paper, rest]), /section/],
    [ledger([included, paper, { ...rest, keys: rest.keys.slice(1) }, { key: rest.keys[0], disposition: 'merged', mergedInto: rest.keys[1] }]), /must point at an included/],
    [ledger([included, paper, { ...rest, reason: 'boring' }]), /skip reason/],
    [ledger([{ ...included, key: undefined, keys: ['x:111'] }, paper, rest]), /batch keys/],
    [{ ...ledger([included, paper, rest]), collectionId: 'other' }, /collectionId/],
    [{ ...ledger([included, paper, rest]), schemaVersion: 2 }, /schemaVersion/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => validateDispositions(value, collection, markdown), pattern);
});

test('dispositions: a cited candidate URL must be included, while links inside an included post only need binding', t => {
  const observed = observedUrls({ collection, rootDir: workspace(t) });
  const included = { key: 'x:111', disposition: 'included', section: 'Frameworks / Infra', url: 'https://x.com/writer/status/111' };
  const skipped = { keys: allSkipped, disposition: 'skipped', reason: 'low_signal' };
  const withLink = digest(['https://x.com/writer/status/111 and its paper https://www.example.org/paper/']);
  assert.equal(validateDigest(withLink, collection, { observed, dispositions: ledger([included, skipped]) }).dispositions.included, 1);
  const citesSkipped = digest(['https://x.com/writer/status/111', 'https://x.com/writer/status/222']);
  assert.throws(() => validateDispositions(ledger([included, skipped]), collection, citesSkipped, observed), /not included: x:222 \(skipped\)/);
  const merged = ledger([included, { key: 'x:222', disposition: 'merged', mergedInto: 'x:111' }, { ...skipped, keys: allSkipped.slice(1) }]);
  assert.throws(() => validateDispositions(merged, collection, citesSkipped, observed), /not included: x:222 \(merged\)/);
});
