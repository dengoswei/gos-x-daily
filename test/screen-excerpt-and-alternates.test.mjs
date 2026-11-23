// Adversarial tests: the Stage 2 editor sees bounded public excerpts, and an editor's
// selection is only adjusted with that editor's own ranked runner-ups. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addScreenExcerpts, parseSelectedPlanPayload, replaceAbstractOnlyDeepPapers, runDailyV2, SCREEN_EXCERPT_CHARS } from '../run-daily.mjs';
import { modelTopic } from '../model-input.mjs';

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-screen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writeBody = (storeDir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(storeDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(storeDir, rel), text);
  return rel;
};
// MID sits beyond the old ~260-character summary; TAIL sits beyond the excerpt bound.
const markedBody = (prefix = 'Body') => `${prefix} opening. ` + 'Context sentence. '.repeat(30) + 'MID-MARKER mechanism. ' + 'Detail sentence. '.repeat(80) + 'TAIL-MARKER result.';

test('screening rows carry a bounded excerpt of the best available body', t => {
  const storeDir = tmp(t);
  const body = markedBody();
  assert.ok(body.indexOf('MID-MARKER') > 300 && body.indexOf('MID-MARKER') < SCREEN_EXCERPT_CHARS);
  assert.ok(body.indexOf('TAIL-MARKER') > SCREEN_EXCERPT_CHARS);
  const topic = { topicId: 't1', title: 'T', cards: [
    { id: 'c1', kind: 'feed', url: 'https://a.example/p', rawBodyPath: writeBody(storeDir, 'raw/c1/body.txt', 'Short teaser.') },
    { id: 'c2', kind: 'x', url: 'https://x.com/a/status/1', rawBodyPath: writeBody(storeDir, 'raw/c2/body.txt', body) },
  ] };
  const [row] = addScreenExcerpts([{ topicId: 't1', title: 'T', tldr: 'old summary' }], new Map([['t1', topic]]), storeDir);
  assert.match(row.excerpt, /MID-MARKER/);
  assert.doesNotMatch(row.excerpt, /TAIL-MARKER/);
  assert.equal(row.excerpt.length, SCREEN_EXCERPT_CHARS);
  assert.equal(row.excerptSource, 'observation');
  assert.equal(row.bodyChars, body.replace(/\s+/g, ' ').trim().length);
  assert.equal('tldr' in row, false, 'the excerpt replaces the one-line summary');

  // A fetched article is preferred over observations.
  topic.fetchedArticle = { url: 'https://a.example/p', rawTextPath: writeBody(storeDir, 'raw/fetched/a.txt', 'FETCHED-ARTICLE ' + body) };
  assert.equal(addScreenExcerpts([{ topicId: 't1' }], new Map([['t1', topic]]), storeDir)[0].excerptSource, 'fetched_full_text');
  // Bound is configurable; 0 disables excerpts; unknown topics and missing stores pass through.
  assert.equal(addScreenExcerpts([{ topicId: 't1' }], new Map([['t1', topic]]), storeDir, { excerptChars: 80 })[0].excerpt.length, 80);
  assert.deepEqual(addScreenExcerpts([{ topicId: 't1', tldr: 'x' }], new Map([['t1', topic]]), storeDir, { excerptChars: 0 }), [{ topicId: 't1', tldr: 'x' }]);
  assert.deepEqual(addScreenExcerpts([{ topicId: 'nope', tldr: 'x' }], new Map(), storeDir), [{ topicId: 'nope', tldr: 'x' }]);
  assert.deepEqual(addScreenExcerpts([{ topicId: 't1', tldr: 'x' }], new Map([['t1', topic]]), null), [{ topicId: 't1', tldr: 'x' }]);
});

