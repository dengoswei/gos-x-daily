// Stage 1 Curation Prior Scorer + Cross-Day High-Value Backlog Pool (Evergreen Pool).
//
// Core principle: Article category (paper / infra / product / essay) ONLY determines
// which section an item renders under — NEVER its quality score.
// Quality prior is driven by 4 objective signals:
//   (1) Author confidence (known high-signal researchers / builders)
//   (2) Source SNR tier (low-frequency high-density blogs vs high-volume aggregators)
//   (3) Social & community endorsement (in-network fanIn, bookmarks, likes, reposts, HF upvotes)
//   (4) Noise penalties (commercial case studies, hiring/giveaway promos)
// Stage 2 (LLM / Host Agent) then evaluates the shortlisted pool on Novel Insight,
// Empirical Engineering Lesson, and Consequential Judgment, while unpicked high-value
// runners-up persist into `state/backlog-pool.json` with signal accumulation & 7-day decay.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalUrl } from './binding.mjs';
import { topicFingerprint } from './telemetry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultTastePath = path.join(repoRoot, 'config', 'taste.json');

const safeCanonical = href => {
  if (typeof href !== 'string' || !href.trim()) return null;
  try { return canonicalUrl(href); } catch { return null; }
};
const sha12 = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 12);

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

export function loadTasteConfig(tasteFile = null) {
  const target = tasteFile && fs.existsSync(tasteFile) ? tasteFile : defaultTastePath;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function matchDomainTier(urls, tierSpec) {
  if (!tierSpec?.domains?.length) return false;
  for (const rawUrl of urls) {
    if (typeof rawUrl !== 'string') continue;
    try {
      const u = new URL(rawUrl);
      const hostAndPath = `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.toLowerCase()}`;
      if (tierSpec.domains.some(d => hostAndPath === d.toLowerCase() || hostAndPath.startsWith(`${d.toLowerCase()}/`) || u.hostname.toLowerCase().replace(/^www\./, '') === d.toLowerCase() || u.hostname.toLowerCase().endsWith(`.${d.toLowerCase()}`))) {
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

/** Aggregates maximum observed social metrics across all observations/cards in a topic. */
export function aggregateTopicMetrics(cards = [], priorMetrics = null) {
  const merged = { ...(priorMetrics ?? {}) };
  const bump = (field, val) => {
    if (Number.isFinite(val) && val >= 0) {
      merged[field] = Math.max(merged[field] ?? 0, val);
    }
  };
  for (const c of cards) {
    const m = c?.metrics;
    if (!m || typeof m !== 'object') continue;
    for (const k of ['likes', 'reposts', 'replies', 'bookmarks', 'views', 'upvotes', 'comments', 'githubStars']) {
      bump(k, m[k]);
    }
  }
  return merged;
}

/**
 * Computes the transparent, category-neutral 4-signal Prior Score for a topic:
 *   priorScore = authorBoost + sourceBoost + socialBoost + noisePenalty - ageDecay
 */
export function scoreTopicPrior(topic, taste = loadTasteConfig(), { reportDate = null } = {}) {
  const tierSAuthors = new Set((taste.authors?.tierS?.handles ?? []).map(h => h.toLowerCase()));
  const tierAAuthors = new Set((taste.authors?.tierA?.handles ?? []).map(h => h.toLowerCase()));

  const cardAuthors = (topic.cards ?? [])
    .map(c => String(c.author ?? '').replace(/^@/, '').toLowerCase())
    .filter(Boolean);

  // (1) Author confidence
  let authorTier = 'standard';
  let authorBoost = 0;
  if (cardAuthors.some(a => tierSAuthors.has(a))) {
    authorTier = 'S';
    authorBoost = taste.authors?.tierS?.boost ?? 6.0;
  } else if (cardAuthors.some(a => tierAAuthors.has(a))) {
    authorTier = 'A';
    authorBoost = taste.authors?.tierA?.boost ?? 3.5;
  }

  // (2) Source SNR tier (matched by feed/blog name OR primary/outbound article domain)
  const sourceNames = (topic.sources ?? []).map(s => String(s).toLowerCase());
  const urlsToCheck = [topic.primaryUrl, ...(topic.allObservedUrls ?? [])].filter(Boolean);
  const matchesSourceSpec = spec => {
    if (!spec) return false;
    const byName = (spec.names ?? []).some(n => sourceNames.includes(n.toLowerCase()));
    return byName || matchDomainTier(urlsToCheck, spec);
  };

  let sourceTier = 'standard';
  let sourceBoost = 1.5;
  if (matchesSourceSpec(taste.sources?.tierS)) {
    sourceTier = 'S';
    sourceBoost = taste.sources?.tierS?.boost ?? 5.0;
  } else if (matchesSourceSpec(taste.sources?.tierA)) {
    sourceTier = 'A';
    sourceBoost = taste.sources?.tierA?.boost ?? 3.0;
  } else if (matchesSourceSpec(taste.sources?.tierB)) {
    sourceTier = 'B';
    sourceBoost = taste.sources?.tierB?.boost ?? 1.0;
  }

  // (3) Social & community resonance (in-network fanIn + bookmarks/likes/reposts + HF upvotes + GitHub stars)
  const weights = taste.socialWeights ?? {};
  const extraFanIn = Math.min(Math.max(0, (topic.fanIn ?? 1) - 1), weights.fanInMaxExtraPosts ?? 4);
  const fanInBoost = extraFanIn * (weights.fanInPerExtraPost ?? 2.8);

  const hasWatchAccount = (topic.sources ?? []).some(s => String(s).startsWith('watch:@'));
  // Avoid double-counting full watch boost if already counted as Tier-S author; add a modest watch curation bonus.
  const watchBoost = hasWatchAccount ? (authorTier === 'S' ? 1.5 : (weights.watchAccountPresenceBoost ?? 4.0)) : 0;

  const m = topic.metrics ?? {};
  // Bookmarks and reposts on technical X carry much higher signal-to-noise than raw likes.
  const weightedXEngagement = (m.bookmarks ?? 0) * 4 + (m.reposts ?? 0) * 3 + (m.likes ?? 0) + (m.replies ?? 0) * 2 + Math.floor((m.views ?? 0) / 500);
  const xMetricBoost = weightedXEngagement > 0
    ? Math.log10(1 + weightedXEngagement) * (weights.xEngagementLogScale ?? 1.6)
    : 0;

  const hfUpvotesBoost = (m.upvotes ?? 0) > 0
    ? Math.log10(1 + m.upvotes + (m.comments ?? 0) * 2) * (weights.hfUpvotesLogScale ?? 2.0)
    : 0;

  const ghStarsBoost = (m.githubStars ?? 0) > 0
    ? Math.log10(1 + m.githubStars) * (weights.githubStarsLogScale ?? 1.2)
    : 0;

  const socialBoost = Number((fanInBoost + watchBoost + xMetricBoost + hfUpvotesBoost + ghStarsBoost).toFixed(2));

  // (4) Noise penalties (commercial case studies, hiring/giveaways)
  const textSample = `${topic.title ?? ''} ${(topic.cards ?? []).map(c => c.tldr ?? '').join(' ')}`;
  let noisePenalty = 0;
  if (topic.category === 'case_study_pr') {
    noisePenalty += taste.noisePenalties?.caseStudyPr ?? -8.0;
  }
  if (/\b(we['’]?re\s+hiring|join\s+our\s+team|giveaway|waitlist\s+is\s+open|register\s+for\s+our\s+webinar)\b|招聘|抽奖|预约直播/i.test(textSample)) {
    noisePenalty += taste.noisePenalties?.purePromoOrHiring ?? -6.0;
  }

  // Backlog age decay (if carried over from an earlier day WITHOUT new fresh observations today)
  let ageDecay = 0;
  if (topic.fromBacklog && !topic.refreshedToday && reportDate && topic.firstSeenDate && reportDate > topic.firstSeenDate) {
    const daysHeld = Math.max(0, Math.round((Date.parse(reportDate) - Date.parse(topic.firstSeenDate)) / DAY_MS));
    ageDecay = Number((daysHeld * (taste.backlog?.dailyDecay ?? 0.6)).toFixed(2));
  }

  // Carry over prior LLM editorial boost when an already-vetted deferred gem returns on a quieter day.
  const llmCarryBonus = topic.deferredByLlm ? 2.5 : 0;

  const priorScore = Number((authorBoost + sourceBoost + socialBoost + llmCarryBonus + noisePenalty - ageDecay).toFixed(2));

  return {
    priorScore,
    signals: {
      authorTier,
      authorBoost,
      sourceTier,
      sourceBoost,
      fanIn: topic.fanIn ?? 1,
      socialBoost,
      ...(Object.keys(m).length ? { metrics: m } : {}),
      ...(noisePenalty ? { noisePenalty } : {}),
      ...(ageDecay ? { ageDecay } : {}),
      ...(llmCarryBonus ? { llmCarryBonus } : {}),
    },
  };
}

/**
 * Loads unexpired, unpublished items from `state/backlog-pool.json`.
 */
export function loadBacklogPool(stateDir, { reportDate, softHistory = null, maxAgeDays = 7 } = {}) {
  const poolFile = path.join(path.resolve(stateDir), 'backlog-pool.json');
  if (!fs.existsSync(poolFile)) return { poolFile, entries: [], expiredCount: 0 };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(poolFile, 'utf8')); } catch { return { poolFile, entries: [], expiredCount: 0 }; }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const cutoff = reportDate
    ? new Date(Date.parse(reportDate) - maxAgeDays * DAY_MS).toISOString().slice(0, 10)
    : null;

  const active = [];
  let expiredCount = 0;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    if (cutoff && entry.firstSeenDate && entry.firstSeenDate < cutoff) {
      expiredCount += 1;
      continue;
    }
    if (softHistory) {
      const urlPublished = [entry.primaryUrl, ...(entry.allObservedUrls ?? [])].filter(Boolean).some(u => softHistory.hasUrl(u));
      const titlePublished = entry.title ? Boolean(softHistory.hasTitle(entry.title)) : false;
      if (urlPublished || titlePublished) continue;
    }
    active.push(entry);
  }
  return { poolFile, entries: active, expiredCount };
}

function topicIdentityUrls(topic) {
  const set = new Set();
  for (const u of [topic.primaryUrl, ...(topic.allObservedUrls ?? [])]) {
    const c = safeCanonical(u);
    if (c) set.add(c);
  }
  return set;
}

/**
 * Merges active backlog entries into today's topics:
 * - If today's collection has new posts/observations for a backlog URL, accumulates `fanIn`,
 *   merges metrics, reuses cached `fetchedFullText` if still missing, and marks `refreshedToday: true`!
 * - If a backlog entry was NOT seen in today's 48h window, injects it as a recall candidate
 *   (marked `fromBacklog: true`) with its cached full text ready so zero re-fetching is needed.
 */
export function mergeBacklogIntoTopics(topics, backlogEntries, storeDir, { taste = loadTasteConfig(), reportDate } = {}) {
  const root = path.resolve(storeDir);
  let recalledStandalone = 0;
  let accumulatedWithFresh = 0;

  for (const entry of backlogEntries) {
    const entryUrls = topicIdentityUrls(entry);
    const entryFp = topicFingerprint(entry.title ?? '');
    const match = topics.find(tp => {
      if (tp.dedupStatus === 'seen_recently') return false;
      const tpUrls = topicIdentityUrls(tp);
      for (const u of entryUrls) if (tpUrls.has(u)) return true;
      return Boolean(entryFp && entryFp.length >= 12 && topicFingerprint(tp.title ?? '') === entryFp);
    });

    if (match) {
      // Cross-day signal accumulation!
      accumulatedWithFresh += 1;
      const prevKeys = new Set(match.candidateKeys ?? []);
      const extraSeenCount = (entry.seenKeys ?? []).filter(k => !prevKeys.has(k)).length;
      match.fanIn = (match.fanIn ?? 1) + extraSeenCount;
      match.metrics = aggregateTopicMetrics([{ metrics: entry.metrics }, ...match.cards], match.metrics);
      match.fromBacklog = true;
      match.refreshedToday = true;
      match.firstSeenDate = entry.firstSeenDate ?? reportDate;
      match.deferredByLlm = Boolean(entry.deferredByLlm);
      for (const s of entry.sources ?? []) {
        if (!match.sources.includes(s)) match.sources.push(s);
      }
      if (entry.author && !match.cards.some(c => String(c.author).toLowerCase() === String(entry.author).toLowerCase())) {
        match.cards.push({
          id: `${match.topicId}-backlog-author`,
          kind: 'backlog',
          author: entry.author,
          sourceLabel: (entry.sources ?? ['backlog'])[0],
          url: entry.primaryUrl,
          publishedAt: entry.publishedAt ?? null,
          metrics: entry.metrics ?? {},
          contentStatus: entry.contentStatus ?? 'snippet_only',
          charCount: (entry.tldr ?? '').length,
          tldr: entry.tldr ?? '',
          rawBodyPath: match.cards[0]?.rawBodyPath ?? '',
        });
      }
      // Reuse previously cached full-text body if today's card is still snippet/abstract-only.
      if (match.contentStatus !== 'full_text' && entry.cachedTextPath && fs.existsSync(entry.cachedTextPath)) {
        const cachedText = fs.readFileSync(entry.cachedTextPath, 'utf8');
        if (cachedText.length >= 800) {
          const fetchedDir = path.join(root, 'raw', 'fetched');
          fs.mkdirSync(fetchedDir, { recursive: true, mode: 0o700 });
          const localCopy = path.join(fetchedDir, `${match.topicId}-backlog-${sha12(entry.primaryUrl ?? match.topicId)}.txt`);
          fs.writeFileSync(localCopy, cachedText, { mode: 0o600 });
          match.fetchedArticle = {
            url: entry.fetchedUrl ?? entry.primaryUrl,
            title: entry.title,
            charCount: cachedText.length,
            paywalled: false,
            rawTextPath: path.relative(root, localCopy),
            outboundLinks: [],
          };
          match.contentStatus = 'full_text';
        }
      }
    } else {
      // Inject standalone recalled backlog gem into today's topic pool.
      recalledStandalone += 1;
      const topicId = `topic-backlog-${String(recalledStandalone).padStart(3, '0')}`;
      let rawTextRel = null;
      let cachedLen = (entry.tldr ?? '').length;
      if (entry.cachedTextPath && fs.existsSync(entry.cachedTextPath)) {
        const cachedText = fs.readFileSync(entry.cachedTextPath, 'utf8');
        cachedLen = cachedText.length;
        const fetchedDir = path.join(root, 'raw', 'fetched');
        fs.mkdirSync(fetchedDir, { recursive: true, mode: 0o700 });
        const localCopy = path.join(fetchedDir, `${topicId}-${sha12(entry.primaryUrl ?? topicId)}.txt`);
        fs.writeFileSync(localCopy, cachedText, { mode: 0o600 });
        rawTextRel = path.relative(root, localCopy);
      }
      const cardRawDir = path.join(root, 'raw', topicId);
      fs.mkdirSync(cardRawDir, { recursive: true, mode: 0o700 });
      const cardBodyFile = path.join(cardRawDir, 'body.txt');
      fs.writeFileSync(cardBodyFile, (entry.cardText || entry.tldr || entry.title || '') + '\n', { mode: 0o600 });

      const recalledTopic = {
        topicId,
        leadCardId: `${topicId}-card`,
        title: entry.title,
        category: entry.category ?? 'general',
        entities: entry.entities ?? [],
        primaryUrl: entry.primaryUrl,
        discussionUrls: entry.discussionUrls ?? [],
        allObservedUrls: entry.allObservedUrls ?? [entry.primaryUrl].filter(Boolean),
        publishedAt: entry.publishedAt ?? null,
        ...(entry.paperPublishedAt ? { paperPublishedAt: entry.paperPublishedAt } : {}),
        fanIn: entry.fanIn ?? 1,
        sources: entry.sources ?? ['backlog'],
        metrics: entry.metrics ?? {},
        contentStatus: rawTextRel && cachedLen >= 800 ? 'full_text' : (entry.contentStatus ?? 'abstract_only'),
        dedupStatus: 'fresh',
        fromBacklog: true,
        refreshedToday: false,
        firstSeenDate: entry.firstSeenDate ?? reportDate,
        deferredByLlm: Boolean(entry.deferredByLlm),
        deferredReason: entry.deferredReason ?? null,
        candidateKeys: [],
        ...(rawTextRel ? {
          fetchedArticle: {
            url: entry.fetchedUrl ?? entry.primaryUrl,
            title: entry.title,
            charCount: cachedLen,
            paywalled: false,
            rawTextPath: rawTextRel,
            outboundLinks: [],
          },
        } : {}),
        cards: [{
          id: `${topicId}-card`,
          kind: 'backlog',
          author: entry.author ?? 'unknown',
          sourceLabel: (entry.sources ?? ['backlog'])[0],
          url: entry.primaryUrl,
          publishedAt: entry.publishedAt ?? null,
          contentStatus: entry.contentStatus ?? 'abstract_only',
          charCount: (entry.cardText || entry.tldr || '').length,
          tldr: entry.tldr ?? entry.title ?? '',
          rawBodyPath: path.relative(root, cardBodyFile),
        }],
      };
      fs.mkdirSync(path.join(root, 'topics'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(root, 'topics', `${topicId}.json`), JSON.stringify(recalledTopic, null, 2) + '\n', { mode: 0o600 });
      topics.push(recalledTopic);
    }
  }

  // Score every topic with the 4-signal prior scorer!
  for (const tp of topics) {
    tp.metrics = aggregateTopicMetrics(tp.cards, tp.metrics);
    const scored = scoreTopicPrior(tp, taste, { reportDate });
    tp.priorScore = scored.priorScore;
    tp.curationSignals = scored.signals;
  }

  return { recalledStandalone, accumulatedWithFresh };
}

/**
 * Updates `state/backlog-pool.json` after a digest is finalized:
 * - Removes any topic whose URL was published today (or in recent 7-day history);
 * - Saves high-value unpicked runners-up (explicitly marked `deferred` by LLM or meeting
 *   `minPriorScoreToEnter`) along with their cached full-text bodies under `state/backlog-articles/`.
 */
export function saveBacklogPool(stateDir, {
  reportDate,
  topics = [],
  citedUrls = [],
  deferredTopicIds = new Map(),
  taste = loadTasteConfig(),
} = {}) {
  const rootState = path.resolve(stateDir);
  const poolFile = path.join(rootState, 'backlog-pool.json');
  const cacheDir = path.join(rootState, 'backlog-articles');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const maxPoolSize = taste.backlog?.maxPoolSize ?? 40;
  const maxAgeDays = taste.backlog?.maxAgeDays ?? 7;
  const minPrior = taste.backlog?.minPriorScoreToEnter ?? 5.5;
  const cutoff = new Date(Date.parse(reportDate) - maxAgeDays * DAY_MS).toISOString().slice(0, 10);

  const publishedSet = new Set(citedUrls.map(safeCanonical).filter(Boolean));
  const candidates = [];

  for (const tp of topics) {
    if (tp.dedupStatus === 'seen_recently' || tp.category === 'case_study_pr') continue;
    const tpUrls = [tp.primaryUrl, ...(tp.discussionUrls ?? []), ...(tp.allObservedUrls ?? [])].filter(Boolean);
    if (tpUrls.some(u => publishedSet.has(safeCanonical(u)))) continue;

    const firstSeenDate = tp.firstSeenDate ?? reportDate;
    if (firstSeenDate < cutoff) continue;

    const isDeferredByLlm = deferredTopicIds.has(tp.topicId) || Boolean(tp.deferredByLlm);
    const score = tp.priorScore ?? 0;
    if (!isDeferredByLlm && score < minPrior) continue;

    // Persist any fetched or raw full text into durable backlog-articles cache so tomorrow needs 0 re-fetches!
    let cachedTextPath = null;
    const persistDir = tp._storeDir ? path.resolve(tp._storeDir) : null;
    if (tp.fetchedArticle?.rawTextPath && persistDir) {
      const srcFile = path.resolve(persistDir, tp.fetchedArticle.rawTextPath);
      if (fs.existsSync(srcFile)) {
        const destFile = path.join(cacheDir, `${sha12(tp.primaryUrl ?? tp.topicId)}.txt`);
        fs.copyFileSync(srcFile, destFile);
        cachedTextPath = destFile;
      }
    }

    const card0 = tp.cards?.[0] ?? {};
    let cardText = card0.tldr ?? '';
    if (card0.rawBodyPath && tp._storeDir) {
      const bodyFile = path.resolve(tp._storeDir, card0.rawBodyPath);
      if (fs.existsSync(bodyFile)) {
        const rawBody = fs.readFileSync(bodyFile, 'utf8').trim();
        if (rawBody.length >= 800 && !cachedTextPath) {
          const destFile = path.join(cacheDir, `${sha12(tp.primaryUrl ?? tp.topicId)}.txt`);
          fs.writeFileSync(destFile, rawBody + '\n', { mode: 0o600 });
          cachedTextPath = destFile;
        }
        cardText = rawBody.slice(0, 2000);
      }
    }

    candidates.push({
      id: sha12(tp.primaryUrl ?? tp.title ?? tp.topicId),
      title: tp.title,
      author: card0.author ?? 'unknown',
      category: tp.category,
      entities: tp.entities ?? [],
      primaryUrl: tp.primaryUrl,
      fetchedUrl: tp.fetchedArticle?.url ?? tp.primaryUrl,
      discussionUrls: (tp.discussionUrls ?? []).slice(0, 5),
      allObservedUrls: (tp.allObservedUrls ?? []).slice(0, 12),
      publishedAt: tp.publishedAt ?? null,
      ...(tp.paperPublishedAt ? { paperPublishedAt: tp.paperPublishedAt } : {}),
      firstSeenDate,
      lastUpdatedDate: reportDate,
      fanIn: tp.fanIn ?? 1,
      seenKeys: [...new Set(tp.candidateKeys ?? [])].slice(0, 20),
      sources: tp.sources ?? [],
      metrics: tp.metrics ?? {},
      contentStatus: cachedTextPath ? 'full_text' : tp.contentStatus,
      priorScore: score,
      deferredByLlm: isDeferredByLlm,
      deferredReason: deferredTopicIds.get(tp.topicId) ?? tp.deferredReason ?? null,
      tldr: card0.tldr ?? tp.title ?? '',
      cardText,
      ...(cachedTextPath ? { cachedTextPath } : {}),
    });
  }

  // Deduplicate by canonical primaryUrl and keep top `maxPoolSize` by score.
  const byUrl = new Map();
  for (const item of candidates.sort((a, b) => Number(b.deferredByLlm) - Number(a.deferredByLlm) || b.priorScore - a.priorScore)) {
    const key = safeCanonical(item.primaryUrl) ?? item.id;
    if (!byUrl.has(key)) byUrl.set(key, item);
  }
  const kept = [...byUrl.values()].slice(0, maxPoolSize);
  writeAtomicJson(poolFile, { schemaVersion: 1, updatedAt: new Date().toISOString(), date: reportDate, count: kept.length, items: kept });
  return { savedCount: kept.length, poolFile };
}
