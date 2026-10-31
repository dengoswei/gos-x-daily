// Offline import of feed documents fetched by tools/fetch-feeds.mjs.
// This module never fetches a URL, drives a browser, authenticates or sends.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { itemKey } from './feed.mjs';

const kinds = ['atom', 'rss', 'hf-daily-papers'];
const MAX_TEXT = 4000;
const stamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Expected an explicit ISO timestamp with timezone: ${label}`);
  return new Date(value).toISOString();
};
const https = (value, label) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL in ${label}: ${String(value).slice(0, 200)}`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} URLs must be HTTPS without credentials: ${url.href.slice(0, 200)}`);
  return url;
};

export function validateFeedConfig(sources) {
  const feeds = sources?.feeds ?? [];
  if (!Array.isArray(feeds)) throw new Error('sources.feeds must be an array');
  const names = new Set();
  for (const feed of feeds) {
    if (typeof feed?.name !== 'string' || !feed.name.trim() || names.has(feed.name)) throw new Error('Each feed needs a unique name');
    names.add(feed.name);
    https(feed.url, `feed ${feed.name}`);
    if (!kinds.includes(feed.kind)) throw new Error(`Feed ${feed.name} kind must be one of ${kinds.join('|')}`);
    if (!Number.isInteger(feed.maxItems) || feed.maxItems < 1 || feed.maxItems > 100) throw new Error(`Feed ${feed.name} maxItems must be an integer 1..100`);
  }
  return feeds;
}

// Returns the verified bytes; the same checks guard the CLI pre-pass and the merge itself.
function readDocument(base, document) {
  if (typeof document?.path !== 'string' || path.isAbsolute(document.path) || document.path.split(/[\\/]/).includes('..')) throw new Error('Feed documents must remain inside the artifact directory');
  const resolved = fs.realpathSync(path.resolve(base, document.path));
  if (!resolved.startsWith(base + path.sep)) throw new Error('Feed document escaped the artifact directory');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Expected a feed document file no larger than 20 MiB');
  const bytes = fs.readFileSync(resolved);
  if (!/^[a-f0-9]{64}$/.test(document.sha256 ?? '') || createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new Error(`Feed document hash mismatch: ${document.id}`);
  return bytes;
}

export function verifyDocumentFiles(bundle, baseDir) {
  const base = fs.realpathSync(baseDir);
  if (!Array.isArray(bundle?.documents) || !bundle.documents.length) throw new Error('Fetched feed documents are required');
  for (const document of bundle.documents) readDocument(base, document);
  return true;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decodeEntities = value => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return entities[name.toLowerCase()] ?? match;
});
// Element content becomes HTML (CDATA verbatim, otherwise XML-decoded), then plain text.
const elementHtml = raw => /<!\[CDATA\[/.test(raw) ? raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decodeEntities(raw);
const plainText = html => decodeEntities(html
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const escapeTag = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const element = (xml, name) => xml.match(new RegExp(`<${escapeTag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(name)}\\s*>`, 'i'))?.[1];
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), decodeEntities(m[2] ?? m[3])]));

function entryLink(xml) {
  const tagged = [...xml.matchAll(/<link\b([^>]*?)\/?>/gi)].map(m => attributes(m[1])).filter(attrs => attrs.href);
  const preferred = tagged.find(attrs => !attrs.rel || attrs.rel === 'alternate') ?? tagged[0];
  if (preferred) return preferred.href.trim();
  const text = element(xml, 'link');
  if (text && plainText(elementHtml(text))) return plainText(elementHtml(text));
  const guid = xml.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid\s*>/i);
  if (guid && attributes(guid[1]).ispermalink !== 'false') return plainText(elementHtml(guid[2]));
  return null;
}

function entryDate(xml, label) {
  for (const name of ['pubDate', 'published', 'dc:date', 'updated']) {
    const raw = element(xml, name);
    if (raw == null) continue;
    const value = plainText(elementHtml(raw));
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Unparseable ${name} in ${label}: ${value.slice(0, 80)}`);
    return new Date(parsed).toISOString();
  }
  return null;
}