test('model-mode excerpts never contain private or out-of-store text', t => {
  const storeDir = tmp(t);
  fs.writeFileSync(path.join(path.dirname(storeDir), `outside-${path.basename(storeDir)}.txt`), 'OUTSIDE-STORE-SECRET '.repeat(100));
  const raw = { topicId: 't2', title: 'Private title', primaryUrl: 'https://pub.example/p', cards: [
    { id: 'm', kind: 'mail', url: 'https://mail.example/m', rawBodyPath: writeBody(storeDir, 'raw/m/body.txt', 'PRIVATE-MAIL-BODY '.repeat(200)) },
    { id: 'x', kind: 'xhs', url: 'https://www.xiaohongshu.com/n', rawBodyPath: writeBody(storeDir, 'raw/x/body.txt', 'PRIVATE-XHS-BODY '.repeat(200)) },
    { id: 'esc', kind: 'feed', url: 'https://pub.example/esc', rawBodyPath: `../outside-${path.basename(storeDir)}.txt` },
    { id: 'p', kind: 'feed', url: 'https://pub.example/p', contentStatus: 'abstract_only', rawBodyPath: writeBody(storeDir, 'raw/p/body.txt', 'Public abstract text.') },
  ],
  // A fetched body not marked shareable is dropped by the projection.
  fetchedArticle: { modelShareable: false, url: 'https://mail.example/m', rawTextPath: writeBody(storeDir, 'raw/fetched/m.txt', 'PRIVATE-FETCHED '.repeat(200)) } };
  const projected = modelTopic(raw);
  const [row] = addScreenExcerpts([{ topicId: 't2' }], new Map([['t2', projected]]), storeDir);
  assert.equal(row.excerpt, 'Public abstract text.');
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|OUTSIDE-STORE-SECRET/);
});

test('the editor ranks deferred runner-ups; order, sections and duplicates are parsed strictly', () => {
  const valid = new Set(['a', 'b', 'c', 'd']);
  const plan = parseSelectedPlanPayload({
    selected: [{ topicId: 'a', tier: 'deep', section: 'Breakthrough Research' }],
    deferred: [
      { topicId: 'c', section: 'Long-form / Essays', reason: 'first' },
      { topicId: 'a', section: 'Frameworks / Infra', reason: 'already selected' },
      { topicId: 'b', section: 'Not A Section', reason: 'second' },
      { topicId: 'c', section: 'Frameworks / Infra', reason: 'duplicate' },
      { topicId: 'zzz', reason: 'unknown' },
    ],
  }, valid);
  assert.deepEqual([...plan.deferredMap], [['c', 'first'], ['b', 'second']]);
  assert.deepEqual([...plan.deferredSections], [['c', 'Long-form / Essays']]);
});

const topicRow = (topicId, extra) => ({ topicId, title: topicId, dedupStatus: 'fresh', primaryUrl: `https://${topicId}.example/p`,
  allObservedUrls: [`https://${topicId}.example/p`], cards: [{ kind: 'feed', url: `https://${topicId}.example/p` }], ...extra });
const weakPaper = () => topicRow('weak', { category: 'paper', contentStatus: 'abstract_only', priorScore: 8 });
const deepPlan = () => [{ topicId: 'weak', tier: 'deep', section: 'Breakthrough Research', followUp: false, reason: 'editor pick' }];

test('an editor pick is replaced only by that editor\'s highest-ranked full-text runner-up', async () => {
  const topics = [
    weakPaper(),
    topicRow('ranked1', { category: 'paper', contentStatus: 'abstract_only', priorScore: 9 }),
    topicRow('ranked2', { category: 'essay', contentStatus: 'full_text', priorScore: 1 }),
    topicRow('ranked3', { category: 'infra_eng', contentStatus: 'full_text', priorScore: 9.5 }),
    topicRow('unranked', { category: 'infra_eng', contentStatus: 'full_text', priorScore: 20 }),
  ];
  const plan = deepPlan();
  const deferredMap = new Map([['ranked1', 'r1'], ['ranked2', 'strong essay'], ['ranked3', 'r3']]);
  const res = await replaceAbstractOnlyDeepPapers(plan, topics, { sortedForSelection: topics, alternates: [...deferredMap.keys()],
    alternateSections: new Map([['ranked2', 'Long-form / Essays']]), deferredMap });
  assert.equal(res.replaced, 1);
  assert.equal(plan[0].topicId, 'ranked2', 'editor rank beats both prior score and an unranked candidate');
  assert.equal(plan[0].section, 'Long-form / Essays');
  assert.match(plan[0].reason, /Editor runner-up.*strong essay/);
  assert.deepEqual(res.adjustments, [{ replaced: 'weak', with: 'ranked2', source: 'editor_alternate' }]);
  assert.equal(deferredMap.has('ranked2'), false, 'the promoted item is no longer a deferred backlog entry');
  assert.match(deferredMap.get('weak'), /abstract-only/);
});

