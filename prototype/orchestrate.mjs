#!/usr/bin/env node
// Prototype orchestrator for pipeline stages 5-7 (screen -> story -> compose) plus an
// optional advisory review (stage 8) over an already captured run's worker packets.
// Capture and delivery stay outside: this writes a draft, feedback and a report, never
// an approval or a send.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateKeys, skipReasons } from '../binding.mjs';
import { validateDigest } from '../digest.mjs';
import { UNTRUSTED, JSON_NOTE, jsonText, modelJson, escapeMarkup, tagged, regularFile, stageContract, extractBlock, parseJsonBlock, containsWholeUrl,
  loadModels, openRun, promptView, assembleEvidence, evidenceBlocks, outputStore, mapPool, usageLedger, budgetGuard, makeStageRunner } from './run-packets.mjs';
import { extractUnits, unitEvidence, unitCitedUrls } from './review-units.mjs';

const ROLES = ['screen', 'story', 'compose'];
const OPTIONAL_ROLES = ['review'];
const SECTIONS = ['Frameworks / Infra', 'Breakthrough Research', 'Applications / Products', 'Long-form / Essays', '补课 / 历史讨论'];
const LIMIT_FIELDS = ['paperPublishedAt', 'dateStatus', 'truncated', 'error'];
const BULLET_START = /^(?:[-*]|\d+[.)])\s/;
const ADVISORY_NOTE = 'Advisory feedback only: this stage has no approval authority, does not change the run status, and does not satisfy the deployment\'s required review.';

const limitsOf = source => Object.fromEntries(LIMIT_FIELDS.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
const nonEmpty = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`); return value.trim(); };
const stringList = (value, label) => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(`${label} must be an array of strings`);
  return value.map(entry => entry.trim()).filter(Boolean);
};
const pad = (index, width) => String(index + 1).padStart(width, '0');

export { extractBlock };

/**
 * A fresh directory beneath an existing parent, never overwriting a prior run; or, with
 * resume, an existing unfinished one (no report.json yet) whose write-once files are reused.
 */
function outputDirectory(chosen, resume) {
  const target = path.resolve(chosen);
  const directory = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (resume) {
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new Error(`--resume needs an existing output directory: ${directory}`);
    if (fs.existsSync(path.join(directory, 'report.json'))) throw new Error(`Orchestrator output is already complete (report.json exists); nothing to resume: ${directory}`);
    return directory;
  }
  if (fs.existsSync(directory)) throw new Error(`Orchestrator output directory must be new (or pass --resume to continue an unfinished one): ${directory}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}

// Screening reads a compact view; full packets are reserved for the story stage.
function screeningView(candidate) {
  return {
    key: candidate.key, kind: candidate.kind, ...(candidate.watchedHandle ? { watchedHandle: candidate.watchedHandle } : {}),
    author: candidate.author ?? null, url: candidate.url ?? null, title: candidate.title ?? null,
    publishedAt: candidate.publishedAt ?? null, text: candidate.text ?? null,
    links: (candidate.links ?? []).map(link => link?.href).filter(Boolean),
    ...limitsOf(candidate), deepRead: candidate.deepRead ?? null, cluster: candidate.cluster ?? null,
    ...(candidate.alternateObservations?.length
      ? { alternateObservations: candidate.alternateObservations.map(observation => ({ publishedAt: observation.publishedAt ?? null, text: observation.text ?? null, ...limitsOf(observation) })) }
      : {}),
  };
}

