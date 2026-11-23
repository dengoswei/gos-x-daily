// Adversarial tests: editor-deferred gems keep long retention, while undeferred leads expire,
// fall below a decayed floor, or drop after repeated editor screenings. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBacklogPool, saveBacklogPool, loadTasteConfig } from '../curation.mjs';
import { runDailyV2 } from '../run-daily.mjs';

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-backlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writePool = (stateDir, items) => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog-pool.json'), JSON.stringify({ schemaVersion: 1, items }));
};
const readPool = stateDir => JSON.parse(fs.readFileSync(path.join(stateDir, 'backlog-pool.json'), 'utf8')).items;
const topic = (id, extra = {}) => ({ topicId: id, title: `Topic ${id} about scheduling`, category: 'essay', primaryUrl: `https://${id}.example/p`,
  allObservedUrls: [`https://${id}.example/p`], sources: ['Essays'], cards: [{ author: 'a', tldr: 't' }], dedupStatus: 'fresh', priorScore: 7, ...extra });
const save = (stateDir, topics, extra = {}) => saveBacklogPool(stateDir, { reportDate: '2026-11-20', topics, ...extra });

test('load: undeferred entries expire after 30 days while deferred gems keep the long retention', t => {
  const stateDir = tmp(t);
  writePool(stateDir, [
    { title: 'old lead', primaryUrl: 'https://a.example/p', firstSeenDate: '2026-10-20', deferredByLlm: false },
    { title: 'recent lead', primaryUrl: 'https://b.example/p', firstSeenDate: '2026-10-25', deferredByLlm: false },
    { title: 'old gem', primaryUrl: 'https://c.example/p', firstSeenDate: '2026-01-10', deferredByLlm: true },
    { title: 'legacy lead without flag', primaryUrl: 'https://d.example/p', firstSeenDate: '2026-10-01' },
  ]);
  const pool = loadBacklogPool(stateDir, { reportDate: '2026-11-20' });
  assert.deepEqual(pool.entries.map(e => e.title), ['recent lead', 'old gem']);
  assert.equal(pool.expiredCount, 2);
  // A shorter overall retention still bounds deferred gems, and never lengthens the undeferred lifetime.
  assert.deepEqual(loadBacklogPool(stateDir, { reportDate: '2026-11-20', maxAgeDays: 20, undeferredMaxAgeDays: 90 }).entries.map(e => e.title), []);
  assert.equal(loadBacklogPool(stateDir, { reportDate: '2026-11-20', undeferredMaxAgeDays: 60 }).entries.length, 4);
});

test('save: age, decayed-score floor and the deferred exemption', t => {
  const stateDir = tmp(t);
  const res = save(stateDir, [
    topic('aged', { fromBacklog: true, firstSeenDate: '2026-10-15', priorScore: 9 }),
    topic('decayed', { fromBacklog: true, firstSeenDate: '2026-11-10', priorScore: -0.5 }),
    topic('refreshed', { fromBacklog: true, refreshedToday: true, firstSeenDate: '2026-11-10', priorScore: -0.5 }),
    topic('gem', { fromBacklog: true, deferredByLlm: true, firstSeenDate: '2026-02-01', priorScore: -12 }),
    topic('fresh', { priorScore: 6 }),
    topic('weakfresh', { priorScore: 3 }),
  ]);
  assert.deepEqual(res.evicted, { age: 1, score: 1, screened: 0 });
  assert.deepEqual(readPool(stateDir).map(e => e.title).sort(), ['Topic fresh about scheduling', 'Topic gem about scheduling', 'Topic refreshed about scheduling']);
  // Editor deferral today exempts an otherwise aged and decayed lead.
  const res2 = save(stateDir, [topic('aged', { fromBacklog: true, firstSeenDate: '2026-10-01', priorScore: -9 })], { deferredTopicIds: new Map([['aged', 'still worth it']]) });
  assert.deepEqual(res2.evicted, { age: 0, score: 0, screened: 0 });
  assert.equal(readPool(stateDir)[0].deferredReason, 'still worth it');
});

test('save: repeated editor screenings without deferral evict a lead; only editor screenings count', t => {
  const stateDir = tmp(t);
  const screened = new Set(['lead', 'picked']);
  save(stateDir, [topic('lead'), topic('picked')], { screenedTopicIds: screened, selectedTopicIds: new Set(['picked']) });
  const day1 = readPool(stateDir);
  assert.equal(day1.find(e => e.title.includes('lead')).screenedWithoutDeferral, 1);
  assert.equal(day1.find(e => e.title.includes('picked')).screenedWithoutDeferral, 0, 'a selected topic was chosen, not passed over');

  const second = save(stateDir, [topic('lead', { fromBacklog: true, firstSeenDate: '2026-11-19', screenedWithoutDeferral: 1 })], { screenedTopicIds: new Set(['lead']) });
  assert.deepEqual(second.evicted, { age: 0, score: 0, screened: 1 });
  assert.equal(readPool(stateDir).length, 0);

  // Heuristic runs (no editor) never count, and an editor deferral resets the count.
  save(stateDir, [topic('lead', { fromBacklog: true, firstSeenDate: '2026-11-19', screenedWithoutDeferral: 1 })], { screenedTopicIds: null });
  assert.equal(readPool(stateDir)[0].screenedWithoutDeferral, 1);
  save(stateDir, [topic('lead', { fromBacklog: true, firstSeenDate: '2026-11-19', screenedWithoutDeferral: 1 })],
    { screenedTopicIds: new Set(['lead']), deferredTopicIds: new Map([['lead', 'ranked runner-up']]) });
  assert.equal(readPool(stateDir)[0].screenedWithoutDeferral, 0);
  assert.equal(readPool(stateDir)[0].deferredByLlm, true);
});

