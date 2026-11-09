// SYNTHETIC ONLY: this test collects nothing, calls no model API and sends nothing.
// Every stage runs against a scripted stdin/stdout fixture over a fictional run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDigest } from '../digest.mjs';
import { candidateKeys } from '../binding.mjs';
import { makeSyntheticRun } from '../prototype/make-synthetic-run.mjs';
import { orchestrate, extractBlock } from '../prototype/orchestrate.mjs';

const scriptedModel = fileURLToPath(new URL('./helpers/scripted-stage-model.mjs', import.meta.url));

test('prototype orchestrator drives screen, story and compose over a synthetic run', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-SYNTHETIC-prototype-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network in the synthetic orchestrator test'); };
  t.after(() => { globalThis.fetch = priorFetch; });

  const run = await makeSyntheticRun({ outDir: path.join(root, 'run') });
  assert.equal(run.candidateCount, 6);
  assert.equal(run.sourcePacketCount, 3);

  // Absolute paths only: the provider spawns with shell:false and inherits no PATH assumption.
  const role = { kind: 'exec', command: [process.execPath, scriptedModel] };
  const modelsFile = path.join(root, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role, story: role, compose: role } }, null, 2) + '\n');

  const outDir = path.join(root, 'out');
  const report = await orchestrate({ runDir: run.runDir, modelsFile, outDir });
  assert.equal(report.status, 'prototype_digest_composed_not_reviewed');
  assert.equal(report.validation.passed, true);
  assert.equal(report.validation.repaired, false);
  assert.equal(report.notApproval, true);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.stages.total.calls, 8);
  assert.equal(report.stages.total.inputTokens, null, 'unreported usage stays unknown, never zero');

  const collection = JSON.parse(fs.readFileSync(run.sourcesFile, 'utf8'));
  const keys = candidateKeys(collection);
  const dispositions = JSON.parse(fs.readFileSync(path.join(outDir, 'dispositions.json'), 'utf8'));
  const covered = dispositions.items.flatMap(row => row.keys ?? [row.key]);
  assert.deepEqual([...covered].sort(), [...keys].sort(), 'every candidate key gets exactly one disposition');
  assert.equal(covered.length, new Set(covered).size);

  const promo = dispositions.items.find(row => row.key === 'x:1003');
  assert.deepEqual({ disposition: promo.disposition, reason: promo.reason }, { disposition: 'skipped', reason: 'promotion' });
  assert.deepEqual(report.decisions.find(decision => decision.key === 'x:1003'), { key: 'x:1003', action: 'skip', reason: 'promotion' });

  // The two posts sharing one external link become one story with a merged row.
  assert.equal(report.screening.groups, 4);
  assert.deepEqual(report.stories[0].keys, ['x:1001', 'x:1002']);
  assert.deepEqual(dispositions.items.find(row => row.key === 'x:1002'), { key: 'x:1002', disposition: 'merged', mergedInto: 'x:1001' });

  const markdown = fs.readFileSync(path.join(outDir, 'digest.md'), 'utf8');
  const revalidated = validateDigest(markdown, collection, { dispositions });
  assert.equal(revalidated.ok, true);
  assert.equal(revalidated.dispositions.candidates, keys.length);
  assert.deepEqual(report.validation.digest, revalidated);

  // A coordinator report carries keys, counts and URLs; source bodies stay in the packets.
  const reportText = fs.readFileSync(path.join(outDir, 'report.json'), 'utf8');
  for (const bodyText of ['SYNTH:', 'PROMO', '推理缓存', '合成']) {
    assert.ok(!reportText.includes(bodyText), `report must not quote candidate body text: ${bodyText}`);
  }
  assert.ok(fs.readFileSync(path.join(outDir, 'raw/screen-00001.txt'), 'utf8').includes('x:1003'));

  await assert.rejects(orchestrate({ runDir: run.runDir, modelsFile, outDir }), /output directory must be new/);
});

test('extractBlock returns the last fenced block of a language', () => {
  const text = '```json\n{"a":1}\n```\ntext\n```markdown\n- one\n```\n```json\n{"a":2}\n```\n';
  assert.equal(extractBlock(text, 'json'), '{"a":2}');
  assert.equal(extractBlock(text, 'markdown'), '- one');
  assert.throws(() => extractBlock(text, 'yaml'), /no ```yaml block/);
});
