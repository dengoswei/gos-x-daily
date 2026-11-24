import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveSources } from '../source-config.mjs';
import { larkMarkdown, publicationGates } from '../digest.mjs';
import { buildReviewSnapshot } from '../review.mjs';
import { runProductionDaily, selectedEvidence } from '../deployment/mac/daily.mjs';
import { makeApiFinalFixture } from './helpers/api-final-fixture.mjs';
import { main as cli } from '../cli.mjs';
import { modelTopic } from '../model-input.mjs';

const tagged = (text, name) => JSON.parse(text.split('<' + name + '>\n')[1].split('\n</' + name + '>')[0]);

test('review retains composer evidence tails and distinguishes observed links from read bodies', () => {
  const url = 'https://example.com/article';
  const companionUrls = Array.from({ length: 35 }, (_, index) => 'https://example.com/code-' + index);
  const text = 'First paragraph. '.repeat(1500) + 'UNIQUE-EXPERIMENT-LIMITATION-AT-THE-END';
  const evidence = selectedEvidence([{ title: 'Synthetic article', primaryUrl: url, companionUrls,
    paperPublishedAt: '2026-11-09T00:00:00Z',
    observations: [{ url, text, publishedAt: '2026-11-11T00:00:00Z' }] }],
  [url, ...companionUrls], '2026-11-12T00:00:00Z');
  const primary = evidence.find(row => row.url === url);
  assert.ok(primary.text.endsWith('UNIQUE-EXPERIMENT-LIMITATION-AT-THE-END'));
  assert.ok(primary.text.includes('2026-11-11T00:00:00Z'));
  assert.ok(primary.text.includes('2026-11-12T00:00:00Z'));
  assert.ok(primary.text.includes('"paperPublishedAt":"2026-11-09T00:00:00Z"'));
  for (const row of evidence.filter(row => row.url !== url)) {
    assert.ok(row.text.includes('link_only'));
    assert.ok(!row.text.includes('UNIQUE-EXPERIMENT-LIMITATION-AT-THE-END'));
  }
});

test('legacy and logged-in source bodies require public provenance before entering model packets', () => {
  for (const kind of ['backlog', 'mail', 'xhs']) {
    assert.equal(modelTopic({ cards: [{ kind, text: 'private source', url: 'https://example.com/private' }] }), null);
  }
  const subscribed = modelTopic({ cards: [{ kind: 'substack', title: 'Subscribed post', url: 'https://writer.substack.com/p/post', sourceLabel: 'substack' }] });
  assert.deepEqual(subscribed.allObservedUrls, ['https://writer.substack.com/p/post']);
  const safe = modelTopic({ title: 'private title', primaryUrl: 'https://example.com/private',
    allObservedUrls: ['https://example.com/private'], cards: [
      { kind: 'xhs', title: 'private title', url: 'https://example.com/private' },
      { kind: 'supplement', title: 'Public article', url: 'https://example.com/article', sourceLabel: 'Public source' },
    ] });
  assert.equal(safe.title, 'Public article');
  assert.deepEqual(safe.allObservedUrls, ['https://example.com/article']);
});

test('public sources follow the release while private profiles and explicit source exclusions persist', () => {
  const defaults = { feeds: [{ name: 'New feed', url: 'https://example.com/rss' }], blogs: [{ name: 'Blog' }] };
  const local = { feeds: [], blogs: [], watchProfiles: [{ handle: 'synthetic' }] };
  assert.equal(effectiveSources(defaults, local).feeds.length, 1);
  assert.deepEqual(effectiveSources(defaults, local).watchProfiles, local.watchProfiles);
  assert.equal(effectiveSources(defaults, { ...local, disabledSources: ['New feed'] }).feeds.length, 0);
});

