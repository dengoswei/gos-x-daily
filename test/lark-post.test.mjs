import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { larkInline, larkPostJson, larkPostVisibleText, renderLarkPost } from '../lark-post.mjs';
import { prepareDelivery, sendDelivery } from '../digest.mjs';
import { createReviewInput, validateReview } from '../review.mjs';
import { approveSyntheticReview, createSyntheticReviewedFixture } from './helpers/review-fixture.mjs';

const draft = '# X AI 日报 2026-11-09\n\n## Frameworks / Infra\n\n- **A readable finding.** A connected explanation. [Original](https://example.invalid/a) · [Paper](https://example.invalid/b) · [Code](https://example.invalid/c)\n- **Second finding.** More text. [Source](https://example.invalid/d)\n\n### 本次采集范围\n\nBoth interval limits remain unknown.\n';

test('three inline citations and separators stay in the same native paragraph', () => {
  const post = renderLarkPost(draft).zh_cn;
  assert.equal(post.title, 'X AI 日报 2026-11-09');
  assert.equal(post.content.length, 5);
  const row = post.content[1];
  assert.equal(row.filter(node => node.tag === 'a').length, 3);
  assert.deepEqual(row.filter(node => node.tag === 'a').map(node => node.href), ['https://example.invalid/a', 'https://example.invalid/b', 'https://example.invalid/c']);
  assert.equal(row.filter(node => node.text === ' · ').length, 2);
  assert.ok(post.content.flat().every(node => ['text', 'a'].includes(node.tag)));
  assert.deepEqual(row[1], { tag: 'text', text: 'A readable finding.', style: ['bold'] });
  assert.ok(post.content.every(row => row.some(node => node.text.trim())));
});

test('soft-wrapped prose is one row while each story remains distinct', () => {
  const post = renderLarkPost('# Title\n## Section\n- First clause\n  continues here. [A](https://example.invalid/a)\n- Next story. [B](https://example.invalid/b)').zh_cn;
  assert.equal(post.content.length, 3);
  assert.equal(post.content[1][0].text, '• First clause continues here. ');
  assert.equal(post.content[2][0].text, '• Next story. ');
});

test('serialization is deterministic and changes with text, URL and inline styling', () => {
  assert.equal(larkPostJson(draft), larkPostJson(draft));
  for (const amended of [draft.replace('connected', 'different'), draft.replace('/a)', '/changed)'), draft.replace('**A readable finding.**', 'A readable finding.')]) {
    assert.notEqual(larkPostJson(amended), larkPostJson(draft));
  }
  assert.equal(larkPostVisibleText(draft).split('\n').length, 6);
  assert.match(larkPostVisibleText(draft), /Original\]\(https:\/\/example.invalid\/a\) · \[Paper/);
  // The pinned CLI v1.0.36 convert_lib/text.go keeps text tags literally,
  // projects a tags to Markdown links, and joins native rows with newlines.
  assert.equal(larkPostVisibleText('# Title\n## Section\n- **Claim.** [Source](https://example.invalid/a) · [Paper](https://example.invalid/b)'),
    'Title\nSection\n• Claim. [Source](https://example.invalid/a) · [Paper](https://example.invalid/b)');
});

test('parentheses in source URLs and literal code are preserved', () => {
  assert.deepEqual(larkInline('Use `a[i] ** b` [Doc](https://example.invalid/a_(b)?q=1&n=2).'), [
    { tag: 'text', text: 'Use ' }, { tag: 'text', text: 'a[i] ** b' }, { tag: 'text', text: ' ' },
    { tag: 'a', text: 'Doc', href: 'https://example.invalid/a_(b)?q=1&n=2' }, { tag: 'text', text: '.' },
  ]);
  assert.equal(larkInline('Array [i] and [Doc](https://example.invalid/a)')[0].text, 'Array [i] and ');
});

test('unsupported or malformed content cannot silently lose evidence', () => {
  for (const body of ['[bad](javascript:alert(1))', '[bad](https://user:pass@example.invalid/a)', '[bad](https://example.invalid/a', '**unclosed', '`unclosed', '![image](https://example.invalid/a)', '<!-- collection marker -->', '```code', '| table |']) {
    assert.throws(() => renderLarkPost(`# Title\n${body}`));
  }
  assert.throws(() => renderLarkPost('# Title\n# Second title'));
  assert.throws(() => renderLarkPost('Missing title'));
  assert.throws(() => renderLarkPost('# Title\n\u0000'));
});

test('transport adds a separately reviewed exact payload without altering legacy snapshots', t => {
  const fixture = createSyntheticReviewedFixture(t);
  const legacy = createReviewInput(fixture.options);
  assert.equal(legacy.bindings.transport, undefined);
  assert.ok(legacy.units.every(unit => unit.kind !== 'transport'));
  const options = { ...fixture.options, transport: 'feishu-post-v1' };
  const pending = createReviewInput(options);
  assert.equal(pending.units.at(-1).kind, 'transport');
  assert.equal(pending.units.at(-1).text, larkPostJson(options.renderedMarkdown));
  assert.equal(pending.bindings.transport.sha256, pending.units.at(-1).sha256);
  assert.throws(() => validateReview(fixture.review, options), /stale or tampered/);
  assert.throws(() => createReviewInput({ ...options, transport: 'unverified-transport' }), /Unsupported delivery transport/);
  const approved = approveSyntheticReview(options);
  assert.equal(validateReview(approved, options).ok, true);
  approved.units.pop();
  assert.throws(() => validateReview(approved, options), /coverage is incomplete/);
});

test('prepared transport is review-bound and tampering blocks before any sender runs', t => {
  const fixture = createSyntheticReviewedFixture(t);
  fixture.snapshotInputs.transport = 'feishu-post-v1';
  const options = { ...fixture.options, transport: 'feishu-post-v1' };
  const review = approveSyntheticReview(options);
  fs.writeFileSync(path.join(fixture.rootDir, fixture.reviewPath), JSON.stringify(review));
  const target = { ...fixture.target, transport: 'feishu-post-v1' };
  assert.throws(() => prepareDelivery(fixture.markdown, fixture.collection, fixture.target, fixture.publication), /transport must match/);
  const plan = prepareDelivery(fixture.markdown, fixture.collection, target, fixture.publication);
  assert.equal(plan.args[6], '--markdown');
  assert.equal(plan.args[9], `xdaily-${target.deploymentId}-${fixture.collection.date}`);
  assert.equal(plan.transport.content, larkPostJson(plan.args[7]));
  assert.equal(plan.transport.sha256, review.bindings.transport.sha256);
  plan.transport.content += ' ';
  let called = false;
  assert.throws(() => sendDelivery(plan, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, target,
    spawnSyncImpl: () => { called = true; throw new Error('must not run'); } }), /modified/);
  assert.equal(called, false);
});
