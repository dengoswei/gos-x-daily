// Public sources follow the release. Private profiles and explicit overrides stay local.
export function effectiveSources(defaults, local = {}) {
  const disabled = new Set(local.disabledSources ?? []);
  const merge = key => [...new Map([
    ...(defaults[key] ?? []).map(row => [row.name, row]),
    ...(local[key] ?? []).map(row => [row.name, row]),
  ]).values()].filter(row => !disabled.has(row.name));
  return { ...defaults, ...local, feeds: merge('feeds'), blogs: merge('blogs') };
}

// A source may declare what its items are, e.g. a mathematician's blog is `essay`.
// The hint replaces keyword guessing for that source; customer stories are still detected.
export const SOURCE_CATEGORY_HINTS = Object.freeze(['essay', 'paper', 'infra_eng', 'open_source', 'product', 'general']);

export function assertSourceCategory(row, kind) {
  if (row?.category !== undefined && !SOURCE_CATEGORY_HINTS.includes(row.category)) {
    throw new Error(`${kind} ${row?.name ?? '(unnamed)'} category must be one of ${SOURCE_CATEGORY_HINTS.join('|')}`);
  }
}

/** Maps feed and blog names (the content-store source label) to their declared category. */
export function sourceCategoryHints(sources = {}) {
  const hints = new Map();
  for (const [key, kind] of [['feeds', 'Feed'], ['blogs', 'Blog']]) {
    for (const row of Array.isArray(sources?.[key]) ? sources[key] : []) {
      assertSourceCategory(row, kind);
      if (row.category && typeof row.name === 'string') hints.set(row.name, row.category);
    }
  }
  return hints;
}
