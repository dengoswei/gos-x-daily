// Offline import of feed documents fetched by tools/fetch-feeds.mjs.
// This module never fetches a URL, drives a browser, authenticates or sends.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { itemKey } from './feed.mjs';

const kinds = ['atom', 'rss', 'hf-daily-papers'];
const MAX_TEXT = 4000;
// Parsing is synchronous; bound its input (the fetch tool already caps bodies at 8 MiB).
const MAX_PARSE_CHARS = 8 * 1024 * 1024;
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
// Bounded entity names keep decoding linear on hostile input. Decode exactly once.
export const decodeEntities = value => value.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z][a-z0-9]{0,31});/gi, (match, name) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return entities[name.toLowerCase()] ?? match;
});
const tagName = /\/?([a-z][a-z0-9:-]*)/y;
// End of the tag opened at lt: the first '>' outside a quoted attribute value, or -1.
function tagEnd(input, lt) {
  let quote = null, previous = '';
  for (let j = lt + 1; j < input.length; j++) {
    const c = input[j];
    if (quote) { if (c === quote) quote = null; continue; }
    if ((c === '"' || c === "'") && previous === '=') quote = c;
    else if (c === '>') return j;
    if (!/\s/.test(c)) previous = c;
  }
  return -1;
}
// One linear pass (indexOf scanning, no backtracking regexes over the document).
// Markup becomes a space; the text between markup is entity-decoded once, after
// the markup is identified. A '<' that cannot open a tag ("<10%", "a < b") stays
// text, as in an HTML tokenizer. CDATA content is verbatim. With `tags`, only
// those element names count as markup and any other '<...>' stays text. An
// unclosed tag leaves the rest as text; unclosed comments/dropped elements end it.
function markupText(input, { tags = null, drop = [] } = {}) {
  const lower = input.toLowerCase(), parts = [];
  let i = 0, from = 0;
  const flush = (to, gap = ' ') => { parts.push(decodeEntities(input.slice(from, to)), gap); };
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) break;
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      flush(lt, '');
      parts.push(input.slice(lt + 9, end < 0 ? input.length : end));
      i = from = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      flush(lt);
      i = from = end < 0 ? input.length : end + 3;
      continue;
    }
    if (!/[a-z!?/]/.test(lower[lt + 1] ?? '')) { i = lt + 1; continue; }
    const gt = tagEnd(input, lt);
    if (gt < 0) break;
    tagName.lastIndex = lt + 1;
    const name = /[!?]/.test(lower[lt + 1]) ? null : tagName.exec(lower)?.[1] ?? null;
    if (tags && !(name && tags.has(name))) { i = gt + 1; continue; }
    flush(lt);
    i = from = gt + 1;
    if (name && drop.includes(name) && lower[lt + 1] !== '/' && input[gt - 1] !== '/') {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeEnd = close < 0 ? -1 : lower.indexOf('>', close);
      i = from = closeEnd < 0 ? input.length : closeEnd + 1;
    }
  }
  parts.push(decodeEntities(input.slice(from)));
  return parts.join('');
}
const squash = value => value.replace(/\s+/g, ' ').trim();
/** HTML to plain text: tags (and script/style/`drop` element content) first, then entities once. */
export const htmlToText = (html, { drop = [] } = {}) => squash(markupText(String(html), { drop: ['script', 'style', ...drop] }));
// XML character data: real child markup removed, entities decoded once, CDATA verbatim.
const xmlText = raw => markupText(raw);
// Publishers often wrap titles in CDATA with inline formatting; only these names are markup there.
const inlineTags = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'em', 'font', 'i', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u']);
// Plain-text fields are never HTML-stripped; HTML fields are XML-decoded, then HTML-to-text.
function fieldText(node, html) {
  if (!node) return '';
  const type = (node.attrs.type ?? '').toLowerCase();
  if (type === 'xhtml') return htmlToText(node.raw);
  if (type === 'html' || type === 'text/html' || (html && type !== 'text')) return htmlToText(xmlText(node.raw));
  if (node.raw.includes('<![CDATA[')) return squash(markupText(xmlText(node.raw), { tags: inlineTags }));
  return squash(xmlText(node.raw));
}

