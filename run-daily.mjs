#!/usr/bin/env node
// Portable v2 X Daily pipeline:
// Zero-bootstrap state -> Wide funnel (Browser + Feeds + Supplements) ->
// Dual-layer store (L0 Raw + L1 Cards + Topics + 7d soft dedup) ->
// Topic selection -> On-demand full-text fetch -> Two-tier digest composition ->
// Deterministic URL hygiene + single-pass review -> Self-check telemetry ->
// Feishu delivery (with guaranteed lark-cli failure alert fallback).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRuntime } from './runtime.mjs';
import { collectionFromBrowserArtifacts, verifyEvidenceFiles } from './browser-artifacts.mjs';
import { mergeFeedDocuments, verifyDocumentFiles } from './feed-import.mjs';
import { fetchFeeds } from './tools/fetch-feeds.mjs';
import { candidateKeys, canonicalUrl, citedUrls } from './binding.mjs';
import { bulletLine, renderLarkPost } from './lark-post.mjs';
import { loadModels, tagged, modelJson, extractBlock, parseJsonBlock, usageLedger, budgetGuard, makeStageRunner, outputStore } from './prototype/run-packets.mjs';
import {
  ensureWorkspace,
  acquireLeaseLock,
  loadSoftHistory,
  appendSoftHistory,
  hasAcceptedReceipt,
  appendAcceptedReceipt,
  collectSourceStatuses,
  updateSourceHealth,
  buildTelemetry,
  renderTelemetryMarkdown,
  formatAlertMarkdown,
  sendViaLarkCli,
} from './telemetry.mjs';
import {
  resolveCollectionShortlinks,
  buildContentStore,
  enrichTopicsWithFullText,
  loadTopicFullMaterial,
  buildAutoDispositions,
} from './content-store.mjs';
import {
  loadTasteConfig,
  scoreTopicPrior,
  loadBacklogPool,
  mergeBacklogIntoTopics,
  saveBacklogPool,
} from './curation.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const readPrompt = name => fs.readFileSync(path.join(repoRoot, 'prompts', name), 'utf8');
const shanghaiDate = (value = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const safeCanonical = href => {
  try { return canonicalUrl(href); } catch { return null; }
};

const FORBIDDEN_JARGON = /所给摘录|提供的材料|摘录(?:没有|未|中)|候选键/;
const CANONICAL_DEEP_ORDER = ['Frameworks / Infra', 'Breakthrough Research', 'Applications / Products', 'Long-form / Essays'];
const DEEP_SECTIONS = new Set(CANONICAL_DEEP_ORDER);
const QUICK_SECTION = 'Quick Hits / 快讯速览';

export function parseSelectedPlanPayload(payload, validTopicIds) {
  const list = Array.isArray(payload) ? payload : payload?.selected;
  if (!Array.isArray(list)) throw new Error('Expected {"selected": [...]}');
  const seen = new Set();
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    if (!validTopicIds.has(row.topicId) || seen.has(row.topicId)) continue;
    if (!['deep', 'quick'].includes(row.tier)) continue;
    seen.add(row.topicId);
    const section = row.tier === 'quick'
      ? QUICK_SECTION
      : (DEEP_SECTIONS.has(row.section) ? row.section : 'Frameworks / Infra');
    out.push({
      topicId: row.topicId,
      tier: row.tier,
      section,
      followUp: Boolean(row.followUp),
      reason: String(row.reason ?? '').trim(),
    });
  }
  if (!out.length) throw new Error('Topic selector returned 0 selected topics');
  const deferred = new Map();
  for (const d of Array.isArray(payload?.deferred) ? payload.deferred : []) {
    if (d && validTopicIds.has(d.topicId) && !seen.has(d.topicId)) {
      deferred.set(d.topicId, String(d.reason ?? 'High-value runner-up deferred for backlog').trim());
    }
  }
  out.deferredMap = deferred;
  return out;
}

function parseSelectionResponse(text, validTopicIds) {
  return parseSelectedPlanPayload(parseJsonBlock(text), validTopicIds);
}

function sectionForTopic(topic) {
  if (['infra_eng', 'open_source'].includes(topic.category)) return 'Frameworks / Infra';
  if (topic.category === 'paper') return 'Breakthrough Research';
  if (topic.category === 'essay') return 'Long-form / Essays';
  return 'Applications / Products';
}

function isQuickHitEligible(topic) {
  if (topic.category === 'paper') return false;
  if ((topic.sources ?? []).some(s => /daily\s*papers/i.test(s))) return false;
  if (/arxiv\.org|huggingface\.co\/papers|openreview\.net/i.test(topic.primaryUrl ?? '')) return false;
  return ['product', 'open_source', 'general'].includes(topic.category);
}

/**
 * Balanced, diversity-guarded heuristic topic selector:
 * 1. Reserves slots across all 4 Deep Dive sections (Infra, Research, Products, Essays) so
 *    a high-volume paper feed never crowds out Infra, Product launches, or Long-form essays.
 * 2. Caps any single feed/source (e.g., HF Daily Papers) at `maxPerSource` (default 2) in Deep Dive.
 * 3. Rewards cross-source/community resonance (`fanIn >= 2` or watch-account signals).
 * 4. Restricts `Quick Hits / 快讯速览` strictly to concise product updates, version releases,
 *    and brief ecosystem notes — research papers NEVER spill over into Quick Hits.
 */
