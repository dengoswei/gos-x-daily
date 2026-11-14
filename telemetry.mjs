// Zero-bootstrap state, lease locks, source health tracking, funnel telemetry,
// self-check digest panel and local failure diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalUrl } from './binding.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 45 * 60 * 1000;
const iso = (value = new Date()) => new Date(value).toISOString();
const shanghaiDate = (value = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

const safeCanonical = href => {
  if (typeof href !== 'string' || !href.trim()) return null;
  try { return canonicalUrl(href); } catch { return null; }
};

/** Normalize title/topic text into a lightweight fingerprint for soft 7-day dedup. */
export function topicFingerprint(text) {
  if (typeof text !== 'string') return '';
  const cleaned = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).slice(0, 12).join(' ');
}

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

/**
 * Zero-bootstrap workspace initialization. Creates state/ and runs/ automatically
 * on a fresh machine without requiring manual init-delivery-ledger or authority files.
 */
export function ensureWorkspace(dataDir) {
  const root = path.resolve(dataDir ?? './data');
  const stateDir = path.join(root, 'state');
  const runsDir = path.join(root, 'runs');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const historyFile = path.join(stateDir, 'published-history.jsonl');
  const healthFile = path.join(stateDir, 'source-health.json');
  const receiptsFile = path.join(stateDir, 'delivery-receipts.jsonl');
  if (!fs.existsSync(healthFile)) {
    writeAtomicJson(healthFile, { schemaVersion: 1, updatedAt: null, sources: {} });
  }
  return { root, stateDir, runsDir, historyFile, healthFile, receiptsFile };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * Lease-based lock that reclaims dead PIDs or expired leases instead of permanently
 * wedging future scheduled occurrences.
 */
export function acquireLeaseLock(lockPath, { stage = 'run', leaseMs = DEFAULT_LEASE_MS, now = () => Date.now(), pid = process.pid, hostname = os.hostname() } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const currentMs = now();
  const payload = () => JSON.stringify({
    pid, hostname, stage,
    startedAt: iso(currentMs),
    expiresAt: iso(currentMs + leaseMs),
  }, null, 2) + '\n';

  let reclaimed = null;
  try {
    fs.writeFileSync(lockPath, payload(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { existing = { corrupt: true }; }
    const expiresMs = Date.parse(existing?.expiresAt ?? '');
    const expired = !Number.isFinite(expiresMs) || currentMs >= expiresMs;
    const sameHostDead = existing?.hostname === hostname && !isProcessAlive(existing?.pid);
    if (!expired && !sameHostDead && !existing?.corrupt) {
      throw new Error(`Active lease lock held by pid=${existing.pid} on ${existing.hostname} (stage=${existing.stage}, expiresAt=${existing.expiresAt})`);
    }
    const staleArchive = `${lockPath}.stale-${currentMs}-${randomUUID().slice(0, 8)}`;
    try {
      fs.renameSync(lockPath, staleArchive);
      reclaimed = { reason: existing?.corrupt ? 'corrupt_lock' : sameHostDead ? 'dead_pid' : 'lease_expired', previous: existing, archivedTo: staleArchive };
    } catch (renameErr) {
      if (renameErr?.code !== 'ENOENT') throw renameErr;
    }
    fs.writeFileSync(lockPath, payload(), { flag: 'wx', mode: 0o600 });
  }

  let released = false;
  return {
    lockPath,
    reclaimed,
    heartbeat(nextStage = stage) {
      if (released) return;
      const t = now();
      writeAtomicJson(lockPath, { pid, hostname, stage: nextStage, startedAt: iso(currentMs), updatedAt: iso(t), expiresAt: iso(t + leaseMs) });
    },
    release() {
      if (released) return;
      released = true;
      try { fs.unlinkSync(lockPath); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    },
  };
}

/**
 * Reads published history within [before - days, before). Returns empty history on a
 * fresh machine and tolerates corrupt lines with warnings instead of crashing the run.
 */
export function loadSoftHistory(historyFile, { before = shanghaiDate(), days = 7, extraFiles = [] } = {}) {
  const urls = new Map();
  const fingerprints = new Map();
  const warnings = [];
  const cutoff = new Date(Date.parse(before) - days * DAY_MS).toISOString().slice(0, 10);

  for (const file of [historyFile, ...extraFiles].filter(Boolean)) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch {
        warnings.push(`Ignored malformed history line ${index + 1} in ${path.basename(file)}`);
        continue;
      }
      const date = row?.date;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (date < cutoff || date >= before) continue;
      for (const rawUrl of Array.isArray(row.urls) ? row.urls : []) {
        const canonical = safeCanonical(rawUrl);
        if (canonical && (!(urls.get(canonical) >= date))) urls.set(canonical, date);
      }
      for (const title of Array.isArray(row.titles) ? row.titles : []) {
        const fp = topicFingerprint(title);
        if (fp && fp.length >= 10 && (!(fingerprints.get(fp) >= date))) fingerprints.set(fp, date);
      }
    }
  }
  return {
    cutoff,
    before,
    urls,
    fingerprints,
    warnings,
    hasUrl: href => {
      const c = safeCanonical(href);
      return c ? urls.get(c) ?? null : null;
    },
    hasTitle: title => {
      const fp = topicFingerprint(title);
      return fp ? fingerprints.get(fp) ?? null : null;
    },
    toRecentEntries: () => {
      const byDate = new Map();
      for (const [url, date] of urls) {
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(url);
      }
      return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, urls: list }));
    },
  };
}

