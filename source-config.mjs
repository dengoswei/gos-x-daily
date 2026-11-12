// Public sources follow the release. Private profiles and explicit overrides stay local.
export function effectiveSources(defaults, local = {}) {
  const disabled = new Set(local.disabledSources ?? []);
  const merge = key => [...new Map([
    ...(defaults[key] ?? []).map(row => [row.name, row]),
    ...(local[key] ?? []).map(row => [row.name, row]),
  ]).values()].filter(row => !disabled.has(row.name));
  return { ...defaults, ...local, feeds: merge('feeds'), blogs: merge('blogs') };
}
