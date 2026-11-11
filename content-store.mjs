// Dual-layer content store (L0 Raw Archive + L1 Summary Cards + Topic Clusters),
// 7-day soft deduplication, and on-demand public full-text extraction.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalUrl, watchGroups } from './binding.mjs';
import { itemKey, canonicalLink, publicUrlRefusal, auditDeepLinks } from './feed.mjs';
import { htmlToText, htmlElements, extractHtmlLinks } from './feed-import.mjs';
import { topicFingerprint } from './telemetry.mjs';

const FETCH_TIMEOUT_MS = 18000;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'gos-x-daily-reader/2.0';

const sha12 = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
const list = value => (Array.isArray(value) ? value : []);
const safeCanonical = href => {
  if (typeof href !== 'string' || !href.trim()) return null;
  try { return canonicalUrl(href); } catch { return null; }
};
const safeSlug = text => String(text ?? 'item').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';

const xHandle = url => {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(x\.com|twitter\.com)$/.test(parsed.hostname)) return null;
    return parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/\d+/)?.[1] ?? null;
  } catch { return null; }
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function classifyHeuristic({ url = '', title = '', text = '' }) {
  const combined = `${title}\n${text}\n${url}`;
  if (/customer\s+story|case\s+study|客户案例|成功案例|customers?\//i.test(combined)) return 'case_study_pr';
  if (/arxiv\.org|huggingface\.co\/papers|openreview\.net|\bpaper\b|论文|定理|theorem|ablation/i.test(combined)) return 'paper';
  if (/github\.com\/[^/]+\/[^/]+\/releases|release\s+notes|\bv\d+\.\d+|开源|open-?weight|model\s+card/i.test(combined)) return 'open_source';
  if (/\b(CUDA|Triton|vLLM|SGLang|kernel|latency|throughput|distributed|megatron|rollout|compiler|infra)\b/i.test(combined)) return 'infra_eng';
  if (/substack\.com|latent\.space|interconnects\.ai|lilianweng|pragmaticengineer|essay|长文/i.test(combined)) return 'essay';
  if (/\b(beta|launch|introducing|available\s+in|pricing|plan|workspace|sheets|connector)\b/i.test(combined)) return 'product';
  return 'general';
}

function extractEntities(text = '') {
  const matches = new Set();
  const patterns = [
    /\b(?:GPT-\d+(?:\.\d+)?(?:-[A-Za-z0-9]+)*|Claude(?:\s+[A-Z][a-zA-Z0-9.]+)?|Gemini(?:\s+\d+(?:\.\d+)?)?(?:\s+[A-Z][a-zA-Z]+)?|Qwen\d*(?:\.\d+)?(?:-[A-Za-z0-9]+)*|DeepSeek(?:-[A-Za-z0-9.]+|\s+V\d+(?:\.\d+)?)|Llama[\s-]\d+(?:\.\d+)?|vLLM|SGLang|PyTorch|Triton|FlashProve|StateBench)\b/g,
  ];
  for (const regex of patterns) {
    for (const match of String(text).matchAll(regex)) {
      matches.add(match[0].trim());
      if (matches.size >= 8) break;
    }
  }
  return [...matches];
}

function heuristicTldr(title, text) {
  const cleanTitle = String(title ?? '').trim();
  const cleanBody = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (cleanTitle && cleanBody && !cleanBody.startsWith(cleanTitle)) {
    return `${cleanTitle} — ${cleanBody.slice(0, 260)}`;
  }
  return (cleanBody || cleanTitle).slice(0, 300);
}

function contentStatusOf(kind, text, item) {
  if (item?.error) return 'fetch_failed';
  if (/paywall|subscribe to continue|paid subscribers only/i.test(text ?? '')) return 'paywalled';
  const len = String(text ?? '').trim().length;
  if (item?.truncated) return 'truncated';
  if (kind === 'feed' && String(item?.url ?? '').includes('huggingface.co/papers/')) return 'abstract_only';
  if (len >= 1200) return 'full_text';
  if (len >= 300) return 'abstract_only';
  return 'snippet_only';
}

const NON_ARTICLE_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co|youtube\.com|youtu\.be|instagram\.com|facebook\.com|linkedin\.com)$/;
const NON_FETCH_FINAL_HOSTS = /(^|\.)(x\.com|twitter\.com|youtube\.com|youtu\.be|instagram\.com|facebook\.com|linkedin\.com)$/;

