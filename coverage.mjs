// Gos-only rolling coverage. No Mac-state import, browser I/O or authorization.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mergeItems, itemKey } from './feed.mjs';

const HOUR = 3600000;
const ORIGIN = 'gos-independent-coverage-v1';
const milliseconds = value => {
  const result = typeof value === 'number' ? value : value instanceof Date ? value.valueOf() : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid coverage timestamp');
  return result;
};
const iso = value => new Date(milliseconds(value)).toISOString();
const range = value => {
  const start = milliseconds(value.start), end = milliseconds(value.end);
  if (end <= start) throw new Error('Coverage interval must have positive duration');
  return { start, end };
};
const external = value => ({ start: iso(value.start), end: iso(value.end) });
const key = value => `${milliseconds(value.start)}:${milliseconds(value.end)}`;
const confirmed = report => report.scanned === true && report.undatedItems === 0 &&
  ['time_boundary', 'explicit_empty', 'observed_end'].includes(report.reason) && report.assurance === 'best_effort_ui' &&
  (report.reason === 'time_boundary' ? report.boundaryEvidence === 'ordered_timestamp_boundary' :
    report.reason === 'observed_end' ? ['explicit_exhaustion', 'stable_scroll_end'].includes(report.boundaryEvidence) :
    report.boundaryEvidence === 'explicit_exhaustion');
const pendingPriority = (a, b) => (a.attempts ?? 0) - (b.attempts ?? 0) || milliseconds(b.end) - milliseconds(a.end);
const splitReasons = new Set(['page_budget', 'time_budget', 'stalled', 'search_time_filter_not_respected', 'bounded_browser_capture', 'interrupted']);

function union(values) {
  const result = [];
  for (const value of values.map(range).sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
    else result.push({ ...value });
  }
  return result;
}
function subtract(targets, covered) {
  let rest = targets.map(range);
  for (const cut of union(covered)) rest = rest.flatMap(value => {
    if (cut.end <= value.start || cut.start >= value.end) return [value];
    return [value.start < cut.start ? { start: value.start, end: cut.start } : null,
      value.end > cut.end ? { start: cut.end, end: value.end } : null].filter(Boolean);
  });
  return rest;
}
const overlaps = (a, b) => milliseconds(a.start) < milliseconds(b.end) && milliseconds(a.end) > milliseconds(b.start);

export function createCoverageState(now = new Date()) {
  return { schemaVersion: 1, origin: ORIGIN, revision: 0, createdAt: iso(now), updatedAt: iso(now),
    attempts: [], pending: [], items: [], deepLinkAudit: [] };
}
export function validateCoverageState(state) {
  if (state?.schemaVersion !== 1 || state.origin !== ORIGIN || !Number.isInteger(state.revision) ||
      !['attempts', 'pending', 'items', 'deepLinkAudit'].every(name => Array.isArray(state[name]))) {
    throw new Error('Not a Gos-only coverage state; no legacy history is imported');
  }
  for (const value of [...state.attempts, ...state.pending]) range(value);
  return state;
}