test('Mac production uses the repository funnel and reviews its output without a second writer', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-unified-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await makeApiFinalFixture(root);
  // Synthetic revision metadata; this fixture never invokes a real sender.
  const runFile = path.join(f.runDir, 'run.json');
  fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(runFile)), revisionOf: 'synthetic-original-message' }));
  const sourcesPath = path.join(f.runDir, 'sources.json');
  const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  sources.sources.substack.push({ url: 'https://example.com/subscribed-post', text: 'Subscribed post preview', publishedAt: sources.collectedAt });
  sources.sources.xiaohongshu = [{ profileId: 'synthetic', notes: [{ url: 'https://example.com/private-note', text: 'PRIVATE-XHS-MUST-STAY-LOCAL' }] }];
  fs.writeFileSync(sourcesPath, JSON.stringify(sources));
  fs.writeFileSync(path.join(f.runDir, 'sources.frozen.json'), JSON.stringify({ watchProfiles: [], blogs: [], feeds: [] }));
  const keyFile = path.join(root, 'synthetic-key');
  fs.writeFileSync(keyFile, 'CODEX_API_KEY=synthetic-placeholder\n');
  const ledgerBefore = fs.readdirSync(f.ledgerDir);
  const calls = [];
  let interruptFirstReview = true;
  const fetchImpl = async (url, init) => {
    if (url !== 'https://api.openai.com/v1/chat/completions') return new Response('<article>' + f.evidenceText.repeat(8) + '</article>');
    const body = JSON.parse(init.body);
    const all = body.messages.map(row => row.content).join('\n');
    const last = body.messages.at(-1).content;
    assert.ok(!all.includes(f.secret));
    assert.ok(!/PRIVATE-XHS-MUST-STAY-LOCAL|private-note/.test(all));
    let content;
    if (!body.response_format && all.includes('two-stage curation')) {
      calls.push('screen');
      const topics = tagged(all, 'topics_json').slice(0, 2);
      content = '```json\n' + JSON.stringify({ selected: topics.map((topic, index) => ({ topicId: topic.topicId,
        tier: index ? 'deep' : 'quick', section: index ? 'Frameworks / Infra' : 'Quick Hits / 快讯速览', reason: 'Synthetic selection' })) }) + '\n```';
    } else if (all.includes('digest composition (v2)')) {
      calls.push('compose');
      const topics = tagged(all, 'selected_topics');
      content = '```markdown\n# X AI 日报 2026-11-08\n\n' + topics.map(topic =>
        '## ' + topic.section + '\n\n- **Synthetic runtime caches repeated prefix state.** A simulated two-level index reuses decoded state. [Original](' + topic.material.primaryUrl + ')').join('\n\n') + '\n```';
    } else {
      if (interruptFirstReview) return new Response('Synthetic permanent interruption', { status: 400 });
      calls.push('review');
      const draft = all.split('<draft_markdown>\n')[1].split('\n</draft_markdown>')[0];
      // A bounded revision names each item it changes.
      const changedItems = draft.split('\n').filter(line => line.startsWith('- ') && line.includes('A simulated two-level'));
      content = '```json\n' + JSON.stringify({ verdict: 'revise',
        issues: changedItems.map((_, index) => `Item ${index + 1}: clarify the synthetic result`),
        revisedMarkdown: draft.replaceAll('A simulated two-level', 'A synthetic two-level') }) + '\n```';
    }
    return Response.json({ id: 'synthetic-' + calls.length, model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 100 } });
  };
  await assert.rejects(runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl }),
    /Provider HTTP 400/);
  interruptFirstReview = false;
  const result = await runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl });
  assert.equal(result.pipeline, 'run-daily.mjs');
  assert.deepEqual(calls, ['screen', 'compose', 'review']);
  const validation = await cli(['validate-publication', '--publication', result.publication]);
  assert.equal(validation.status, 'structural_review_binding_passed_not_semantic_proof');
  assert.ok(fs.existsSync(path.join(f.runDir, 'store', 'raw')));
  assert.ok(fs.existsSync(path.join(f.runDir, 'telemetry.json')));
  const packet = JSON.parse(fs.readFileSync(path.join(f.runDir, 'api-final-input.json')));
  assert.ok(packet.excerpts.some(row => row.id.startsWith('pipeline-accounting-') && row.text.includes('sourceCandidateCount')));
  assert.ok(packet.excerpts.some(row => row.text.includes('same_day_revision') && row.text.includes('replacement takes effect')));
  assert.ok(packet.materialsPaths.includes('run.json'));
  const published = fs.readFileSync(path.join(f.runDir, 'digest.publication.md'), 'utf8');
  assert.match(published, /一篇成稿可能综合多个来源/);
  assert.match(published, /本次采集范围与运行自检 \[(?:OK|WARN|ACTION_NEEDED)\]/);
  assert.equal(published.split('### 运行自检').length - 1, 1, 'the self-check panel is published once');
  assert.ok(published.indexOf('### 运行自检') > published.indexOf('## 差异补充'));
  const delivered = larkMarkdown(published, sources, { renderStyle: 'concise' });
  assert.match(delivered, /本次采集范围与运行自检/);
  assert.match(delivered, /浏览器有界抽样（近24小时与近48小时均未做全量区间遍历验证/);
  assert.ok(!delivered.includes('### 运行自检'));
  assert.deepEqual(fs.readdirSync(f.ledgerDir), ledgerBefore);
  const again = await runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl });
  assert.equal(again.publication, result.publication);
  assert.equal(calls.length, 3);
  // Operational review retries reuse only the byte-bound writer transcript.
  // Completed model stages are reused only when their prompt and model bindings match.
  assert.equal(calls.filter(stage => stage === 'compose').length, 1);
  // Publication gate: a bound editorial record that claims fewer fixes than it made, or an
  // unknown revision contract, fails even when every hash is rebound to the tampered bytes.
  const publicationRecord = JSON.parse(fs.readFileSync(result.publication, 'utf8'));
  const rootDir = path.resolve(path.dirname(result.publication), publicationRecord.rootDir);
  const editorialFile = path.join(rootDir, 'editorial-review.json');
  const reviewFile = path.join(rootDir, publicationRecord.reviewPath);
  const editorialBytes = fs.readFileSync(editorialFile);
  const reviewBytes = fs.readFileSync(reviewFile);
  const rebindAndValidate = editorial => {
    fs.writeFileSync(editorialFile, JSON.stringify(editorial));
    const inputsBase = publicationRecord.snapshotInputs;
    const markdown = fs.readFileSync(path.join(rootDir, inputsBase.digestPath), 'utf8');
    const collection = JSON.parse(fs.readFileSync(path.join(rootDir, inputsBase.sourcesPath), 'utf8'));
    const { renderedMarkdown } = publicationGates(rootDir, inputsBase, markdown, collection);
    const snapshot = buildReviewSnapshot({ ...inputsBase, rootDir, renderedMarkdown });
    fs.writeFileSync(reviewFile, JSON.stringify({ ...JSON.parse(reviewBytes), snapshotSha256: snapshot.snapshotSha256, bindings: snapshot.bindings }));
    return cli(['validate-publication', '--publication', result.publication]);
  };
  const editorial = JSON.parse(editorialBytes);
  assert.equal(editorial.revisionContract, 'bounded-v1');
  assert.equal(editorial.result.verdict, 'revise');
  assert.ok(editorial.result.issues.length >= 2, 'the synthetic review revises several items');
  assert.deepEqual(editorial.result.advisories, []);
  assert.equal((await rebindAndValidate(editorial)).status, 'structural_review_binding_passed_not_semantic_proof');
  await assert.rejects(rebindAndValidate({ ...editorial, result: { ...editorial.result, issues: editorial.result.issues.slice(0, 1) } }),
    /changed \d+ items .* but listed 1 issues/);
  await assert.rejects(rebindAndValidate({ ...editorial, revisionContract: 'bounded-v0' }), /Unsupported editorial revision contract/);
  // Records written before the contract carry no marker and stay readable for reconciliation.
  const { revisionContract, ...legacy } = editorial;
  assert.equal((await rebindAndValidate(legacy)).status, 'structural_review_binding_passed_not_semantic_proof');
  fs.writeFileSync(editorialFile, editorialBytes);
  fs.writeFileSync(reviewFile, reviewBytes);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).status, 'structural_review_binding_passed_not_semantic_proof');
  const changed = JSON.parse(fs.readFileSync(path.join(f.runDir, 'prepared-topics.json')));
  changed[0].material.title = 'Changed after review';
  fs.writeFileSync(path.join(f.runDir, 'prepared-topics.json'), JSON.stringify(changed));
  await assert.rejects(cli(['validate-publication', '--publication', result.publication]), /stale or tampered/);
});