export function selectTopicsHeuristic(topics, { maxDeep = 7, maxQuick = 4, maxPerSource = 2, taste = null } = {}) {
  const activeTaste = taste ?? loadTasteConfig();
  const eligible = topics.filter(t => t.dedupStatus !== 'seen_recently' && t.category !== 'case_study_pr');
  const scoreTopic = t => {
    // Category NEVER determines quality score; use the 4-signal Prior Score directly!
    if (Number.isFinite(t.priorScore)) return t.priorScore;
    return scoreTopicPrior(t, activeTaste).priorScore;
  };

  const ranked = eligible.slice().sort((a, b) => scoreTopic(b) - scoreTopic(a));
  const pickedIds = new Set();
  const sourceCounts = new Map();
  const deepSelected = [];

  const primaryFeedSource = t => (t.sources ?? []).find(s => s !== 'x' && !String(s).startsWith('watch:@')) ?? t.sources?.[0] ?? 'unknown';
  const vendorOf = t => {
    const entityRoot = String(t.entities?.[0] ?? '').split(/[\s-]/)[0].trim();
    if (entityRoot) return entityRoot.toLowerCase();
    try { return new URL(t.primaryUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { return primaryFeedSource(t); }
  };
  const canTakeFromSource = (t, relaxCap = false) => {
    const src = primaryFeedSource(t);
    if (src === 'x') return true;
    const limit = relaxCap ? maxPerSource + 1 : maxPerSource;
    return (sourceCounts.get(src) ?? 0) < limit;
  };
  const takeDeep = (t, reason) => {
    const src = primaryFeedSource(t);
    pickedIds.add(t.topicId);
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
    deepSelected.push({
      topicId: t.topicId,
      tier: 'deep',
      section: sectionForTopic(t),
      followUp: t.dedupStatus === 'follow_up_candidate',
      reason,
    });
  };

  // Pass 1: Guarantee representation across each non-empty editorial section (up to initial bucket quota).
  const sectionQuotas = [
    ['Frameworks / Infra', 2],
    ['Breakthrough Research', 2],
    ['Applications / Products', 1],
    ['Long-form / Essays', 1],
  ];
  const vendorDeepProduct = new Set();

  for (const [targetSection, quota] of sectionQuotas) {
    let count = 0;
    for (const t of ranked) {
      if (count >= quota || deepSelected.length >= maxDeep) break;
      if (pickedIds.has(t.topicId)) continue;
      if (sectionForTopic(t) !== targetSection) continue;
      if (!canTakeFromSource(t, false)) continue;
      // Avoid spending multiple Deep Dive slots on minor product launches from the same vendor.
      const vendor = vendorOf(t);
      if (t.category === 'product' && vendorDeepProduct.has(vendor)) continue;
      if (t.category === 'product') vendorDeepProduct.add(vendor);
      takeDeep(t, `Top signal in ${targetSection}`);
      count += 1;
    }
  }

  // Pass 2: Fill remaining Deep Dive slots by overall score while respecting per-source diversity cap.
  for (const relax of [false, true]) {
    for (const t of ranked) {
      if (deepSelected.length >= maxDeep) break;
      if (pickedIds.has(t.topicId)) continue;
      if (!canTakeFromSource(t, relax)) continue;
      const vendor = vendorOf(t);
      if (t.category === 'product' && vendorDeepProduct.has(vendor)) continue;
      if (t.category === 'product') vendorDeepProduct.add(vendor);
      takeDeep(t, 'High cross-source/technical signal');
    }
  }

  // Pass 3: Select Quick Hits strictly from concise product updates, SDK/tool releases, or brief notes (NEVER papers).
  const quickSelected = [];
  for (const t of ranked) {
    if (quickSelected.length >= maxQuick) break;
    if (pickedIds.has(t.topicId)) continue;
    if (!isQuickHitEligible(t)) continue;
    pickedIds.add(t.topicId);
    quickSelected.push({
      topicId: t.topicId,
      tier: 'quick',
      section: QUICK_SECTION,
      followUp: t.dedupStatus === 'follow_up_candidate',
      reason: 'Concise release or product update suitable for Quick Hits',
    });
  }

  return [...deepSelected, ...quickSelected];
}

/**
 * Reorders `## ` sections into canonical reader order:
 * Frameworks / Infra -> Breakthrough Research -> Applications / Products -> Long-form / Essays ->
 * any custom deep sections -> Quick Hits / 快讯速览 (always last before telemetry footer).
 */
export function normalizeDigestSectionOrder(markdown) {
  const lines = String(markdown ?? '').trim().split(/\r?\n/);
  if (!lines.length || !lines[0].startsWith('# ')) return String(markdown ?? '').trim();
  const headerLines = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const h2 = line.trim().match(/^##\s+(.+)$/);
    if (h2) {
      current = { name: h2[1].trim(), heading: `## ${h2[1].trim()}`, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      headerLines.push(line);
    }
  }
  if (sections.length <= 1) return lines.join('\n').trim();

  const rankOf = name => {
    if (name === QUICK_SECTION || /quick\s*hits|快讯/i.test(name)) return 100;
    const idx = CANONICAL_DEEP_ORDER.indexOf(name);
    return idx >= 0 ? idx : 50;
  };
  const ordered = sections
    .map((sec, idx) => ({ ...sec, idx, rank: rankOf(sec.name) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx);

  const out = [...headerLines.filter((l, i) => i === 0 || l.trim())];
  for (const sec of ordered) {
    const body = sec.lines.join('\n').trim();
    if (!body) continue;
    out.push('', sec.heading, '', body);
  }
  return out.join('\n').trim();
}

/**
 * Validates only essential reader-facing invariants:
 * 1. Correct date header
 * 2. Every main-body bullet carries at least one observed URL (zero hallucinated links)
 * 3. No leaked pipeline jargon ("所给摘录" etc.)
 * 4. Valid Feishu rich-text post rendering
 */
export function validateV2Digest(markdown, { date, observedUrlSet }) {
  const clean = String(markdown ?? '').trim();
  if (!clean.startsWith(`# X AI 日报 ${date}`)) {
    throw new Error(`Digest must start with "# X AI 日报 ${date}"`);
  }
  if (FORBIDDEN_JARGON.test(clean)) {
    const hit = clean.match(FORBIDDEN_JARGON)[0];
    throw new Error(`Digest leaked internal pipeline phrasing ("${hit}"); rewrite from public reader perspective`);
  }

  const lines = clean.split(/\r?\n/);
  let currentSection = null;
  let currentBullet = null;
  const bullets = [];
  const flushBullet = () => {
    if (currentBullet) bullets.push({ section: currentSection, text: currentBullet.join('\n') });
    currentBullet = null;
  };

  for (const raw of lines.slice(1)) {
    const trimmed = raw.trim();
    if (!trimmed) { flushBullet(); continue; }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) { flushBullet(); currentSection = h2[1].trim(); continue; }
    if (/^#{3,6}\s/.test(trimmed)) { flushBullet(); continue; }
    if (bulletLine.test(trimmed)) {
      flushBullet();
      currentBullet = [trimmed];
    } else if (currentBullet) {
      currentBullet.push(trimmed);
    }
  }
  flushBullet();

  if (!bullets.length) throw new Error('Digest contains 0 story bullets');

  const bulletSectionsByUrl = new Map();
  const allCited = [];
  for (const b of bullets) {
    const urls = citedUrls(b.text);
    if (!urls.length) throw new Error(`Bullet under "${b.section ?? 'header'}" is missing a direct source URL: ${b.text.slice(0, 80)}`);
    for (const u of urls) {
      const c = safeCanonical(u);
      if (!c || !observedUrlSet.has(c)) {
        throw new Error(`Unobserved or hallucinated URL in digest: ${u}`);
      }
      allCited.push(u);
      if (!bulletSectionsByUrl.has(c) && b.section) bulletSectionsByUrl.set(c, b.section);
    }
  }

  // Ensure Feishu native rich-text renderer accepts the exact Markdown.
  renderLarkPost(clean);

  const deepDiveCount = bullets.filter(b => b.section !== QUICK_SECTION).length;
  const quickHitsCount = bullets.filter(b => b.section === QUICK_SECTION).length;
  const extractedTitles = bullets.map(b => b.text.match(/\*\*([^*]+)\*\*/)?.[1] ?? b.text.slice(0, 60));

  return {
    bulletsCount: bullets.length,
    deepDiveCount,
    quickHitsCount,
    citedUrls: [...new Set(allCited)],
    bulletSectionsByUrl,
    extractedTitles,
  };
}

/**
 * Executes the end-to-end v2 daily digest workflow.
 * - Zero-bootstrap: initializes state automatically in `dataDir`.
 * - Resilient: degrades gracefully when individual feeds/pages fail; sends a `lark-cli`
 *   diagnostic alert card if an unrecoverable failure occurs so scheduled runs never fail silently.
 */
export async function runDailyV2({
  dataDir = './data',
  runDir: existingRunDir = null,
  sourcesConfig = null,
  sourcesFile = null,
  tasteFile = null,
  modelsFile = null,
  browserArtifactsPath = null,
  feedArtifactsPath = null,
  premergedSourcesPath = null,
  supplements = [],
  prepareOnly = false,
  selectedTopicsPath = null,
  finalizeDigestPath = null,
  larkConfig = null,
  lookbackHours = 48,
  fetchFeedsOnline = false,
  fetchFullTextOnline = true,
  resolveShortlinksOnline = null,
  allowSend = false,
  runtimeHooks = {},
} = {}) {
  const fetchImpl = runtimeHooks.fetch ?? globalThis.fetch;
  const spawnSyncImpl = runtimeHooks.spawnSync;
  const nowDate = runtimeHooks.now ? new Date(runtimeHooks.now) : new Date();
  const today = shanghaiDate(nowDate);

  const workspace = ensureWorkspace(dataDir);
  const lock = acquireLeaseLock(path.join(workspace.stateDir, 'run-daily.lock'), {
    stage: 'init',
    now: () => (runtimeHooks.now ? new Date(runtimeHooks.now).valueOf() : Date.now()),
  });
  const reclaimedLocks = lock.reclaimed ? [lock.reclaimed] : [];

  let currentStage = 'init';
  let runDir = null;
  let telemetry = null;

  try {
    // Idempotency check: if today's report was already delivered, exit cleanly without re-running.
    const priorReceipt = hasAcceptedReceipt(workspace.receiptsFile, today);
    if (priorReceipt && !runtimeHooks.forceRerun) {
      return {
        status: 'already_sent_today',
        date: today,
        messageId: priorReceipt.messageId,
        sentAt: priorReceipt.sentAt,
      };
    }

    const resolvedSources = sourcesConfig
      ?? (sourcesFile && fs.existsSync(sourcesFile)
        ? JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
        : JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'sources.json'), 'utf8')));
    const taste = loadTasteConfig(tasteFile);

    const usage = usageLedger();
    let collection = null;
    let reportDate = today;
    let storeDir = null;
    let storeCounts = null;
    let storeTopics = null;
    let trackedSources = null;
    let selectedPlan = null;
    let deferredMap = new Map();
    let backlogStats = { recalledStandalone: 0, accumulatedWithFresh: 0 };
    let deepFetchStats = null;
    let observedUrlSet = null;
    let warnings = [];
    let draftMarkdown = null;

    const hasPreparedState = Boolean(existingRunDir && fs.existsSync(path.join(existingRunDir, 'prepare-state.json')));
    const resumingFinalize = Boolean(hasPreparedState && finalizeDigestPath);
    const reselectingPreparedRun = Boolean(hasPreparedState && selectedTopicsPath && !finalizeDigestPath);

    if (resumingFinalize) {
      currentStage = 'load_prepared_run';
      lock.heartbeat(currentStage);
      runDir = path.resolve(existingRunDir);
      storeDir = path.join(runDir, 'store');
      collection = JSON.parse(fs.readFileSync(path.join(runDir, 'sources.merged.json'), 'utf8'));
      const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'prepare-state.json'), 'utf8'));
      reportDate = saved.reportDate || collection.date || today;
      trackedSources = saved.trackedSources;
      storeCounts = saved.counts;
      storeTopics = saved.topics;
      selectedPlan = saved.selectedPlan;
      deferredMap = new Map(saved.deferredEntries ?? []);
      backlogStats = saved.backlogStats ?? backlogStats;
      deepFetchStats = saved.deepFetchStats;
      observedUrlSet = new Set(saved.observedUrls ?? []);
      warnings = saved.warnings ?? [];
      draftMarkdown = fs.readFileSync(finalizeDigestPath, 'utf8');
    } else {
      if (reselectingPreparedRun) {
        currentStage = 'reselect_prepared_run';
        lock.heartbeat(currentStage);
        runDir = path.resolve(existingRunDir);
        storeDir = path.join(runDir, 'store');
        collection = JSON.parse(fs.readFileSync(path.join(runDir, 'sources.merged.json'), 'utf8'));
        const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'prepare-state.json'), 'utf8'));
        reportDate = saved.reportDate || collection.date || today;
        trackedSources = saved.trackedSources;
        storeCounts = saved.counts;
        storeTopics = saved.topics;
        backlogStats = saved.backlogStats ?? backlogStats;
        warnings = saved.warnings ?? [];
      } else {
        const stampSuffix = new Date().toISOString().replace(/[:.]/g, '-');
        runDir = existingRunDir
          ? path.resolve(existingRunDir)
          : fs.mkdtempSync(path.join(workspace.runsDir, `${today}-${stampSuffix.slice(11, 19)}-`));
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const runId = path.basename(runDir).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 80);
        const runtime = makeRuntime({ dataDir: workspace.root, lookbackHours, sources: resolvedSources }, { runId });

        // Stage 1: Collect / Import Browser + Feeds (with graceful degradation & cross-window skew tolerance)
        currentStage = 'collect_and_import';
        lock.heartbeat(currentStage);

        if (premergedSourcesPath) {
          collection = JSON.parse(fs.readFileSync(premergedSourcesPath, 'utf8'));
        } else {
          if (browserArtifactsPath && fs.existsSync(browserArtifactsPath)) {
            try {
              const bundle = JSON.parse(fs.readFileSync(browserArtifactsPath, 'utf8'));
              verifyEvidenceFiles(bundle, path.dirname(path.resolve(browserArtifactsPath)));
              collection = collectionFromBrowserArtifacts(runtime, bundle);
            } catch (err) {
              warnings.push(`Browser capture import degraded (${err.message}); continuing with remaining sources`);
            }
          }

          let activeFeedBundlePath = feedArtifactsPath;
          if (!activeFeedBundlePath && fetchFeedsOnline && Array.isArray(resolvedSources.feeds) && resolvedSources.feeds.length > 0) {
            try {
              const fetched = await fetchFeeds(resolvedSources, runDir, { fetchImpl, clock: () => nowDate });
              activeFeedBundlePath = fetched.output;
            } catch (err) {
              warnings.push(`Live feed fetch degraded (${err.message})`);
            }
          }

          if (activeFeedBundlePath && fs.existsSync(activeFeedBundlePath)) {
            try {
              const feedBundle = JSON.parse(fs.readFileSync(activeFeedBundlePath, 'utf8'));
              const baseDir = path.dirname(path.resolve(activeFeedBundlePath));
              verifyDocumentFiles(feedBundle, baseDir);
              collection = mergeFeedDocuments(runtime, collection, feedBundle, baseDir, {
                maxText: Infinity,
                maxSkewHours: lookbackHours,
              });
            } catch (err) {
              warnings.push(`Feed merge degraded (${err.message})`);
            }
          }
        }

        if (!collection && supplements.length > 0) {
          collection = {
            schemaVersion: 1,
            collectionId: runId,
            digestMarker: `<!-- x-daily-collection: ${runId} -->`,
            date: today,
            collectedAt: nowDate.toISOString(),
            checks: {},
            warnings,
            sources: { xFollowing: [], substack: [], watchProfiles: [], feeds: [], blogs: [], xiaohongshu: [], deepArticles: [] },
            stats: {},
          };
        }

        if (!collection) {
          throw new Error('No usable source inputs were collected (both browser capture and feeds failed or were empty)');
        }

        // Pre-resolve `t.co` shortlinks before building the store so X discussions sharing the same
        // external blog/paper/repo cluster together instead of staying fragmented as `fanIn = 1`.
        const shouldResolveShortlinks = resolveShortlinksOnline ?? fetchFullTextOnline;
        if (shouldResolveShortlinks) {
          currentStage = 'resolve_shortlinks';
          lock.heartbeat(currentStage);
          await resolveCollectionShortlinks(collection, { fetchImpl });
        }

        reportDate = collection.date || today;
        fs.writeFileSync(path.join(runDir, 'sources.merged.json'), JSON.stringify(collection, null, 2) + '\n', { mode: 0o600 });

        // Stage 2: Build Dual-Layer Content Store + Merge Rolling Backlog + 7-Day Soft Deduplication
        currentStage = 'build_content_store';
        lock.heartbeat(currentStage);
        const softHistory = loadSoftHistory(workspace.historyFile, { before: reportDate, days: 7 });
        warnings.push(...softHistory.warnings);

        storeDir = path.join(runDir, 'store');
        const storeResult = buildContentStore(collection, storeDir, { softHistory, supplements, taste });
        storeCounts = storeResult.counts;
        storeTopics = storeResult.topics;

        const loadedBacklog = loadBacklogPool(workspace.stateDir, {
          reportDate,
          softHistory,
          maxAgeDays: taste.backlog?.maxAgeDays ?? 7,
        });
        backlogStats = mergeBacklogIntoTopics(storeTopics, loadedBacklog.entries, storeDir, { taste, reportDate });
        storeCounts.topics = storeTopics.length;

        const sourceRows = collectSourceStatuses(collection, {
          configuredSources: resolvedSources,
          extraSources: supplements.length
            ? [{ id: 'supplements', label: 'Supplemental Mail/Docs', kind: 'mail', status: 'ok', items: supplements.length }]
            : [],
        });
        trackedSources = updateSourceHealth(workspace.healthFile, sourceRows, { date: reportDate });

        if (storeTopics.length === 0) {
          telemetry = buildTelemetry({
            date: reportDate,
            sources: trackedSources,
            funnel: { rawItems: storeCounts.rawItems, dedupSkipped7d: storeCounts.dedupSkipped7d, clusteredTopics: 0, screenSelectedTopics: 0, publishedTotal: 0 },
            warnings,
            reclaimedLocks,
          });
          fs.writeFileSync(path.join(runDir, 'telemetry.json'), JSON.stringify(telemetry, null, 2) + '\n', { mode: 0o600 });
          throw new Error('All collected sources yielded 0 candidate topics');
        }
      }

      // Stage 3: Topic Selection (Explicit file -> Model-driven -> Balanced bucketed heuristic)
      currentStage = 'select_topics';
      lock.heartbeat(currentStage);
      let runStage = null;
      let roles = null;
      if (modelsFile && !prepareOnly) {
        const loaded = loadModels(modelsFile, ['compose'], ['screen', 'review'], runtimeHooks);
        roles = loaded.roles;
        const stageStore = outputStore(path.join(runDir, 'model-artifacts'));
        fs.mkdirSync(path.join(runDir, 'model-artifacts'), { recursive: true, mode: 0o700 });
        runStage = makeStageRunner({ roles, store: stageStore, usage, budget: budgetGuard(loaded.budget) });
      }

      const sortedForSelection = storeTopics.slice().sort((a, b) => (b.priorScore ?? 0) - (a.priorScore ?? 0));
      const compactTopics = sortedForSelection.map(t => ({
        topicId: t.topicId,
        title: t.title,
        category: t.category,
        priorScore: t.priorScore ?? 0,
        curationSignals: t.curationSignals ?? null,
        fromBacklog: Boolean(t.fromBacklog),
        firstSeenDate: t.firstSeenDate ?? null,
        entities: t.entities,
        fanIn: t.fanIn,
        sources: t.sources,
        publishedAt: t.publishedAt,
        contentStatus: t.contentStatus,
        dedupStatus: t.dedupStatus,
        previouslyPublishedDate: t.previouslyPublishedDate ?? null,
        primaryUrl: t.primaryUrl,
        discussionUrls: (t.discussionUrls ?? []).slice(0, 3),
        tldr: t.cards?.[0]?.tldr ?? '',
      }));

      // Always write candidate-topics.json + host-select-prompt.md so a local host agent (Codex)
      // can inspect ALL clustered topics across X + Feeds and override selection if desired.
      const candidateTopicsPath = path.join(runDir, 'candidate-topics.json');
      const selectPromptPath = path.join(runDir, 'host-select-prompt.md');
      fs.writeFileSync(candidateTopicsPath, JSON.stringify(compactTopics, null, 2) + '\n', { mode: 0o600 });
      // For LLM Stage 2 screening, pass top 45 candidates sorted by Stage 1 priorScore so context stays high-signal!
      const screenShortlist = compactTopics.filter(t => t.dedupStatus !== 'seen_recently' && t.category !== 'case_study_pr').slice(0, 45);
      fs.writeFileSync(selectPromptPath, `${readPrompt('v2-select-topics.md')}\n\n${tagged('topics_json', modelJson(screenShortlist))}\n`, { mode: 0o600 });

      const validTopicIds = new Set(storeTopics.map(t => t.topicId));
      if (selectedTopicsPath) {
        const customRaw = JSON.parse(fs.readFileSync(selectedTopicsPath, 'utf8'));
        selectedPlan = parseSelectedPlanPayload(customRaw, validTopicIds);
        deferredMap = selectedPlan.deferredMap ?? new Map();
      } else if (runStage && roles?.screen) {
        selectedPlan = await runStage({
          stage: 'screen',
          label: 'v2-select-topics',
          system: readPrompt('v2-select-topics.md'),
          prompt: tagged('topics_json', modelJson(screenShortlist.length ? screenShortlist : compactTopics.slice(0, 45))),
          parse: text => parseSelectionResponse(text, validTopicIds),
        });
        deferredMap = selectedPlan.deferredMap ?? new Map();
      } else {
        selectedPlan = selectTopicsHeuristic(storeTopics, { taste });
      }

      if (!selectedPlan.length) {
        throw new Error('0 fresh high-signal topics remained after 7-day deduplication and PR filtering');
      }

      // Stage 4: On-Demand Full-Text Fetching for Selected Topics
      currentStage = 'enrich_full_text';
      lock.heartbeat(currentStage);
      const selectedIds = selectedPlan.map(s => s.topicId);
      deepFetchStats = fetchFullTextOnline
        ? await enrichTopicsWithFullText(storeTopics, storeDir, { topicIds: selectedIds, fetchImpl })
        : {
            attempted: selectedIds.length,
            fullText: storeTopics.filter(t => selectedIds.includes(t.topicId) && t.contentStatus === 'full_text').length,
            snippetOnly: storeTopics.filter(t => selectedIds.includes(t.topicId) && t.contentStatus !== 'full_text').length,
            failed: 0,
            degradedUrls: [],
          };

      // Assemble complete L0 materials & full observed URL allowlist
      const topicById = new Map(storeTopics.map(t => [t.topicId, t]));
      const selectedMaterials = selectedPlan.map(plan => ({
        ...plan,
        material: loadTopicFullMaterial(topicById.get(plan.topicId), storeDir),
      }));

      observedUrlSet = new Set();
      for (const t of storeTopics) {
        for (const u of [t.primaryUrl, ...(t.discussionUrls ?? []), ...(t.allObservedUrls ?? [])]) {
          const c = safeCanonical(u);
          if (c) observedUrlSet.add(c);
        }
      }

      const composeInput = tagged('digest_date', reportDate) + '\n\n' + tagged('selected_topics', modelJson(selectedMaterials));

      // Save prepared artifacts so a local host agent (Codex / Claude Code) can author the digest
      // without transmitting private browser captures to an external HTTP API.
      const preparedTopicsPath = path.join(runDir, 'prepared-topics.json');
      const composePromptPath = path.join(runDir, 'host-compose-prompt.md');
      const prepareStatePath = path.join(runDir, 'prepare-state.json');
      fs.writeFileSync(preparedTopicsPath, JSON.stringify(selectedMaterials, null, 2) + '\n', { mode: 0o600 });
      fs.writeFileSync(composePromptPath, `${readPrompt('v2-compose-digest.md')}\n\n${composeInput}\n`, { mode: 0o600 });
      fs.writeFileSync(prepareStatePath, JSON.stringify({
        schemaVersion: 1,
        reportDate,
        trackedSources,
        counts: storeCounts,
        topics: storeTopics,
        selectedPlan,
        deferredEntries: [...deferredMap.entries()],
        backlogStats,
        deepFetchStats,
        observedUrls: [...observedUrlSet],
        warnings,
      }, null, 2) + '\n', { mode: 0o600 });

      if (prepareOnly) {
        return {
          status: 'prepared_for_host_compose',
          date: reportDate,
          runDir,
          storeDir,
          candidateTopicsPath,
          selectPromptPath,
          preparedTopicsPath,
          composePromptPath,
          rawItems: storeCounts.rawItems,
          backlogRecalled: backlogStats.recalledStandalone,
          backlogAccumulated: backlogStats.accumulatedWithFresh,
          clusteredTopics: storeCounts.topics,
          selectedTopics: selectedPlan.length,
          deepFetch: deepFetchStats,
          warnings,
        };
      }

      if (finalizeDigestPath) {
        draftMarkdown = fs.readFileSync(finalizeDigestPath, 'utf8');
      } else {
        // Stage 5: Compose Two-Tier Digest from Complete L0 Materials
        currentStage = 'compose_digest';
        lock.heartbeat(currentStage);
        if (!runStage) {
          throw new Error('Supply --models models.json for API composition, or use --prepare-only then --finalize-digest DRAFT.md');
        }

        draftMarkdown = await runStage({
          stage: 'compose',
          label: 'v2-compose',
          system: readPrompt('v2-compose-digest.md'),
          prompt: composeInput,
          parse: text => {
            const md = extractBlock(text, 'markdown');
            validateV2Digest(md, { date: reportDate, observedUrlSet });
            return md;
          },
        });

        // Stage 6: Optional Single-Pass Technical & Style Review (replaces 4-call rigid loop)
        if (roles?.review) {
          currentStage = 'review_digest';
          lock.heartbeat(currentStage);
          const reviewOutcome = await runStage({
            stage: 'review',
            label: 'v2-review',
            system: readPrompt('v2-review-digest.md'),
            prompt: tagged('draft_markdown', draftMarkdown) + '\n\n' + tagged('selected_topics', modelJson(selectedMaterials)),
            parse: text => {
              const parsed = parseJsonBlock(text);
              if (!['pass', 'revise'].includes(parsed?.verdict)) throw new Error('verdict must be pass or revise');
              if (parsed.verdict === 'revise') {
                if (typeof parsed.revisedMarkdown !== 'string' || !parsed.revisedMarkdown.trim()) {
                  throw new Error('revise verdict requires non-empty revisedMarkdown');
                }
                validateV2Digest(parsed.revisedMarkdown, { date: reportDate, observedUrlSet });
              }
              return parsed;
            },
          });
          if (reviewOutcome.verdict === 'revise' && reviewOutcome.revisedMarkdown) {
            draftMarkdown = reviewOutcome.revisedMarkdown.trim();
          }
        }
      }
    }

    currentStage = 'validate_digest';
    lock.heartbeat(currentStage);
    draftMarkdown = normalizeDigestSectionOrder(draftMarkdown);
    const digestStats = validateV2Digest(draftMarkdown, { date: reportDate, observedUrlSet });

    // Stage 7: Auto-generate dispositions + Update Rolling High-Value Backlog + Self-Check Telemetry Panel
    currentStage = 'finalize_artifacts';
    lock.heartbeat(currentStage);
    const autoDispositions = buildAutoDispositions({
      collectionId: collection.collectionId,
      candidateKeys: candidateKeys(collection),
      topics: storeTopics,
      citedUrls: digestStats.citedUrls,
      bulletSectionsByUrl: digestStats.bulletSectionsByUrl,
    });
    fs.writeFileSync(path.join(runDir, 'dispositions.json'), JSON.stringify(autoDispositions, null, 2) + '\n', { mode: 0o600 });

    const citedCanonicalSet = new Set(digestStats.citedUrls.map(safeCanonical).filter(Boolean));
    const publishedFromBacklog = storeTopics.filter(tp =>
      tp.fromBacklog &&
      [tp.primaryUrl, ...(tp.discussionUrls ?? []), ...(tp.allObservedUrls ?? [])]
        .filter(Boolean)
        .some(u => citedCanonicalSet.has(safeCanonical(u))),
    ).length;

    const persistBacklog = Boolean((allowSend && larkConfig?.enabled === true) || runtimeHooks.recordHistoryOnLocalRun || runtimeHooks.persistBacklogOnLocalRun !== false);
    let savedBacklogCount = 0;
    if (persistBacklog) {
      for (const tp of storeTopics) tp._storeDir = storeDir;
      const savedPool = saveBacklogPool(workspace.stateDir, {
        reportDate,
        topics: storeTopics,
        citedUrls: digestStats.citedUrls,
        deferredTopicIds: deferredMap,
        taste,
      });
      for (const tp of storeTopics) delete tp._storeDir;
      savedBacklogCount = savedPool.savedCount;
    }

    telemetry = buildTelemetry({
      date: reportDate,
      sources: trackedSources,
      funnel: {
        rawItems: storeCounts.rawItems,
        backlogRecalled: backlogStats.recalledStandalone,
        backlogAccumulated: backlogStats.accumulatedWithFresh,
        backlogSaved: savedBacklogCount,
        dedupSkipped7d: storeCounts.dedupSkipped7d,
        dedupFollowUps: storeCounts.dedupFollowUps,
        clusteredTopics: storeCounts.topics,
        screenSelectedTopics: selectedPlan.length,
        deepFetch: deepFetchStats,
        publishedDeepDive: digestStats.deepDiveCount,
        publishedQuickHits: digestStats.quickHitsCount,
        publishedFromBacklog,
        publishedTotal: digestStats.bulletsCount,
      },
      stageUsage: usage.report(),
      warnings,
      reclaimedLocks,
    });
    fs.writeFileSync(path.join(runDir, 'telemetry.json'), JSON.stringify(telemetry, null, 2) + '\n', { mode: 0o600 });

    const telemetryPanel = renderTelemetryMarkdown(telemetry);
    const finalMarkdown = `${draftMarkdown.trim()}\n\n${telemetryPanel}\n`;
    renderLarkPost(finalMarkdown);
    fs.writeFileSync(path.join(runDir, 'digest.md'), finalMarkdown, { mode: 0o600 });

    // Stage 8: Deliver via lark-cli (when enabled & authorized) + update 7-day soft history
    currentStage = 'deliver';
    lock.heartbeat(currentStage);
    let delivery = { sent: false, status: 'local_only_send_not_requested' };
    const idempotencyKey = `xdaily-v2-${reportDate}`;

    if (allowSend && larkConfig?.enabled === true) {
      delivery = sendViaLarkCli(finalMarkdown, larkConfig, { idempotencyKey, spawnSyncImpl });
      if (!delivery.sent) {
        throw new Error(`Feishu digest delivery failed (${delivery.status}): ${delivery.error ?? 'unknown error'}`);
      }
      appendAcceptedReceipt(workspace.receiptsFile, {
        date: reportDate,
        messageId: delivery.messageId,
        chatId: larkConfig.chatId ?? null,
        userId: larkConfig.userId ?? null,
      });
      appendSoftHistory(workspace.historyFile, {
        date: reportDate,
        idempotencyKey,
        urls: digestStats.citedUrls,
        titles: digestStats.extractedTitles,
      });
    } else if (runtimeHooks.recordHistoryOnLocalRun) {
      appendSoftHistory(workspace.historyFile, {
        date: reportDate,
        idempotencyKey,
        urls: digestStats.citedUrls,
        titles: digestStats.extractedTitles,
      });
    }

    return {
      status: delivery.sent ? 'completed_and_sent' : 'completed_local',
      date: reportDate,
      runDir,
      digestPath: path.join(runDir, 'digest.md'),
      telemetryPath: path.join(runDir, 'telemetry.json'),
      storeDir,
      overallHealth: telemetry.overallHealth,
      funnel: telemetry.funnel,
      delivery,
    };
  } catch (error) {
    // Guaranteed visibility: never fail silently when lark-cli is configured.
    const alertMarkdown = formatAlertMarkdown({
      date: today,
      stage: currentStage,
      error,
      runDir,
      telemetry,
    });
    if (runDir && fs.existsSync(runDir)) {
      fs.writeFileSync(path.join(runDir, 'alert.md'), alertMarkdown, { mode: 0o600 });
    }
    let alertDelivery = { sent: false, status: 'alert_not_configured' };
    if (allowSend && larkConfig?.enabled === true) {
      alertDelivery = sendViaLarkCli(alertMarkdown, larkConfig, {
        idempotencyKey: `xdaily-alert-${today}-${currentStage}`,
        spawnSyncImpl,
      });
    }
    const wrapped = new Error(`[${currentStage}] ${error?.message ?? error}`);
    wrapped.stage = currentStage;
    wrapped.runDir = runDir;
    wrapped.alertMarkdown = alertMarkdown;
    wrapped.alertDelivery = alertDelivery;
    throw wrapped;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flagValue = (flag, fallback = null) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--') ? argv[idx + 1] : fallback;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(JSON.stringify({
      usage: 'node run-daily.mjs [--data-dir ./data] [--run-dir EXISTING_RUN] [--sources config/sources.json] [--models models.json] [--browser-artifacts browser-capture.json] [--feed-artifacts feed-capture.json] [--fetch-feeds] [--no-fetch-fulltext] [--prepare-only] [--selected-topics selected.json] [--finalize-digest draft.md] [--lark-config runtime.local.json] [--allow-send]',
    }, null, 2));
    process.exit(0);
  }
  const larkConfigFile = flagValue('--lark-config');
  const larkConfig = larkConfigFile && fs.existsSync(larkConfigFile)
    ? JSON.parse(fs.readFileSync(larkConfigFile, 'utf8')).lark
    : null;
  try {
    const result = await runDailyV2({
      dataDir: flagValue('--data-dir', './data'),
      runDir: flagValue('--run-dir'),
      sourcesFile: flagValue('--sources'),
      modelsFile: flagValue('--models'),
      browserArtifactsPath: flagValue('--browser-artifacts'),
      feedArtifactsPath: flagValue('--feed-artifacts'),
      prepareOnly: argv.includes('--prepare-only'),
      selectedTopicsPath: flagValue('--selected-topics'),
      finalizeDigestPath: flagValue('--finalize-digest'),
      fetchFeedsOnline: argv.includes('--fetch-feeds'),
      fetchFullTextOnline: !argv.includes('--no-fetch-fulltext'),
      larkConfig,
      allowSend: argv.includes('--allow-send') && process.env.X_DAILY_ALLOW_SEND === '1',
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: error.stage ?? 'unknown',
      error: error.message,
      runDir: error.runDir ?? null,
      alertDelivery: error.alertDelivery ?? null,
    }, null, 2));
    process.exitCode = 1;
  }
}