test('with no eligible editor alternate the editor pick stays, even if a stronger unranked item exists', async () => {
  const unranked = topicRow('unranked', { category: 'infra_eng', contentStatus: 'full_text', priorScore: 20 });
  const ineligible = [
    topicRow('seen', { category: 'essay', contentStatus: 'full_text', dedupStatus: 'seen_recently' }),
    topicRow('robot', { category: 'paper', contentStatus: 'full_text', title: 'Humanoid locomotion via sim-to-real VLA' }),
    topicRow('pr', { category: 'case_study_pr', contentStatus: 'full_text' }),
    topicRow('stale', { category: 'essay', contentStatus: 'full_text', curationSignals: { ageDecay: 9 } }),
    topicRow('snippet', { category: 'essay', contentStatus: 'snippet_only' }),
  ];
  for (const alternates of [[], ineligible.map(c => c.topicId), ['missing-id']]) {
    const plan = deepPlan();
    const topics = [weakPaper(), unranked, ...ineligible];
    const res = await replaceAbstractOnlyDeepPapers(plan, topics, { sortedForSelection: topics, alternates, deferredMap: new Map() });
    assert.equal(res.replaced, 0, JSON.stringify(alternates));
    assert.equal(plan[0].topicId, 'weak');
    assert.deepEqual(res.adjustments, [{ kept: 'weak', reason: 'no full-text editor alternate' }]);
  }
  // Quick items and full-text deep papers are never replaced.
  const quick = [{ ...deepPlan()[0], tier: 'quick' }];
  assert.equal((await replaceAbstractOnlyDeepPapers(quick, [weakPaper(), unranked], { alternates: ['unranked'] })).replaced, 0);
  const fullPaper = topicRow('weak', { category: 'paper', contentStatus: 'full_text' });
  assert.equal((await replaceAbstractOnlyDeepPapers(deepPlan(), [fullPaper, unranked], { alternates: ['unranked'] })).replaced, 0);
});

test('editor rank is preserved when a higher-ranked alternate needs an on-demand fetch, within a fetch bound', async t => {
  const storeDir = tmp(t);
  const fetched = [];
  const article = '<html><body><article>' + '<p>Measured rollout throughput across clusters with a full explanation of the scheduler.</p>'.repeat(40) + '</article></body></html>';
  const fetchImpl = async url => {
    fetched.push(String(url));
    return String(url).startsWith('https://ranked1.example') ? new Response(article, { headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 });
  };
  const topics = [weakPaper(),
    topicRow('ranked1', { category: 'essay', contentStatus: 'snippet_only', priorScore: 1 }),
    topicRow('ranked2', { category: 'essay', contentStatus: 'full_text', priorScore: 9 })];
  const plan = deepPlan();
  const res = await replaceAbstractOnlyDeepPapers(plan, topics, { sortedForSelection: topics, alternates: ['ranked1', 'ranked2'], storeDir, fetchImpl, deferredMap: new Map() });
  assert.equal(plan[0].topicId, 'ranked1');
  assert.equal(res.adjustments[0].with, 'ranked1');

  // Unfetchable higher-ranked alternates consume at most two fetches before the next full-text rank wins.
  fetched.length = 0;
  const many = [weakPaper(), ...['u1', 'u2', 'u3'].map(id => topicRow(id, { category: 'essay', contentStatus: 'snippet_only' })),
    topicRow('full', { category: 'essay', contentStatus: 'full_text' })];
  const plan2 = deepPlan();
  await replaceAbstractOnlyDeepPapers(plan2, many, { sortedForSelection: many, alternates: ['u1', 'u2', 'u3', 'full'], storeDir, fetchImpl, deferredMap: new Map() });
  assert.equal(plan2[0].topicId, 'full');
  assert.equal(new Set(fetched.map(u => new URL(u).hostname)).size, 2);
  assert.ok(!fetched.some(u => u.includes('u3.example')));
});