function attributes(tag) {
  const out = {};
  for (let i = 0; i < tag.length;) {
    const start = i;
    while (i < tag.length && /[\w:.-]/.test(tag[i])) i++;
    if (i === start) { i++; continue; }
    const name = tag.slice(start, i).toLowerCase();
    while (/\s/.test(tag[i] ?? '')) i++;
    if (tag[i] !== '=') continue;
    i++;
    while (/\s/.test(tag[i] ?? '')) i++;
    const quote = tag[i];
    if (quote !== '"' && quote !== "'") { while (i < tag.length && !/\s/.test(tag[i])) i++; continue; }
    const end = tag.indexOf(quote, i + 1);
    if (end < 0) break;
    out[name] = decodeEntities(tag.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}
// Skip CDATA sections and comments so their contents never look like elements.
function nextTag(lower, from) {
  for (let i = from; ;) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) return -1;
    const special = lower.startsWith('<![cdata[', lt) ? ']]>' : lower.startsWith('<!--', lt) ? '-->' : null;
    if (!special) return lt;
    const end = lower.indexOf(special, lt + 4);
    if (end < 0) return -1;
    i = end + special.length;
  }
}
const named = (lower, at, name) => lower.startsWith(name, at) && /[\s/>]/.test(lower[at + name.length] ?? '');
// Linear scan for the next element with one of `names` at or after `from`:
// { name, attrs, raw, end } or null. An unclosed element is malformed and throws,
// except an HTML-style void <link ...> whose next tag is not its own close.
function nextElement(xml, lower, names, from, label) {
  for (let lt = nextTag(lower, from); lt >= 0; lt = nextTag(lower, lt + 1)) {
    const name = names.find(value => named(lower, lt + 1, value));
    if (!name) continue;
    const gt = lower.indexOf('>', lt);
    if (gt < 0) throw new Error(`Unclosed <${name}> in ${label}`);
    const tag = xml.slice(lt + 1 + name.length, gt);
    if (tag.endsWith('/')) return { name, attrs: attributes(tag.slice(0, -1)), raw: '', end: gt + 1 };
    for (let close = nextTag(lower, gt + 1); close >= 0; close = nextTag(lower, close + 1)) {
      const closing = lower[close + 1] === '/' && named(lower, close + 2, name);
      if (!closing && name === 'link') return { name, attrs: attributes(tag), raw: '', end: gt + 1 };
      if (!closing) continue;
      const closeEnd = lower.indexOf('>', close);
      if (closeEnd < 0) break;
      return { name, attrs: attributes(tag), raw: xml.slice(gt + 1, close), end: closeEnd + 1 };
    }
    if (name === 'link') return { name, attrs: attributes(tag), raw: '', end: gt + 1 };
    throw new Error(`Unclosed <${name}> in ${label}`);
  }
  return null;
}
function elementsOf(xml, names, label) {
  const lower = xml.toLowerCase(), out = [];
  for (let node = nextElement(xml, lower, names, 0, label); node; node = nextElement(xml, lower, names, node.end, label)) out.push(node);
  return out;
}
const firstElement = (xml, name, label) => nextElement(xml, xml.toLowerCase(), [name.toLowerCase()], 0, label);
/** HTML pages: every complete `name` element as { attrs, raw } (linear; stops at the first unclosed one). */
export function htmlElements(html, name) {
  const text = String(html), lower = text.toLowerCase(), out = [];
  try {
    for (let node = nextElement(text, lower, [name], 0, 'html'); node; node = nextElement(text, lower, [name], node.end, 'html')) out.push(node);
  } catch { /* An unclosed element ends the scan; earlier complete elements remain. */ }
  return out.map(({ attrs, raw }) => ({ attrs, raw }));
}

function entryLink(xml, label) {
  const links = elementsOf(xml, ['link'], label);
  const tagged = links.map(node => node.attrs).filter(attrs => attrs.href);
  const preferred = tagged.find(attrs => !attrs.rel || attrs.rel === 'alternate') ?? tagged[0];
  if (preferred) return preferred.href.trim();
  const text = links.map(node => fieldText(node, false)).find(Boolean);
  if (text) return text;
  const guid = firstElement(xml, 'guid', label);
  if (guid && guid.attrs.ispermalink !== 'false') return fieldText(guid, false);
  return null;
}

function entryDate(xml, label) {
  for (const name of ['pubDate', 'published', 'dc:date', 'updated']) {
    const value = fieldText(firstElement(xml, name, label), false);
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Unparseable ${name} in ${label}: ${value.slice(0, 80)}`);
    return new Date(parsed).toISOString();
  }
  return null;
}

// Cut text is marked, never presented as the whole entry.
const feedItem = ({ url, title, text, publishedAt }, label) => {
  const href = https(url, label).href;
  const cleanTitle = (title ?? '').slice(0, 500);
  const full = text || cleanTitle;
  const body = full.slice(0, MAX_TEXT);
  if (!body) throw new Error(`Feed entry has neither title nor text in ${label}: ${href}`);
  return { url: href, title: cleanTitle, text: body, publishedAt, ...(full.length > MAX_TEXT ? { truncated: true } : {}) };
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
      // JSON fields are plain text: "<10%" or "$a<b$" is content, never markup.
      return { ...feedItem({ url: `https://huggingface.co/papers/${paper.id}`, title: squash(String(paper.title ?? entry.title ?? '')),
        text: squash(String(paper.summary ?? '')), publishedAt: when == null ? null : stamp(when, label) }, label),
      paperPublishedAt: original == null ? null : stamp(original, label) };
    });
  }
  if (!kinds.includes(kind)) throw new Error(`Unsupported feed kind: ${kind}`);
  if (text.length > MAX_PARSE_CHARS) throw new Error(`Feed document exceeds ${MAX_PARSE_CHARS} characters: ${label}`);
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) throw new Error(`Feed document is not RSS/Atom XML: ${label}`);
  return elementsOf(text, ['item', 'entry'], label).map(({ raw: xml }) => {
    const link = entryLink(xml, label);
    if (!link) throw new Error(`Feed entry without a link in ${label}`);
    // RSS bodies are HTML; Atom text constructs default to type="text".
    const body = ['description', 'summary', 'content:encoded', 'content'].map(name => fieldText(firstElement(xml, name, label), kind !== 'atom' || name === 'content:encoded')).find(Boolean) ?? '';
    return feedItem({ url: link, title: fieldText(firstElement(xml, 'title', label), false), text: body, publishedAt: entryDate(xml, label) }, label);
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
