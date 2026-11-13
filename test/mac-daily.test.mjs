import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveSources } from '../source-config.mjs';
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
  for (const kind of ['backlog', 'mail', 'xhs', 'substack']) {
    assert.equal(modelTopic({ cards: [{ kind, text: 'private source', url: 'https://example.com/private' }] }), null);
  }
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
  sources.sources.substack.push({ url: 'https://example.com/private-subscription', text: 'PRIVATE-SUBSCRIPTION-MUST-STAY-LOCAL', publishedAt: sources.collectedAt });
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
    assert.ok(!/PRIVATE-(SUBSCRIPTION|XHS)-MUST-STAY-LOCAL|private-subscription|private-note/.test(all));
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
      content = '```json\n' + JSON.stringify({ verdict: 'revise', issues: ['Clarify synthetic result'],
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
  assert.match(fs.readFileSync(path.join(f.runDir, 'digest.publication.md'), 'utf8'), /一篇成稿可能综合多个来源/);
  assert.deepEqual(fs.readdirSync(f.ledgerDir), ledgerBefore);
  const again = await runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl });
  assert.equal(again.publication, result.publication);
  assert.equal(calls.length, 3);
  // Operational review retries reuse only the byte-bound writer transcript.
  // Completed model stages are reused only when their prompt and model bindings match.
  assert.equal(calls.filter(stage => stage === 'compose').length, 1);
  const changed = JSON.parse(fs.readFileSync(path.join(f.runDir, 'prepared-topics.json')));
  changed[0].material.title = 'Changed after review';
  fs.writeFileSync(path.join(f.runDir, 'prepared-topics.json'), JSON.stringify(changed));
  await assert.rejects(cli(['validate-publication', '--publication', result.publication]), /stale or tampered/);
});