test('end to end: the editor sees excerpts and a missing full text promotes its own runner-up', async t => {
  const dir = tmp(t);
  const paperBody = markedBody('Paper abstract');
  const collection = { schemaVersion: 1, collectionId: 'excerpt-e2e', date: '2026-11-11', collectedAt: '2026-11-11T00:30:00Z', checks: {}, warnings: [],
    sources: { xFollowing: [], substack: [], watchProfiles: [], blogs: [], xiaohongshu: [], deepArticles: [], feeds: [
      { url: 'https://huggingface.co/papers/2611.40001', title: 'Sparse Credit Assignment', text: paperBody, publishedAt: '2026-11-10T08:00:00Z', feedName: 'Hugging Face Daily Papers', links: [] },
      { url: 'https://essays.example/runner-up', title: 'Essay on rollout scheduling', text: 'A short teaser for the essay.', publishedAt: '2026-11-10T09:00:00Z', feedName: 'Essays', links: [] },
      { url: 'https://thinkingmachines.ai/blog/unranked', title: 'Unranked lab post', text: 'Lab post body. '.repeat(120), publishedAt: '2026-11-10T10:00:00Z', feedName: 'Thinking Machines', links: [] },
    ] } };
  const premerged = path.join(dir, 'premerged.json');
  fs.writeFileSync(premerged, JSON.stringify(collection));
  const modelsFile = path.join(dir, 'models.json');
  process.env.SYNTHETIC_EXCERPT_KEY = 'synthetic';
  t.after(() => { delete process.env.SYNTHETIC_EXCERPT_KEY; });
  const role = model => ({ kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model, apiKeyEnv: 'SYNTHETIC_EXCERPT_KEY', maxTokens: 4000 });
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role('s'), compose: role('c'), review: role('r') } }));

  const prompts = {};
  const article = '<html><body><article>' + '<p>The essay explains rollout scheduling, its bottleneck and the measured fix in detail.</p>'.repeat(40) + '</article></body></html>';
  const fetchImpl = async (url, init) => {
    if (!String(url).startsWith('https://api.synthetic.local/')) {
      return String(url).startsWith('https://essays.example/') ? new Response(article, { headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 });
    }
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages.at(-1).content;
    let content;
    if (sys.includes('two-stage curation & editorial selection (v2)')) {
      prompts.screen = user;
      const rows = JSON.parse(user.split('<topics_json>\n')[1].split('\n</topics_json>')[0]);
      const id = title => rows.find(row => row.title === title).topicId;
      content = '```json\n' + JSON.stringify({
        selected: [{ topicId: id('Sparse Credit Assignment'), tier: 'deep', section: 'Breakthrough Research', reason: 'clean formulation' }],
        deferred: [{ topicId: id('Essay on rollout scheduling'), section: 'Long-form / Essays', reason: 'strong essay runner-up' }],
      }) + '\n```';
    } else if (sys.includes('digest composition (v2)')) {
      const topics = JSON.parse(user.split('<selected_topics>\n')[1].split('\n</selected_topics>')[0]);
      prompts.composeTitles = topics.map(row => row.material.title);
      content = '```markdown\n# X AI 日报 2026-11-11\n\n' + topics.map(row => `## ${row.section}\n\n- **[作者 · ${row.material.title}]：调度瓶颈被定位。** 11 月 10 日发布的文章说明了调度瓶颈与修复。 [原文](${row.material.primaryUrl})`).join('\n\n') + '\n```';
    } else {
      content = '```json\n{"verdict":"pass","issues":[],"advisories":[]}\n```';
    }
    return Response.json({ id: 'synthetic', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };

  const result = await runDailyV2({ dataDir: path.join(dir, 'data'), modelsFile, premergedSourcesPath: premerged,
    sourcesConfig: { feeds: [], blogs: [], watchProfiles: [] }, fetchFullTextOnline: true,
    runtimeHooks: { fetch: fetchImpl, now: '2026-11-11T01:00:00Z' } });
  assert.equal(result.status, 'completed_local');

  const screenRows = JSON.parse(prompts.screen.split('<topics_json>\n')[1].split('\n</topics_json>')[0]);
  const paperRow = screenRows.find(row => row.title === 'Sparse Credit Assignment');
  assert.match(paperRow.excerpt, /MID-MARKER/, 'the editor sees substance beyond the old one-line summary');
  assert.doesNotMatch(prompts.screen, /TAIL-MARKER/, 'the excerpt is bounded');

  const state = JSON.parse(fs.readFileSync(path.join(result.runDir, 'prepare-state.json'), 'utf8'));
  const idOf = title => state.topics.find(topic => topic.title === title).topicId;
  assert.deepEqual(state.selectionAdjustments, [{ replaced: idOf('Sparse Credit Assignment'), with: idOf('Essay on rollout scheduling'), source: 'editor_alternate' }]);
  assert.deepEqual(state.selectedPlan.map(row => [row.topicId, row.section]), [[idOf('Essay on rollout scheduling'), 'Long-form / Essays']]);
  assert.deepEqual(state.deferredEntries.map(([id]) => id), [idOf('Sparse Credit Assignment')]);
  assert.deepEqual(prompts.composeTitles, ['Essay on rollout scheduling'], 'the higher-prior unranked lab post is never substituted');
  const digest = fs.readFileSync(result.digestPath, 'utf8');
  assert.match(digest, /https:\/\/essays\.example\/runner-up/);
  assert.doesNotMatch(digest, /thinkingmachines\.ai/);
});