export function coverageReport(state, now = new Date()) {
  validateCoverageState(state);
  const end = milliseconds(now);
  const windows = {};
  for (const hours of [24, 48]) {
    const target = { start: end - hours * HOUR, end };
    const valid = state.attempts.filter(confirmed).filter(value => overlaps(value, target));
    const gaps = subtract([target], valid).flatMap(value => {
      const failures = state.attempts.filter(attempt => !confirmed(attempt) && overlaps(value, attempt));
      const boundaries = [...new Set([value.start, value.end, ...failures.flatMap(attempt => [
        Math.max(value.start, milliseconds(attempt.start)), Math.min(value.end, milliseconds(attempt.end))])])].sort((a, b) => a - b);
      return boundaries.slice(0, -1).map((start, index) => {
        const piece = { start, end: boundaries[index + 1] };
        const matching = failures.filter(attempt => overlaps(piece, attempt));
        return { ...external(piece), durationHours: (piece.end - piece.start) / HOUR,
          reasons: matching.length ? [...new Set(matching.map(attempt => attempt.reason))] : ['never_scanned'] };
      });
    });
    // Sum exact millisecond intervals before conversion; fractional-hour sums can drift outside the window.
    const unscannedMs = gaps.reduce((sum, value) => sum + (milliseconds(value.end) - milliseconds(value.start)), 0);
    const unscannedHours = unscannedMs / HOUR;
    windows[`${hours}h`] = { ...external(target), uiScannedHours: (hours * HOUR - unscannedMs) / HOUR, unscannedHours, gaps,
      assurance: 'best_effort_ui_not_all_posts' };
  }
  const candidates = new Map(state.deepLinkAudit.map(link => [link.href, link]));
  const values = [...candidates.values()];
  const eligible = values.filter(link => link.eligible !== false && !String(link.reason).startsWith('filtered_'));
  const read = link => ['read', 'browser_observed'].includes(link.readStatus);
  return {
    asOf: iso(end), windows, unknownMissingPostCount: null,
    missingPostCountExplanation: 'Unseen post counts cannot be inferred from unscanned time or browser snapshots.',
    knownCandidates: {
      observedPosts: mergeItems(state.items).length,
      truncatedPosts: mergeItems(state.items).filter(item => item.truncated === true).length,
      truncatedDeepReads: values.filter(link => link.truncated === true).length,
      observedLinks: values.length,
      filterDrops: values.filter(link => link.eligible === false || String(link.reason).startsWith('filtered_')).length,
      filterDropReasons: values.filter(link => link.eligible === false || String(link.reason).startsWith('filtered_')).reduce((out, link) => { out[link.reason] = (out[link.reason] ?? 0) + 1; return out; }, {}),
      deepReadBacklog: eligible.filter(link => !read(link)).length,
      deepReadFailures: eligible.filter(link => link.readStatus === 'failed').length,
      knownMissedCandidates: eligible.filter(link => !read(link)).map(link => ({ url: link.href, reason: link.readStatus === 'failed' ? 'deep_read_failed' : link.reason ?? 'not_read' })),
      digestInclusionOmissions: null,
    },
    countsScope: 'Observed candidate processing only; not a count of unknown missing posts or proof that each candidate belongs in a digest.',
  };
}

export function planCoverage(state, { now = new Date(), initialWindowHours = 6, horizonHours = 48 } = {}) {
  validateCoverageState(state);
  if (!(initialWindowHours > 0 && initialWindowHours <= 6) || horizonHours !== 48) throw new Error('Use positive initial windows <=6h within the recent 48h');
  const end = milliseconds(now), start = end - horizonHours * HOUR, priorityStart = end - 24 * HOUR;
  const confirmedWindows = state.attempts.filter(confirmed);
  const gaps = subtract([{ start, end }], confirmedWindows);
  const pending = [];
  // Keep interrupted/split intervals intact. Only clip to the rolling horizon.
  for (const saved of state.pending) {
    const raw = range(saved), clipped = { start: Math.max(raw.start, start), end: Math.min(raw.end, end) };
    if (clipped.end <= clipped.start) continue;
    for (const value of subtract([clipped], [...confirmedWindows, ...pending])) pending.push({ ...saved, ...external(value) });
  }
  for (const gap of subtract(gaps, pending)) {
    let cursor = gap.end;
    while (cursor > gap.start) {
      let from = Math.max(gap.start, cursor - initialWindowHours * HOUR);
      if (cursor > priorityStart && from < priorityStart) from = priorityStart;
      pending.push({ start: iso(from), end: iso(cursor), attempts: 0, reason: 'never_scanned' });
      cursor = from;
    }
  }
  return pending.sort(pendingPriority).map(value => ({ ...value,
    priority: milliseconds(value.end) > priorityStart ? 'recent_24h' : 'previous_24h' }));
}