export function appendSoftHistory(historyFile, { date, idempotencyKey = null, urls = [], titles = [], now = iso() } = {}) {
  fs.mkdirSync(path.dirname(historyFile), { recursive: true, mode: 0o700 });
  const cleanUrls = [...new Set(urls.map(safeCanonical).filter(Boolean))];
  const cleanTitles = [...new Set(titles.map(t => String(t ?? '').trim()).filter(Boolean))];
  const record = { date, ...(idempotencyKey ? { idempotencyKey } : {}), urls: cleanUrls, titles: cleanTitles, recordedAt: now };
  fs.appendFileSync(historyFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

export function hasAcceptedReceipt(receiptsFile, date) {
  if (!receiptsFile || !fs.existsSync(receiptsFile)) return null;
  for (const line of fs.readFileSync(receiptsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.date === date && row?.status === 'sent' && row?.messageId) return row;
    } catch { /* ignore */ }
  }
  return null;
}

export function appendAcceptedReceipt(receiptsFile, { date, messageId, chatId = null, userId = null, now = iso() }) {
  fs.mkdirSync(path.dirname(receiptsFile), { recursive: true, mode: 0o700 });
  const row = { date, status: 'sent', messageId, ...(chatId ? { chatId } : {}), ...(userId ? { userId } : {}), sentAt: now };
  fs.appendFileSync(receiptsFile, JSON.stringify(row) + '\n', { mode: 0o600 });
  return row;
}

/**
 * Extracts normalized per-source status records from a collection (browser + feeds + supplements).
 */
// Past this age a feed's newest entry suggests a moved or abandoned feed URL rather than a quiet author.
const DEFAULT_FEED_STALE_DAYS = 120;

export function collectSourceStatuses(collection, { configuredSources = null, extraSources = [] } = {}) {
  const rows = [];
  const checks = collection?.checks ?? {};
  const stats = collection?.stats ?? {};
  const reports = collection?.coverage?.reports ?? {};

  if (configuredSources?.xFollowing !== false && (checks.xFollowing || (collection?.sources?.xFollowing?.length ?? 0) > 0)) {
    const xCheck = checks.xFollowing ?? { attempted: true, status: 'ok', items: collection.sources.xFollowing.length };
    const items = collection?.sources?.xFollowing?.length ?? xCheck.items ?? 0;
    const xReports = Array.isArray(reports.xFollowing) ? reports.xFollowing : [];
    const dates = (collection?.sources?.xFollowing ?? []).map(item => Date.parse(item?.publishedAt ?? '')).filter(Number.isFinite);
    const windowEnd = Date.parse(collection?.coverage?.digestWindow?.end ?? collection?.collectedAt ?? '');
    const oldest = dates.length ? Math.min(...dates) : null;
    const observedSpanHours = oldest !== null && Number.isFinite(windowEnd) && windowEnd >= oldest
      ? Number(((windowEnd - oldest) / 3600000).toFixed(1))
      : null;
    const stopReason = xReports.at(-1)?.reason ?? null;
    const status = xCheck.attempted === false ? 'unattempted'
      : xCheck.status !== 'ok' ? 'failed'
      : items === 0 ? 'empty'
      : (stopReason && !['time_boundary', 'explicit_empty', 'observed_end'].includes(stopReason)) ? 'partial' : 'ok';
    rows.push({
      id: 'xFollowing',
      label: 'X Following',
      kind: 'x',
      required: false,
      status,
      items,
      ...(observedSpanHours !== null ? { observedSpanHours } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(xCheck.status && xCheck.status !== 'ok' ? { error: xCheck.status } : {}),
    });
  } else if (configuredSources && configuredSources.xFollowing !== false) {
    rows.push({ id: 'xFollowing', label: 'X Following', kind: 'x', required: false, status: 'unattempted', items: 0 });
  }

  const watchMap = checks.watch ?? {};
  const configuredWatch = configuredSources?.watchProfiles ?? collection?.sources?.watchProfiles ?? [];
  for (const profile of configuredWatch) {
    const handle = profile.handle;
    const check = watchMap[handle];
    const items = check?.items ?? (profile.items?.length ?? 0);
    const status = !check || check.attempted === false ? 'unattempted'
      : check.status !== 'ok' ? 'failed'
      : items === 0 ? 'empty' : 'ok';
    rows.push({
      id: `watch:${handle}`,
      label: `Watch @${handle}`,
      kind: 'watch',
      status,
      items,
      ...(check?.status && check.status !== 'ok' ? { error: check.status } : {}),
    });
  }

  if (checks.substack) {
    const s = checks.substack;
    rows.push({
      id: 'substack',
      label: 'Substack',
      kind: 'substack',
      status: s.attempted === false ? 'unattempted' : s.status !== 'ok' ? 'failed' : (s.items ?? 0) === 0 ? 'empty' : 'ok',
      items: s.items ?? 0,
      ...(s.status && s.status !== 'ok' ? { error: s.status } : {}),
    });
  }

  const feedChecks = checks.feeds ?? {};
  const configuredFeeds = configuredSources?.feeds ?? [];
  const feedNames = [...new Set([...configuredFeeds.map(f => f.name), ...Object.keys(feedChecks)])];
  const warningText = (collection?.warnings ?? []).join('\n');
  for (const name of feedNames) {
    const f = feedChecks[name];
    const errMatch = warningText.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} fetch failed: (.+)`));
    const status = !f || f.attempted === false || f.status === 'not_fetched' ? 'unattempted'
      : f.status === 'ok' ? ((f.items ?? 0) === 0 ? 'empty' : 'ok') : 'failed';
    rows.push({
      id: `feed:${name}`,
      label: name,
      kind: 'feed',
      status,
      items: f?.items ?? 0,
      ...(f?.newestEntryAt && Number.isFinite(Date.parse(f.newestEntryAt)) ? {
        newestEntryAt: f.newestEntryAt,
        newestEntryAgeDays: Math.max(0, Math.floor((Date.parse(collection?.collectedAt ?? collection?.provenance?.startedAt ?? new Date().toISOString()) - Date.parse(f.newestEntryAt)) / 86400000)),
        staleAfterDays: f.staleAfterDays ?? DEFAULT_FEED_STALE_DAYS,
      } : {}),
      ...(errMatch ? { error: errMatch[1].trim() } : f?.status && f.status !== 'ok' ? { error: f.status } : {}),
    });
  }

  const blogChecks = checks.blogs ?? {};
  const configuredBlogs = configuredSources?.blogs ?? [];
  const capturedBlogs = collection?.sources?.blogs ?? [];
  const blogNames = [...new Set([...configuredBlogs.map(b => b.name), ...Object.keys(blogChecks), ...capturedBlogs.map(b => b.blog).filter(Boolean)])];
  for (const name of blogNames) {
    const b = blogChecks[name];
    const count = b?.items ?? capturedBlogs.filter(item => item.blog === name).length;
    const status = b
      ? (b.attempted === false ? 'unattempted' : ['failed', 'articles_failed'].includes(b.status) ? 'failed' : count === 0 ? 'empty' : 'ok')
      : (count > 0 ? 'ok' : 'unattempted');
    rows.push({
      id: `blog:${name}`,
      label: name,
      kind: 'blog',
      status,
      items: count,
      ...(b?.status && ['failed', 'articles_failed'].includes(b.status) ? { error: b.status } : {}),
    });
  }

  const xhsProfiles = configuredSources?.xiaohongshuProfiles ?? [];
  const capturedXhs = collection?.sources?.xiaohongshu ?? [];
  for (const profile of xhsProfiles) {
    const match = capturedXhs.find(p => p.profileId === profile.profileId);
    rows.push({
      id: `xhs:${profile.profileId}`,
      label: `小红书 ${profile.name ?? profile.profileId}`,
      kind: 'xhs',
      status: match ? ((match.notes?.length ?? 0) > 0 ? 'ok' : 'empty') : 'unattempted',
      items: match?.notes?.length ?? 0,
    });
  }

  if ((stats.deepArticles ?? 0) > 0) {
    rows.push({ id: 'deepArticles', label: 'Browser Deep Reads', kind: 'supplement', status: 'ok', items: stats.deepArticles });
  }

  for (const extra of extraSources) {
    if (extra && typeof extra.id === 'string') rows.push(extra);
  }
  return rows;
}

/**
 * Updates persistent rolling source health (consecutive failures, last success date)
 * so silent multi-day auth expiry or broken RSS feeds surface with clear magnitudes.
 */
export function updateSourceHealth(healthFile, sourceRows, { date = shanghaiDate(), now = iso() } = {}) {
  let state = { schemaVersion: 1, updatedAt: null, sources: {} };
  if (healthFile && fs.existsSync(healthFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      if (parsed && typeof parsed.sources === 'object') state = parsed;
    } catch { /* rebuild corrupt health file */ }
  }

  const enriched = sourceRows.map(row => {
    const prev = state.sources[row.id] ?? { consecutiveFailures: 0, consecutiveZeroYield: 0, lastOkDate: null, lastStatus: null };
    const isFailure = row.status === 'failed';
    const isUsable = ['ok', 'partial', 'empty'].includes(row.status);
    // Idempotent within the same report date: re-running the same day does not inflate consecutive day counts.
    const sameDate = prev.lastCheckedDate === date;
    const consecutiveFailures = isFailure
      ? (sameDate ? Math.max(1, prev.consecutiveFailures) : prev.consecutiveFailures + 1)
      : (isUsable ? 0 : prev.consecutiveFailures);
    const consecutiveZeroYield = row.items === 0 && row.status !== 'unattempted'
      ? (sameDate ? Math.max(1, prev.consecutiveZeroYield ?? 0) : (prev.consecutiveZeroYield ?? 0) + 1)
      : (row.items > 0 ? 0 : (prev.consecutiveZeroYield ?? 0));
    const lastOkDate = isUsable && row.items > 0 ? date : prev.lastOkDate;

    state.sources[row.id] = {
      label: row.label,
      kind: row.kind,
      lastCheckedDate: date,
      lastStatus: row.status,
      lastItems: row.items,
      lastError: row.error ?? null,
      consecutiveFailures,
      consecutiveZeroYield,
      lastOkDate,
    };
    return {
      ...row,
      consecutiveFailures,
      consecutiveZeroYield,
      lastOkDate,
      actionNeeded: consecutiveFailures >= 2 || (row.error === 'login_required'),
    };
  });

  state.updatedAt = now;
  if (healthFile) writeAtomicJson(healthFile, state);
  return enriched;
}

function summarizeSourceList(rows, max = 4) {
  const labels = rows.map(r => r.label || r.id).filter(Boolean);
  if (labels.length <= max) return labels.join('、');
  return `${labels.slice(0, max).join('、')} 等 ${labels.length} 项`;
}

/**
 * Computes overall health verdict [OK | WARN | ACTION_NEEDED], funnel drop-off numbers,
 * and concrete recommendations for humans or calling agents.
 */
export function buildTelemetry({ date = shanghaiDate(), sources = [], funnel = {}, stageUsage = null, warnings = [], reclaimedLocks = [] } = {}) {
  const attempted = sources.filter(s => s.status !== 'unattempted');
  const usable = attempted.filter(s => ['ok', 'partial', 'empty'].includes(s.status));
  const failed = sources.filter(s => s.status === 'failed');
  const unattempted = sources.filter(s => s.status === 'unattempted');

  const recommendations = [];
  if (unattempted.length > 0) {
    recommendations.push({
      level: 'WARN',
      target: 'unattempted_sources',
      label: '未尝试信源',
      reason: `计划信源中有 ${unattempted.length}/${sources.length} 项本次未尝试（${summarizeSourceList(unattempted)}），当前非全源覆盖`,
    });
  }
  for (const s of sources) {
    if (s.error === 'login_required' || s.consecutiveFailures >= 2) {
      recommendations.push({
        level: 'ACTION_NEEDED',
        target: s.id,
        label: s.label,
        reason: `${s.label} 失败 (${s.error ?? 'error'})${s.consecutiveFailures > 1 ? `，已连续 ${s.consecutiveFailures} 天` : ''}`,
      });
    } else if (s.status === 'failed') {
      recommendations.push({
        level: 'WARN',
        target: s.id,
        label: s.label,
        reason: `${s.label} 本次抓取失败 (${s.error ?? 'error'})`,
      });
    }
  }

  const staleFeeds = sources.filter(s => s.kind === 'feed' && Number.isFinite(s.newestEntryAgeDays) && s.newestEntryAgeDays > (s.staleAfterDays ?? DEFAULT_FEED_STALE_DAYS));
  if (staleFeeds.length > 0) {
    recommendations.push({
      level: 'WARN',
      target: 'stale_feeds',
      label: '疑似失效 Feed',
      reason: `${staleFeeds.map(s => `${s.label}（最新条目距今 ${s.newestEntryAgeDays} 天）`).join('、')}：feed 地址可能已迁移或停更`,
    });
  }

  const xRow = sources.find(s => s.id === 'xFollowing');
  if (xRow && xRow.status === 'partial' && Number.isFinite(xRow.observedSpanHours) && xRow.observedSpanHours < 36) {
    recommendations.push({
      level: 'WARN',
      target: 'xFollowing',
      label: 'X Following',
      reason: `X Following 观察帖子时间跨度约 ${xRow.observedSpanHours}h（于 ${xRow.stopReason ?? '采集上限'} 停止，非连续完整遍历，遗漏帖数未知）`,
    });
  }

  const deepFetch = funnel.deepFetch ?? { attempted: 0, fullText: 0, snippetOnly: 0, failed: 0 };
  if (deepFetch.attempted > 0 && deepFetch.failed / deepFetch.attempted >= 0.5) {
    recommendations.push({
      level: 'ACTION_NEEDED',
      target: 'deepFetch',
      label: '原文全文提取',
      reason: `入选话题全文抓取失败率过高 (${deepFetch.failed}/${deepFetch.attempted})，多数条目退化为短摘要写作`,
    });
  }

  const publishedTotal = funnel.publishedTotal ?? ((funnel.publishedDeepDive ?? 0) + (funnel.publishedQuickHits ?? 0));
  if (publishedTotal === 0) {
    recommendations.push({
      level: 'ACTION_NEEDED',
      target: 'pipeline',
      label: '产出为空',
      reason: '最终成稿条目数为 0，请检查信源可用性与筛选阈值',
    });
  }

  for (const lock of reclaimedLocks) {
    if (lock) {
      recommendations.push({
        level: 'WARN',
        target: 'lock',
        label: '过期运行锁回收',
        reason: `自动回收上次未正常退出的运行锁 (${lock.reason})`,
      });
    }
  }

  const hasAction = recommendations.some(r => r.level === 'ACTION_NEEDED') || usable.length === 0;
  const hasWarn = !hasAction && (recommendations.length > 0 || failed.length > 0 || unattempted.length > 0 || (deepFetch.failed ?? 0) > 0);
  const overallHealth = hasAction ? 'ACTION_NEEDED' : hasWarn ? 'WARN' : 'OK';

  return {
    schemaVersion: 1,
    date,
    generatedAt: iso(),
    overallHealth,
    sourceSummary: {
      configured: sources.length,
      attempted: attempted.length,
      usable: usable.length,
      failed: failed.length,
      unattempted: unattempted.length,
    },
    sources,
    funnel: {
      rawItems: funnel.rawItems ?? 0,
      backlogRecalled: funnel.backlogRecalled ?? 0,
      backlogAccumulated: funnel.backlogAccumulated ?? 0,
      backlogSaved: funnel.backlogSaved ?? 0,
      dedupSkipped7d: funnel.dedupSkipped7d ?? 0,
      dedupFollowUps: funnel.dedupFollowUps ?? 0,
      clusteredTopics: funnel.clusteredTopics ?? 0,
      screenSelectedTopics: funnel.screenSelectedTopics ?? 0,
      deepFetch,
      publishedDeepDive: funnel.publishedDeepDive ?? 0,
      publishedQuickHits: funnel.publishedQuickHits ?? 0,
      publishedFromBacklog: funnel.publishedFromBacklog ?? 0,
      publishedTotal,
    },
    recommendations,
    warnings,
    ...(stageUsage ? { stageUsage } : {}),
  };
}

function formatTelemetryParts(telemetry) {
  const { sources, funnel } = telemetry;
  const byKind = kind => sources.filter(s => s.kind === kind && s.status !== 'unattempted');

  const sourceParts = [];
  const xRow = sources.find(s => s.id === 'xFollowing');
  if (xRow && xRow.status !== 'unattempted') {
    const span = Number.isFinite(xRow.observedSpanHours) ? `，时间跨度约 ${xRow.observedSpanHours}h` : '';
    sourceParts.push(xRow.status === 'failed' ? `X Following 失败(${xRow.error ?? 'error'})` : `X Following ${xRow.items} 帖${span}`);
  }
  const watches = byKind('watch');
  if (watches.length) {
    const okWatches = watches.filter(w => w.status !== 'failed');
    const totalItems = watches.reduce((sum, w) => sum + (w.items ?? 0), 0);
    sourceParts.push(`Watch ${okWatches.length}/${watches.length} (${totalItems} 帖)`);
  }
  const feeds = byKind('feed');
  if (feeds.length) {
    const okFeeds = feeds.filter(f => f.status !== 'failed');
    const totalItems = feeds.reduce((sum, f) => sum + (f.items ?? 0), 0);
    sourceParts.push(`Feeds/Papers ${okFeeds.length}/${feeds.length} (${totalItems} 篇)`);
  }
  const blogs = byKind('blog');
  if (blogs.length) {
    const okBlogs = blogs.filter(b => b.status !== 'failed');
    const totalItems = blogs.reduce((sum, b) => sum + (b.items ?? 0), 0);
    sourceParts.push(`Blogs ${okBlogs.length}/${blogs.length} (${totalItems} 篇)`);
  }
  const supplements = sources.filter(s => ['substack', 'xhs', 'supplement', 'mail'].includes(s.kind) && s.status !== 'unattempted');
  for (const sup of supplements) {
    sourceParts.push(sup.status === 'failed' ? `${sup.label} 失败(${sup.error ?? 'error'})` : `${sup.label} ${sup.items} 条`);
  }

  const df = funnel.deepFetch ?? {};
  const deepText = df.attempted > 0
    ? ` → 正文可用 ${df.fullText ?? 0}/${df.attempted}${df.snippetOnly ? ` (${df.snippetOnly} 篇仅摘要/截断)` : ''}${df.failed ? ` (${df.failed} 篇抓取失败)` : ''}`
    : '';
  const pubBreakdown = (funnel.publishedDeepDive || funnel.publishedQuickHits)
    ? `（深度 ${funnel.publishedDeepDive ?? 0} + 快讯 ${funnel.publishedQuickHits ?? 0}${funnel.publishedFromBacklog ? `，含捞回遗珠 ${funnel.publishedFromBacklog}` : ''}）`
    : '';
  const backlogIn = (funnel.backlogRecalled || funnel.backlogAccumulated)
    ? `（另遗珠池召回 ${funnel.backlogRecalled ?? 0}、跨日累加 ${funnel.backlogAccumulated ?? 0}）`
    : '';
  const backlogOut = (funnel.backlogSaved ?? 0) > 0
    ? ` → 遗珠池留存 ${funnel.backlogSaved} 条`
    : '';

  return { sourceParts, deepText, pubBreakdown, backlogIn, backlogOut };
}

/**
 * Single-line reader-facing status footer summarizing source coverage, funnel counts, and any health warnings.
 */
export function renderCompactTelemetryLine(telemetry) {
  const { overallHealth, sourceSummary, funnel, recommendations } = telemetry;
  const { sourceParts, pubBreakdown } = formatTelemetryParts(telemetry);
  const srcText = sourceParts.length ? `（${sourceParts.join(' · ')}）` : '';
  const base = `本次采集范围与运行自检 [${overallHealth}]：可用信源 ${sourceSummary.usable}/${sourceSummary.configured}${srcText}，入库 ${funnel.rawItems} 条 → 聚合 ${funnel.clusteredTopics} 话题 → 成稿 ${funnel.publishedTotal} 条${pubBreakdown}。`;
  if (overallHealth === 'OK' || !recommendations?.length) return base;
  return `${base} 关注：${recommendations.map(r => r.reason).join('；')}。`;
}

/**
 * Concise, human- and agent-readable self-check footer replacing repetitive coverage disclaimers.
 */
export function renderTelemetryMarkdown(telemetry) {
  const { overallHealth, sourceSummary, sources, funnel, recommendations } = telemetry;
  const { sourceParts, deepText, pubBreakdown, backlogIn, backlogOut } = formatTelemetryParts(telemetry);

  const unattemptedRows = sources.filter(s => s.status === 'unattempted');
  const statusHeader = sourceSummary.unattempted > 0
    ? `信源状态 (可用 ${sourceSummary.usable}/${sourceSummary.configured} · 已尝试 ${sourceSummary.attempted} · 未尝试 ${sourceSummary.unattempted})`
    : `信源状态 (${sourceSummary.usable}/${sourceSummary.configured} 可用)`;
  const statusDetail = [
    sourceParts.join(' · ') || '无活跃采集源',
    ...(unattemptedRows.length ? [`未尝试：${summarizeSourceList(unattemptedRows)}`] : []),
  ].join(' · ');

  const lines = [
    `### 运行自检 [${overallHealth}]`,
    `- **${statusHeader}**：${statusDetail}`,
    `- **漏斗统计**：原始入库 ${funnel.rawItems} 条${backlogIn} → 7日去重跳过 ${funnel.dedupSkipped7d} 条 → 聚合 ${funnel.clusteredTopics} 个话题 → 初筛入选 ${funnel.screenSelectedTopics} 个${deepText} → 成稿 ${funnel.publishedTotal} 条${pubBreakdown}${backlogOut}`,
  ];

  if (recommendations.length) {
    const notes = recommendations.map(r => `[${r.level}] ${r.reason}`).join('；');
    lines.push(`- **异常与建议**：${notes}`);
  }
  return lines.join('\n');
}

/**
 * Formats a concise Feishu alert Markdown card when the pipeline hits an unrecoverable error,
 * ensuring scheduled runs never fail silently.
 */
export function formatAlertMarkdown({ date = shanghaiDate(), stage = 'unknown', error, runDir = null, telemetry = null, commandHint = 'node run-daily.mjs' }) {
  const errMsg = String(error?.message ?? error ?? 'unknown error').replace(/\r?\n/g, ' ').slice(0, 400);
  const lines = [
    `# X AI 日报运行告警 ${date}`,
    `- **告警级别**：ACTION_NEEDED（流程未能产出正常日报）`,
    `- **失败阶段**：\`${stage}\``,
    `- **错误详情**：${errMsg}`,
  ];
  if (telemetry?.sourceSummary) {
    const failedNames = (telemetry.sources ?? []).filter(s => s.status === 'failed').map(s => `${s.label}(${s.error ?? 'failed'})`).slice(0, 6);
    lines.push(`- **信源快照**：已尝试 ${telemetry.sourceSummary.attempted} 项，可用 ${telemetry.sourceSummary.usable} 项${failedNames.length ? `；失败：${failedNames.join('、')}` : ''}`);
  }
  if (runDir) lines.push(`- **现场目录**：\`${runDir}\``);
  lines.push(`- **排查建议**：检查上述报错或信源状态后重跑 \`${commandHint}\``);
  return lines.join('\n') + '\n';
}
