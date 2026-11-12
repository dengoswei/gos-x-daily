export const QUICK_SECTION = 'Quick Hits / 快讯速览';
export const DEEP_SECTION_ORDER = Object.freeze([
  'Frameworks / Infra', 'Breakthrough Research', 'Applications / Products', 'Long-form / Essays',
]);

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
