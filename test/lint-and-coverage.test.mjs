// Adversarial tests: every selected topic reaches the digest, and the prose lint runs in
// production as reviewer leads and internal telemetry. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSelectedCoverage, runDailyV2, summarizeEditorialLint } from '../run-daily.mjs';
import { evaluateDigestMarkdown as viaEval } from '../editorial-eval.mjs';
import { evaluateDigestMarkdown } from '../editorial-lint.mjs';

const topic = (topicId, url, extra = {}) => ({ topicId, title: `Title ${topicId}`, primaryUrl: url, allObservedUrls: [url], cards: [{ url }], ...extra });
const topics = new Map([
  ['a', topic('a', 'https://a.example/post', { discussionUrls: ['https://x.com/a/status/1'] })],
  ['b', topic('b', 'https://b.example/post')],
  ['c', topic('c', 'https://c.example/post')],
]);
const plan = ids => ids.map(topicId => ({ topicId, tier: 'deep', section: 'Frameworks / Infra' }));
const digest = items => `# X AI 日报 2026-11-11\n\n## Frameworks / Infra\n\n${items.join('\n')}`;
const item = (...urls) => `- **[Lab · X]：机制。** 正文。 ${urls.map(u => `[原文](${u})`).join(' · ')}`;

test('a digest must cite every selected topic by one of its own addresses', () => {
  assert.doesNotThrow(() => assertSelectedCoverage(digest([item('https://a.example/post'), item('https://b.example/post')]), plan(['a', 'b']), topics));
  // A discussion address or an observed card address counts; merging genuine duplicates is allowed.
  assert.doesNotThrow(() => assertSelectedCoverage(digest([item('https://x.com/a/status/1', 'https://b.example/post?utm_source=x')]), plan(['a', 'b']), topics));
  assert.throws(() => assertSelectedCoverage(digest([item('https://a.example/post')]), plan(['a', 'b', 'c']), topics),
    /omits 2 selected topic\(s\): b \(Title b\); c \(Title c\)\. Write one item for each selected topic/);
  // A heading or text outside an item does not cover a topic; neither does a link in the title line.
  assert.throws(() => assertSelectedCoverage(`# X AI 日报 2026-11-11 [x](https://b.example/post)\n\n## Frameworks / Infra\n\n${item('https://a.example/post')}`, plan(['a', 'b']), topics), /omits 1/);
  // Unknown plan rows are ignored rather than crashing.
  assert.doesNotThrow(() => assertSelectedCoverage(digest([item('https://a.example/post')]), plan(['a', 'ghost']), topics));
});

test('the prose lint is one module shared by the eval harness and production', () => {
  assert.equal(viaEval, evaluateDigestMarkdown);
  const md = digest(['- **[Lab · X]：瓶颈被打破。** 这不是缓存问题而是调度问题，所给摘录没有更多细节。 [原文](https://a.example/post)']);
  const summary = summarizeEditorialLint(md);
  assert.equal(summary.notApproval, true);
  assert.equal(summary.totalBullets, 1);
  assert.equal(summary.cleanBullets, 0);
  assert.ok(summary.issues.some(issue => /jarring_negative_contrast/.test(issue)));
  assert.ok(summary.issues.some(issue => /pipeline_jargon/.test(issue)));
  assert.equal(summarizeEditorialLint(md, { maxIssues: 1 }).issues.length, 1);
  assert.equal(summarizeEditorialLint(md, { maxIssues: 1 }).issueCount, summary.issueCount);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const feeds = ['alpha', 'beta'].map((name, index) => ({ url: `https://${name}.example/post`, title: `Post ${name}`,
    text: `${name} systems post about kernel scheduling and measured throughput. `.repeat(30), publishedAt: `2026-11-10T0${index + 1}:00:00Z`, feedName: 'Thinking Machines', links: [] }));
  const premerged = path.join(dir, 'premerged.json');
  fs.writeFileSync(premerged, JSON.stringify({ schemaVersion: 1, collectionId: 'lint-e2e', date: '2026-11-11', collectedAt: '2026-11-11T00:30:00Z', checks: {}, warnings: [],
    sources: { xFollowing: [], substack: [], watchProfiles: [], blogs: [], xiaohongshu: [], deepArticles: [], feeds } }));
  return { dir, premerged, dataDir: path.join(dir, 'data'), sourcesConfig: { feeds: [], blogs: [], watchProfiles: [] } };
}
const between = (text, tag) => JSON.parse(text.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0]);
const bullet = row => `- **[作者 · ${row.material.title}]：这不是吞吐问题而是调度问题。** 11 月 10 日发布的文章解释了调度瓶颈。 [原文](${row.material.primaryUrl})`;

