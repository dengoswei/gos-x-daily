// Offline gates that bind a digest to what was actually observed: every cited URL
// must come from the collection or a declared material file, and every candidate
// needs exactly one recorded disposition. This module never fetches a URL.
import fs from 'node:fs';
import path from 'node:path';
import { itemKey, canonicalLink } from './feed.mjs';
import { linkSpan, safeHref } from './lark-post.mjs';

const urlPattern = /https?:\/\/[^\s)<>]+/gi;
const materialUrlPattern = /https?:\/\/[^\s"'`<>)\]\\]+/g;
const trailing = /[.,;:!?。，、)\]》」）】]+$/;
const textExtensions = new Set(['.txt', '.md', '.json', '.jsonl', '.html', '.xml']);
const list = value => Array.isArray(value) ? value : [];
const meaningful = value => typeof value === 'string' && value.trim().length > 0;

/** Watch-profile item lists; collections without sources.watchProfiles fall back to sources.karpathy. */
export function watchGroups(sources) {
  if (Array.isArray(sources?.watchProfiles)) return sources.watchProfiles.map(profile => ({ handle: profile?.handle, items: list(profile?.items) }));
  return list(sources?.karpathy).length ? [{ handle: 'karpathy', items: list(sources.karpathy) }] : [];
}

// Item groups in candidate order: Following, Substack, each watch profile, then feeds.
const itemGroups = sources => [['xFollowing', list(sources.xFollowing)], ['substack', list(sources.substack)],
  ...watchGroups(sources).map(({ handle, items }) => [`watch:${handle}`, items]), ['feeds', list(sources.feeds)]];
export const skipReasons = ['off_topic', 'promotion', 'duplicate_topic', 'outside_window', 'low_signal', 'unreadable', 'other'];
export function readPublicationFile(rootDir, relative) {
  const root = fs.realpathSync(rootDir);
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('Publication paths must be safe relative paths');
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Publication paths must not use symlinks');
  }
  if (!fs.statSync(file).isFile() || !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error('Publication artifact must be a regular file inside rootDir');
  return fs.readFileSync(file, 'utf8');
}

export function canonicalUrl(href) {
  const url = canonicalLink(href);
  const host = url.host.toLowerCase().replace(/^www\./, '');
  return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;
}

const auditHeading = /^##\s+差异补充\s*$/;
const collectionMarker = /<!-- x-daily-collection: [a-zA-Z0-9-]+ -->[ \t]*/g;

/**
 * The one main-body/audit split used by render, binding and review. Markers are
 * removed within their line (never consuming a newline); a marker-only line is
 * dropped with the blank lines after it. `auditIndex` indexes `lines` (-1: none).
 */
export function splitDigest(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const auditIndex = lines.findIndex(line => auditHeading.test(line.replace(collectionMarker, '').trim()));
  const main = [];
  let afterMarker = false;
  for (const line of auditIndex >= 0 ? lines.slice(0, auditIndex) : lines) {
    const stripped = line.replace(collectionMarker, '');
    if (stripped !== line && !stripped.trim()) { afterMarker = true; continue; }
    if (afterMarker && !stripped.trim()) continue;
    afterMarker = false;
    main.push(stripped);
  }
  return { lines, auditIndex, main };
}
const mainBody = markdown => splitDigest(markdown).main.join('\n');

/**
 * Every URL a reader can follow in text: bare URLs (scheme in any case) and every
 * Markdown link destination in the renderer's grammar. Unsafe destinations throw.
 */
export function citedUrls(text) {
  const found = [...text.matchAll(urlPattern)].map(match => [match.index, match[0].replace(trailing, '')]);
  for (let index = text.indexOf('['); index >= 0; index = text.indexOf('[', index + 1)) {
    const span = linkSpan(text, index);
    if (!span) continue;
    let linkable = /^[\\/]/.test(span.href);
    try { new URL(span.href); linkable = true; } catch { /* Not a destination the renderer could emit. */ }
    if (linkable) found.push([span.hrefStart, span.href]);
  }
  const urls = [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, href]) => href))];
  const unsafe = urls.find(href => !safeHref(href));
  if (unsafe !== undefined) throw new Error(`Digest link is not a safe absolute HTTP(S) URL: ${unsafe}`);
  return urls;
}

