// Stateless feed helpers; Gos-only interval persistence lives in coverage.mjs.
const iso = value => new Date(value).toISOString();
const ms = value => Date.parse(value);

// Non-X keys are the canonical link: tracking parameters and section anchors are
// dropped, but an identifying query (?p=101, ?v=…, ?id=…) is kept, so distinct
// posts never collapse into one key. Keys before this change dropped every query;
// see docs/COVERAGE.md for the compatibility behaviour of persisted keys.
export function itemKey(item) {
  const href = item.url || item.links?.find((l) => /\/status\/\d+|\/p\/|\/home\/post\//.test(l.href))?.href;
  if (href) {
    try {
      const u = new URL(href);
      const status = u.pathname.match(/\/status\/(\d+)(?:\/|$)/);
      if (/(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) && status) return `x:${status[1]}`;
      if (item.id) return item.id;
      return canonicalLink(href).href;
    } catch {}
  }
  return item.id || item.text;
}

// Deep reads and collector fetches only go to public HTTPS hosts. Returns a
// refusal reason or null. Names that are IP literals (any WHATWG-normalised
// IPv4 form or IPv6), loopback/link-local/private suffixes or single labels are
// never public article hosts; this is a name check, not DNS-rebinding proof.
const nonPublicSuffix = /(?:^|\.)(?:localhost|local|internal|localdomain|intranet|lan|home\.arpa)$/;
export function publicUrlRefusal(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); } catch { return 'invalid_url'; }
  if (url.protocol !== 'https:') return ['http:'].includes(url.protocol) ? 'insecure_protocol' : 'unsupported_protocol';
  if (url.username || url.password) return 'embedded_credentials';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'ip_literal_host';
  if (!host.includes('.') || nonPublicSuffix.test(host)) return 'non_public_host';
  return null;
}

const stableKey = value => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const union = values => [...new Map(values.filter(value => value != null).map(value => [stableKey(value), value])).values()];

export function mergeItems(...groups) {
  const result = new Map();
  for (const item of groups.flat()) {
    const key = itemKey(item);
    if (!key) continue;
    const previous = result.get(key);
    if (!previous) result.set(key, { ...item,
      ...((item.evidenceId || item.evidenceIds?.length) ? { evidenceIds: union([item.evidenceId, ...(item.evidenceIds || [])]) } : {}),
      ...((item.discovery || item.discoveries) ? { discoveries: union([item.discovery, ...(item.discoveries || [])]) } : {}),
    });
    else result.set(key, {
      ...previous, ...item,
      text: (previous.text || '').length > (item.text || '').length ? previous.text : item.text,
      publishedAt: Number.isFinite(ms(previous.publishedAt)) && !Number.isFinite(ms(item.publishedAt)) ? previous.publishedAt : item.publishedAt,
      ...((previous.evidenceId || item.evidenceId) ? { evidenceId: item.evidenceId || previous.evidenceId } : {}),
      evidenceIds: union([previous.evidenceId, ...(previous.evidenceIds || []), item.evidenceId, ...(item.evidenceIds || [])]),
      discoveries: union([previous.discovery, ...(previous.discoveries || []), item.discovery, ...(item.discoveries || [])]),
      links: [...new Map([...(previous.links || []), ...(item.links || [])].map((l) => [l.href, l])).values()],
    });
  }
  return [...result.values()];
}