test('end to end: a composer that drops a selected topic is retried, and lint reaches the reviewer and telemetry only', async t => {
  const f = fixture(t);
  const modelsFile = path.join(f.dir, 'models.json');
  process.env.SYNTHETIC_LINT_KEY = 'synthetic';
  t.after(() => { delete process.env.SYNTHETIC_LINT_KEY; });
  const role = model => ({ kind: 'openai', baseUrl: 'https://api.synthetic.local/v1', model, apiKeyEnv: 'SYNTHETIC_LINT_KEY', maxTokens: 4000 });
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role('s'), compose: role('c'), review: role('r') } }));
  const composePrompts = [];
  let reviewPrompt = null;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages.at(-1).content;
    let content;
    if (sys.includes('two-stage curation & editorial selection (v2)')) {
      const rows = between(user, 'topics_json');
      content = '```json\n' + JSON.stringify({ selected: rows.map(row => ({ topicId: row.topicId, tier: 'deep', section: 'Frameworks / Infra', reason: 'synthetic' })) }) + '\n```';
    } else if (sys.includes('digest composition (v2)')) {
      composePrompts.push(user);
      const rows = between(user, 'selected_topics');
      // First attempt silently drops the second selected topic.
      const kept = composePrompts.length === 1 ? rows.slice(0, 1) : rows;
      content = '```markdown\n# X AI 日报 2026-11-11\n\n## Frameworks / Infra\n\n' + kept.map(bullet).join('\n') + '\n```';
    } else {
      reviewPrompt = user;
      content = '```json\n{"verdict":"pass","issues":[],"advisories":["bullet 1: negative template"]}\n```';
    }
    return Response.json({ id: 'synthetic', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const result = await runDailyV2({ dataDir: f.dataDir, modelsFile, premergedSourcesPath: f.premerged, sourcesConfig: f.sourcesConfig,
    fetchFullTextOnline: false, runtimeHooks: { fetch: fetchImpl, now: '2026-11-11T01:00:00Z' } });
  assert.equal(composePrompts.length, 2);
  assert.match(composePrompts[1], /Digest omits 1 selected topic\(s\)/);
  assert.equal(result.funnel.publishedTotal, 2);

  const lintFindings = between(reviewPrompt, 'lint_findings');
  assert.ok(lintFindings.length >= 2 && lintFindings.every(hit => /jarring_negative_contrast/.test(hit) || /bullet_\d/.test(hit)));
  const telemetry = JSON.parse(fs.readFileSync(result.telemetryPath, 'utf8'));
  assert.equal(telemetry.editorialLint.notApproval, true);
  assert.equal(telemetry.editorialLint.totalBullets, 2);
  assert.ok(telemetry.editorialLint.issueCount >= 2);
  assert.ok(telemetry.recommendations.every(rec => !/lint|editorial/i.test(`${rec.target} ${rec.reason}`)), 'lint never feeds operational health');
  const { buildTelemetry } = await import('../telemetry.mjs');
  const base = { date: '2026-11-11', sources: telemetry.sources, funnel: telemetry.funnel };
  assert.equal(buildTelemetry({ ...base, editorialLint: telemetry.editorialLint }).overallHealth, buildTelemetry(base).overallHealth);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.runDir, 'editorial-lint.json'), 'utf8')), telemetry.editorialLint);
  const digestText = fs.readFileSync(result.digestPath, 'utf8');
  assert.doesNotMatch(digestText, /jarring|lint|notApproval/, 'lint is internal, never rendered to readers');

  // A composer that keeps dropping the topic fails the run after its one retry.
  const always = async (url, init) => {
    const sys = JSON.parse(init.body).messages[0].content;
    if (!sys.includes('digest composition (v2)')) return fetchImpl(url, init);
    const rows = between(JSON.parse(init.body).messages.at(-1).content, 'selected_topics');
    const content = '```markdown\n# X AI 日报 2026-11-12\n\n## Frameworks / Infra\n\n' + bullet(rows[0]) + '\n```';
    return Response.json({ id: 'synthetic', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const second = JSON.parse(fs.readFileSync(f.premerged, 'utf8'));
  second.date = '2026-11-12';
  fs.writeFileSync(f.premerged, JSON.stringify(second));
  await assert.rejects(runDailyV2({ dataDir: path.join(f.dir, 'data2'), modelsFile, premergedSourcesPath: f.premerged, sourcesConfig: f.sourcesConfig,
    fetchFullTextOnline: false, runtimeHooks: { fetch: always, now: '2026-11-12T01:00:00Z' } }),
  err => err.stage === 'compose_digest' && /failed after one retry: .*Digest omits 1 selected topic/.test(err.message));
});

test('host-composed finalize path also rejects a digest that omits a selected topic', async t => {
  const f = fixture(t);
  const prepared = await runDailyV2({ dataDir: f.dataDir, premergedSourcesPath: f.premerged, sourcesConfig: f.sourcesConfig,
    prepareOnly: true, fetchFullTextOnline: false, runtimeHooks: { now: '2026-11-11T01:00:00Z' } });
  const rows = JSON.parse(fs.readFileSync(prepared.preparedTopicsPath, 'utf8'));
  assert.equal(rows.length, 2);
  const draft = path.join(f.dir, 'draft.md');
  const write = kept => fs.writeFileSync(draft, '# X AI 日报 2026-11-11\n\n## Frameworks / Infra\n\n' + kept.map(bullet).join('\n') + '\n');
  write(rows.slice(1));
  await assert.rejects(runDailyV2({ dataDir: f.dataDir, runDir: prepared.runDir, finalizeDigestPath: draft, sourcesConfig: f.sourcesConfig,
    fetchFullTextOnline: false, runtimeHooks: { now: '2026-11-11T01:00:00Z' } }),
  err => err.stage === 'validate_digest' && /omits 1 selected topic/.test(err.message));
  write(rows);
  const done = await runDailyV2({ dataDir: f.dataDir, runDir: prepared.runDir, finalizeDigestPath: draft, sourcesConfig: f.sourcesConfig,
    fetchFullTextOnline: false, runtimeHooks: { now: '2026-11-11T01:00:00Z' } });
  assert.equal(done.funnel.publishedTotal, 2);
});

test('lint incident patterns are data: a new row is enforced and a malformed config fails closed', async t => {
  const { loadLintPatterns } = await import('../editorial-lint.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-lintcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = config => { const file = path.join(dir, `c-${Math.random()}.json`); fs.writeFileSync(file, JSON.stringify(config)); return file; };
  const custom = loadLintPatterns(write({ schemaVersion: 1, mistranslations: [{ wrong: '内核函数(', right: 'kernel' }],
    coldTerms: [{ name: 'bare_dflash', pattern: '\\bDFlash\\d*\\b', anchor: '投机解码' }] }));
  assert.ok(custom.mistranslated.test('调用内核函数(x)'), 'literal text is escaped, not treated as a regex');
  assert.equal(custom.cold[0].test('DFlash2 加速'), true);
  assert.equal(custom.cold[0].test('投机解码验证阶段（DFlash2）'), false);
  for (const bad of [{}, { schemaVersion: 2, mistranslations: [], coldTerms: [] }, { schemaVersion: 1, mistranslations: [{ wrong: '' , right: 'x' }], coldTerms: [] },
    { schemaVersion: 1, mistranslations: [], coldTerms: [{ name: 'Bad Name', pattern: 'x' }] }, { schemaVersion: 1, mistranslations: [], coldTerms: [{ name: 'ok', pattern: '(' }] }]) {
    assert.throws(() => loadLintPatterns(write(bad)));
  }
  const shipped = JSON.parse(fs.readFileSync(new URL('../config/editorial-lint.json', import.meta.url), 'utf8'));
  assert.ok(shipped.mistranslations.some(row => row.wrong === '重数量化'));
  assert.deepEqual(shipped.coldTerms.map(row => row.name), ['bare_verify_without_speculative_anchor', 'bare_smithy_without_api_model_anchor']);
});