/** Raw URLs cited in the digest main body (the audit section is excluded). */
export function digestUrls(markdown) {
  return citedUrls(mainBody(markdown));
}

// Each candidate with its own URL; thread contexts are discovery leads, not candidates.
export function candidateEntries(collection) {
  const sources = collection?.sources ?? {};
  const entries = [];
  for (const [group, items] of itemGroups(sources)) {
    for (const item of items) {
      const key = itemKey(item);
      if (!meaningful(key)) throw new Error(`Candidate in ${group} has no stable key`);
      entries.push({ key, url: item?.url });
    }
  }
  const direct = (prefix, item) => {
    if (!meaningful(item?.url)) throw new Error(`Candidate ${prefix} item has no URL`);
    entries.push({ key: `${prefix}:${item.url}`, url: item.url });
  };
  for (const blog of list(sources.blogs)) direct('blog', blog);
  for (const article of list(sources.deepArticles)) direct('deep', article);
  for (const profile of list(sources.xiaohongshu)) for (const note of list(profile?.notes)) direct('xhs', note);
  return entries;
}

export function candidateKeys(collection) {
  return [...new Set(candidateEntries(collection).map(entry => entry.key))];
}

const addUrl = (set, value) => {
  if (typeof value !== 'string') return;
  try { set.add(canonicalUrl(value)); } catch { /* Unparseable values cannot match a digest URL. */ }
};
const addItem = (set, item) => {
  addUrl(set, item?.url);
  for (const link of list(item?.links)) addUrl(set, link?.href);
};

export function observedUrls({ collection, rootDir, materialsPaths = [], evidencePaths = [] }) {
  const sources = collection?.sources ?? {};
  const observed = { collection: new Set(), materials: new Set() };
  for (const [, items] of itemGroups(sources)) items.forEach(item => addItem(observed.collection, item));
  for (const link of list(collection?.deepLinkAudit)) { addUrl(observed.collection, link?.href); addUrl(observed.collection, link?.originalHref); }
  for (const blog of list(sources.blogs)) addUrl(observed.collection, blog?.url);
  for (const article of list(sources.deepArticles)) { addUrl(observed.collection, article?.url); addUrl(observed.collection, article?.sourceHref); }
  for (const profile of list(sources.xiaohongshu)) list(profile?.notes).forEach(note => addItem(observed.collection, note));
  for (const context of list(sources.threadContexts)) {
    addItem(observed.collection, context);
    list(context?.quotedPosts).forEach(quote => addItem(observed.collection, quote));
    list(context?.unresolvedReferences).forEach(reference => addUrl(observed.collection, reference?.url));
  }
  for (const file of [...materialsPaths, ...evidencePaths]) {
    if (!textExtensions.has(path.extname(String(file)).toLowerCase())) continue;
    for (const match of readPublicationFile(rootDir, file).matchAll(materialUrlPattern)) addUrl(observed.materials, match[0].replace(trailing, ''));
  }
  return observed;
}

const parse = href => {
  try { return canonicalUrl(href); } catch { throw new Error(`Digest URL is not a valid URL: ${href}`); }
};
const hostOf = canonical => new URL(canonical).host;

export function validateUrlBinding(markdown, observed) {
  if (!(observed?.collection instanceof Set) || !(observed?.materials instanceof Set)) throw new Error('Observed URL sets are required for URL binding');
  let checked = 0, matchedCollection = 0, matchedMaterials = 0;
  for (const href of digestUrls(markdown)) {
    const canonical = parse(href);
    checked++;
    if (observed.collection.has(canonical)) { matchedCollection++; continue; }
    if (observed.materials.has(canonical)) { matchedMaterials++; continue; }
    const host = hostOf(canonical);
    const nearby = [...observed.collection, ...observed.materials].filter(url => hostOf(url) === host).slice(0, 3);
    throw new Error(`Digest URL not observed in collection or declared materials: ${href} (observed on the same host: ${nearby.length ? nearby.join(', ') : 'none'})`);
  }
  return { checked, matchedCollection, matchedMaterials };
}

/**
 * Ledger rows: {key, disposition: 'included', section, url} | {key, disposition: 'merged', mergedInto}
 * | {key|keys, disposition: 'skipped', reason, note?}. A cited candidate's own URL must belong to an
 * included row; other cited URLs are left to validateUrlBinding (observed.materials names supplements).
 */