const feedItem = ({ url, title, text, publishedAt }, label) => {
  const href = https(url, label).href;
  const cleanTitle = (title ?? '').slice(0, 500);
  const body = (text || cleanTitle).slice(0, MAX_TEXT);
  if (!body) throw new Error(`Feed entry has neither title nor text in ${label}: ${href}`);
  return { url: href, title: cleanTitle, text: body, publishedAt };
};

// Returns entries in document order as { url, title, text, publishedAt }; throws on any malformed entry.
export function parseFeedDocument(text, kind, label = kind) {
  if (typeof text !== 'string') throw new Error(`Feed document must be text: ${label}`);
  if (kind === 'hf-daily-papers') {
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`Feed document is not JSON: ${label}`); }
    if (!Array.isArray(value)) throw new Error(`Expected a daily-papers array: ${label}`);
    return value.map(entry => {
      const paper = entry?.paper;
      if (typeof paper?.id !== 'string' || !/^[\w.-]{1,100}$/.test(paper.id)) throw new Error(`Daily-papers entry lacks a paper id: ${label}`);
      // The feed's own publication is the Daily Papers listing; the arXiv date is often days older.
      const when = paper.submittedOnDailyAt ?? entry.publishedAt ?? paper.publishedAt ?? null;
      const original = paper.publishedAt ?? entry.publishedAt ?? null;
      return { ...feedItem({ url: `https://huggingface.co/papers/${paper.id}`, title: plainText(String(paper.title ?? entry.title ?? '')),
        text: plainText(String(paper.summary ?? '')), publishedAt: when == null ? null : stamp(when, label) }, label),
      paperPublishedAt: original == null ? null : stamp(original, label) };
    });
  }
  if (!kinds.includes(kind)) throw new Error(`Unsupported feed kind: ${kind}`);
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) throw new Error(`Feed document is not RSS/Atom XML: ${label}`);
  return [...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(([, , xml]) => {
    const link = entryLink(xml);
    if (!link) throw new Error(`Feed entry without a link in ${label}`);
    const body = ['description', 'summary', 'content:encoded', 'content'].map(name => element(xml, name)).find(raw => raw != null && plainText(elementHtml(raw)));
    return feedItem({ url: link, title: plainText(elementHtml(element(xml, 'title') ?? '')),
      text: body == null ? '' : plainText(elementHtml(body)), publishedAt: entryDate(xml, label) }, label);
  });
}

