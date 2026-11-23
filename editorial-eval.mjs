#!/usr/bin/env node
// Development-time Editorial & Curation Evaluation Harness (v2).
// Evaluates both good and bad cases across:
//   (1) Curation & Domain Balance (AI Infra + Intelligence/Theory + World-Impact + Hamming Open-Door vs Robotics downweight)
//   (2) Prose Clarity, Positive Framing (正面直述), Paragraph Density, and Anti-Disclaimer Hygiene.
//
// The prose lint itself lives in editorial-lint.mjs; production records it as reviewer leads and
// internal telemetry. Neither this harness nor the lint is approval (`notApproval: true`), and no
// publication or delivery gate reads their output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasteConfig, scoreTopicPrior, isRoboticsEmbodiedTopic } from './curation.mjs';
import { selectTopicsHeuristic, buildScreenShortlist } from './run-daily.mjs';
import { evaluateBulletProse, evaluateDigestMarkdown } from './editorial-lint.mjs';

export { evaluateBulletProse, evaluateDigestMarkdown };

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultDatasetPath = path.join(repoRoot, 'examples', 'editorial-eval-cases.json');

/**
 * Runs the curated Good/Bad benchmark dataset (`examples/editorial-eval-cases.json`) to ensure
 * curation priors, shortlist diversity, robotics caps, and prose hygiene never regress.
 */
export function runEditorialBenchmarkSuite(datasetPath = defaultDatasetPath) {
  const suite = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const taste = loadTasteConfig();
  const results = [];

  for (const c of suite.curationCases ?? []) {
    const reportDate = c.reportDate ?? '2026-11-12';
    const topics = c.topics.map(tp => {
      const scored = scoreTopicPrior(tp, taste, { reportDate });
      return { ...tp, priorScore: scored.priorScore, curationSignals: scored.signals };
    });
    const shortlist = buildScreenShortlist(topics, { limit: c.shortlistLimit ?? 48 });
    const selected = selectTopicsHeuristic(topics, {
      maxDeep: c.maxDeep ?? 7,
      maxQuick: c.maxQuick ?? 4,
      maxRoboticsDeep: c.maxRoboticsDeep ?? 1,
      taste,
    });
    const selectedIds = new Set(selected.map(s => s.topicId));
    const shortlistIds = new Set(shortlist.map(s => s.topicId));
    const deepRobotics = selected.filter(s => s.tier === 'deep' && isRoboticsEmbodiedTopic(topics.find(t => t.topicId === s.topicId))).length;

    const failures = [];
    for (const mustId of c.expect?.mustSelect ?? []) {
      if (!selectedIds.has(mustId)) failures.push(`expected topic "${mustId}" to be selected`);
    }
    for (const forbidId of c.expect?.mustExclude ?? []) {
      if (selectedIds.has(forbidId)) failures.push(`expected topic "${forbidId}" to be excluded`);
    }
    for (const mustShortlistId of c.expect?.mustReachShortlist ?? []) {
      if (!shortlistIds.has(mustShortlistId)) failures.push(`expected topic "${mustShortlistId}" in Stage 2 shortlist`);
    }
    if (c.expect?.maxRoboticsDeep !== undefined && deepRobotics > c.expect.maxRoboticsDeep) {
      failures.push(`deep robotics ${deepRobotics} > ${c.expect.maxRoboticsDeep}`);
    }
    for (const [higherId, lowerId] of c.expect?.scoreOrder ?? []) {
      const hi = topics.find(t => t.topicId === higherId)?.priorScore ?? -Infinity;
      const lo = topics.find(t => t.topicId === lowerId)?.priorScore ?? Infinity;
      if (!(hi > lo)) failures.push(`expected priorScore(${higherId}=${hi}) > priorScore(${lowerId}=${lo})`);
    }

    results.push({ id: c.id, kind: 'curation', description: c.description, passed: failures.length === 0, failures });
  }

  for (const p of suite.proseCases ?? []) {
    const res = evaluateBulletProse(p.bullet, { tier: p.tier ?? 'deep' });
    const failures = [];
    if (res.passed !== p.expectPass) {
      failures.push(`expected passed=${p.expectPass}, got ${res.passed} (issues: ${res.issues.join(', ') || 'none'})`);
    }
    for (const expectedIssue of p.expectIssues ?? []) {
      if (!res.issues.some(i => i.startsWith(expectedIssue))) {
        failures.push(`missing expected issue prefix "${expectedIssue}" (got: ${res.issues.join(', ') || 'none'})`);
      }
    }
    results.push({ id: p.id, kind: 'prose', label: p.label, passed: failures.length === 0, charCount: res.charCount, issues: res.issues, failures });
  }

  const passedCount = results.filter(r => r.passed).length;
  return {
    notApproval: true,
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    allPassed: passedCount === results.length,
    results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const digestIdx = argv.indexOf('--digest');
  const digestFile = digestIdx >= 0 ? argv[digestIdx + 1] : null;
  const datasetIdx = argv.indexOf('--dataset');
  const datasetFile = datasetIdx >= 0 ? argv[datasetIdx + 1] : defaultDatasetPath;

  const benchmark = runEditorialBenchmarkSuite(datasetFile);
  const output = { benchmark };
  if (digestFile) {
    output.digestEvaluation = evaluateDigestMarkdown(fs.readFileSync(digestFile, 'utf8'));
  }
  console.log(JSON.stringify(output, null, 2));
  if (!benchmark.allPassed) process.exitCode = 1;
}