function xStatusKey(href) {
  if (typeof href !== 'string') return null;
  try {
    const u = new URL(href);
    if (!/(^|\.)(x\.com|twitter\.com)$/.test(u.hostname)) return null;
    if (/\/analytics\/?$/.test(u.pathname)) return null;
    const m = u.pathname.match(/\/status\/(\d+)/);
    return m ? `x-status:${m[1]}` : null;
  } catch { return null; }
}

function recoverDisplayLink(link) {
  const href = String(link?.href ?? '').trim();
  const label = String(link?.text ?? '').trim();
  if (!href) return [];
  const results = [{ href, text: label }];
  try {
    const u = new URL(href);
    if (u.hostname === 't.co' && label && !label.includes('…') && !label.endsWith('...')) {
      const candidate = /^https?:\/\//i.test(label) ? label : /^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(label) ? `https://${label}` : null;
      if (candidate) {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:' && !NON_ARTICLE_HOSTS.test(parsed.hostname)) {
          results.push({ href: parsed.href, text: label });
        }
      }
    }
  } catch { /* ignore */ }
  return results;
}

function primarySubjectUrls(card) {
  const keys = [];
  const pushKey = k => { if (k && !keys.includes(k)) keys.push(k); };
  const addUrl = href => {
    const c = safeCanonical(href);
    if (!c) return;
    try {
      const u = new URL(c);
      if (u.hostname === 't.co' && u.pathname.length > 1) {
        pushKey(c);
        return;
      }
      if (NON_ARTICLE_HOSTS.test(u.hostname)) return;
      if (u.pathname === '/' && !u.search && !u.hash) return;
      pushKey(c);
    } catch { /* ignore */ }
  };

  const ownStatus = xStatusKey(card.url);
  if (ownStatus) pushKey(ownStatus);
  else addUrl(card.url);

  for (const link of card.outboundUrls ?? []) addUrl(link);
  for (const raw of card.rawLinks ?? []) {
    const quotedStatus = xStatusKey(raw.href);
    if (quotedStatus && quotedStatus !== ownStatus) pushKey(quotedStatus);
    addUrl(raw.href);
  }

  // Normalize HF papers <-> arXiv IDs so posts linking arXiv cluster with HF Daily Papers entries.
  const expanded = [...keys];
  for (const u of keys) {
    const arxivMatch = u.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/);
    const hfMatch = u.match(/huggingface\.co\/papers\/(\d{4}\.\d{4,5})/);
    const paperId = arxivMatch?.[1] ?? hfMatch?.[1];
    if (paperId) {
      const canonicalArxiv = `https://arxiv.org/abs/${paperId}`;
      if (!expanded.includes(canonicalArxiv)) expanded.unshift(canonicalArxiv);
    }
  }
  return expanded;
}

/**
 * Ingests an imported collection + optional supplemental markdown/mail files into
 * the unified dual-layer store:
 * - store/raw/<itemId>/item.json + body.txt (untruncated L0 raw archive)
 * - store/cards/<itemId>.json (lightweight L1 index card for screening & clustering)
 * - store/topics/<topicId>.json (cross-source clustered topics with 7-day soft dedup tags)
 */
