import { bulletLine } from './lark-post.mjs';
import { canonicalUrl, citedUrls } from './binding.mjs';

export const QUICK_SECTION = 'Quick Hits / 快讯速览';
export const DEEP_SECTION_ORDER = Object.freeze([
  'Frameworks / Infra', 'Breakthrough Research', 'Applications / Products', 'Long-form / Essays',
]);

export function assertDigestLayout(markdown) {
  const headings = [...String(markdown).matchAll(/^##[ \t]+(.+?)\s*$/gm)].map(match => match[1]);
  const quick = headings.filter(name => /quick\s*hits|快讯速览/i.test(name));
  if (quick.length && (quick.length !== 1 || headings[0] !== QUICK_SECTION)) {
    throw new Error('Quick Hits must appear once under its canonical heading before other sections');
  }
  if (/所给摘录|提供的材料|摘录(?:没有|未|中)|候选键/.test(markdown)) {
    throw new Error('Digest leaked internal pipeline phrasing');
  }
}

export const digestLayoutPrompt = `## Digest sections

Use these headings in order, omitting sections without a qualifying item:
${[QUICK_SECTION, ...DEEP_SECTION_ORDER].map((name, index) => (index + 1) + '. \`## ' + name + '\`').join('\n')}

Use Quick Hits for standalone releases, version updates or ecosystem news whose
practical change fits in one or two sentences. State what changed, who can use it
when known, and cite the primary source. Give research and items that require
explaining a mechanism or comparison a deep section of their own. Include
substantive essays, engineering retrospectives and first-person analyses in
Long-form / Essays. Give each item one place in the report.
`;

/**
 * Splits a digest into its items (one per list bullet, continuation lines included)
 * and its skeleton (title, headings and any text outside an item). Lines are trimmed,
 * as the validator and renderer treat them.
 */
export function parseDigestStructure(markdown) {
  const lines = String(markdown ?? '').trim().split(/\r?\n/);
  const skeleton = lines.length && lines[0].trim() ? [lines[0].trim()] : [];
  const bullets = [];
  let section = null;
  let current = null;
  const flush = () => {
    if (current) bullets.push({ section, text: current.join('\n') });
    current = null;
  };
  for (const raw of lines.slice(1)) {
    const trimmed = raw.trim();
    if (!trimmed) { flush(); continue; }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) { flush(); section = h2[1].trim(); skeleton.push(trimmed); continue; }
    if (/^#{3,6}\s/.test(trimmed)) { flush(); skeleton.push(trimmed); continue; }
    if (bulletLine.test(trimmed)) { flush(); current = [trimmed]; continue; }
    if (current) current.push(trimmed);
    else skeleton.push(trimmed);
  }
  flush();
  return { skeleton, bullets };
}

const linkSet = text => new Set(citedUrls(text).map(href => {
  try { return canonicalUrl(href); } catch { return href; }
}));

/**
 * A single-pass reviewer may correct sentences inside existing items only. It keeps the
 * title, headings, item count, order and sections, adds no link to an item, changes at
 * least one item, and lists at least one issue per changed item.
 */
export function assertBoundedRevision(draftMarkdown, revisedMarkdown, issues = []) {
  const draft = parseDigestStructure(draftMarkdown);
  const revised = parseDigestStructure(revisedMarkdown);
  if (JSON.stringify(draft.skeleton) !== JSON.stringify(revised.skeleton)) {
    throw new Error('Review revision changed the title, headings or text outside items; correct sentences inside items only');
  }
  if (draft.bullets.length !== revised.bullets.length) {
    throw new Error(`Review revision changed the item count (draft ${draft.bullets.length}, revised ${revised.bullets.length}); keep every item and correct it in place`);
  }
  const changed = [];
  for (const [index, before] of draft.bullets.entries()) {
    const after = revised.bullets[index];
    if (before.section !== after.section) throw new Error(`Review revision moved item ${index + 1} to another section`);
    if (before.text === after.text) continue;
    changed.push(index + 1);
    const allowed = linkSet(before.text);
    const added = [...linkSet(after.text)].filter(href => !allowed.has(href));
    if (added.length) throw new Error(`Review revision added a link to item ${index + 1} (${added[0]}); keep the item's own links`);
  }
  if (!changed.length) throw new Error('A revise verdict must change at least one item; return pass with advisories instead');
  if (changed.length > issues.length) {
    throw new Error(`Review revision changed ${changed.length} items (${changed.join(', ')}) but listed ${issues.length} issues; name each changed item and its exact change`);
  }
  return { changedItems: changed };
}