test('shipped taste config declares the eviction policy', () => {
  const { backlog } = loadTasteConfig();
  assert.equal(backlog.maxAgeDays, 365);
  assert.equal(backlog.undeferredMaxAgeDays, 30);
  assert.equal(backlog.undeferredMinPriorScore, 0);
  assert.equal(backlog.maxUndeferredScreenings, 2);
});

test('end to end: an editor run evicts a twice-screened lead and expires an old one', async t => {
  const dir = tmp(t);
  const dataDir = path.join(dir, 'data');
  const stateDir = path.join(dataDir, 'state');
  const lead = { id: 'seeded-lead', title: 'Seeded backlog essay on queueing', primaryUrl: 'https://lead.example/essay', allObservedUrls: ['https://lead.example/essay'],
    category: 'essay', sources: ['Thinking Machines'], author: 'a', firstSeenDate: '2026-11-08', fanIn: 1, metrics: {}, contentStatus: 'abstract_only',
    priorScore: 7, deferredByLlm: false, screenedWithoutDeferral: 1, tldr: 'Queueing essay', cardText: 'Queueing essay body. '.repeat(20), modelShareable: true };
  const stale = { ...lead, id: 'stale', title: 'Stale lead', tldr: 'Stale lead', primaryUrl: 'https://stale.example/p', allObservedUrls: ['https://stale.example/p'], firstSeenDate: '2026-10-01', screenedWithoutDeferral: 0 };
  writePool(stateDir, [lead, stale]);
  const feeds = ['alpha', 'beta'].map((name, i) => ({ url: `https://${name}.example/post`, title: `Post ${name}`,
    text: `${name} systems post about kernel scheduling and measured throughput. `.repeat(30), publishedAt: `2026-11-10T0${i + 1}:00:00Z`, feedName: 'Thinking Machines', links: [] }));
  const premerged = path.join(dir, 'premerged.json');
  fs.writeFileSync(premerged, JSON.stringify({ schemaVersion: 1, collectionId: 'evict-e2e', date: '2026-11-11', collectedAt: '2026-11-11T00:30:00Z', checks: {}, warnings: [],
    sources: { xFollowing: [], substack: [], watchProfiles: [], blogs: [], xiaohongshu: [], deepArticles: [], feeds } }));
  const modelsFile = path.join(dir, 'models.json');
  process.env.SYNTHETIC_EVICT_KEY = 'synthetic';
  t.after(() => { delete process.env.SYNTHETIC_EVICT_KEY; });
  const role = model => ({ kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model, apiKeyEnv: 'SYNTHETIC_EVICT_KEY', maxTokens: 4000 });
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role('s'), compose: role('c'), review: role('r') } }));
  const between = (text, tag) => JSON.parse(text.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0]);
  let screenTitles = [];
  let interruptReview = true;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages.at(-1).content;
    let content;
    if (sys.includes('two-stage curation & editorial selection (v2)')) {
      const rows = between(user, 'topics_json');
      screenTitles = rows.map(row => row.title);
      content = '```json\n' + JSON.stringify({ selected: rows.filter(row => row.title.startsWith('Post ')).map(row => ({ topicId: row.topicId, tier: 'deep', section: 'Frameworks / Infra', reason: 'synthetic' })) }) + '\n```';
    } else if (sys.includes('digest composition (v2)')) {
      const rows = between(user, 'selected_topics');
      content = '```markdown\n# X AI 日报 2026-11-11\n\n## Frameworks / Infra\n\n' + rows.map(row => `- **[作者 · ${row.material.title}]：调度瓶颈被定位。** 11 月 10 日发布的文章解释了调度。 [原文](${row.material.primaryUrl})`).join('\n') + '\n```';
    } else {
      if (interruptReview) return new Response('Synthetic review interruption', { status: 400 });
      content = '```json\n{"verdict":"pass","issues":[],"advisories":[]}\n```';
    }
    return Response.json({ id: 'synthetic', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const run = () => runDailyV2({ dataDir, runDir: path.join(dir, 'run'), modelsFile, premergedSourcesPath: premerged, sourcesConfig: { feeds: [], blogs: [], watchProfiles: [] },
    fetchFullTextOnline: false, runtimeHooks: { resumeModels: true, fetch: fetchImpl, now: '2026-11-11T01:00:00Z' } });
  await assert.rejects(run(), /Provider HTTP 400/);
  interruptReview = false;
  const result = await run();
  // The model projection titles a recalled backlog card by its public summary.
  assert.ok(screenTitles.includes('Queueing essay'), 'the editor saw the seeded lead');
  assert.ok(!screenTitles.includes('Stale lead'), 'the expired lead never reached the editor');
  assert.deepEqual(result.funnel.backlogEvicted, { age: 0, score: 0, screened: 1 });
  assert.ok(!readPool(stateDir).some(entry => /Seeded|Stale/.test(entry.title)));
});
