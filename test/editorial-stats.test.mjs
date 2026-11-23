// Tests for rolling pillar mix and per-source yield. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PILLARS, pillarFor, buildDailyEditorialStats, appendEditorialStats, rollingEditorialStats } from '../editorial-stats.mjs';
import { parseSelectedPlanPayload, runDailyV2 } from '../run-daily.mjs';

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const topic = (id, sources, extra = {}) => ({ topicId: id, primaryUrl: `https://${id}.example/p`, allObservedUrls: [`https://${id}.example/p`],
  sources, dedupStatus: 'fresh', ...extra });

test('pillars come from the editor when valid, else from the prior domain tag', () => {
  assert.deepEqual(PILLARS, ['infra', 'intelligence', 'world_impact', 'open_door']);
  assert.equal(pillarFor({ pillar: 'open_door' }, { curationSignals: { domainTag: 'core_ml_systems' } }), 'open_door');
  assert.equal(pillarFor({ pillar: 'robotics' }, { curationSignals: { domainTag: 'core_ml_systems' } }), 'infra');
  assert.equal(pillarFor({}, { curationSignals: { domainTag: 'intelligence_theory' } }), 'intelligence');
  assert.equal(pillarFor({}, { curationSignals: { domainTag: 'robotics_embodied' } }), 'unclassified');
  const plan = parseSelectedPlanPayload({ selected: [
    { topicId: 'a', tier: 'deep', section: 'Frameworks / Infra', pillar: 'infra' },
    { topicId: 'b', tier: 'deep', section: 'Frameworks / Infra', pillar: 'INFRA' },
  ] }, new Set(['a', 'b']));
  assert.equal(plan[0].pillar, 'infra');
  assert.equal('pillar' in plan[1], false, 'an invalid tag is dropped, not guessed');
});

test('daily row counts only what was actually composed, per source and pillar', () => {
  const topics = [
    topic('a', ['Essays', 'x', 'x'], { discussionUrls: ['https://x.com/a/status/1'] }),
    topic('b', ['Essays'], { allObservedUrls: ['https://c.example/p'] }),
    topic('c', ['HF']),
    topic('d', ['HF'], { dedupStatus: 'seen_recently' }),
  ];
  const row = buildDailyEditorialStats({ date: '2026-11-11', topics, shortlistIds: new Set(['a', 'b', 'c']),
    selectedPlan: [
      { topicId: 'a', tier: 'deep', pillar: 'open_door' },
      { topicId: 'b', tier: 'deep', pillar: 'infra' },
      { topicId: 'c', tier: 'quick' },
    ],
    // Topic a is cited only by its discussion link; topic b was selected but dropped from the final text.
    citedUrls: ['https://x.com/a/status/1?utm_source=share', 'https://c.example/p'] });
  assert.deepEqual(row.pillars, { deep: { infra: 0, intelligence: 0, world_impact: 0, open_door: 1, unclassified: 0 }, quick: 1 });
  assert.deepEqual(row.sources, {
    Essays: { ingested: 2, shortlisted: 2, selected: 2, composed: 1 },
    x: { ingested: 1, shortlisted: 1, selected: 1, composed: 1 },
    HF: { ingested: 1, shortlisted: 1, selected: 1, composed: 1 },
  });
  assert.equal(row.shortlistMeasured, true);
  assert.equal(buildDailyEditorialStats({ date: '2026-11-11', topics }).shortlistMeasured, false);
});

test('a rerun replaces its date, malformed lines are ignored, and windows are inclusive and bounded', t => {
  const file = path.join(tmp(t), 'state', 'editorial-stats.jsonl');
  const day = (date, deep, sources = { Essays: { ingested: 2, shortlisted: 1, selected: 1, composed: 1 } }) =>
    ({ schemaVersion: 2, date, shortlistMeasured: true, pillars: { deep: { infra: 0, intelligence: 0, world_impact: 0, open_door: 0, unclassified: 0, ...deep }, quick: 0 }, sources });
  appendEditorialStats(file, day('2025-09-01', { infra: 50 }));
  appendEditorialStats(file, day('2026-11-04', { infra: 9 })); // 7 days before 11-11: outside the 7-day window
  // Version 1 used the name "published" for this same pre-delivery count.
  appendEditorialStats(file, { ...day('2026-11-05', { infra: 2 }), schemaVersion: 1,
    sources: { Essays: { ingested: 2, shortlisted: 1, selected: 1, published: 1 } } });
  appendEditorialStats(file, day('2026-11-11', { infra: 99 }));
  appendEditorialStats(file, day('2026-11-11', { infra: 1, open_door: 1 })); // rerun replaces
  appendEditorialStats(file, day('2026-11-20', { infra: 5 })); // future relative to asOf
  fs.appendFileSync(file, 'not json\n{"date":"bad"}\n');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.ok(!lines.some(line => line.includes('2025-09-01')), 'rows older than the retention are pruned');
  const report = rollingEditorialStats(file, { asOf: '2026-11-11' });
  assert.equal(report.pillarWindow.reports, 2);
  assert.deepEqual(report.pillarWindow.deep, { infra: 3, intelligence: 0, world_impact: 0, open_door: 1, unclassified: 0 });
  assert.equal(report.pillarWindow.shares.open_door, 0.25);
  assert.equal(report.sourceWindow.reports, 3);
  assert.deepEqual(report.sources, [{ source: 'Essays', reports: 3, ingested: 6, shortlisted: 3, selected: 3, composed: 3, composedPerIngested: 0.5 }]);
  const empty = rollingEditorialStats(path.join(path.dirname(file), 'missing.jsonl'));
  assert.equal(empty.asOf, null);
  appendEditorialStats(file, day('2026-11-21', {}, {}));
  assert.equal(rollingEditorialStats(file, { asOf: '2026-11-21', pillarDays: 1 }).pillarWindow.shares.infra, null, 'no composed Deep Dives: shares are unknown, not zero');
});

