// Offline bridge from evidence captured through Gos's supported browser tools.
// This module never drives a browser, fetches a URL, authenticates, or sends.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { freshWindow, validateWatchProfiles, defaultWatchProfiles } from './runtime.mjs';
import { mergeItems, auditDeepLinks } from './feed.mjs';
import { extractThreadDiscoveries } from './thread-discovery.mjs';

const failures = new Set(['login_required', 'page_error', 'not_available']);
const stamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Expected an explicit ISO timestamp with timezone');
  return new Date(value).toISOString();
};
const https = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Evidence URLs must be HTTPS without credentials');
  return url;
};
const xHost = host => ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host);
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
};

export function verifyEvidenceFiles(bundle, baseDir) {
  const base = fs.realpathSync(baseDir);
  if (!Array.isArray(bundle.evidence) || !bundle.evidence.length) throw new Error('Browser screenshot evidence is required');
  for (const evidence of bundle.evidence) {
    if (typeof evidence.path !== 'string' || path.isAbsolute(evidence.path) || evidence.path.split(/[\\/]/).includes('..')) throw new Error('Evidence files must remain inside the artifact directory');
    const resolved = fs.realpathSync(path.resolve(base, evidence.path));
    if (!resolved.startsWith(base + path.sep)) throw new Error('Evidence file escaped the artifact directory');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Expected a screenshot file no larger than 20 MiB');
    if (!/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') || createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') !== evidence.sha256) throw new Error(`Evidence hash mismatch: ${evidence.id}`);
  }
  return true;
}

