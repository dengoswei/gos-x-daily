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