function parseDecisions(text, expected) {
  const payload = parseJsonBlock(text);
  if (!Array.isArray(payload?.decisions)) throw new Error('Expected {"decisions": [...]}');
  const seen = new Set();
  const decisions = payload.decisions.map((row, index) => {
    const label = `Decision ${index + 1}`;
    if (!row || typeof row !== 'object') throw new Error(`${label} must be an object`);
    if (!expected.includes(row.key)) throw new Error(`${label} names a key that is not in this batch: ${row.key}`);
    if (seen.has(row.key)) throw new Error(`${label} repeats a decided key: ${row.key}`);
    seen.add(row.key);
    if (!['story', 'skip'].includes(row.action)) throw new Error(`${label} action must be story or skip`);
    if (typeof row.reason !== 'string' || !row.reason.trim()) throw new Error(`${label} needs a reason`);
    if (row.action === 'skip' && !skipReasons.includes(row.reason)) throw new Error(`${label} skip reason must be one of: ${skipReasons.join(', ')}`);
    if (row.groupWith !== undefined && (row.action !== 'story' || typeof row.groupWith !== 'string' || !row.groupWith.trim())) throw new Error(`${label} groupWith is only valid on a story decision`);
    return { key: row.key, action: row.action, reason: row.reason.trim(), ...(row.groupWith ? { groupWith: row.groupWith } : {}) };
  });
  const missing = expected.filter(key => !seen.has(key));
  if (missing.length) throw new Error(`Every batch key needs a decision; missing ${missing.length}: ${missing.join(', ')}`);
  return decisions;
}

// Groups span batches: a watch post may share a subject with a Following post.
function buildGroups(decisions, keyOrder) {
  const selected = decisions.filter(decision => decision.action === 'story').map(decision => decision.key);
  const known = new Set(selected);
  const rank = new Map(keyOrder.map((key, index) => [key, index]));
  const parent = new Map(selected.map(key => [key, key]));
  const find = key => { let root = key; while (parent.get(root) !== root) root = parent.get(root); for (let at = key; at !== root; ) { const next = parent.get(at); parent.set(at, root); at = next; } return root; };
  const warnings = [];
  for (const decision of decisions) {
    if (decision.action !== 'story' || !decision.groupWith) continue;
    if (decision.groupWith === decision.key || !known.has(decision.groupWith)) {
      warnings.push(`Screening groupWith ${decision.groupWith} is not another selected candidate; ${decision.key} keeps its own group`);
      continue;
    }
    const left = find(decision.key), right = find(decision.groupWith);
    if (left === right) continue;
    const keep = rank.get(left) <= rank.get(right) ? left : right;
    parent.set(keep === left ? right : left, keep);
  }
  const grouped = new Map();
  for (const key of selected) {
    const root = find(key);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(key);
  }
  const groups = [...grouped.values()].map(keys => keys.slice().sort((a, b) => rank.get(a) - rank.get(b)))
    .sort((a, b) => rank.get(a[0]) - rank.get(b[0]));
  return { groups, warnings };
}

function parseStory(text, group, suppliedBytes) {
  const markdown = extractBlock(text, 'markdown');
  if (!/^[-*]\s/.test(markdown)) throw new Error('The markdown block must be a single bullet starting with "- "');
  // extractUnits ends a bullet at a blank line, another bullet or a heading, so none may follow.
  if (markdown.split('\n').slice(1).some(line => !line.trim() || BULLET_START.test(line) || /^#{1,6}\s/.test(line))) {
    throw new Error('The markdown block must hold exactly one bullet: no blank line, second bullet or heading after its first line');
  }
  if (!/https?:\/\/[^\s)<>]+/.test(markdown)) throw new Error('The bullet needs a direct source URL');
  const meta = parseJsonBlock(text);
  if (!group.includes(meta?.primaryKey)) throw new Error(`primaryKey must be one of this group's keys: ${group.join(', ')}`);
  if (!SECTIONS.includes(meta.section)) throw new Error(`section must be one of: ${SECTIONS.join(', ')}`);
  if (!Array.isArray(meta.citedUrls) || !meta.citedUrls.length || meta.citedUrls.some(url => typeof url !== 'string' || !url.trim())) throw new Error('citedUrls must be a non-empty array of URL strings');
  for (const field of ['limits', 'unresolved']) {
    if (!Array.isArray(meta[field]) || meta[field].some(entry => typeof entry !== 'string')) throw new Error(`${field} must be an array of strings`);
  }
  for (const url of meta.citedUrls) {
    // Whole-URL matches: a cited prefix of a longer supplied URL is not a supplied URL.
    if (!containsWholeUrl(suppliedBytes, url)) throw new Error(`citedUrls contains a URL absent from the supplied packets: ${url}`);
    if (!containsWholeUrl(markdown, url)) throw new Error(`citedUrls contains a URL the bullet does not cite: ${url}`);
  }
  return { markdown, primaryKey: meta.primaryKey, section: meta.section, citedUrls: [...meta.citedUrls], limits: [...meta.limits], unresolved: [...meta.unresolved] };
}

