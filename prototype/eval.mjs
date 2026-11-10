#!/usr/bin/env node
// Development-time eval harness over a passed prototype run: deterministic counts
// copied from the report, plus an LLM-judge rubric score per item and for the draft.
// It is a measurement, never a review and never an approval; no gate reads it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSON_NOTE, jsonText, modelJson, tagged, regularFile, stageContract, parseJsonBlock, loadModels, openRun, assembleEvidence,
  evidenceBlocks, outputStore, mapPool, usageLedger, budgetGuard, makeStageRunner } from './run-packets.mjs';
import { extractUnits, unitEvidence, unitCitedUrls } from './review-units.mjs';

const DIMENSIONS = { item: ['reconstructability', 'fidelity', 'disclosure'], digest: ['ordering', 'structure', 'coverageDisclosure'] };
const MEASUREMENT_NOTE = 'Development-time measurement only: these scores carry no approval authority, resolve no finding, and no publication gate reads this file.';

function parseScores(text, scope) {
  const payload = parseJsonBlock(text);
  const scores = {};
  for (const field of DIMENSIONS[scope]) {
    const value = payload?.scores?.[field];
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`scores.${field} must be an integer from 1 to 5`);
    scores[field] = value;
  }
  if (!Array.isArray(payload?.notes) || payload.notes.some(note => typeof note !== 'string')) throw new Error('notes must be an array of strings');
  return { scores, notes: payload.notes.map(note => note.trim()).filter(Boolean) };
}

// Counts only: the deterministic section never carries item prose or source text.
function deterministicSection(report) {
  const ledger = report.validation?.digest?.dispositions ?? {};
  const advisory = report.advisoryReview;
  return {
    candidates: ledger.candidates ?? null, included: ledger.included ?? null, merged: ledger.merged ?? null,
    skipped: ledger.skipped ?? null, skippedReasons: ledger.skippedReasons ?? {},
    groups: report.screening?.groups ?? null, stories: Array.isArray(report.stories) ? report.stories.length : null,
    repaired: report.validation?.repaired === true,
    ...(report.validation?.repairedFrom ? { repairedFrom: report.validation.repairedFrom } : {}),
    warningsCount: Array.isArray(report.warnings) ? report.warnings.length : null,
    ...(advisory ? { advisoryReview: { units: advisory.units, verdicts: advisory.verdicts, findings: advisory.findings } } : {}),
    mainBullets: report.validation?.digest?.mainBullets ?? null,
    stages: report.stages ?? null,
  };
}

/** Scores OUT_DIR's passed draft against RUN's packets and writes OUT_DIR/eval.json once. */
export async function evaluate({ runDir, outDir, modelsFile, resume = false, runtime = {} }) {
  const out = fs.realpathSync(outDir);
  const report = JSON.parse(fs.readFileSync(regularFile(path.join(out, 'report.json')), 'utf8'));
  if (report?.validation?.passed !== true) throw new Error('Eval needs a run whose composition passed validation');
  const markdown = fs.readFileSync(regularFile(path.join(out, 'digest.md')), 'utf8');
  const dispositions = JSON.parse(fs.readFileSync(regularFile(path.join(out, 'dispositions.json')), 'utf8'));
  // Refuse before any model call, so a second invocation costs nothing.
  if (fs.existsSync(path.join(out, 'eval.json'))) throw new Error(`Eval output already exists: ${path.join(out, 'eval.json')}`);
  const { roles, budget: limits } = loadModels(modelsFile, ['judge'], [], runtime);
  const run = openRun(runDir);
  if (run.collection.collectionId !== report.collectionId) throw new Error('RUN and OUT belong to different collections');

  const store = outputStore(out);
  const usage = usageLedger();
  const budget = budgetGuard(limits);
  const runStage = makeStageRunner({ roles, store, usage, budget, resume });
  const deterministic = deterministicSection(report);
  const system = ['<!-- stage: judge -->', stageContract('judge'), JSON_NOTE].join('\n\n');

  const units = extractUnits(markdown).filter(unit => unit.kind === 'item');
  const items = await mapPool(units, roles.judge.concurrency, async unit => {
    const evidence = unitEvidence(unit, dispositions);
    // An item whose cited URLs resolve to no included row is recorded, never scored blind.
    if (!evidence.keys.length) return { unit: unit.id, keys: [], citedUrls: [], scores: null, notes: [], evidenceResolved: false, unitUrls: unitCitedUrls(unit) };
    const prompt = [
      tagged('judge_scope', modelJson({ scope: 'item', unit: unit.id, ...(unit.section ? { section: unit.section } : {}) })),
      tagged('unit_prose', unit.prose),
      ...evidenceBlocks(assembleEvidence(run.read, run.rows, evidence.keys)),
    ].join('\n\n');
    const scored = await runStage({ stage: 'judge', label: `judge-${unit.id}`, system, prompt, parse: text => parseScores(text, 'item') });
    return { unit: unit.id, keys: evidence.keys, citedUrls: evidence.citedUrls, ...scored };
  }, { what: 'judge items', label: unit => `judge-${unit.id}` });
  const warnings = items.filter(item => item.evidenceResolved === false)
    .map(item => `Eval ${item.unit}: no included dispositions row matches the unit's cited URLs; the item was not scored`);

  const digestPrompt = [
    tagged('judge_scope', modelJson({ scope: 'digest', items: items.length })),
    tagged('digest_markdown', markdown.trim()),
    tagged('deterministic_summary', modelJson(deterministic)),
  ].join('\n\n');
  const digest = await runStage({ stage: 'judge', label: 'judge-digest', system, prompt: digestPrompt, parse: text => parseScores(text, 'digest') });

  const result = {
    schemaVersion: 1, kind: 'prototype-eval-measurement', notReview: true, note: MEASUREMENT_NOTE,
    runDir: run.runRoot, outDir: out, collectionId: report.collectionId,
    deterministic, items, digest, judge: roles.judge.describe(), usage: usage.report(),
    ...(limits ? { budget: budget.report() } : {}), warnings,
  };
  store.put('eval.json', jsonText(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
  const [runDir, outDir, modelsFile] = ['--run', '--out', '--models'].map(value);
  const resume = argv.includes('--resume');
  if (!runDir || !outDir || !modelsFile) {
    console.error('Usage: eval.mjs --run RUN_DIRECTORY --out ORCHESTRATOR_OUT_DIRECTORY --models models.json [--resume]');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await evaluate({ runDir, outDir, modelsFile, resume }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.message }));
    process.exitCode = 1;
  }
}
