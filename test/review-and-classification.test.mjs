// Adversarial tests for the bounded single-pass review contract and the
// bounded-lead / source-hinted category classifier. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReviewResponse, runDailyV2 } from '../run-daily.mjs';
import { assertBoundedRevision, parseDigestStructure } from '../digest-layout.mjs';
import { canonicalUrl } from '../binding.mjs';
import { buildContentStore, classifyHeuristic, CLASSIFY_LEAD_CHARS } from '../content-store.mjs';
import { sourceCategoryHints, SOURCE_CATEGORY_HINTS } from '../source-config.mjs';
import { validateFeedConfig } from '../feed-import.mjs';

const date = '2026-11-11';
const QUICK = '- **Acme · Sheets**：11 月 10 日面向付费计划开放协同表格 beta。 [官方介绍](https://product.example/sheets)';
const INFRA = '- **[Lab · FastKV]：用两级索引复用前缀状态，单卡吞吐提升。** 11 月 10 日发布，单张 H100 在 1,024-token 上下文下达到 110 tok/s。 [原文](https://infra.example/fastkv) · [代码](https://github.com/example/fastkv)';
const RESEARCH = '- **[Uni · StateBench]：长程状态追踪基准。** 在 50 个仿真任务上评测记忆检索。 [论文](https://arxiv.org/abs/2611.12345)';
const draftOf = (quick = QUICK, infra = INFRA, research = RESEARCH) =>
  `# X AI 日报 ${date}\n\n## Quick Hits / 快讯速览\n\n${quick}\n\n## Frameworks / Infra\n\n${infra}\n\n## Breakthrough Research\n\n${research}`;
const draft = draftOf();
const observedUrlSet = new Set(['https://product.example/sheets', 'https://infra.example/fastkv', 'https://github.com/example/fastkv',
  'https://arxiv.org/abs/2611.12345', 'https://infra.example/unrelated-observed'].map(canonicalUrl));
const reply = body => '```json\n' + JSON.stringify(body) + '\n```';
const parse = body => parseReviewResponse(reply(body), { draftMarkdown: draft, date, observedUrlSet });
const revise = (revisedMarkdown, issues = ['Item 2: corrected 110 tok/s to 101 tok/s from the source']) =>
  parse({ verdict: 'revise', issues, revisedMarkdown });

test('digest structure separates items from the skeleton', () => {
  const parsed = parseDigestStructure(draft + '\n\nA stray paragraph outside any item.');
  assert.equal(parsed.bullets.length, 3);
  assert.deepEqual(parsed.bullets.map(b => b.section), ['Quick Hits / 快讯速览', 'Frameworks / Infra', 'Breakthrough Research']);
  assert.deepEqual(parsed.skeleton, [`# X AI 日报 ${date}`, '## Quick Hits / 快讯速览', '## Frameworks / Infra',
    '## Breakthrough Research', 'A stray paragraph outside any item.']);
});

test('pass carries non-blocking advisories, and pass with issues is rejected with a usable instruction', () => {
  const ok = parse({ verdict: 'pass', issues: [], advisories: ['Item 2 lead could name the bottleneck earlier'], revisedMarkdown: null });
  assert.deepEqual(ok, { verdict: 'pass', issues: [], advisories: ['Item 2 lead could name the bottleneck earlier'], revisedMarkdown: null });
  assert.deepEqual(parse({ verdict: 'pass', issues: [] }).advisories, [], 'advisories are optional');
  // The old prompt asked reviewers to "flag" wording and still return pass; that must not
  // silently pass with findings, and the retry message must name the advisories field.
  assert.throws(() => parse({ verdict: 'pass', issues: ['Wording preference on item 2'] }), /put non-blocking notes in advisories/);
  for (const advisories of ['a string', [1], [''], [{ note: 'x' }]]) {
    assert.throws(() => parse({ verdict: 'pass', issues: [], advisories }), /advisories must be an array of non-empty strings/);
  }
  for (const issues of [undefined, 'x', [null], ['']]) {
    assert.throws(() => parse({ verdict: 'pass', issues }), /issues must be an array/);
  }
  assert.throws(() => parse({ verdict: 'approve', issues: [] }), /verdict must be pass or revise/);
});

test('a bounded revision that corrects one sentence in one item is accepted', () => {
  const revised = draftOf(QUICK, INFRA.replace('110 tok/s', '101 tok/s'));
  const out = revise(revised);
  assert.equal(out.verdict, 'revise');
  assert.equal(out.revisedMarkdown, revised);
  assert.deepEqual(out.advisories, []);
  assert.deepEqual(assertBoundedRevision(draft, revised, out.issues), { changedItems: [2] });
  // Deleting an unsupported claim together with its own link is allowed; one link remains.
  const trimmed = draftOf(QUICK, INFRA.replace(' · [代码](https://github.com/example/fastkv)', '').replace('，单卡吞吐提升', ''));
  assert.equal(revise(trimmed).verdict, 'revise');
});