export async function scanWindow({ read, scroll, window, maxPages = 80, maxMs = 120000, clock = Date.now, allowExhausted = false,
  orderedTimestamps = false, stallLimit = 8, recover, maxRecoveryMs = 5000, endConfirmReads = 3 }) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isFinite(maxMs) || maxMs <= 0 ||
      !Number.isInteger(stallLimit) || stallLimit < 1 || !Number.isFinite(maxRecoveryMs) || maxRecoveryMs <= 0 ||
      !Number.isInteger(endConfirmReads) || endConfirmReads < 1 ||
      (recover !== undefined && typeof recover !== 'function')) throw new Error('Invalid feed traversal budget');
  const started = clock();
  let items = [], stagnant = 0, oldPages = 0, reason = 'page_budget', pages = 0, reads = 0, readAttempts = 0;
  let boundary = false, boundaryEvidence = null, stallCause = null, loadingReads = 0;
  // endStreak: consecutive settled bottom reads (atEnd, not loading, nothing new).
  // endMark: the streak length when a completed recovery nudge began, if any.
  let endStreak = 0, endMark = null;
  let failure = null;
  const recordFailure = (error, phase) => {
    failure = { phase, name: String(error?.name || 'Error'), code: error?.code == null ? null : String(error.code),
      message: String(error?.message || error).slice(0, 500) };
    reason = ['RUN_BUDGET', 'ABORT_ERR', 'ERR_ABORTED', 'DEADLINE_EXCEEDED'].includes(failure.code) ||
      ['AbortError', 'TimeoutError'].includes(failure.name) ? 'interrupted' : `${phase}_error`;
  };
  const recovery = { attempts: 0, status: 'not_attempted' };
  const unknown = new Set();
  for (; pages < maxPages && clock() - started < maxMs; pages++) {
    let page;
    readAttempts++;
    try {
      page = await read();
      if (!page || typeof page !== 'object' || (page.items !== undefined && !Array.isArray(page.items))) {
        throw new Error('Feed read must return a page object with an optional items array');
      }
      reads++;
    } catch (error) { recordFailure(error, 'read'); break; }
    if (page.blocked) { reason = page.blocked; break; }
    if (page.loading) loadingReads++;
    const before = items.length;
    items = mergeItems(items, page.items || []);
    const dated = (page.items || []).filter((i) => Number.isFinite(ms(i.publishedAt)));
    unknown.clear();
    for (const item of items) {
      if (!Number.isFinite(ms(item.publishedAt))) unknown.add(itemKey(item));
    }
    stagnant = items.length === before ? stagnant + 1 : 0;
    endStreak = page.atEnd === true && !page.loading && items.length === before ? endStreak + 1 : 0;
    if (endStreak === 0) endMark = null;
    // One old pinned/reposted item must not terminate the scan.
    const tail = dated.slice(-4);
    const allOld = !page.loading && tail.length >= 2 && dated.length === (page.items || []).length && tail.every((i) => ms(i.publishedAt) < ms(window.start));
    oldPages = allOld && items.length > before ? oldPages + 1 : 0;
    // Adapters may opt in only when timestamps express feed order (not the
    // original date of a repost). Otherwise old posts cannot stop traversal.
    if (orderedTimestamps === true && oldPages >= 2) { boundary = true; boundaryEvidence = 'ordered_timestamp_boundary'; reason = 'time_boundary'; break; }
    if (page.empty && !page.loading && items.length === 0) { boundary = true; boundaryEvidence = 'explicit_exhaustion'; reason = 'explicit_empty'; break; }
    // Scroll geometry alone cannot prove a virtualized feed is exhausted.
    if (page.exhausted === true && !page.loading && items.length > 0) { boundary = allowExhausted; boundaryEvidence = 'explicit_exhaustion'; reason = 'observed_end'; break; }
    // readFeedDom reports atEnd, never exhausted. A bounded adapter may opt in to
    // treat the bottom as the end only when it stayed settled for endConfirmReads
    // reads before a completed recovery nudge and endConfirmReads reads after it,
    // with no loading indicator and no new item. Any new item or non-bottom read
    // voids it; without recovery, or with loading, the bottom remains a stall.
    if (allowExhausted === true && endMark !== null && endStreak >= endMark + endConfirmReads && items.length > 0) {
      boundary = true; boundaryEvidence = 'stable_scroll_end'; reason = 'observed_end'; break;
    }
    if (stagnant >= stallLimit) {
      stallCause = page.loading ? 'delayed_loading' : 'unchanged_feed';
      if (recover && recovery.attempts === 0 && pages + 1 < maxPages && clock() - started < maxMs) {
        recovery.attempts = 1;
        recovery.cause = stallCause;
        const remainingMs = Math.min(maxRecoveryMs, maxMs - (clock() - started));
        const controller = new AbortController();
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => recover({ cause: stallCause, stagnant, pages: reads, remainingMs, signal: controller.signal })),
            new Promise((_, reject) => { timer = setTimeout(() => {
              recovery.status = 'timed_out';
              controller.abort();
              reject(new Error('Feed recovery timed out'));
            }, remainingMs); }),
          ]);
          recovery.status = 'completed';
          endMark = endStreak >= endConfirmReads ? endStreak : null;
          stagnant = 0;
          oldPages = 0;
          stallCause = null;
          continue;
        } catch (error) {
          if (recovery.status !== 'timed_out') recovery.status = 'failed';
          recovery.error = String(error?.message || error).slice(0, 250);
          if (recovery.status !== 'timed_out') recordFailure(error, 'recovery');
        } finally { clearTimeout(timer); }
      }
      if (!failure) reason = 'stalled';
      break;
    }
    try { await scroll(); } catch (error) { recordFailure(error, 'scroll'); break; }
  }
  // A late source-terminal response or exception is stronger evidence than
  // elapsed time. Never replace its actionable reason with a generic budget.
  if (clock() - started >= maxMs && reason === 'page_budget') reason = 'time_budget';
  const dates = items.map((i) => ms(i.publishedAt)).filter(Number.isFinite);
  return {
    items: items.filter((i) => !Number.isFinite(ms(i.publishedAt)) || (ms(i.publishedAt) >= ms(window.start) && ms(i.publishedAt) < ms(window.end))),
    coverage: { ...window, scanned: boundary && boundaryEvidence !== null && unknown.size === 0, reason, pages: reads, readAttempts, boundaryEvidence,
      assurance: 'best_effort_ui', observedItems: items.length, undatedItems: unknown.size,
      stallLimit, stallCause, loadingReads, recovery, failure,
      oldestObserved: dates.length ? iso(Math.min(...dates)) : null,
      newestObserved: dates.length ? iso(Math.max(...dates)) : null },
  };
}

