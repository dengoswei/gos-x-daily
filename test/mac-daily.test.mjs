import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveSources } from '../source-config.mjs';
import { runProductionDaily } from '../deployment/mac/daily.mjs';
import { makeApiFinalFixture } from './helpers/api-final-fixture.mjs';
import { main as cli } from '../cli.mjs';
import { modelTopic } from '../model-input.mjs';

const tagged = (text, name) => JSON.parse(text.split('<' + name + '>\n')[1].split('\n</' + name + '>')[0]);

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
    } else if (!body.response_format) {
      calls.push('compose');
      const topics = tagged(all, 'selected_topics');
      content = '```markdown\n# X AI 日报 2026-11-08\n\n' + topics.map(topic =>
        '## ' + topic.section + '\n\n- **Synthetic runtime caches repeated prefix state.** A simulated two-level index reuses decoded state. [Original](' + topic.material.primaryUrl + ')').join('\n\n') + '\n```';
    } else {
      const comprehension = /reconstructing your final units/.test(last) || body.messages[0].content.includes('reader-comprehension');
      calls.push(comprehension ? 'comprehension' : 'fidelity');
      const units = tagged(all, 'review_units');
      const evidence = comprehension ? [] : [...tagged(all, 'verified_evidence').excerpts, tagged(all, 'local_disposition_facts')];
      content = JSON.stringify({ units: units.map(unit => ({ id: unit.id, status: 'pass', notes: 'Synthetic fixture has the expected exact source support.',
        ...(comprehension ? { reconstruction: { problem: 'Synthetic repeated prefix work.', method: 'Synthetic two-level cache lookup.',
          result: 'Synthetic reuse of decoded state.', innovation: 'Synthetic reuse avoids repeated decoding.' } }
          : { evidence: evidence.map(row => ({ id: row.id, quote: row.text.slice(0, 100) })) }) })) });
    }
    return Response.json({ id: 'synthetic-' + calls.length, model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 100 } });
  };
  const result = await runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl });
  assert.equal(result.pipeline, 'run-daily.mjs');
  assert.deepEqual(calls, ['screen', 'compose', 'comprehension', 'fidelity', 'comprehension', 'fidelity']);
  const validation = await cli(['validate-publication', '--publication', result.publication]);
  assert.equal(validation.status, 'structural_review_binding_passed_not_semantic_proof');
  assert.ok(fs.existsSync(path.join(f.runDir, 'store', 'raw')));
  assert.ok(fs.existsSync(path.join(f.runDir, 'telemetry.json')));
  assert.deepEqual(fs.readdirSync(f.ledgerDir), ledgerBefore);
  const again = await runProductionDaily({ ...f, dataDir: path.join(root, 'state-data'), keyFile, fetchImpl });
  assert.equal(again.publication, result.publication);
  assert.equal(calls.length, 6);
});
