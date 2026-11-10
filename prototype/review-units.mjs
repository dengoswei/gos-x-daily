// Deterministic split of a composed digest into review units: one per main-body
// bullet block, plus one final audit unit carrying the coverage paragraph and the
// whole 差异补充 section. No model is involved, so two stages see the same cut.
import { canonicalUrl, digestUrls } from '../binding.mjs';

const AUDIT_HEADING = /^##\s+差异补充\s*$/;
const COVERAGE_START = /^(?:#{3,6}\s+)?本次采集范围/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const HEADING = /^#{1,6}\s/;
// The same bullet starts the digest validator counts, so units and mainBullets agree.
const BULLET_START = /^(?:[-*]|\d+[.)])\s/;

const unitId = index => `unit-${String(index + 1).padStart(3, '0')}`;

/**
 * Returns [{id, kind: 'item'|'audit', section, prose}] in digest order.
 * A bullet block ends at a blank line, the next bullet or any heading.
 */
export function extractUnits(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const auditIndex = lines.findIndex(line => AUDIT_HEADING.test(line.trim()));
  const mainEnd = auditIndex >= 0 ? auditIndex : lines.length;
  const coverageIndex = lines.findIndex((line, index) => index < mainEnd && COVERAGE_START.test(line.trim()));
  const bodyEnd = coverageIndex >= 0 ? coverageIndex : mainEnd;

  const units = [];
  let section = null;
  for (let index = 0; index < bodyEnd; index++) {
    const line = lines[index];
    const heading = line.match(SECTION_HEADING);
    if (heading) { section = heading[1]; continue; }
    if (HEADING.test(line) || section === null || !BULLET_START.test(line)) continue;
    const bullet = [line];
    let end = index + 1;
    while (end < bodyEnd && lines[end].trim() && !BULLET_START.test(lines[end]) && !HEADING.test(lines[end])) bullet.push(lines[end++]);
    units.push({ id: unitId(units.length), kind: 'item', section, prose: bullet.join('\n').trim() });
    index = end - 1;
  }

  const audit = [...(coverageIndex >= 0 ? lines.slice(coverageIndex, mainEnd) : []), ...(auditIndex >= 0 ? lines.slice(auditIndex) : [])]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (audit) units.push({ id: unitId(units.length), kind: 'audit', section: null, prose: audit });
  return units;
}

const canonical = href => { try { return canonicalUrl(href); } catch { return null; } };

/** The URLs a unit's prose cites, extracted the way the digest URL gate extracts them. */
export const unitCitedUrls = unit => [...new Set(digestUrls(unit.prose))];

/**
 * A unit's evidence keys: the included dispositions rows whose URL the unit cites,
 * compared canonically (`…/status/1` matches `…/status/1/`; `…/post` never matches `…/post-2`).
 */
export function unitEvidence(unit, dispositions) {
  const cited = new Set(unitCitedUrls(unit).map(canonical).filter(Boolean));
  const rows = (Array.isArray(dispositions?.items) ? dispositions.items : [])
    .filter(row => row?.disposition === 'included' && typeof row.url === 'string' && row.url.trim() && cited.has(canonical(row.url.trim())));
  return { keys: rows.map(row => row.key), citedUrls: [...new Set(rows.map(row => row.url))] };
}