export function buildContentStore(collection, storeDir, { softHistory = null, supplements = [] } = {}) {
  const root = path.resolve(storeDir);
  const rawDir = path.join(root, 'raw');
  const cardsDir = path.join(root, 'cards');
  const topicsDir = path.join(root, 'topics');
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cardsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(topicsDir, { recursive: true, mode: 0o700 });

  const sources = collection?.sources ?? {};
  const deepByUrl = new Map();
  for (const deep of list(sources.deepArticles)) {
    for (const u of [deep?.url, deep?.sourceHref]) {
      const c = safeCanonical(u);
      if (c) deepByUrl.set(c, deep);
    }
  }

  const rawEntries = [];
  const collect = (kind, items, extra = {}) => {
    for (const item of list(items)) rawEntries.push({ kind, item, ...extra });
  };
  collect('x', sources.xFollowing);
  collect('substack', sources.substack);
  for (const { handle, items } of watchGroups(sources)) collect('watch', items, { watchedHandle: handle });
  collect('feed', sources.feeds);
  collect('blog', sources.blogs);
  for (const profile of list(sources.xiaohongshu)) {
    collect('xhs', profile?.notes, { profileName: profile?.name ?? profile?.profileId });
  }
  for (const sup of list(supplements)) {
    rawEntries.push({ kind: sup.kind ?? 'supplement', item: sup });
  }

  const groupedByKey = new Map();
  for (const entry of rawEntries) {
    const key = entry.kind === 'blog' ? `blog:${entry.item?.url}`
      : entry.kind === 'xhs' ? `xhs:${entry.item?.url}`
      : entry.kind === 'supplement' || entry.kind === 'mail' ? `sup:${entry.item?.id ?? sha12(entry.item?.url ?? entry.item?.title ?? entry.item?.text)}`
      : itemKey(entry.item);
    if (!key) continue;
    if (!groupedByKey.has(key)) groupedByKey.set(key, []);
    groupedByKey.get(key).push(entry);
  }

  const threadByStatus = new Map();
  for (const ctx of list(sources.threadContexts)) {
    const sk = xStatusKey(ctx?.url) ?? xStatusKey(ctx?.threadUrl);
    if (!sk) continue;
    if (!threadByStatus.has(sk)) threadByStatus.set(sk, []);
    threadByStatus.get(sk).push(ctx);
  }

  const cards = [];
  let index = 0;
  for (const [key, observations] of groupedByKey) {
    index += 1;
    const primary = observations[0];
    const item = primary.item ?? {};
    const id = `${String(index).padStart(4, '0')}-${safeSlug(primary.kind)}-${sha12(key)}`;
    const bodyTexts = observations.map(o => o.item?.text ?? o.item?.content ?? o.item?.bodyText ?? '').filter(Boolean);
    const longestBody = bodyTexts.sort((a, b) => b.length - a.length)[0] ?? '';

    const ownStatus = xStatusKey(item.url);
    const threadExtras = ownStatus ? (threadByStatus.get(ownStatus) ?? []) : [];
    const threadLinks = threadExtras.flatMap(ctx => [
      ...list(ctx.links),
      ...list(ctx.quotedPosts).flatMap(q => [...(q?.url ? [{ href: q.url, text: 'quoted' }] : []), ...list(q?.links)]),
    ]);

    const allLinkObjs = [...observations.flatMap(o => list(o.item?.links)), ...threadLinks]
      .flatMap(recoverDisplayLink);
    const outboundUrls = [...new Set(
      auditDeepLinks([{ url: item.url, text: longestBody, links: allLinkObjs }], 0)
        .filter(r => !['invalid_url', 'unsupported_protocol', 'embedded_credentials', 'social_link', 'analytics_link', 'substack_navigation', 'homepage_navigation'].includes(r.reason))
        .map(r => safeCanonical(r.href))
        .filter(Boolean),
    )];

    // Attach already-captured browser deep article if matching.
    let attachedDeep = deepByUrl.get(safeCanonical(item.url));
    if (!attachedDeep) {
      for (const outUrl of outboundUrls) {
        if (deepByUrl.has(outUrl)) { attachedDeep = deepByUrl.get(outUrl); break; }
      }
    }

    const fullText = attachedDeep?.text && attachedDeep.text.length > longestBody.length
      ? `${longestBody}\n\n--- [Preserved Deep Article: ${attachedDeep.url}] ---\n${attachedDeep.text}`
      : longestBody;

    const itemRawDir = path.join(rawDir, id);
    fs.mkdirSync(itemRawDir, { recursive: true, mode: 0o700 });
    const rawBodyPath = path.join(itemRawDir, 'body.txt');
    fs.writeFileSync(rawBodyPath, fullText + '\n', { mode: 0o600 });
    writeJson(path.join(itemRawDir, 'item.json'), {
      id,
      candidateKey: key,
      kind: primary.kind,
      observations: observations.map(o => ({ kind: o.kind, watchedHandle: o.watchedHandle ?? null, item: o.item })),
      ...(attachedDeep ? { attachedDeepUrl: attachedDeep.url } : {}),
    });

    const author = xHandle(item.url) ?? item.author ?? item.feedName ?? item.blog ?? primary.profileName ?? primary.watchedHandle ?? 'unknown';
    const category = classifyHeuristic({ url: item.url, title: item.title, text: fullText });
    const contentStatus = attachedDeep ? 'full_text' : contentStatusOf(primary.kind, longestBody, item);
    const card = {
      id,
      candidateKey: key,
      kind: primary.kind,
      sourceLabel: item.feedName ?? item.blog ?? (primary.watchedHandle ? `watch:@${primary.watchedHandle}` : primary.kind),
      author,
      url: item.url ?? null,
      canonicalUrl: safeCanonical(item.url),
      title: item.title ?? null,
      publishedAt: item.publishedAt ?? null,
      ...(item.paperPublishedAt ? { paperPublishedAt: item.paperPublishedAt } : {}),
      outboundUrls,
      rawLinks: allLinkObjs.map(l => ({ href: l?.href ?? '', text: l?.text ?? '' })).filter(l => l.href),
      contentStatus,
      charCount: fullText.length,
      category,
      entities: extractEntities(`${item.title ?? ''} ${longestBody.slice(0, 1500)}`),
      tldr: heuristicTldr(item.title, longestBody),
      rawBodyPath: path.relative(root, rawBodyPath),
    };
    writeJson(path.join(cardsDir, `${id}.json`), card);
    cards.push(card);
  }

  // Cluster cards into unified cross-source Topics by shared subject URL (or shared paper ID).
  const parent = new Map(cards.map(c => [c.id, c.id]));
  const find = x => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let at = x; at !== r;) { const next = parent.get(at); parent.set(at, r); at = next; }
    return r;
  };
  const unite = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const urlOwner = new Map();
  for (const card of cards) {
    for (const subjectUrl of primarySubjectUrls(card)) {
      if (urlOwner.has(subjectUrl)) unite(urlOwner.get(subjectUrl), card.id);
      else urlOwner.set(subjectUrl, card.id);
    }
  }

  const topicBuckets = new Map();
  for (const card of cards) {
    const rootId = find(card.id);
    if (!topicBuckets.has(rootId)) topicBuckets.set(rootId, []);
    topicBuckets.get(rootId).push(card);
  }

  const kindPriority = { blog: 1, feed: 2, substack: 3, supplement: 4, mail: 4, watch: 5, x: 6, xhs: 7 };
  const topics = [];
  let dedupSkipped7d = 0;
  let dedupFollowUps = 0;
  let topicSeq = 0;

  for (const groupCards of topicBuckets.values()) {
    topicSeq += 1;
    const sorted = groupCards.slice().sort((a, b) =>
      (kindPriority[a.kind] ?? 9) - (kindPriority[b.kind] ?? 9) || b.charCount - a.charCount);
    const lead = sorted[0];
    const topicId = `topic-${String(topicSeq).padStart(4, '0')}`;

    const allCandidateKeys = sorted.map(c => c.candidateKey);
    const allUrls = [...new Set(sorted.flatMap(c => [c.url, ...c.outboundUrls]).filter(Boolean))];
    const discussionUrls = sorted.filter(c => ['x', 'watch'].includes(c.kind) && c.url).map(c => c.url);
    const primaryArticleUrl = sorted.find(c => !['x', 'watch'].includes(c.kind) && c.url)?.url
      ?? lead.outboundUrls[0]
      ?? lead.url;

    // 7-day soft deduplication check against published history.
    let priorDate = null;
    if (softHistory) {
      for (const u of [primaryArticleUrl, ...lead.outboundUrls, lead.url].filter(Boolean)) {
        priorDate = softHistory.hasUrl(u);
        if (priorDate) break;
      }
      if (!priorDate && lead.title) priorDate = softHistory.hasTitle(lead.title);
    }

    const hasFollowUpSignal = Boolean(priorDate) && /open-?source|released?\s+weights|benchmark|复现|实测|开源权重|v\d+\.\d+/i.test(
      sorted.map(c => `${c.title ?? ''} ${c.tldr}`).join(' '),
    );
    const dedupStatus = !priorDate ? 'fresh' : hasFollowUpSignal ? 'follow_up_candidate' : 'seen_recently';
    if (dedupStatus === 'seen_recently') dedupSkipped7d += 1;
    if (dedupStatus === 'follow_up_candidate') dedupFollowUps += 1;

    const bestStatus = sorted.some(c => c.contentStatus === 'full_text') ? 'full_text'
      : sorted.some(c => c.contentStatus === 'abstract_only') ? 'abstract_only'
      : 'snippet_only';

    const topic = {
      topicId,
      leadCardId: lead.id,
      title: lead.title ?? sorted.find(c => c.title)?.title ?? lead.tldr.slice(0, 100),
      category: sorted.map(c => c.category).find(cat => cat !== 'general') ?? lead.category,
      entities: [...new Set(sorted.flatMap(c => c.entities))].slice(0, 10),
      primaryUrl: primaryArticleUrl,
      discussionUrls,
      allObservedUrls: allUrls,
      publishedAt: lead.publishedAt ?? sorted.find(c => c.publishedAt)?.publishedAt ?? null,
      ...(lead.paperPublishedAt ? { paperPublishedAt: lead.paperPublishedAt } : {}),
      fanIn: sorted.length,
      sources: [...new Set(sorted.map(c => c.sourceLabel))],
      contentStatus: bestStatus,
      dedupStatus,
      ...(priorDate ? { previouslyPublishedDate: priorDate } : {}),
      candidateKeys: allCandidateKeys,
      cards: sorted.map(c => ({
        id: c.id,
        kind: c.kind,
        author: c.author,
        sourceLabel: c.sourceLabel,
        url: c.url,
        publishedAt: c.publishedAt,
        contentStatus: c.contentStatus,
        charCount: c.charCount,
        tldr: c.tldr,
        rawBodyPath: c.rawBodyPath,
      })),
    };
    writeJson(path.join(topicsDir, `${topicId}.json`), topic);
    topics.push(topic);
  }

  const indexManifest = {
    schemaVersion: 1,
    collectionId: collection?.collectionId ?? null,
    date: collection?.date ?? null,
    counts: {
      rawItems: cards.length,
      topics: topics.length,
      dedupSkipped7d,
      dedupFollowUps,
    },
    topics: topics.map(({ cards: _cards, ...summary }) => summary),
  };
  writeJson(path.join(root, 'index.json'), indexManifest);
  return { storeDir: root, cards, topics, counts: indexManifest.counts };
}