export function mergeFeedDocuments(runtime, collection, bundle, baseDir) {
  if (bundle?.schemaVersion !== 1 || bundle.transport !== 'fetched-documents') throw new Error('Unsupported feed capture schema/transport');
  if (collection?.schemaVersion !== 1 || typeof collection.collectionId !== 'string' || !collection.sources || typeof collection.sources !== 'object') throw new Error('Expected an imported collection');
  if (collection.sources.feeds !== undefined) throw new Error('Collection already contains imported feeds');
  const configured = validateFeedConfig(runtime.sources);
  const startedAt = stamp(bundle.startedAt, 'startedAt');
  const fetchedAt = stamp(bundle.fetchedAt, 'fetchedAt');
  const collectedAt = stamp(collection.collectedAt, 'collection collectedAt');
  if (Date.parse(startedAt) > Date.parse(fetchedAt) || Date.parse(fetchedAt) - Date.parse(startedAt) > 2 * 3600000) throw new Error('Feed fetches must belong to one run of at most two hours');
  // Feeds may be fetched shortly before or after the browser capture; both sides share one two-hour run.
  if (Math.abs(Date.parse(startedAt) - Date.parse(collectedAt)) > 2 * 3600000) throw new Error('Feed fetch must start within two hours of the browser capture');
  const base = fs.realpathSync(baseDir);
  if (!Array.isArray(bundle.documents) || !bundle.documents.length) throw new Error('Fetched feed documents are required');
  const failures = bundle.failures ?? [];
  if (!Array.isArray(failures)) throw new Error('Feed capture failures must be an array');
  const known = new Set((collection.provenance?.evidence ?? []).map(entry => entry.id));
  const byFeed = new Map();
  for (const document of bundle.documents) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(document?.id ?? '') || known.has(document.id)) throw new Error('Missing or duplicate feed document ID');
    known.add(document.id);
    const feed = configured.find(value => value.name === document.feed);
    if (!feed) throw new Error(`Feed capture contains an unconfigured feed: ${document.feed}`);
    if (byFeed.has(feed.name)) throw new Error(`Duplicate document for feed: ${feed.name}`);
    if (https(document.url, `document ${document.id}`).href !== https(feed.url, `feed ${feed.name}`).href) throw new Error(`Document URL does not match configured feed: ${document.id}`);
    const at = stamp(document.fetchedAt, `document ${document.id}`);
    if (Date.parse(at) < Date.parse(startedAt) || Date.parse(at) > Date.parse(fetchedAt)) throw new Error(`Document timestamp lies outside this fetch run: ${document.id}`);
    if (typeof document.contentType !== 'string') throw new Error(`Document needs a contentType: ${document.id}`);
    byFeed.set(feed.name, { ...document, fetchedAt: at });
  }
  const failed = new Map();
  for (const failure of failures) {
    if (!configured.some(value => value.name === failure?.feed)) throw new Error(`Feed capture failure names an unconfigured feed: ${failure?.feed}`);
    if (byFeed.has(failure.feed) || failed.has(failure.feed)) throw new Error(`Feed recorded as both fetched and failed: ${failure.feed}`);
    failed.set(failure.feed, String(failure.error ?? 'unknown error').slice(0, 300));
  }
  const windowStart = Date.parse(startedAt) - runtime.lookbackHours * 3600000;
  const warnings = ['Feed items are publisher-declared entries; document hashes verify fetched bytes, not semantic accuracy.'];
  const checks = {}, items = [], seen = new Set(), evidence = [];
  let undated = 0;
  for (const feed of configured) {
    const document = byFeed.get(feed.name);
    if (!document) {
      if (failed.has(feed.name)) warnings.push(`${feed.name} fetch failed: ${failed.get(feed.name)}`);
      else warnings.push(`${feed.name} was not fetched in this run`);
      checks[feed.name] = { attempted: failed.has(feed.name), items: 0, status: failed.has(feed.name) ? 'fetch_failed' : 'not_fetched' };
      continue;
    }
    const parsed = parseFeedDocument(readDocument(base, document).toString('utf8'), feed.kind, feed.name);
    const dated = parsed.filter(entry => entry.publishedAt).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    // Window first, then cap: maxItems bounds the in-window items a feed may contribute.
    const fresh = [...dated, ...parsed.filter(entry => !entry.publishedAt)]
      .filter(entry => !entry.publishedAt || (Date.parse(entry.publishedAt) >= windowStart && Date.parse(entry.publishedAt) <= Date.parse(startedAt)));
    const kept = [];
    for (const entry of fresh) {
      const value = { ...entry, source: 'feed', feedName: feed.name, evidenceId: document.id, links: [] };
      const key = itemKey(value);
      if (seen.has(key)) continue;
      if (kept.length === feed.maxItems) { warnings.push(`${feed.name} capped at ${feed.maxItems} items`); break; }
      seen.add(key);
      kept.push(value);
    }
    undated += kept.filter(entry => !entry.publishedAt).length;
    items.push(...kept);
    checks[feed.name] = { attempted: true, items: kept.length, status: 'ok' };
    evidence.push({ id: document.id, kind: 'fetched_document', path: document.path, sha256: document.sha256, url: document.url, capturedAt: document.fetchedAt });
  }
  if (undated) warnings.push(`feeds: ${undated} item(s) lack publication dates; do not claim all are fresh`);
  const result = structuredClone(collection);
  result.sources.feeds = items;
  result.stats = { ...result.stats, feeds: items.length };
  result.checks = { ...result.checks, feeds: checks };
  result.warnings = [...(result.warnings ?? []), ...warnings];
  result.provenance = { ...(result.provenance ?? {}), evidence: [...(result.provenance?.evidence ?? []), ...evidence] };
  return result;
}