test('runProductionDaily routes Gemini 4 models through Interactions API and restores caller environment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-mac-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await makeApiFinalFixture(root);
  fs.writeFileSync(path.join(f.runDir, 'sources.frozen.json'), JSON.stringify({ watchProfiles: [], blogs: [], feeds: [] }));
  const keyFile = path.join(root, 'synthetic-gemini-key');
  fs.writeFileSync(keyFile, 'GEMINI_API_KEY=synthetic-gemini-placeholder\n');
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url !== 'https://generativelanguage.googleapis.com/v1/interactions') {
      return new Response('<article>' + f.evidenceText.repeat(8) + '</article>');
    }
    const headers = init.headers;
    assert.equal(headers['x-goog-api-key'], 'synthetic-gemini-placeholder');
    const body = JSON.parse(init.body);
    assert.equal(body.generation_config.max_output_tokens, 65536);
    assert.equal(body.generation_config.thinking_level, 'high');
    assert.equal(body.store, false);
    const all = `${body.system_instruction ?? ''}\n${body.input}`;
    let text;
    if (all.includes('two-stage curation')) {
      seen.push({ stage: 'screen', model: body.model });
      const topics = tagged(all, 'topics_json').slice(0, 2);
      text = '```json\n' + JSON.stringify({ selected: topics.map(topic => ({ topicId: topic.topicId,
        tier: 'deep', section: 'Frameworks / Infra', reason: 'Synthetic Gemini selection' })) }) + '\n```';
    } else if (all.includes('digest composition (v2)')) {
      seen.push({ stage: 'compose', model: body.model });
      const topics = tagged(all, 'selected_topics');
      text = '```markdown\n# X AI 日报 2026-11-08\n\n## Frameworks / Infra\n\n' + topics.map(topic =>
        `- **[Synthetic · Gemini]：核心结论先行。** 详细展开。[Original](${topic.material.primaryUrl})`).join('\n\n') + '\n```';
    } else {
      seen.push({ stage: 'review', model: body.model });
      const draft = all.split('<draft_markdown>\n')[1].split('\n</draft_markdown>')[0];
      text = '```json\n' + JSON.stringify({ verdict: 'pass', issues: [], revisedMarkdown: draft }) + '\n```';
    }
    return Response.json({
      status: 'completed',
      steps: [
        { type: 'thought', content: [{ type: 'text', text: 'hidden' }] },
        { type: 'model_output', content: [{ type: 'text', text }] },
      ],
      usage: { total_input_tokens: 100, total_output_tokens: 40, total_thought_tokens: 20, total_cached_tokens: 10 },
    });
  };
  const beforeGemini = process.env.GEMINI_API_KEY;
  const result = await runProductionDaily({
    ...f, dataDir: path.join(root, 'state-data'), keyFile,
    screenModel: 'gemini-4-hydrogen', composeModel: 'gemini-4-neon', reviewModel: 'gemini-4-neon', fetchImpl,
  });
  assert.equal(process.env.GEMINI_API_KEY, beforeGemini);
  assert.deepEqual(seen, [
    { stage: 'screen', model: 'gemini-4-hydrogen' },
    { stage: 'compose', model: 'gemini-4-neon' },
    { stage: 'review', model: 'gemini-4-neon' },
  ]);
  const validation = await cli(['validate-publication', '--publication', result.publication]);
  assert.equal(validation.status, 'structural_review_binding_passed_not_semantic_proof');
});
