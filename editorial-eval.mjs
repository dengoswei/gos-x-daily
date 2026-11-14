#!/usr/bin/env node
// Development-time Editorial & Curation Evaluation Harness (v2).
// Evaluates both good and bad cases across:
//   (1) Curation & Domain Balance (AI Infra + Intelligence/Theory + World-Impact + Hamming Open-Door vs Robotics downweight)
//   (2) Prose Clarity, Positive Framing (正面直述), Paragraph Density, and Anti-Disclaimer Hygiene.
//
// Strictly a development-time measurement tool (`notApproval: true`); no publication or delivery gate reads its output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasteConfig, scoreTopicPrior, isRoboticsEmbodiedTopic, isCoreMlSystemsTopic, isIntelligenceTheoryTopic } from './curation.mjs';
import { selectTopicsHeuristic, buildScreenShortlist } from './run-daily.mjs';
import { QUICK_SECTION } from './digest-layout.mjs';
import { bulletLine } from './lark-post.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultDatasetPath = path.join(repoRoot, 'examples', 'editorial-eval-cases.json');

const NEGATIVE_CONTRAST_RE = /不是[^，。；\n]{1,24}而是|把[^，。；\n]{1,20}变成[^，。；\n]{1,20}，?而不是|不只是[^，。；\n]{1,20}，?还包括|容易混淆的(?:是|地方)/g;
const STRAWMAN_DISCLAIMER_RE = /不能合并为一个?统一(?:加速)?倍数|不等于整个索引按?同比例缩小|这只是功能开放[，,]?不代表|不能将其扩展为整个[^，。；\n]{1,18}的安全保证|不意味着[^，。；\n]{1,24}已有评测保证/g;
const PIPELINE_JARGON_RE = /所给摘录|提供的材料|摘录(?:没有|未|中)|候选键/g;
const MISTRANSLATED_JARGON_RE = /重数量化/g;
const COLD_JARGON_PATTERNS = [
  { name: 'bare_verify_without_speculative_anchor', test: text => /\bverify\s*(?:步|耗时|阶段)/i.test(text) && !/投机|草稿|draft|speculative/i.test(text) },
  { name: 'bare_smithy_without_api_model_anchor', test: text => /\bSmithy\b/.test(text) && !/API\s*模型|接口定义|IDL/i.test(text) },
];

function stripMarkdownLinksAndFormatting(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/^[-*+•]\s+/, '')
    .trim();
}

function countCjkChars(prose) {
  const clean = stripMarkdownLinksAndFormatting(prose);
  return (clean.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

function countTotalReadableChars(prose) {
  return stripMarkdownLinksAndFormatting(prose).replace(/\s+/g, '').length;
}

/**
 * Evaluates a single digest bullet (either `deep` or `quick`) against the reader-calibrated editorial rubric.
 * `cjkCount` counts Chinese characters (matching standard Chinese editorial word-count conventions where
 * technical tokens like `SGLang-TorchTPU` or `nDCG@10` are single terms rather than 15 characters each).
 */
export function evaluateBulletProse(bulletText, { tier = 'deep' } = {}) {
  const raw = String(bulletText ?? '').trim();
  const cjkCount = countCjkChars(raw);
  const totalChars = countTotalReadableChars(raw);
  const boldMatch = raw.match(/^(?:[-*+•]\s+)?\*\*([^*]+)\*\*/);
  const boldLead = boldMatch ? boldMatch[1].trim() : '';
  const hasEntityBracketLead = /^\[[^\]]+·[^\]]+\][：:]/.test(boldLead) || /^(?:补读|跟进)｜\[[^\]]+·[^\]]+\][：:]/.test(boldLead);

  const negativeContrastHits = [...raw.matchAll(NEGATIVE_CONTRAST_RE)].map(m => m[0]);
  const strawmanDisclaimerHits = [...raw.matchAll(STRAWMAN_DISCLAIMER_RE)].map(m => m[0]);
  const pipelineJargonHits = [...raw.matchAll(PIPELINE_JARGON_RE)].map(m => m[0]);
  const mistranslatedJargonHits = [...raw.matchAll(MISTRANSLATED_JARGON_RE)].map(m => m[0]);
  const coldJargonHits = COLD_JARGON_PATTERNS.filter(p => p.test(raw)).map(p => p.name);
  const hasInternalBlankLine = /\n\s*\n/.test(raw);
  const hasTrailingLinks = /\[[^\]]+\]\(https?:\/\/[^)]+\)\s*$/.test(raw);

  const maxCjk = tier === 'quick' ? 145 : 340;
  const minCjk = tier === 'quick' ? 18 : 100;
  const issues = [];

  if (tier === 'deep' && !hasEntityBracketLead) issues.push('missing_entity_bracket_bold_lead');
  if (cjkCount > maxCjk) issues.push(`bloated_length(${cjkCount}_cjk>${maxCjk})`);
  if (cjkCount < minCjk) issues.push(`under_explained_length(${cjkCount}_cjk<${minCjk})`);
  if (negativeContrastHits.length) issues.push(`jarring_negative_contrast(${negativeContrastHits.join('|')})`);
  if (strawmanDisclaimerHits.length) issues.push(`strawman_disclaimer_tail(${strawmanDisclaimerHits.join('|')})`);
  if (pipelineJargonHits.length) issues.push(`pipeline_jargon(${pipelineJargonHits.join('|')})`);
  if (mistranslatedJargonHits.length) issues.push(`mistranslated_jargon(${mistranslatedJargonHits.join('|')})`);
  if (coldJargonHits.length) issues.push(`cold_unanchored_jargon(${coldJargonHits.join('|')})`);
  if (hasInternalBlankLine) issues.push('internal_blank_line_detaches_links');
  if (!hasTrailingLinks) issues.push('missing_inline_markdown_link');

  return {
    passed: issues.length === 0,
    tier,
    charCount: cjkCount,
    totalChars,
    boldLead,
    hasEntityBracketLead,
    issues,
  };
}