test('revisions that drop, add, reorder, move or rewrite more than they declare are rejected', () => {
  const cases = [
    ['no declared fix', () => revise(draftOf(QUICK, INFRA.replace('110', '101')), []), /must list each material fix/],
    ['no change at all', () => revise(draft), /must change at least one item/],
    ['dropped item', () => revise(draftOf(QUICK, INFRA).replace(`\n\n## Breakthrough Research\n\n${RESEARCH}`, '')), /changed the title, headings|item count/],
    ['added item inside a section', () => revise(draft.replace(QUICK, QUICK + '\n- **Acme · Docs**：新增协同文档 beta。 [官方介绍](https://product.example/sheets)')), /item count \(draft 3, revised 4\)/],
    ['silent rewrite of a second item', () => revise(draftOf(QUICK.replace('beta', '正式版'), INFRA.replace('110', '101'))), /changed 2 items \(1, 2\) but listed 1 issues/],
    ['rewrite of every item', () => revise(draftOf(QUICK.replace('beta', 'GA'), INFRA.replace('110', '101'), RESEARCH.replace('50', '40')),
      ['Item 2: corrected throughput']), /changed 3 items/],
    ['link borrowed from another observed topic', () => revise(draftOf(QUICK, INFRA.replace('[原文](https://infra.example/fastkv)',
      '[原文](https://infra.example/fastkv) · [相关](https://infra.example/unrelated-observed)'))), /added a link to item 2/],
    ['link from another item (reorder within the digest)', () => revise(draftOf(QUICK, INFRA.replace('https://github.com/example/fastkv', 'https://arxiv.org/abs/2611.12345'))), /added a link to item 2/],
    ['unobserved link', () => revise(draftOf(QUICK, INFRA.replace('https://github.com/example/fastkv', 'https://github.com/example/invented'))), /Unobserved or hallucinated URL/],
    ['changed title', () => revise(draft.replace(`# X AI 日报 ${date}`, `# X AI 日报 ${date}（修订）`).replace('110', '101')), /changed the title, headings/],
    ['renamed heading', () => revise(draft.replace('## Breakthrough Research', '## Long-form / Essays').replace('110', '101')), /changed the title, headings/],
    ['added commentary outside items', () => revise(draft.replace('## Frameworks / Infra', '编者按：今天以 Infra 为主。\n\n## Frameworks / Infra').replace('110', '101')), /text outside items/],
    ['missing revised text', () => parse({ verdict: 'revise', issues: ['Item 2: x'], revisedMarkdown: '  ' }), /non-empty revisedMarkdown/],
  ];
  for (const [name, run, expected] of cases) assert.throws(run, expected, name);
});

test('the shipped review prompt describes the same contract the parser enforces', () => {
  const prompt = fs.readFileSync(new URL('../prompts/v2-review-digest.md', import.meta.url), 'utf8');
  assert.match(prompt, /"advisories"/);
  assert.match(prompt, /Do not add, remove, reorder, merge or move items/);
  assert.match(prompt, /one `issues` entry per changed item/);
  assert.doesNotMatch(prompt, /^\s*\d+\. \*\*.*\*\*: .*\n\s+- Flag/m, 'style checks are advisories, not unqualified flags');
});

test('category reads the address, title and opening only', () => {
  const filler = 'We measured tail latency of the storage engine under contention and the lock convoy dominated. ';
  const body = filler.repeat(Math.ceil(CLASSIFY_LEAD_CHARS / filler.length) + 1);
  const essay = { url: 'https://essays.example/2026/tail', title: 'A postmortem of tail behaviour', sourceLabel: 'Essays' };
  for (const phrase of ['As a customer story, consider the allocator.', 'Case study: our allocator.', 'Introducing the beta preview of our new connector.',
    'Read our release notes and changelog.', 'We are rolling out pricing for the desktop app.']) {
    const got = classifyHeuristic({ ...essay, text: body + phrase });
    assert.notEqual(got, 'case_study_pr', phrase);
    assert.notEqual(got, 'product', phrase);
    assert.notEqual(got, 'open_source', phrase);
  }
  // The opening still classifies normally.
  assert.equal(classifyHeuristic({ ...essay, title: 'Notes', text: 'Introducing the beta of our spreadsheet connector. ' + 'It edits cells. '.repeat(60) }), 'product');
});