test('end to end: an editor run records its pillar mix and source yield in private state and telemetry only', async t => {
  const dir = tmp(t);
  const feeds = ['alpha', 'beta'].map((name, i) => ({ url: `https://${name}.example/post`, title: `Post ${name}`,
    text: `${name} systems post about kernel scheduling and measured throughput. `.repeat(30), publishedAt: `2026-11-10T0${i + 1}:00:00Z`, feedName: `Feed ${name}`, links: [] }));
  const premerged = path.join(dir, 'premerged.json');
  fs.writeFileSync(premerged, JSON.stringify({ schemaVersion: 1, collectionId: 'stats-e2e', date: '2026-11-11', collectedAt: '2026-11-11T00:30:00Z', checks: {}, warnings: [],
    sources: { xFollowing: [], substack: [], watchProfiles: [], blogs: [], xiaohongshu: [], deepArticles: [], feeds } }));
  const modelsFile = path.join(dir, 'models.json');
  process.env.SYNTHETIC_STATS_KEY = 'synthetic';
  t.after(() => { delete process.env.SYNTHETIC_STATS_KEY; });
  const role = model => ({ kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model, apiKeyEnv: 'SYNTHETIC_STATS_KEY', maxTokens: 4000 });
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role('s'), compose: role('c'), review: role('r') } }));
  const between = (text, tag) => JSON.parse(text.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0]);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages.at(-1).content;
    let content;
    if (sys.includes('two-stage curation & editorial selection (v2)')) {
      const rows = between(user, 'topics_json');
      content = '```json\n' + JSON.stringify({ selected: rows.map((row, i) => ({ topicId: row.topicId, tier: 'deep', section: 'Frameworks / Infra',
        pillar: i ? 'open_door' : 'infra', reason: 'synthetic' })) }) + '\n```';
    } else if (sys.includes('digest composition (v2)')) {
      const rows = between(user, 'selected_topics');
      content = '```markdown\n# X AI 日报 2026-11-11\n\n## Frameworks / Infra\n\n' + rows.map(row => `- **[作者 · ${row.material.title}]：调度瓶颈被定位。** 11 月 10 日发布的文章解释了调度。 [原文](${row.material.primaryUrl})`).join('\n') + '\n```';
    } else {
      content = '```json\n{"verdict":"pass","issues":[],"advisories":[]}\n```';
    }
    return Response.json({ id: 'synthetic', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const run = dataDir => runDailyV2({ dataDir, modelsFile, premergedSourcesPath: premerged, sourcesConfig: { feeds: [], blogs: [], watchProfiles: [] },
    fetchFullTextOnline: false, runtimeHooks: { publicationPending: true, fetch: fetchImpl, now: '2026-11-11T01:00:00Z' } });
  const dataDir = path.join(dir, 'data');
  const result = await run(dataDir);
  assert.equal(result.delivery.sent, false);
  const telemetry = JSON.parse(fs.readFileSync(result.telemetryPath, 'utf8'));
  assert.deepEqual(telemetry.editorialStats.pillarWindow.deep, { infra: 1, intelligence: 0, world_impact: 0, open_door: 1, unclassified: 0 });
  assert.equal(telemetry.editorialStats.pillarWindow.shares.open_door, 0.5);
  assert.deepEqual(telemetry.editorialStats.sources.map(row => [row.source, row.ingested, row.shortlisted, row.composed]),
    [['Feed alpha', 1, 1, 1], ['Feed beta', 1, 1, 1]]);
  assert.doesNotMatch(fs.readFileSync(result.digestPath, 'utf8'), /open_door|pillar|editorialStats/);
  assert.ok(telemetry.editorialStats.sources.every(source => !('published' in source)));
  // A same-day rerun replaces the day's row instead of double counting.
  await run(dataDir);
  const rows = fs.readFileSync(path.join(dataDir, 'state', 'editorial-stats.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
});
