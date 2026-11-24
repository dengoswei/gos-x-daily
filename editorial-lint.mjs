// Deterministic prose lint for digest bullets. It finds pattern hits (length,
// strawman tails, pipeline phrasing, mistranslation, cold codenames). A hit is a
// lead for the reviewer, not a semantic finding; a clean result is not approval.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isRoboticsEmbodiedTopic, isCoreMlSystemsTopic, isIntelligenceTheoryTopic } from './curation.mjs';
import { QUICK_SECTION } from './digest-layout.mjs';
import { bulletLine } from './lark-post.mjs';

const defaultLintConfig = fileURLToPath(new URL('./config/editorial-lint.json', import.meta.url));

const STRAWMAN_DISCLAIMER_RE = /不能合并为一个?统一(?:加速)?倍数|不等于整个索引按?同比例缩小|这只是功能开放[，,]?不代表|不能将其扩展为整个[^，。；\n]{1,18}的安全保证|不意味着[^，。；\n]{1,24}已有评测保证/g;
const PIPELINE_JARGON_RE = /所给摘录|提供的材料|摘录(?:没有|未|中)|候选键/g;
// Incident patterns live in config/editorial-lint.json; an invalid row fails at load.
export function loadLintPatterns(file = defaultLintConfig) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config?.schemaVersion !== 1 || !Array.isArray(config.mistranslations) || !Array.isArray(config.coldTerms)) {
    throw new Error('editorial-lint config needs schemaVersion 1, mistranslations[] and coldTerms[]');
  }
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const row of config.mistranslations) {
    if (typeof row?.wrong !== 'string' || !row.wrong.trim() || typeof row.right !== 'string' || !row.right.trim()) throw new Error('Each mistranslation needs wrong and right');
  }
  const mistranslated = config.mistranslations.length
    ? new RegExp(config.mistranslations.map(row => escape(row.wrong)).join('|'), 'g')
    : null;
  const cold = config.coldTerms.map(row => {
    if (typeof row?.name !== 'string' || !/^[a-z0-9_]+$/.test(row.name)) throw new Error('Each cold term needs a snake_case name');
    const pattern = new RegExp(row.pattern, row.flags ?? '');
    const anchor = row.anchor ? new RegExp(row.anchor, row.anchorFlags ?? '') : null;
    return { name: row.name, test: text => pattern.test(text) && !(anchor && anchor.test(text)) };
  });
  return { mistranslated, cold };
}
const LINT_PATTERNS = loadLintPatterns();

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

  const strawmanDisclaimerHits = [...raw.matchAll(STRAWMAN_DISCLAIMER_RE)].map(m => m[0]);
  const pipelineJargonHits = [...raw.matchAll(PIPELINE_JARGON_RE)].map(m => m[0]);
  const mistranslatedJargonHits = LINT_PATTERNS.mistranslated ? [...raw.matchAll(LINT_PATTERNS.mistranslated)].map(m => m[0]) : [];
  const coldJargonHits = LINT_PATTERNS.cold.filter(p => p.test(raw)).map(p => p.name);
  const hasInternalBlankLine = /\n\s*\n/.test(raw);
  const hasTrailingLinks = /\[[^\]]+\]\(https?:\/\/[^)]+\)\s*$/.test(raw);

  const maxCjk = tier === 'quick' ? 145 : 560;
  const minCjk = tier === 'quick' ? 18 : 100;
  const issues = [];

  if (tier === 'deep' && !hasEntityBracketLead) issues.push('missing_entity_bracket_bold_lead');
  if (cjkCount > maxCjk) issues.push(`bloated_length(${cjkCount}_cjk>${maxCjk})`);
  if (cjkCount < minCjk) issues.push(`under_explained_length(${cjkCount}_cjk<${minCjk})`);
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