export function recordCoverageAttempt(state, window, result, { now = new Date(), runId, minWindowMinutes = 30, maxPendingWindows = 128, maxSplitDepth = 6 } = {}) {
  validateCoverageState(state);
  const requested = range(window);
  const report = result.coverage ?? result;
  if (key(report) !== key(window)) throw new Error('Scan result interval differs from requested interval');
  const attempt = { ...report, ...external(requested), attemptedAt: iso(now), runId,
    scanned: confirmed(report), originalScannedClaim: report.scanned === true };
  state.attempts.push(attempt);
  state.items = mergeItems(state.items, (result.items ?? []).map(item => ({ ...item, observedAt: iso(now) })));
  state.pending = state.pending.filter(value => key(value) !== key(window));
  if (!attempt.scanned) {
    const entry = { ...external(requested), attempts: (window.attempts ?? 0) + 1, reason: attempt.reason, lastRunId: runId };
    if (splitReasons.has(attempt.reason) && requested.end - requested.start >= 2 * minWindowMinutes * 60000 &&
        state.pending.length + 2 <= maxPendingWindows && (window.depth ?? 0) < maxSplitDepth) {
      const midpoint = requested.start + Math.floor((requested.end - requested.start) / 2);
      // Exact adjacent halves: no dropped tail, no overlap, no changed watermark.
      state.pending.push({ ...entry, end: iso(midpoint), lastRunId: null, parent: external(requested), depth: (window.depth ?? 0) + 1 },
        { ...entry, start: iso(midpoint), lastRunId: null, parent: external(requested), depth: (window.depth ?? 0) + 1 });
    } else state.pending.push({ ...entry, depth: window.depth ?? 0, deferredBecause:
      !splitReasons.has(attempt.reason) ? 'terminal_or_non_split_failure' : requested.end - requested.start < 2 * minWindowMinutes * 60000 ? 'minimum_window_width' :
      (window.depth ?? 0) >= maxSplitDepth ? 'maximum_split_depth' : 'maximum_pending_windows' });
  }
  const cutoff = milliseconds(now) - 48 * HOUR;
  state.attempts = state.attempts.filter(value => milliseconds(value.end) > cutoff);
  state.items = state.items.filter(item => Date.parse(item.publishedAt ?? item.observedAt ?? state.updatedAt) >= cutoff);
  state.updatedAt = iso(now);
  state.revision++;
  return attempt;
}

export function recordCollectionCoverage(state, collection) {
  validateCoverageState(state);
  const reports = collection.coverage?.reports?.xFollowing ?? [];
  for (const report of reports) {
    range(report);
    if (state.attempts.some(value => value.runId === collection.collectionId && key(value) === key(report) && value.source === report.source)) continue;
    const browserArtifact = collection.provenance?.transport === 'gos-supported-browser';
    state.attempts.push({ ...report, runId: collection.collectionId, attemptedAt: collection.collectedAt,
      scanned: !browserArtifact && confirmed(report) });
  }
  state.items = mergeItems(state.items, (collection.sources?.xFollowing ?? []).map(item => ({ ...item, observedAt: collection.collectedAt })));
  const audit = new Map(state.deepLinkAudit.map(link => [link.href, link]));
  for (const link of collection.deepLinkAudit ?? []) {
    const previous = audit.get(link.href);
    // A duplicate occurrence does not supersede the selected candidate's status.
    if (link.reason === 'duplicate_url' && previous) continue;
    const readStatus = ['read', 'browser_observed'].includes(previous?.readStatus) && !['read', 'browser_observed'].includes(link.readStatus) ? previous.readStatus : link.readStatus;
    audit.set(link.href, { ...previous, ...link, readStatus, lastObservedAt: collection.collectedAt });
  }
  const cutoff = Date.parse(collection.collectedAt) - 48 * HOUR;
  state.attempts = state.attempts.filter(value => Date.parse(value.end) > cutoff);
  state.items = state.items.filter(item => Date.parse(item.publishedAt ?? item.observedAt ?? state.updatedAt) >= cutoff);
  state.deepLinkAudit = [...audit.values()].filter(link => Date.parse(link.lastObservedAt ?? state.updatedAt) >= cutoff);
  state.updatedAt = iso(collection.collectedAt);
  state.revision++;
  return coverageReport(state, collection.collectedAt);
}

export function executionPolicy(runtime, capability = {}) {
  const requestedConcurrency = runtime.maxConcurrency ?? 2;
  const verified = capability.transport === 'cdp' && capability.independentTargets === true && capability.cancellation === true;
  return { requestedConcurrency, effectiveConcurrency: verified ? Math.min(2, requestedConcurrency) : 1,
    reason: verified ? 'independent_cancellable_targets_explicitly_verified' : 'browser_parallelism_unverified_or_shared_CUA; serialize',
    liveVerifiedByThisPackage: false };
}