function parseComposed(text) {
  const markdown = extractBlock(text, 'markdown');
  if (!markdown.startsWith('# ')) throw new Error('The markdown block must start with the digest title line');
  return { markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n`, dispositions: parseJsonBlock(text) };
}

function parseReconstruction(text) {
  const payload = parseJsonBlock(text);
  if (!payload?.reconstruction || typeof payload.reconstruction !== 'object') throw new Error('Expected a reconstruction object');
  const reconstruction = Object.fromEntries(['problem', 'mechanism', 'conclusion', 'innovationType']
    .map(field => [field, nonEmpty(payload.reconstruction[field], `reconstruction.${field}`)]));
  if (!['clear', 'unclear'].includes(payload.verdictA)) throw new Error('verdictA must be clear or unclear');
  return { reconstruction, missingLinks: stringList(payload.missingLinks, 'missingLinks'),
    confusions: stringList(payload.confusions, 'confusions'), verdictA: payload.verdictA };
}

function parseFindings(text) {
  const payload = parseJsonBlock(text);
  if (!Array.isArray(payload?.findings)) throw new Error('Expected {"findings": [...]}');
  const findings = payload.findings.map((row, index) => {
    const label = `Finding ${index + 1}`;
    if (!row || typeof row !== 'object') throw new Error(`${label} must be an object`);
    if (!['material', 'minor'].includes(row.severity)) throw new Error(`${label} severity must be material or minor`);
    return { severity: row.severity, ...Object.fromEntries(['kind', 'quote', 'problem', 'suggestion']
      .map(field => [field, nonEmpty(row[field], `${label} ${field}`)])) };
  });
  if (!['faithful', 'issues'].includes(payload.verdictB)) throw new Error('verdictB must be faithful or issues');
  return { findings, verdictB: payload.verdictB };
}

/** Candidate ledger coverage before the shared digest gates, so a repair prompt names the gap. */
function validateComposed(markdown, collection, dispositions) {
  const keys = candidateKeys(collection);
  const rows = Array.isArray(dispositions?.items) ? dispositions.items : [];
  const covered = rows.flatMap(row => (Array.isArray(row?.keys) ? row.keys : [row?.key]));
  const missing = keys.filter(key => !covered.includes(key));
  const unknown = [...new Set(covered.filter(key => !keys.includes(key)))];
  if (missing.length || unknown.length) {
    throw new Error(`dispositions keys must equal the candidate keys (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.map(String).join(', ') || 'none'})`);
  }
  return validateDigest(markdown, collection, { dispositions });
}

const evidenceUnresolvedFinding = urls => ({
  severity: 'material', kind: 'evidence-unresolved',
  quote: urls.length ? urls.join(' ') : '(the unit cites no URL)',
  problem: 'No included dispositions row matches a URL this unit cites, so no evidence was resolved and source fidelity was not checked. Recorded by the orchestrator without a model call.',
  suggestion: 'Cite the included candidate\'s own URL in the bullet, or correct the dispositions row url, then review the unit against its evidence.',
});

/**
 * Advisory stage 8 over the validated draft, units in parallel: per unit, blind
 * comprehension first and persisted, then source fidelity against that unit's own
 * evidence. Feedback only, never approval.
 */
async function advisoryReview({ markdown, dispositions, run, runStage, store, concurrency }) {
  const units = extractUnits(markdown);
  const systemA = ['<!-- stage: review-a -->', stageContract('review-a')].join('\n\n');
  const systemB = ['<!-- stage: review-b -->', stageContract('review-b'), UNTRUSTED, JSON_NOTE].join('\n\n');
  const scope = unit => ({ unit: unit.id, kind: unit.kind, ...(unit.section ? { section: unit.section } : {}) });

  const reviewUnit = async unit => {
    const header = tagged('review_unit', modelJson(scope(unit)));
    const stageA = await runStage({ stage: 'review', label: `review-a-${unit.id}`, system: systemA,
      prompt: [header, tagged('unit_prose', unit.prose)].join('\n\n'), parse: parseReconstruction });
    const fileA = `review/${unit.id}.a.json`;
    let recordA;
    if (store.exists(fileA)) {
      // Resume: the persisted blind record, with its real timestamp, is what Stage B reads.
      recordA = store.read(fileA);
      const saved = JSON.parse(recordA);
      if (saved.unit !== unit.id || saved.verdictA !== stageA.verdictA || JSON.stringify(saved.reconstruction) !== JSON.stringify(stageA.reconstruction)) {
        throw new Error(`${fileA} does not match its checkpointed Stage A response; start a new --out`);
      }
    } else {
      // Escaped JSON: the persisted bytes are exactly the bytes Stage B is shown.
      recordA = escapeMarkup(jsonText({ schemaVersion: 1, stage: 'review-a', advisory: true, notApproval: true, ...scope(unit),
        sourceBlind: true, persistedAt: new Date().toISOString(), ...stageA }));
      store.put(fileA, recordA);
    }

    const evidence = unitEvidence(unit, dispositions);
    const unresolved = unit.kind === 'item' && !evidence.keys.length;
    let stageB, warning = null;
    if (unresolved) {
      // Never hand a fidelity reviewer an empty evidence set as if evidence were present.
      stageB = { findings: [evidenceUnresolvedFinding(unitCitedUrls(unit))], verdictB: 'issues' };
      warning = `Advisory review ${unit.id}: no included dispositions row matches the unit's cited URLs; Stage B made no model call and records a material evidence-unresolved finding`;
    } else {
      const blocks = unit.kind === 'audit'
        ? [tagged('collection_context', modelJson(promptView(run.context))),
          tagged('coverage_accounting', modelJson({ coverage: run.collection.coverage, warnings: run.collection.warnings }))]
        : evidenceBlocks(assembleEvidence(run.read, run.rows, evidence.keys));
      // Stage B reads back exactly the bytes persisted, so the blind record cannot be revised.
      stageB = await runStage({ stage: 'review', label: `review-b-${unit.id}`, system: systemB, parse: parseFindings,
        prompt: [header, tagged('stage_a_record', recordA.trim()), tagged('unit_prose', unit.prose), ...blocks].join('\n\n') });
    }
    const fileB = `review/${unit.id}.b.json`;
    if (store.exists(fileB)) {
      if (JSON.parse(store.read(fileB)).verdictB !== stageB.verdictB) throw new Error(`${fileB} does not match its Stage B result; start a new --out`);
    } else {
      store.put(fileB, jsonText({ schemaVersion: 1, stage: 'review-b', advisory: true, notApproval: true, ...scope(unit),
        checkedAt: new Date().toISOString(), stageAFile: fileA,
        evidence: unit.kind === 'audit' ? { kind: 'collection_context_and_coverage' }
          : { keys: evidence.keys, citedUrls: evidence.citedUrls, resolved: !unresolved, ...(unresolved ? { unitUrls: unitCitedUrls(unit) } : {}) },
        ...(unresolved ? { modelCall: false } : {}), ...stageB }));
    }
    return { files: [fileA, fileB], verdictA: stageA.verdictA, verdictB: stageB.verdictB, findings: stageB.findings, warning };
  };

  const results = await mapPool(units, concurrency, reviewUnit, { what: 'review units', label: unit => unit.id });
  const verdicts = { clear: 0, unclear: 0, faithful: 0, issues: 0 };
  const findings = { material: 0, minor: 0 };
  for (const result of results) {
    verdicts[result.verdictA] += 1;
    verdicts[result.verdictB] += 1;
    for (const finding of result.findings) findings[finding.severity] += 1;
  }
  return {
    review: { units: units.length, stageABlind: true, verdicts, findings,
      evidenceUnresolved: results.filter(result => result.warning).length,
      unitFiles: results.flatMap(result => result.files), note: ADVISORY_NOTE },
    warnings: results.map(result => result.warning).filter(Boolean),
  };
}