// This is a relevance heuristic, not a claim that the destination is an article.
// Root-hosted papers and interactive research microsites still need a deep read.
const technicalTopic = /\b(RL|GRPO|PPO|TRL|BF16|FP8|FP4|INT8|INT4|MoE|MLA|GQA|KV[\s-]?cache|CUDA|Triton|NCCL|ROCm|TPU|vLLM|SGLang|Megatron|PyTorch|JAX|optimizer|rollout|checkpoint|training|pretraining|post-training|fine-?tuning|distillation|quantization|speculative|attention|transformer|inference|serving|throughput|latency|benchmark|eval(?:uation)?s?|weight.?sync|delta|kernel|GPU|LLMs?|VLMs?|multimodal|vision-language|diffusion|world[\s-]?model|robotics|embodied|compiler|formal|verification|theorem|Lean\b|zero-knowledge|ZKP?|agents?|agentic|coding|RAG|context[\s-]?window|long[\s-]?context|research|paper|arxiv|open-?source|open-?weight|release|architecture|scaling|mechanistic[\s-]+interpretability|interpretability|mech[\s-]?interp|neurons?|superposition|monosemanticity|polysemanticity|sparse[\s-]+autoencoders?|SAEs?|feature[\s-]+visuali[sz]ation|Goodfire|Nick[\s_-]*Cammarata|nickcammarata)\b|(?<![\w.])AI\b|训练|推理|微调|蒸馏|量化|算子|吞吐|延迟|评测|基准|架构|开源|模型|多模态|智能体|代理|论文|权重|研究|可解释性|神经元|叠加/i;
const navigationLabel = /^(?:home(?:page)?|website|official (?:site|website)|my (?:site|website)|profile|sign[ -]?in|log[ -]?in|subscribe|首页|主页|官网)\s*[.!]?$/i;