/**
 * Extracts and scores every story bullet + whole-digest portfolio balance from a Markdown digest.
 */
export function evaluateDigestMarkdown(markdown) {
  const clean = String(markdown ?? '').split('\n### 运行自检')[0].split('\n## 差异补充')[0].trim();
  const lines = clean.split(/\r?\n/);
  let section = null;
  let current = null;
  const bullets = [];
  const flush = () => {
    if (current) bullets.push({ section, text: current.join('\n') });
    current = null;
  };

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) { flush(); section = h2[1].trim(); continue; }
    if (/^#{3,6}\s/.test(trimmed) || /^本次采集范围/.test(trimmed) || /^\d+\s*月\s*\d+\s*日修订版/.test(trimmed)) {
      flush();
      continue;
    }
    if (bulletLine.test(trimmed)) {
      flush();
      current = [trimmed];
    } else if (current) {
      current.push(trimmed);
    }
  }
  flush();

  const evaluated = bullets.map((b, idx) => {
    const tier = b.section === QUICK_SECTION ? 'quick' : 'deep';
    const proseEval = evaluateBulletProse(b.text, { tier });
    const fakeTopic = { title: proseEval.boldLead, cards: [{ tldr: stripMarkdownLinksAndFormatting(b.text) }] };
    const domain = isRoboticsEmbodiedTopic(fakeTopic) ? 'robotics_embodied'
      : isCoreMlSystemsTopic(fakeTopic) ? 'core_ml_systems'
      : isIntelligenceTheoryTopic(fakeTopic) ? 'intelligence_theory'
      : 'general_or_open_door';
    return { index: idx + 1, section: b.section, domain, ...proseEval };
  });

  const deepBullets = evaluated.filter(b => b.tier === 'deep');
  const quickBullets = evaluated.filter(b => b.tier === 'quick');
  const deepRoboticsCount = deepBullets.filter(b => b.domain === 'robotics_embodied').length;
  const deepCharCounts = deepBullets.map(b => b.charCount);
  const avgDeepChars = deepCharCounts.length
    ? Math.round(deepCharCounts.reduce((a, b) => a + b, 0) / deepCharCounts.length)
    : 0;
  const maxDeepChars = deepCharCounts.length ? Math.max(...deepCharCounts) : 0;

  const digestIssues = [];
  if (deepRoboticsCount > 1) digestIssues.push(`excess_robotics_in_deep(${deepRoboticsCount}>1)`);
  for (const b of evaluated) {
    for (const issue of b.issues) digestIssues.push(`bullet_${b.index}[${b.section}]:${issue}`);
  }

  return {
    notApproval: true,
    totalBullets: evaluated.length,
    deepCount: deepBullets.length,
    quickCount: quickBullets.length,
    deepRoboticsCount,
    avgDeepChars,
    maxDeepChars,
    sectionCounts: Object.fromEntries(
      [...new Set(evaluated.map(b => b.section))].map(sec => [sec, evaluated.filter(b => b.section === sec).length]),
    ),
    domainCounts: Object.fromEntries(
      ['core_ml_systems', 'intelligence_theory', 'general_or_open_door', 'robotics_embodied']
        .map(d => [d, deepBullets.filter(b => b.domain === d).length]),
    ),
    cleanBullets: evaluated.filter(b => b.passed).length,
    digestPassed: digestIssues.length === 0,
    digestIssues,
    bullets: evaluated,
  };
}

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