/**
 * Drives screening, story writing, composition and the optional advisory review over
 * RUN's worker packets. RUN needs sources.json, prompt.md and packets/ from `worker-input`.
 * Independent calls run in a bounded pool; with resume, an unfinished OUT is continued.
 */
export async function orchestrate({ runDir, modelsFile, outDir, resume = false, runtime = {} }) {
  const started = Date.now();
  const { roles, budget: limits } = loadModels(modelsFile, ROLES, OPTIONAL_ROLES, runtime);
  const run = openRun(runDir);
  const { read, coordinator, collection, keyOrder, rows, history, context, integrity } = run;
  const runPrompt = fs.readFileSync(regularFile(path.join(run.runRoot, 'prompt.md')), 'utf8');

  const out = outputDirectory(outDir, resume);
  const store = outputStore(out);
  const manifest = jsonText({ schemaVersion: 1, kind: 'prototype-orchestrator-output', collectionId: collection.collectionId });
  if (store.exists('manifest.json') && store.read('manifest.json') !== manifest) throw new Error(`--resume output belongs to a different collection: ${out}`);
  store.putOnce('manifest.json', manifest);
  const usage = usageLedger();
  const budget = budgetGuard(limits);
  const runStage = makeStageRunner({ roles, store, usage, budget, resume });
  const warnings = [];

  // Stable per-run context goes into each stage's system prefix, shared by every call of
  // that stage (provider prefix caching); only the batch, group or unit varies per call.
  const recent = history.publishedRecently.flatMap(({ date, urls }) => urls.map(url => `${date}  ${url}`));
  const common = [UNTRUSTED, JSON_NOTE, tagged('collection_context', modelJson({
    collectionId: context.collectionId, date: context.date, window: context.window,
    candidateCount: coordinator.candidateCount, warnings: context.warnings, zeroYieldSources: context.zeroYieldSources,
  })), ...(recent.length ? [tagged('published_recently', escapeMarkup(recent.join('\n')))] : [])];

  const screenSystem = ['<!-- stage: screen -->', stageContract('screen'), ...common].join('\n\n');
  const screenLabel = (_, index) => `screen-${pad(index, 5)}`;
  const screened = await mapPool(coordinator.sourcePackets, roles.screen.concurrency, async (descriptor, index) => {
    const packet = read(descriptor).value;
    const batch = packet.items.map(item => screeningView(read(item.packet).value.candidate));
    const label = screenLabel(descriptor, index);
    const batchKeys = batch.map(view => view.key);
    const prompt = [
      tagged('source_batch', modelJson({ source: packet.source, instructions: packet.instructions })),
      tagged('candidates_json', modelJson(batch)),
      tagged('screen_keys', escapeMarkup(batchKeys.join('\n'))),
    ].join('\n\n');
    const decided = await runStage({ stage: 'screen', label, system: screenSystem, prompt, parse: text => parseDecisions(text, batchKeys) });
    store.putOnce(`screen/${label}.json`, jsonText({ schemaVersion: 1, source: packet.source, decisions: decided }));
    return decided;
  }, { what: 'screening batches', label: screenLabel });
  const decisions = screened.flat();

  const { groups, warnings: groupWarnings } = buildGroups(decisions, keyOrder);
  warnings.push(...groupWarnings);
  const reasonOf = new Map(decisions.map(decision => [decision.key, decision.reason]));

  const storySystem = ['<!-- stage: story -->', stageContract('story'), ...common].join('\n\n');
  const storyLabel = (_, index) => `story-${pad(index, 4)}`;
  const stories = await mapPool(groups, roles.story.concurrency, async (group, index) => {
    const packets = assembleEvidence(read, rows, group);
    const label = storyLabel(group, index);
    const prompt = [
      tagged('group', modelJson({ representative: group[0], keys: group, screeningReasons: group.map(key => ({ key, reason: reasonOf.get(key) })) })),
      ...evidenceBlocks(packets),
    ].join('\n\n');
    const story = await runStage({ stage: 'story', label, system: storySystem, prompt, parse: text => parseStory(text, group, packets.suppliedBytes) });
    const file = `stories/${label}.md`;
    store.putOnce(file, `${story.markdown}\n`);
    store.putOnce(`stories/${label}.json`, jsonText({ schemaVersion: 1, keys: group, ...story, markdown: undefined, file }));
    return { ...story, keys: group, file };
  }, { what: 'story groups', label: (group, index) => `${storyLabel(group, index)} (${group.join(', ')})` });

  const skipped = decisions.filter(decision => decision.action === 'skip');
  // The run's composition input plus the compose contract is the prefix the compose call
  // and its repair round share.
  const composeSystem = ['<!-- stage: compose -->', runPrompt, stageContract('compose-suffix'), JSON_NOTE].join('\n\n');
  const composeBase = [
    tagged('screen_decisions', modelJson({
      selected: groups.map(group => ({ representative: group[0], keys: group })),
      skipped: skipped.map(decision => ({ key: decision.key, reason: decision.reason })),
    })),
    tagged('story_items', modelJson(stories.map(story => ({ primaryKey: story.primaryKey, keys: story.keys, section: story.section,
      citedUrls: story.citedUrls, limits: story.limits, unresolved: story.unresolved, markdown: story.markdown })))),
  ].join('\n\n');

  let composed = await runStage({ stage: 'compose', label: 'compose', system: composeSystem, prompt: composeBase, parse: parseComposed });
  let validation = null, failure = null, repaired = false, repairedFrom = null;
  try { validation = validateComposed(composed.markdown, collection, composed.dispositions); }
  catch (error) { failure = error.message; }
  if (failure) {
    repaired = true;
    repairedFrom = failure;
    composed = await runStage({ stage: 'compose', label: 'compose.repair', system: composeSystem, parse: parseComposed,
      prompt: `${composeBase}\n\n${tagged('validation_error', `The offline validator rejected your previous draft: ${failure}\nReturn the complete corrected digest and ledger in exactly the required format.`)}\n` });
    try { validation = validateComposed(composed.markdown, collection, composed.dispositions); failure = null; }
    catch (error) { failure = error.message; }
  }

  const passed = failure === null;
  store.putOnce(passed ? 'digest.md' : 'digest.rejected.md', composed.markdown);
  store.putOnce(passed ? 'dispositions.json' : 'dispositions.rejected.json', jsonText(composed.dispositions));

  // A rejected draft is never reviewed, and the review never changes the status below.
  let review = null;
  if (passed && roles.review) {
    const advisory = await advisoryReview({ markdown: composed.markdown, dispositions: composed.dispositions, run, runStage, store, concurrency: roles.review.concurrency });
    review = advisory.review;
    warnings.push(...advisory.warnings);
  }

  const report = {
    status: passed ? 'prototype_digest_composed_not_reviewed' : 'prototype_composition_rejected',
    prototype: true, runDir: run.runRoot, outDir: out, packetsDir: run.packetsRoot,
    collectionId: collection.collectionId, date: collection.date,
    packets: { candidates: integrity.candidates, sourcePackets: coordinator.sourcePackets.length, integrity: integrity.status },
    roles: Object.fromEntries(Object.keys(roles).map(role => [role, { ...roles[role].describe(), concurrency: roles[role].concurrency }])),
    screening: { decided: decisions.length, story: decisions.length - skipped.length, skipped: skipped.length, groups: groups.length,
      skippedReasons: skipped.reduce((counts, decision) => ({ ...counts, [decision.reason]: (counts[decision.reason] ?? 0) + 1 }), {}) },
    decisions: decisions.map(decision => ({ key: decision.key, action: decision.action, ...(decision.action === 'skip' ? { reason: decision.reason } : {}) })),
    stories: stories.map(story => ({ primaryKey: story.primaryKey, keys: story.keys, section: story.section, citedUrls: story.citedUrls, file: story.file })),
    stages: usage.report(),
    ...(limits ? { budget: budget.report() } : {}),
    resumed: resume, elapsedMs: Date.now() - started,
    validation: { passed, repaired, ...(repaired ? { repairedFrom } : {}), ...(passed ? { digest: validation } : { error: failure }) },
    ...(review ? { advisoryReview: review } : {}),
    warnings, notApproval: true,
  };
  store.put('report.json', jsonText(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
  const [runDir, modelsFile, outDir] = ['--run', '--models', '--out'].map(value);
  const resume = argv.includes('--resume');
  if (!runDir || !modelsFile || !outDir) {
    console.error('Usage: orchestrate.mjs --run RUN_DIRECTORY --models models.json --out NEW_DIRECTORY [--resume]');
    process.exit(2);
  }
  try {
    const report = await orchestrate({ runDir, modelsFile, outDir, resume });
    console.log(JSON.stringify(report, null, 2));
    if (!report.validation.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.message }));
    process.exitCode = 1;
  }
}