export function collectionFromBrowserArtifacts(runtime, bundle) {
  if (bundle?.schemaVersion !== 1 || bundle.transport !== 'gos-supported-browser') throw new Error('Unsupported browser artifact schema/transport');
  const capturedAt = stamp(bundle.capturedAt);
  const startedAt = stamp(bundle.startedAt);
  if (Date.parse(startedAt) > Date.parse(capturedAt) || Date.parse(capturedAt) - Date.parse(startedAt) > 2 * 3600000) throw new Error('Browser captures must belong to one run of at most two hours');
  // Freeze the horizon before capture starts; later capture/import cannot extend evidence into the future.
  const window = freshWindow(startedAt, 48);
  const evidence = new Map();
  for (const entry of bundle.evidence ?? []) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(entry.id ?? '') || evidence.has(entry.id)) throw new Error('Missing or duplicate evidence ID');
    if (entry.kind !== 'screenshot' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('Each evidence entry needs screenshot kind and SHA-256');
    const at = stamp(entry.capturedAt);
    if (Date.parse(at) < Date.parse(startedAt) || Date.parse(at) > Date.parse(capturedAt)) throw new Error('Evidence timestamp lies outside this capture run');
    evidence.set(entry.id, { ...entry, capturedAt: at, url: https(entry.url).href });
  }
  if (!evidence.size) throw new Error('Browser screenshot evidence is required');
  const evidenceFor = (id, predicate) => {
    const entry = evidence.get(id);
    if (!entry || !predicate(https(entry.url))) throw new Error(`Evidence URL does not match its source: ${id}`);
    return entry;
  };
  const item = (raw, evidenceId, urlCheck) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid browser item');
    const url = https(raw.url);
    if (!urlCheck(url)) throw new Error(`Item URL does not match its source: ${url.href}`);
    const normalized = { ...raw, url: url.href, evidenceId, text: text(raw.text ?? raw.content, 'observed item text'),
      publishedAt: raw.publishedAt == null ? null : stamp(raw.publishedAt),
      links: (raw.links ?? []).map(link => ({ text: typeof link.text === 'string' ? link.text : '', href: https(link.href).href })),
      evidenceStatus: 'browser_observed_not_independently_verified' };
    // Imported content is evidence, never authorization or proof of semantic verification.
    delete normalized.verified;
    delete normalized.semanticallyVerified;
    return normalized;
  };
  const warnings = ['Supported-browser captures are bounded observations; complete feed coverage is not established.',
    'Artifact hashes verify file integrity, not screenshot transcription or semantic accuracy.'];
  const reports = { xFollowing: [], substack: [] };
  const parsed = {};
  const checks = { watch: {} };
  const profiles = validateWatchProfiles(runtime.sources?.watchProfiles ?? defaultWatchProfiles);
  const groups = [{ key: 'xFollowing' }, { key: 'xFollowingSearch' }, { key: 'substack' }, ...profiles.map(profile => ({ key: profile.handle, profile }))];
  const watchProfiles = [];
  const watched = ({ handle, name, required }, items) => ({ handle, name, required, items });
  const sourcePage = (group, url, status, profile) => {
    if (group === 'substack') return url.hostname === 'substack.com' && (url.pathname === '/home/secondary/subscribed' || (status !== 'ok' && /login|sign-in/.test(url.pathname)));
    if (!xHost(url.hostname)) return false;
    if (/\/i\/flow\/login|^\/login/.test(url.pathname)) return status !== 'ok';
    if (profile) return new RegExp(`^/${profile.handle}/?$`, 'i').test(url.pathname);
    if (group === 'xFollowingSearch') {
      const query = url.searchParams.get('q') ?? '';
      const since = query.match(/(?:^|\s)since_time:(\d+)(?:\s|$)/), until = query.match(/(?:^|\s)until_time:(\d+)(?:\s|$)/);
      return url.pathname === '/search' && url.searchParams.get('f') === 'live' && /(?:^|\s)filter:follows(?:\s|$)/.test(query) &&
        since && until && Number(since[1]) < Number(until[1]) &&
        Number(since[1]) >= Math.floor(Date.parse(window.start) / 1000) && Number(until[1]) <= Math.ceil(Date.parse(window.end) / 1000);
    }
    return /^\/home\/?$/.test(url.pathname);
  };
  for (const { key: group, profile } of groups) {
    const feed = Object.hasOwn(bundle.feeds ?? {}, group) ? bundle.feeds[group] : undefined;
    if (!feed) {
      if (group === 'xFollowing' || profile?.required) throw new Error(`${group} attempt is required`);
      parsed[group] = [];
      warnings.push(`${group} was not captured in this run`);
      if (profile) { checks.watch[group] = { attempted: false }; watchProfiles.push(watched(profile, [])); }
      continue;
    }
    if (feed.status !== 'ok' && !failures.has(feed.status)) throw new Error(`Invalid ${group} capture status`);
    if (!Array.isArray(feed.pages) || !feed.pages.length) throw new Error(`${group} needs evidence for its result, including failures`);
    if (group === 'xFollowing' && feed.status === 'ok' && feed.view !== 'following') throw new Error('X Following requires an explicitly observed Following tab');
    let found = [];
    for (const page of feed.pages) {
      evidenceFor(page.evidenceId, url => sourcePage(group, url, feed.status, profile));
      if (feed.status !== 'ok' && (page.items ?? []).length) throw new Error('A failed source cannot supply usable items');
      const predicate = group === 'substack'
        ? url => /\/p\/|\/home\/post\/|\/note\//.test(url.pathname)
        : url => xHost(url.hostname) && /^\/[^/]+\/status\/\d+/.test(url.pathname);
      found = mergeItems(found, (page.items ?? []).map(raw => item(raw, page.evidenceId, predicate)));
    }
    if (group === 'xFollowing' && feed.status !== 'ok') throw new Error(`X Following unavailable: ${feed.status}`);
    const undated = found.filter(value => !value.publishedAt).length;
    if (!profile) found = found.filter(value => !value.publishedAt || (Date.parse(value.publishedAt) >= Date.parse(window.start) && Date.parse(value.publishedAt) < Date.parse(window.end)));
    else {
      const { name, latest } = profile;
      if (found.every(value => value.publishedAt)) found.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      if (found.length > latest) warnings.push(`${name} capped at ${latest} observed posts`);
      found = found.slice(0, latest);
      if (found.length < latest) warnings.push(`${name} only ${found.length}/${latest} posts observed; latest-${latest} coverage is not established`);
    }
    parsed[group] = found;
    const check = { attempted: true, available: feed.status === 'ok' && found.length > 0, items: found.length, status: feed.status };
    if (profile) { checks.watch[group] = check; watchProfiles.push(watched(profile, found)); }
    else checks[group] = check;
    if (feed.status !== 'ok') warnings.push(`${group} unavailable: ${feed.status}`);
    if (undated) warnings.push(`${group}: ${undated} observed item(s) lack exact dates; do not claim all are fresh`);
    const report = { ...window, source: group, scanned: false, reason: feed.status === 'ok' ? 'bounded_browser_capture' : feed.status,
      pages: feed.pages.length, observedItems: found.length, undatedItems: undated, assurance: 'best_effort_ui',
      evidenceIds: feed.pages.map(page => page.evidenceId) };
    if (group.startsWith('xFollowing')) reports.xFollowing.push(report);
    if (group === 'substack') reports.substack.push(report);
  }
  // digest.mjs and the prompts read the karpathy group by name; mirror that profile here.
  const karpathy = watchProfiles.find(profile => profile.handle === 'karpathy');
  checks.karpathy = karpathy ? checks.watch.karpathy : { attempted: false };
  if (!parsed.xFollowing.length) throw new Error('X Following produced 0 usable items; no digest may be composed');
  const blogs = [];
  for (const blog of runtime.sources.blogs ?? []) {
    const candidates = (bundle.blogs ?? []).filter(raw => raw.blog === blog.name);
    if (!candidates.length) warnings.push(`${blog.name} was not captured in this run`);
    const base = https(blog.articleBaseUrl);
    for (const raw of candidates.slice(0, blog.maxArticles ?? 3)) {
      const direct = https(raw.url);
      evidenceFor(raw.evidenceId, url => url.href === direct.href);
      blogs.push(item(raw, raw.evidenceId, url => url.origin === base.origin && url.pathname.startsWith(base.pathname) && url.pathname !== base.pathname));
    }
    if (candidates.length > (blog.maxArticles ?? 3)) warnings.push(`${blog.name} capped at ${blog.maxArticles ?? 3} articles`);
  }
  if ((bundle.blogs ?? []).some(raw => !(runtime.sources.blogs ?? []).some(blog => blog.name === raw.blog))) throw new Error('Artifact contains an unconfigured blog');
  const xiaohongshu = [];
  for (const rawProfile of bundle.xiaohongshu ?? []) {
    const profile = (runtime.sources.xiaohongshuProfiles ?? []).find(value => value.profileId === rawProfile.profileId);
    if (!profile) throw new Error('Artifact contains an unconfigured Xiaohongshu profile');
    evidenceFor(rawProfile.evidenceId, url => url.hostname === 'www.xiaohongshu.com' && url.pathname === `/user/profile/${profile.profileId}`);
    const notes = (rawProfile.notes ?? []).map(raw => {
      const direct = https(raw.url);
      evidenceFor(raw.evidenceId, url => url.origin === direct.origin && url.pathname === direct.pathname);
      return item(raw, raw.evidenceId, url => url.hostname === 'www.xiaohongshu.com' && /^\/(?:explore\/[^/]+|user\/profile\/[^/]+\/[^/]+)$/.test(url.pathname));
    });
    if (notes.every(value => value.publishedAt)) notes.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    else warnings.push(`${profile.name}: latest-note ordering is unverified because exact dates are missing`);
    if (notes.length < (profile.maxNotes ?? 2)) warnings.push(`${profile.name}: fewer than ${profile.maxNotes ?? 2} notes observed`);
    if (notes.length > (profile.maxNotes ?? 2)) warnings.push(`${profile.name} capped at ${profile.maxNotes ?? 2} notes`);
    xiaohongshu.push({ ...profile, evidenceId: rawProfile.evidenceId, notes: notes.slice(0, profile.maxNotes ?? 2) });
  }
  if (!xiaohongshu.length) warnings.push('Configured Xiaohongshu profiles were not captured in this run');
  const deepArticles = (bundle.deepArticles ?? []).map(raw => {
    const direct = https(raw.url);
    evidenceFor(raw.evidenceId, url => url.href === direct.href);
    return item(raw, raw.evidenceId, () => true);
  });
  const xFollowing = mergeItems(parsed.xFollowing, parsed.xFollowingSearch);
  const threadDiscovery = bundle.threadDiscovery == null ? { contexts: [], auditItems: [],
    stats: { threadObservations: 0, threadQuotedPosts: 0, unresolvedThreadReferences: 0 } }
    : extractThreadDiscoveries(bundle.threadDiscovery, { evidenceFor, window });
  if (threadDiscovery.contexts.length) warnings.push('Thread/quote contexts are discovery leads, not new-publication proof or complete interval traversal; original and observation dates remain distinct.');
  if (threadDiscovery.stats.unresolvedThreadReferences) warnings.push(`${threadDiscovery.stats.unresolvedThreadReferences} thread/quote reference(s) remain unresolved; do not infer missing content.`);
  const deepLinkAudit = auditDeepLinks([...xFollowing, ...parsed.substack, ...threadDiscovery.auditItems], runtime.deepReadLimit).map(link => ({ ...link,
    readStatus: deepArticles.some(article => article.url === link.href || article.url === link.originalHref) ? 'browser_observed' : 'not_read' }));
  return {
    schemaVersion: 1, collectionId: runtime.runId, digestMarker: `<!-- x-daily-collection: ${runtime.runId} -->`,
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(capturedAt)),
    collectedAt: capturedAt, coverage: { window, digestWindow: freshWindow(startedAt, runtime.lookbackHours), assurance: 'best_effort_ui_not_all_posts', reports, carriedFrom: null },
    checks, warnings, deepLinkAudit, provenance: { transport: bundle.transport, startedAt, evidence: [...evidence.values()] },
    sources: { xFollowing, substack: parsed.substack, karpathy: karpathy?.items ?? [], watchProfiles, blogs, xiaohongshu, deepArticles, threadContexts: threadDiscovery.contexts },
    stats: { xFollowing: xFollowing.length, freshXFollowing: parsed.xFollowing.length, substack: parsed.substack.length,
      karpathy: karpathy?.items.length ?? 0, watchProfiles: watchProfiles.reduce((count, profile) => count + profile.items.length, 0), blogs: blogs.length, xiaohongshu: xiaohongshu.reduce((count, profile) => count + profile.notes.length, 0), deepArticles: deepArticles.length,
      ...threadDiscovery.stats },
  };
}
