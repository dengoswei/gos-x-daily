// Offline, versioned thread/quote discovery. Observations are not semantic proof.
// Never filters by author, never claims interval coverage, never fetches URLs.
const ownObject = (value, fields, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid ${label} object`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!fields.includes(key) || !Object.hasOwn(descriptor, 'value')) throw new Error(`Unsupported ${label} field: ${key}`);
  }
  return value;
};
const nonempty = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
};
const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} array`);
  return value;
};
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Thread dates require explicit ISO timestamps with timezone');
  }
  return new Date(value).toISOString();
};
const https = value => {
  nonempty(value, 'thread URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Thread URLs must be HTTPS without credentials');
  return url;
};
const isXStatus = url => ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) &&
  /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(url.pathname);
const statusUrl = value => {
  const url = https(value);
  if (!isXStatus(url)) throw new Error('Thread post URL must be an exact X status URL');
  return url.href;
};
const links = (value = []) => array(value, 'thread links').map(raw => {
  ownObject(raw, ['href', 'text'], 'thread link');
  if (raw.text != null && typeof raw.text !== 'string') throw new Error('Thread link text must be a string');
  return { href: https(raw.href).href, text: raw.text ?? '' };
});
const dated = (value, observedAt) => {
  const result = value == null ? null : iso(value);
  if (result && Date.parse(result) > Date.parse(observedAt)) throw new Error('Post publication cannot follow its screenshot observation');
  return result;
};
const windowStatus = (publishedAt, window) => !publishedAt ? 'unknown' :
  Date.parse(publishedAt) >= Date.parse(window.start) && Date.parse(publishedAt) < Date.parse(window.end) ? 'in_window' : 'outside_window';

/**
 * Input: {schemaVersion:1,pages:[{evidenceId,items:[{url,text,publishedAt?,links?,
 * quotedPosts?:[{url?,text?,publishedAt?,links?,unresolvedReason?}],
 * unresolvedReferences?:[{url?,text,reason}]}]}]}.
 * observedAt always comes from the referenced screenshot, never quoted dates.
 * evidenceFor must resolve an existing validated screenshot and enforce predicate.
 */
export function extractThreadDiscoveries(input, { evidenceFor, window }) {
  ownObject(input, ['schemaVersion', 'pages'], 'thread discovery');
  if (input.schemaVersion !== 1 || typeof evidenceFor !== 'function') throw new Error('Unsupported thread discovery schema or evidence resolver');
  const start = iso(window?.start), end = iso(window?.end);
  if (Date.parse(start) >= Date.parse(end)) throw new Error('Invalid thread discovery window');
  const contexts = [], auditItems = [];
  let quoteCount = 0, unresolvedCount = 0;
  for (const [pageIndex, page] of array(input.pages, 'thread pages').entries()) {
    ownObject(page, ['evidenceId', 'items'], 'thread page');
    const evidenceId = nonempty(page.evidenceId, 'thread evidence ID');
    const evidence = evidenceFor(evidenceId, isXStatus);
    if (!evidence || evidence.kind !== 'screenshot' || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '')) throw new Error('Thread page requires screenshot evidence');
    const observedAt = iso(evidence.capturedAt), threadUrl = statusUrl(evidence.url);
    for (const [itemIndex, raw] of array(page.items, 'thread items').entries()) {
      ownObject(raw, ['url', 'text', 'publishedAt', 'links', 'quotedPosts', 'unresolvedReferences'], 'thread item');
      const url = statusUrl(raw.url), publishedAt = dated(raw.publishedAt, observedAt);
      const context = {
        id: `thread-${pageIndex + 1}-${itemIndex + 1}`, url,
        authorHandle: new URL(url).pathname.split('/')[1], text: nonempty(raw.text, 'observed thread text'),
        publishedAt, observedAt, dateStatus: windowStatus(publishedAt, { start, end }),
        threadUrl, evidenceId, links: links(raw.links), quotedPosts: [], unresolvedReferences: [],
        discoveryOnly: true, evidenceStatus: 'browser_observed_not_independently_verified',
      };
      for (const quote of array(raw.quotedPosts ?? [], 'quoted posts')) {
        ownObject(quote, ['url', 'text', 'publishedAt', 'links', 'unresolvedReason'], 'quoted post');
        if (quote.text != null && typeof quote.text !== 'string') throw new Error('Quoted text must be a string or null');
        if (quote.unresolvedReason != null && typeof quote.unresolvedReason !== 'string') throw new Error('Unresolved quote reason must be a string');
        const quoteUrl = quote.url == null ? null : statusUrl(quote.url);
        const quoteText = quote.text ?? null;
        const incomplete = !quoteUrl || !quoteText?.trim();
        if (incomplete && !quote.unresolvedReason?.trim()) throw new Error('Incomplete quoted posts require an unresolved reason');
        context.quotedPosts.push({ url: quoteUrl, text: quoteText, publishedAt: dated(quote.publishedAt, observedAt), observedAt,
          links: links(quote.links), referenceStatus: incomplete || quote.unresolvedReason?.trim() ? 'unresolved' : 'observed',
          unresolvedReason: quote.unresolvedReason ?? null, discoveryOnly: true,
          evidenceStatus: 'browser_observed_not_independently_verified' });
        quoteCount++;
        if (incomplete || quote.unresolvedReason?.trim()) unresolvedCount++;
      }
      for (const reference of array(raw.unresolvedReferences ?? [], 'unresolved thread references')) {
        ownObject(reference, ['url', 'text', 'reason'], 'unresolved reference');
        context.unresolvedReferences.push({ url: reference.url == null ? null : https(reference.url).href,
          text: nonempty(reference.text, 'unresolved reference text'), reason: nonempty(reference.reason, 'unresolved reference reason'),
          observedAt, evidenceId, discoveryOnly: true });
        unresolvedCount++;
      }
      contexts.push(context); // Keep every observed occurrence, regardless of author or date.
      const discoveryContext = { contextUrl: url, contextPublishedAt: publishedAt, contextDateStatus: context.dateStatus,
        observedAt, evidenceId, threadUrl, discoveryOnly: true, inWindowDiscussion: context.dateStatus === 'in_window' };
      auditItems.push({ id: context.id, url, text: context.text, publishedAt,
        links: [...context.links, ...context.unresolvedReferences.filter(ref => ref.url).map(ref => ({ href: ref.url, text: ref.text }))]
          .map(link => ({ ...link, discoveryContext })) });
      context.quotedPosts.forEach((quote, index) => {
        const quoteLinks = [...quote.links, ...(quote.url ? [{ href: quote.url, text: 'Observed quoted post; not a new publication' }] : [])];
        auditItems.push({ id: `${context.id}-quote-${index + 1}`, url: quote.url ?? url,
          text: `${context.text}\n[Quoted discovery context; original date ${quote.publishedAt ?? 'unknown'}]\n${quote.text ?? ''}`,
          publishedAt: quote.publishedAt,
          links: quoteLinks.map(link => ({ ...link, discoveryContext: { ...discoveryContext,
            quotedUrl: quote.url, quotedPublishedAt: quote.publishedAt, quotedReferenceStatus: quote.referenceStatus } })) });
      });
    }
  }
  return { contexts, auditItems, stats: { threadObservations: contexts.length, threadQuotedPosts: quoteCount,
    unresolvedThreadReferences: unresolvedCount }, coverage: { scanned: false, reason: 'thread_discovery_not_interval_traversal' } };
}