export async function runCoveragePlan(runtime, state, { scan, now = () => new Date(), clock = Date.now,
  checkpoint = async () => {}, capability = {}, startMs = clock() } = {}) {
  if (typeof scan !== 'function') throw new Error('A real authorized scan adapter is required');
  const policy = executionPolicy(runtime, capability);
  const deadline = startMs + runtime.totalBudgetMs;
  const anchor = now();
  state.pending = planCoverage(state, { now: anchor, initialWindowHours: runtime.initialWindowHours ?? 6 });
  const active = new Set();
  let checkpoints = Promise.resolve();
  let completedAttempts = 0;
  let blocked = null;
  async function worker() {
    while (!blocked && clock() < deadline) {
      const window = state.pending.find(value => value.lastRunId !== runtime.runId && !active.has(key(value)));
      if (!window) break;
      active.add(key(window));
      let result;
      try {
        result = await scan(window, { maxPages: runtime.maxPages, maxMs: Math.min(runtime.maxFeedMs, deadline - clock()), deadline });
      } catch (error) {
        result = { items: [], coverage: { ...external(range(window)), scanned: false, assurance: 'best_effort_ui', undatedItems: 0,
          reason: error.code === 'LOGIN_REQUIRED' ? 'login_required' : error.code === 'RUN_BUDGET' ? 'time_budget' : 'scan_error', error: error.message } };
      }
      if (['login_required', 'rate_limited', 'page_error'].includes(result.coverage?.reason)) blocked = result.coverage.reason;
      recordCoverageAttempt(state, window, result, { now: anchor, runId: runtime.runId, minWindowMinutes: runtime.minWindowMinutes ?? 30 });
      active.delete(key(window));
      state.pending.sort(pendingPriority);
      completedAttempts++;
      // Serialize persistence even when independently verified adapters run two scans.
      const snapshot = structuredClone(state);
      checkpoints = checkpoints.then(() => checkpoint(snapshot));
      await checkpoints;
      if (blocked) break;
    }
  }
  await Promise.all(Array.from({ length: policy.effectiveConcurrency }, worker));
  await checkpoints;
  return { completedAttempts, policy, stopReason: blocked ?? (clock() >= deadline ? 'total_time_budget' : state.pending.length ? 'deferred_incomplete_intervals' : 'observed_horizon_scanned'),
    elapsedMs: clock() - startMs, budgetMs: runtime.totalBudgetMs, budgetMode: 'cooperative_deadline_inflight_operations_must_honor_adapter_budget',
    coverage: coverageReport(state, anchor) };
}

export function openCoverageStore(runtime, now = new Date()) {
  const directory = runtime.stateDir;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'coverage.json'), lock = path.join(directory, 'coverage.lock');
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: iso(now) }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { throw new Error('Coverage lock is unreadable; inspect before removing it'); }
    let gone = false;
    if (owner.hostname === os.hostname() && Number.isInteger(owner.pid)) {
      try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') gone = true; }
    }
    if (!gone) throw new Error('Another collector holds the coverage lock; do not run concurrent controllers');
    const recovery = path.join(directory, 'coverage.recovery.lock');
    let recoveryFd;
    try { recoveryFd = fs.openSync(recovery, 'wx', 0o600); }
    catch { throw new Error('Another process is recovering the coverage lock; retry after it finishes'); }
    try {
      const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (JSON.stringify(current) !== JSON.stringify(owner)) throw new Error('Coverage lock owner changed during recovery');
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: iso(now) }), { flag: 'wx' });
    } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
  }
  let closed = false;
  const close = () => { if (!closed) { closed = true; fs.unlinkSync(lock); } };
  try {
    const state = fs.existsSync(file) ? validateCoverageState(JSON.parse(fs.readFileSync(file, 'utf8'))) : createCoverageState(now);
    const save = value => {
      if (closed) throw new Error('Coverage store is closed');
      validateCoverageState(value);
      const temporary = path.join(directory, `.coverage-${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    };
    return { state, save, close, file };
  } catch (error) { close(); throw error; }
}

export function loadCoverageState(runtime, now = new Date()) {
  const file = path.join(runtime.stateDir, 'coverage.json');
  return fs.existsSync(file) ? validateCoverageState(JSON.parse(fs.readFileSync(file, 'utf8'))) : createCoverageState(now);
}