export function canonicalLink(href) {
  const url = new URL(href);
  // Preserve hash-router paths; ordinary section anchors do not change articles.
  if (!/^#!?\//.test(url.hash)) url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(?:fbclid|gclid|mc_cid|mc_eid|ref_src|ref_url)$/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

// Includes every observed link occurrence, even rejected and duplicate links.
// Only eligible:true records belong in a deep-read queue or eligible backlog.
export function auditDeepLinks(items, limit = 12) {
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid deep-read budget');
  const records = [], links = new Map();
  for (const item of items) {
    for (const link of item.links || []) {
      const record = { ...link, score: 0, context: (item.text || '').slice(0, 1000), sourceId: itemKey(item),
        eligible: false, selected: false, status: 'filtered', reason: 'invalid_url' };
      records.push(record);
      let url;
      try { url = canonicalLink(link.href); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) { record.reason = 'unsupported_protocol'; continue; }
      if (url.username || url.password) { record.reason = 'embedded_credentials'; continue; }
      record.href = url.href;
      if (link.href !== url.href) record.originalHref = link.href;
      // Loopback, metadata, LAN and plain-HTTP targets never enter a deep-read queue.
      const refusal = publicUrlRefusal(url);
      if (refusal) { record.reason = refusal; continue; }
      const hostname = url.hostname.replace(/^www\./, '');
      const text = `${item.text || ''} ${link.text || ''} ${link.href}`;
      const technical = technicalTopic.test(text);
      const primary = /(^|\.)(huggingface\.co|arxiv\.org|github\.com|openreview\.net)$/.test(url.hostname);
      const essay = /(^|\.)(substack\.com|latent\.space)$/.test(url.hostname);
      const platformHome = /^(?:github\.com|huggingface\.co|arxiv\.org|openreview\.net|substack\.com|youtube\.com|youtu\.be|linkedin\.com|facebook\.com|instagram\.com|t\.co)$/.test(hostname);
      record.score = Number(technical) * 3 + Number(primary) * 2 + Number(essay);
      if (/(^|\.)(x\.com|twitter\.com)$/.test(hostname)) record.reason = 'social_link';
      else if (/\/analytics\/?$/.test(url.pathname)) record.reason = 'analytics_link';
      else if (hostname === 'substack.com' && /^\/(?:@|profile(?:\/|$)|home(?:\/|$))/.test(url.pathname)) record.reason = 'substack_navigation';
      else if (url.pathname === '/' && (platformHome || navigationLabel.test((link.text || '').trim()))) record.reason = 'homepage_navigation';
      else if (url.pathname === '/' && !technical) record.reason = 'homepage_without_technical_signal';
      else if (!technical && !primary && !essay) record.reason = 'no_technical_signal';
      else {
        record.eligible = true;
        record.reason = technical ? 'technical_context' : primary ? 'primary_source' : 'essay_source';
      }
      const prev = links.get(url.href);
      // A stronger later context can rescue an earlier weak link occurrence.
      if (!prev || Number(record.eligible) > Number(prev.eligible) ||
          (record.eligible === prev.eligible && record.score > prev.score)) links.set(url.href, record);
    }
  }
  // Fan-in rewards a link shared by several distinct posts; it is topic-neutral by design.
  const sources = new Map();
  for (const record of records) sources.set(record.href, (sources.get(record.href) ?? new Set()).add(record.sourceId));
  for (const record of records) {
    record.fanIn = sources.get(record.href).size;
    record.score += Math.min(record.fanIn - 1, 3);
  }
  for (const record of records) {
    if (links.has(record.href) && links.get(record.href) !== record) {
      record.eligibilityReason = record.reason;
      record.eligible = false;
      record.reason = 'duplicate_url';
      record.duplicateOf = record.href;
    }
  }
  const ranked = [...links.values()].filter(link => link.eligible).sort((a, b) => b.score - a.score);
  ranked.forEach((link, index) => {
    link.eligibilityReason = link.reason;
    link.selected = index < limit;
    link.status = link.selected ? 'selected' : 'eligible_backlog';
    link.reason = link.selected ? 'ranked_for_deep_read' : 'deep_read_budget';
  });
  return [...ranked, ...records.filter(link => !link.eligible)];
}

const structuralReasons = new Set(['invalid_url', 'unsupported_protocol', 'embedded_credentials', 'social_link',
  'analytics_link', 'substack_navigation', 'homepage_navigation']);

/** Links shared by >= 2 distinct items: [{ url, fanIn, itemKeys }], fanIn desc then url asc. keyOf names each item. */
export function clusterByLink(items, { keyOf = itemKey } = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    for (const record of auditDeepLinks([{ ...item, links: item.links || [] }], 0)) {
      // Profile, hashtag and navigation links are page chrome, not a shared subject.
      if (structuralReasons.has(record.reason) || structuralReasons.has(record.eligibilityReason)) continue;
      groups.set(record.href, (groups.get(record.href) ?? new Set()).add(key));
    }
  }
  return [...groups].filter(([, keys]) => keys.size >= 2).map(([url, keys]) => ({ url, fanIn: keys.size, itemKeys: [...keys] }))
    .sort((a, b) => b.fanIn - a.fanIn || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// Backward-compatible selection API: omit filtered links, retain eligible backlog.
export function rankDeepLinks(items, limit = 12) {
  return auditDeepLinks(items, limit).filter(link => link.eligible);
}

// Executed inside the browser, kept here so fixture tests can exercise the adapter.
export function readFeedDom(kind) {
  const nodes = [...document.querySelectorAll(kind === 'x' ? 'article' : '[role=article]')];
  const items = nodes.filter(node => !node.querySelector('[data-testid="promotedIndicator"], [data-testid="placementTracking"]') &&
    !node.closest('[data-testid="placementTracking"]')).map((node) => {
    const links = [...node.querySelectorAll('a[href]')].map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim(), href: a.href }));
    const time = node.querySelector('time') || [...node.querySelectorAll('a[title]')].find((a) => Number.isFinite(Date.parse(a.getAttribute('title'))));
    const status = time?.closest('a[href]')?.href || links.find((l) => /\/status\/\d+/.test(l.href))?.href;
    const url = kind === 'x' ? status : time?.closest('a[href]')?.href || links.find((l) => /\/p\/|\/home\/post\/|\/note\//.test(l.href))?.href;
    const rawDate = time?.getAttribute('datetime') || time?.getAttribute('title') || '';
    const parsed = Date.parse(rawDate);
    return { url, publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
      text: (node.innerText || '').trim().slice(0, 16000), links,
      truncated: Boolean(node.querySelector('[data-testid="tweet-text-show-more-link"]')) || (node.innerText || '').trim().length > 16000 };
  }).filter((i) => i.text && i.url);
  const text = document.body.innerText || '';
  const errorText = items.length ? (document.querySelector('[role="alert"]')?.innerText || '') : text;
  return { items,
    blocked: /\/i\/flow\/login|\/login/.test(location.pathname) ? 'login_required' :
      /Rate limit exceeded|Too many requests/i.test(errorText) ? 'rate_limited' :
      /Something went wrong|Try again later/i.test(errorText) ? 'page_error' : null,
    loading: Boolean(document.querySelector('[role="progressbar"]')),
    empty: kind === 'x' && /No results for/.test(text),
    atEnd: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 40,
  };
}