async function readBoundedBytes(response, controller, maxBytes = MAX_FETCH_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`Body exceeds ${maxBytes} bytes`);
    return Buffer.from(ab);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function normalizeFetchTarget(rawUrl) {
  const u = new URL(rawUrl);
  // Convert arXiv /abs/ or /pdf/ to /html/ first if desired? Actually /abs/ has title+abstract reliably,
  // and arXiv /html/ exists for most modern papers; keep original URL and let HTML extractor parse <article> or <main>.
  const arxivPdf = u.hostname === 'arxiv.org' && u.pathname.match(/^\/pdf\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (arxivPdf) u.pathname = `/abs/${arxivPdf[1]}`;
  return u;
}

function extractReadableArticle(html, url) {
  const titleNode = htmlElements(html, 'title')[0];
  const title = titleNode ? htmlToText(titleNode.raw).slice(0, 300) : null;
  // Prefer <article> or <main> content when present to avoid nav/footer boilerplate.
  const articleNodes = htmlElements(html, 'article');
  const mainNodes = articleNodes.length ? articleNodes : htmlElements(html, 'main');
  const chosenHtml = mainNodes.length
    ? mainNodes.map(n => n.raw).sort((a, b) => b.length - a.length)[0]
    : html;
  const text = htmlToText(chosenHtml, { drop: ['nav', 'footer', 'header', 'aside', 'noscript', 'svg'] });
  const links = extractHtmlLinks(chosenHtml, url);
  const paywalled = /subscribe to read|paid subscribers only|this post is for paid subscribers|sign in to continue reading/i.test(text);
  return { title, text, links, paywalled };
}

/**
 * Fetches public HTTPS web pages for shortlisted topics that currently lack full text,
 * persisting both raw HTML/text and extracted links under store/raw/fetched/.
 */
export async function enrichTopicsWithFullText(topics, storeDir, {
  topicIds = null,
  maxFetches = 20,
  fetchImpl = globalThis.fetch,
} = {}) {
  const root = path.resolve(storeDir);
  const fetchedDir = path.join(root, 'raw', 'fetched');
  fs.mkdirSync(fetchedDir, { recursive: true, mode: 0o700 });

  const targetSet = topicIds ? new Set(topicIds) : null;
  const stats = { attempted: 0, fullText: 0, snippetOnly: 0, failed: 0, degradedUrls: [] };

  for (const topic of topics) {
    if (targetSet && !targetSet.has(topic.topicId)) continue;
    if (topic.contentStatus === 'full_text') {
      stats.attempted += 1;
      stats.fullText += 1;
      continue;
    }
    if (stats.attempted >= maxFetches) break;

    const candidateUrls = [topic.primaryUrl, ...(topic.allObservedUrls ?? [])]
      .filter(Boolean)
      .filter(href => {
        try {
          const u = new URL(href);
          return !publicUrlRefusal(u) && !NON_FETCH_FINAL_HOSTS.test(u.hostname);
        } catch { return false; }
      });

    const targetUrl = candidateUrls[0];
    if (!targetUrl) {
      stats.attempted += 1;
      stats.snippetOnly += 1;
      continue;
    }

    stats.attempted += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Fetch timeout')), FETCH_TIMEOUT_MS);
    try {
      let current = normalizeFetchTarget(targetUrl);
      let finalResponse = null;
      for (let hop = 0; ; hop++) {
        const refusal = publicUrlRefusal(current);
        if (refusal) throw new Error(`Refused target (${refusal})`);
        if (hop > 0 && NON_FETCH_FINAL_HOSTS.test(current.hostname)) {
          // A t.co link that resolved to another X status or video host stays a social post, not an external article.
          if (!topic.allObservedUrls.includes(current.href)) topic.allObservedUrls.push(current.href);
          break;
        }
        const res = await fetchImpl(current.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5',
          },
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
          const loc = res.headers.get('location');
          if (!loc) throw new Error('Redirect missing Location');
          current = new URL(loc, current);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        finalResponse = { res, finalUrl: current.href };
        break;
      }

      if (!finalResponse) {
        stats.snippetOnly += 1;
        writeJson(path.join(root, 'topics', `${topic.topicId}.json`), topic);
        continue;
      }

      if (!topic.allObservedUrls.includes(finalResponse.finalUrl)) {
        topic.allObservedUrls.unshift(finalResponse.finalUrl);
      }

      const contentType = (finalResponse.res.headers.get('content-type') ?? '').toLowerCase();
      if (/application\/pdf|image\/|audio\/|video\/|octet-stream/.test(contentType)) {
        stats.snippetOnly += 1;
        topic.fetchNote = `Binary content-type (${contentType.split(';')[0]}); retained existing abstract/post text`;
        continue;
      }

      const bytes = await readBoundedBytes(finalResponse.res, controller);
      const rawText = bytes.toString('utf8');
      const slug = `${topic.topicId}-${sha12(finalResponse.finalUrl)}`;
      const isHtml = contentType.includes('html') || /<html|<body|<article/i.test(rawText);
      const parsed = isHtml
        ? extractReadableArticle(rawText, finalResponse.finalUrl)
        : { title: null, text: rawText.trim(), links: [], paywalled: false };

      if (isHtml) fs.writeFileSync(path.join(fetchedDir, `${slug}.html`), rawText, { mode: 0o600 });
      const extractedPath = path.join(fetchedDir, `${slug}.txt`);
      fs.writeFileSync(extractedPath, parsed.text + '\n', { mode: 0o600 });

      const relPath = path.relative(root, extractedPath);
      topic.fetchedArticle = {
        url: finalResponse.finalUrl,
        title: parsed.title,
        charCount: parsed.text.length,
        paywalled: parsed.paywalled,
        rawTextPath: relPath,
        outboundLinks: parsed.links.slice(0, 30),
      };
      for (const l of parsed.links.slice(0, 30)) {
        const c = safeCanonical(l.href);
        if (c && !topic.allObservedUrls.includes(l.href)) topic.allObservedUrls.push(l.href);
      }

      if (!parsed.paywalled && parsed.text.length >= 800) {
        topic.contentStatus = 'full_text';
        stats.fullText += 1;
      } else {
        topic.contentStatus = parsed.paywalled ? 'paywalled' : 'abstract_only';
        stats.snippetOnly += 1;
        stats.degradedUrls.push(finalResponse.finalUrl);
      }
      writeJson(path.join(root, 'topics', `${topic.topicId}.json`), topic);
    } catch (error) {
      stats.failed += 1;
      stats.degradedUrls.push(targetUrl);
      topic.fetchError = String(error?.message ?? error).slice(0, 240);
      writeJson(path.join(root, 'topics', `${topic.topicId}.json`), topic);
    } finally {
      clearTimeout(timer);
    }
  }
  return stats;
}

/** Loads complete L0 raw text + all card perspectives for a selected topic. */
export function loadTopicFullMaterial(topic, storeDir) {
  const root = path.resolve(storeDir);
  const readSafe = rel => {
    if (!rel) return '';
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return '';
    return fs.readFileSync(target, 'utf8');
  };
  const fetchedBody = topic.fetchedArticle?.rawTextPath ? readSafe(topic.fetchedArticle.rawTextPath) : '';
  const cardBodies = (topic.cards ?? []).map(c => ({
    id: c.id,
    kind: c.kind,
    author: c.author,
    sourceLabel: c.sourceLabel,
    url: c.url,
    publishedAt: c.publishedAt,
    contentStatus: c.contentStatus,
    text: readSafe(c.rawBodyPath).slice(0, 24000),
  }));

  return {
    topicId: topic.topicId,
    title: topic.title,
    category: topic.category,
    publishedAt: topic.publishedAt,
    paperPublishedAt: topic.paperPublishedAt ?? null,
    dedupStatus: topic.dedupStatus,
    previouslyPublishedDate: topic.previouslyPublishedDate ?? null,
    primaryUrl: topic.primaryUrl,
    discussionUrls: topic.discussionUrls ?? [],
    companionUrls: (topic.allObservedUrls ?? []).slice(0, 15),
    contentStatus: topic.contentStatus,
    ...(fetchedBody ? {
      fetchedFullText: {
        url: topic.fetchedArticle.url,
        title: topic.fetchedArticle.title,
        paywalled: topic.fetchedArticle.paywalled,
        text: fetchedBody.slice(0, 32000),
      },
    } : {}),
    ...(topic.fetchError ? { fetchError: topic.fetchError } : {}),
    observations: cardBodies,
  };
}

/**
 * Deterministically builds a complete `dispositions.json` from screening + composition
 * results so the model never has to output 200+ disposition rows by hand.
 */
export function buildAutoDispositions({ collectionId, candidateKeys = [], topics = [], citedUrls = [], bulletSectionsByUrl = new Map() }) {
  const citedCanonical = new Set(citedUrls.map(safeCanonical).filter(Boolean));
  const items = [];
  const handled = new Set();

  for (const topic of topics) {
    const keys = (topic.candidateKeys ?? []).filter(k => candidateKeys.includes(k) && !handled.has(k));
    if (!keys.length) continue;

    const topicUrls = [topic.primaryUrl, ...(topic.discussionUrls ?? []), ...(topic.allObservedUrls ?? [])].filter(Boolean);
    const matchedUrl = topicUrls.find(u => citedCanonical.has(safeCanonical(u)));

    if (matchedUrl) {
      const primaryKey = keys[0];
      const section = bulletSectionsByUrl.get(safeCanonical(matchedUrl)) ?? 'Frameworks / Infra';
      items.push({ key: primaryKey, disposition: 'included', section, url: matchedUrl });
      handled.add(primaryKey);
      for (const extraKey of keys.slice(1)) {
        items.push({ key: extraKey, disposition: 'merged', mergedInto: primaryKey });
        handled.add(extraKey);
      }
    } else {
      const reason = topic.dedupStatus === 'seen_recently' ? 'duplicate_topic'
        : topic.category === 'case_study_pr' ? 'promotion'
        : topic.skipReason && ['off_topic', 'promotion', 'duplicate_topic', 'outside_window', 'low_signal', 'unreadable', 'other'].includes(topic.skipReason)
          ? topic.skipReason
          : 'low_signal';
      items.push(keys.length === 1
        ? { key: keys[0], disposition: 'skipped', reason }
        : { keys, disposition: 'skipped', reason });
      for (const k of keys) handled.add(k);
    }
  }

  const remaining = candidateKeys.filter(k => !handled.has(k));
  if (remaining.length) {
    items.push(remaining.length === 1
      ? { key: remaining[0], disposition: 'skipped', reason: 'low_signal' }
      : { keys: remaining, disposition: 'skipped', reason: 'low_signal' });
  }

  return { schemaVersion: 1, collectionId, items };
}