export function validateDispositions(dispositions, collection, markdown, observed) {
  if (!dispositions || typeof dispositions !== 'object' || dispositions.schemaVersion !== 1) throw new Error('Dispositions require schemaVersion 1');
  if (dispositions.collectionId !== collection?.collectionId) throw new Error('Dispositions collectionId does not match this collection');
  if (!Array.isArray(dispositions.items)) throw new Error('Dispositions items must be an array');
  const keys = candidateKeys(collection), known = new Set(keys), seen = new Map();
  const body = mainBody(markdown);
  const headings = new Set(body.split(/\r?\n/).map(line => line.match(/^#{2,6}\s+(.+?)\s*$/)?.[1]).filter(Boolean));
  const cited = new Set(digestUrls(markdown).map(parse));
  const counts = { included: 0, merged: 0, skipped: 0 }, skippedReasons = {}, includedUrls = new Set(), merges = [];
  for (const [index, row] of dispositions.items.entries()) {
    const label = `Disposition row ${index + 1}`;
    if (!row || typeof row !== 'object') throw new Error(`${label} must be an object`);
    if (!['included', 'merged', 'skipped'].includes(row.disposition)) throw new Error(`${label} has an invalid disposition`);
    if ((row.key === undefined) === (row.keys === undefined)) throw new Error(`${label} needs exactly one of key or keys`);
    if (row.keys !== undefined && (row.disposition !== 'skipped' || !Array.isArray(row.keys) || !row.keys.length)) throw new Error(`${label}: batch keys are only allowed on skipped rows`);
    const rowKeys = row.keys ?? [row.key];
    for (const key of rowKeys) {
      if (!meaningful(key)) throw new Error(`${label} has an empty key`);
      if (!known.has(key)) throw new Error(`Unknown disposition key: ${key}`);
      if (seen.has(key)) throw new Error(`Duplicate disposition for candidate: ${key}`);
      seen.set(key, row.disposition);
    }
    if (row.disposition === 'included') {
      if (!meaningful(row.section) || !headings.has(row.section.trim())) throw new Error(`Included ${row.key} needs a section matching a digest main-body heading`);
      if (!meaningful(row.url)) throw new Error(`Included ${row.key} needs a url`);
      const canonical = parse(row.url);
      if (!cited.has(canonical)) throw new Error(`Included ${row.key} url is not cited in the digest main body: ${row.url}`);
      includedUrls.add(canonical);
    }
    if (row.disposition === 'merged') merges.push(row);
    if (row.disposition === 'skipped') {
      if (!skipReasons.includes(row.reason)) throw new Error(`${label} needs a skip reason from: ${skipReasons.join(', ')}`);
      if (row.note !== undefined && typeof row.note !== 'string') throw new Error(`${label} note must be a string`);
      skippedReasons[row.reason] = (skippedReasons[row.reason] ?? 0) + rowKeys.length;
    }
    counts[row.disposition] += rowKeys.length;
  }
  for (const row of merges) {
    if (seen.get(row.mergedInto) !== 'included') throw new Error(`Merged ${row.key} must point at an included candidate: ${row.mergedInto}`);
  }
  const missing = keys.filter(key => !seen.has(key));
  if (missing.length) throw new Error(`Missing disposition for ${missing.length} candidate(s): ${missing.slice(0, 5).join(', ')}`);
  const owners = new Map();
  for (const { key, url } of candidateEntries(collection)) {
    if (typeof url !== 'string') continue;
    let canonical;
    try { canonical = canonicalUrl(url); } catch { continue; }
    owners.set(canonical, [...(owners.get(canonical) ?? []), key]);
  }
  for (const canonical of cited) {
    const owned = owners.get(canonical);
    if (owned && !owned.some(key => seen.get(key) === 'included')) {
      throw new Error(`Digest cites the own URL of a candidate that is not included: ${owned.join(', ')} (${seen.get(owned[0])}) ${canonical}`);
    }
  }
  const supplement = observed?.materials instanceof Set ? observed.materials : new Set();
  const supplementUrls = [...cited].filter(canonical => !includedUrls.has(canonical) && !owners.has(canonical) && supplement.has(canonical));
  return { candidates: keys.length, ...counts, skippedReasons, supplementUrls };
}
