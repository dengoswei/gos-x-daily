// SYNTHETIC ONLY: this test collects nothing, calls no model API and sends nothing.
// The advisory review and the eval judge both run against a scripted stdin/stdout
// fixture over a fictional run; neither reviews, measures nor approves anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSyntheticRun } from '../prototype/make-synthetic-run.mjs';
import { orchestrate } from '../prototype/orchestrate.mjs';
import { evaluate } from '../prototype/eval.mjs';
import { extractUnits, unitEvidence } from '../prototype/review-units.mjs';

const scriptedModel = fileURLToPath(new URL('./helpers/scripted-stage-model.mjs', import.meta.url));
const BODY_TEXT = ['SYNTH:', 'PROMO', '推理缓存', '合成'];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('advisory review and eval measurement run over a synthetic composed draft', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-SYNTHETIC-review-eval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network in the synthetic review/eval test'); };
  t.after(() => { globalThis.fetch = priorFetch; });

  const run = await makeSyntheticRun({ outDir: path.join(root, 'run') });
  // Absolute paths only: the provider spawns with shell:false and inherits no PATH assumption.
  const role = { kind: 'exec', command: [process.execPath, scriptedModel] };
  const modelsFile = path.join(root, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ roles: { screen: role, story: role, compose: role, review: role, judge: role } }, null, 2) + '\n');

  const outDir = path.join(root, 'out');
  const report = await orchestrate({ runDir: run.runDir, modelsFile, outDir });
  assert.equal(report.status, 'prototype_digest_composed_not_reviewed', 'an advisory review never promotes the status');
  assert.equal(report.notApproval, true);
  assert.equal(report.validation.passed, true);
  assert.ok(report.roles.review, 'the review role is reported when configured');

  const advisory = report.advisoryReview;
  assert.ok(advisory.units >= 2, 'at least one bullet unit plus the audit unit');
  assert.equal(advisory.units, report.validation.digest.mainBullets + 1);
  assert.equal(advisory.stageABlind, true);
  assert.deepEqual(advisory.verdicts, { clear: 5, unclear: 0, faithful: 1, issues: 4 });
  assert.deepEqual(advisory.findings, { material: 0, minor: 4 });
  assert.match(advisory.note, /no approval authority/);
  assert.equal(advisory.unitFiles.length, advisory.units * 2);

  // Stage A is persisted, source-blind and timestamped before Stage B ever sees evidence.
  for (let index = 1; index <= advisory.units; index++) {
    const unit = `unit-${String(index).padStart(3, '0')}`;
    const stageA = readJson(path.join(outDir, `review/${unit}.a.json`));
    const stageB = readJson(path.join(outDir, `review/${unit}.b.json`));
    assert.equal(stageA.sourceBlind, true);
    assert.equal(stageA.unit, unit);
    assert.deepEqual(Object.keys(stageA.reconstruction), ['problem', 'mechanism', 'conclusion', 'innovationType']);
    assert.ok(stageA.persistedAt <= stageB.checkedAt, `${unit}: Stage A must be persisted before Stage B concludes`);
    assert.equal(stageB.stageAFile, `review/${unit}.a.json`);
    assert.equal(stageA.notApproval, true);
    assert.equal(stageB.notApproval, true);
  }
  assert.equal(readJson(path.join(outDir, 'review/unit-005.b.json')).kind, 'audit');
  assert.deepEqual(readJson(path.join(outDir, 'review/unit-005.b.json')).findings, []);
  assert.equal(report.stages.review.calls, advisory.units * 2);
  assert.equal(report.stages.total.calls, 18);

  const evaluation = await evaluate({ runDir: run.runDir, outDir, modelsFile });
  assert.equal(evaluation.notReview, true);
  assert.equal(evaluation.kind, 'prototype-eval-measurement');
  assert.ok(fs.existsSync(path.join(outDir, 'eval.json')));
  assert.deepEqual(readJson(path.join(outDir, 'eval.json')), evaluation);

  const ledger = report.validation.digest.dispositions;
  assert.deepEqual(evaluation.deterministic, {
    candidates: ledger.candidates, included: ledger.included, merged: ledger.merged,
    skipped: ledger.skipped, skippedReasons: ledger.skippedReasons,
    groups: report.screening.groups, stories: report.stories.length,
    repaired: false, warningsCount: 0,
    advisoryReview: { units: advisory.units, verdicts: advisory.verdicts, findings: advisory.findings },
    mainBullets: report.validation.digest.mainBullets, stages: report.stages,
  });

  assert.equal(evaluation.items.length, report.validation.digest.mainBullets);
  for (const item of evaluation.items) {
    assert.deepEqual(item.scores, { reconstructability: 4, fidelity: 4, disclosure: 4 });
    assert.equal(item.notes.length, 1);
    assert.equal(item.keys.length, 1, 'each synthetic bullet cites exactly one included candidate');
    assert.deepEqual(Object.keys(item), ['unit', 'keys', 'citedUrls', 'scores', 'notes']);
  }
  assert.deepEqual(evaluation.digest.scores, { ordering: 4, structure: 4, coverageDisclosure: 4 });
  assert.equal(evaluation.usage.judge.calls, evaluation.items.length + 1);

  // A coordinator report and a measurement carry keys, counts and URLs; bodies stay in the packets.
  for (const file of ['report.json', 'eval.json']) {
    const text = fs.readFileSync(path.join(outDir, file), 'utf8');
    for (const bodyText of BODY_TEXT) assert.ok(!text.includes(bodyText), `${file} must not quote candidate body text: ${bodyText}`);
  }

  await assert.rejects(evaluate({ runDir: run.runDir, outDir, modelsFile }), /Eval output already exists/);
});

test('review units cut a digest at bullets, with one audit unit last', () => {
  const markdown = [
    '# X AI 日报 2026-11-08', '<!-- x-daily-collection: abc -->', '',
    '## Frameworks / Infra',
    '- **first** body https://example.invalid/a',
    '  continuation line of the first bullet', '',
    '- **second** body https://example.invalid/b', '',
    '## Applications / Products',
    '- **third** body https://example.invalid/c', '',
    '本次采集范围：近24小时有 3 小时未验证扫描。未看到的帖子数未知。', '',
    '## 差异补充', 'process detail', '',
  ].join('\n');
  const units = extractUnits(markdown);
  assert.deepEqual(units.map(unit => [unit.id, unit.kind, unit.section]), [
    ['unit-001', 'item', 'Frameworks / Infra'], ['unit-002', 'item', 'Frameworks / Infra'],
    ['unit-003', 'item', 'Applications / Products'], ['unit-004', 'audit', null],
  ]);
  assert.match(units[0].prose, /continuation line/);
  assert.ok(!units[2].prose.includes('本次采集范围'), 'a plain coverage paragraph is not folded into the last bullet');
  assert.match(units[3].prose, /^本次采集范围/);
  assert.match(units[3].prose, /## 差异补充\nprocess detail$/);

  const dispositions = { items: [
    { key: 'x:1', disposition: 'included', url: 'https://example.invalid/a' },
    { key: 'x:2', disposition: 'included', url: 'https://example.invalid/b' },
    { key: 'x:3', disposition: 'merged', mergedInto: 'x:1' },
  ] };
  assert.deepEqual(unitEvidence(units[0], dispositions), { keys: ['x:1'], citedUrls: ['https://example.invalid/a'] });
  assert.deepEqual(unitEvidence(units[3], dispositions), { keys: [], citedUrls: [] });
});