test('customer stories are detected from their own address or headline, never a passing phrase', () => {
  const base = { sourceLabel: 'Vendor Blog', text: 'A long engineering narrative. '.repeat(40) };
  assert.equal(classifyHeuristic({ ...base, url: 'https://vendor.example/customers/hospital', title: 'How a hospital scaled' }), 'case_study_pr');
  assert.equal(classifyHeuristic({ ...base, url: 'https://vendor.example/blog/x', title: 'Customer Story: How Hospital Signed 20k Contracts' }), 'case_study_pr');
  assert.equal(classifyHeuristic({ ...base, url: 'https://vendor.example/blog/x', title: 'Case study: Acme cuts inference cost' }), 'case_study_pr');
  assert.equal(classifyHeuristic({ ...base, url: 'https://vendor.example/blog/x', title: '客户案例：某银行的智能客服' }), 'case_study_pr');
  // Research usage of the phrase, a customers-named domain and a body mention are not commercial PR.
  assert.notEqual(classifyHeuristic({ ...base, url: 'https://essays.example/convoys', title: 'A case study in lock convoys' }), 'case_study_pr');
  assert.notEqual(classifyHeuristic({ ...base, url: 'https://customers.example/blog/post', title: 'Scheduling notes' }), 'case_study_pr');
  assert.notEqual(classifyHeuristic({ ...base, url: 'https://essays.example/p', title: 'Notes', text: base.text + ' See our customer story for details.' }), 'case_study_pr');
  // A titled essay that merely links to a customers page keeps its category...
  assert.notEqual(classifyHeuristic({ ...base, url: 'https://essays.example/p', title: 'Notes on queues',
    linkHints: 'https://vendor.example/customers/hospital' }), 'case_study_pr');
  // ...while an untitled post is about the link it shares, and its opening is its headline.
  assert.equal(classifyHeuristic({ url: 'https://x.com/vendor/status/1', text: 'Big day for us!', linkHints: 'https://vendor.example/customers/hospital' }), 'case_study_pr');
  assert.equal(classifyHeuristic({ url: 'https://x.com/vendor/status/2', text: 'Customer story: how Acme scaled support with our agents' }), 'case_study_pr');
});

test('a configured source category replaces keyword guessing but cannot launder a customer story', () => {
  const opening = 'Introducing a short proof via a compactness argument, now in beta preview. ';
  assert.equal(classifyHeuristic({ url: 'https://math.example/2026/11/10/compactness/', title: 'On compactness', text: opening, sourceLabel: 'Math Blog' }), 'product');
  assert.equal(classifyHeuristic({ url: 'https://math.example/2026/11/10/compactness/', title: 'On compactness', text: opening, sourceLabel: 'Math Blog', hint: 'essay' }), 'essay');
  assert.equal(classifyHeuristic({ url: 'https://vendor.example/customers/acme', title: 'How Acme works', text: opening, sourceLabel: 'Vendor', hint: 'essay' }), 'case_study_pr');
});

test('content store applies source hints by feed and blog name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-hints-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = 'We give a short proof via a compactness argument and explain why it fails in the sparse regime. '.repeat(15);
  const collection = { schemaVersion: 1, collectionId: 'hints', date, sources: { xFollowing: [],
    feeds: [{ url: 'https://math.example/2026/11/10/compactness/', title: 'On a compactness argument', text, publishedAt: '2026-11-10T09:00:00Z', feedName: 'Math Blog', links: [] }],
    blogs: [{ url: 'https://lab.example/blog/notes', title: 'Lab notes on credit assignment', text, publishedAt: '2026-11-10T09:00:00Z', blog: 'Lab Blog', links: [] }] } };
  const unhinted = buildContentStore(collection, path.join(dir, 'a'), {});
  assert.deepEqual(unhinted.topics.map(topic => topic.category).sort(), ['general', 'general']);
  const hints = sourceCategoryHints({ feeds: [{ name: 'Math Blog', category: 'essay' }], blogs: [{ name: 'Lab Blog', category: 'paper' }] });
  const hinted = buildContentStore(collection, path.join(dir, 'b'), { categoryHints: hints });
  assert.deepEqual(Object.fromEntries(hinted.topics.map(topic => [topic.sources[0], topic.category])), { 'Math Blog': 'essay', 'Lab Blog': 'paper' });
});

test('source category hints are validated fail-closed, including through the pipeline entry', async t => {
  assert.deepEqual(SOURCE_CATEGORY_HINTS, ['essay', 'paper', 'infra_eng', 'open_source', 'product', 'general']);
  // A hint may not apply the commercial penalty, and unknown values do not fall back silently.
  for (const category of ['case_study_pr', 'Essay', '', 1, null]) {
    assert.throws(() => sourceCategoryHints({ feeds: [{ name: 'F', category }] }), /category must be one of/);
    assert.throws(() => sourceCategoryHints({ blogs: [{ name: 'B', category }] }), /Blog B category must be one of/);
    assert.throws(() => validateFeedConfig({ feeds: [{ name: 'F', url: 'https://f.example/rss', kind: 'rss', maxItems: 3, category }] }), /Feed F category/);
  }
  const shipped = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  const shippedHints = sourceCategoryHints(shipped);
  assert.equal(shippedHints.get('Terence Tao'), 'essay');
  assert.equal(shippedHints.get('Dan Luu'), 'essay');
  assert.equal(shippedHints.get('Transformer Circuits'), 'paper');
  assert.equal(shippedHints.has('Hugging Face Daily Papers'), false);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-hint-gate-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await assert.rejects(runDailyV2({ dataDir, sourcesConfig: { feeds: [{ name: 'F', category: 'case_study_pr' }] }, fetchFullTextOnline: false }),
    /\[init\] Feed F category must be one of/);
});
