import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoverageState, planCoverage, recordCoverageAttempt, recordCollectionCoverage, coverageReport,
  openCoverageStore, loadCoverageState, runCoveragePlan, executionPolicy } from '../coverage.mjs';
import { makeRuntime } from '../runtime.mjs';
import { larkMarkdown } from '../digest.mjs';
import { main } from '../cli.mjs';

const now = '2026-10-18T08:00:00.000Z';
const HOUR = 3600000;
const before = hours => new Date(Date.parse(now) - hours * HOUR).toISOString();
const interval = (from, to) => ({ start: before(from), end: before(to) });
const result = (window, reason = 'explicit_empty', extra = {}) => ({ items: [], coverage: {
  ...window, scanned: true, undatedItems: 0, reason, boundaryEvidence: 'explicit_exhaustion', assurance: 'best_effort_ui', ...extra } });
const runtime = { runId: 'synthetic-coverage-run', maxPages: 200, maxFeedMs: 300000, totalBudgetMs: 3000000,
  maxConcurrency: 2, initialWindowHours: 6, minWindowMinutes: 30 };

test('fresh Gos-only planner covers recent 48h in adjacent six-hour windows newest first', () => {
  const state = createCoverageState(now), plan = planCoverage(state, { now });
  assert.equal(plan.length, 8);
  assert.equal(plan[0].end, now);
  assert.equal(plan.at(-1).start, before(48));
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].end, plan[i - 1].start);
  assert.equal(plan.filter(value => value.priority === 'recent_24h').length, 4);
  assert.equal(coverageReport(state, now).windows['48h'].unscannedHours, 48);
  assert.throws(() => planCoverage({ ...state, origin: 'legacy-mac' }, { now }), /no legacy/);
});

test('six-hour cap failure splits into exact halves without losing observations', () => {
  const state = createCoverageState(now), window = interval(6, 0);
  state.pending = [window];
  const attempted = result(window, 'time_budget', { scanned: false, boundaryEvidence: null });
  attempted.items = [{ url: 'https://x.com/synthetic/status/1', text: 'Synthetic', publishedAt: before(1) }];
  recordCoverageAttempt(state, window, attempted, { now, runId: runtime.runId });
  assert.equal(state.pending.length, 2);
  assert.equal(state.pending[0].start, window.start);
  assert.equal(state.pending[0].end, state.pending[1].start);
  assert.equal(state.pending[1].end, window.end);
  assert.equal(state.items.length, 1);
  const plan = planCoverage(state, { now });
  assert.deepEqual(plan.filter(value => value.parent).map(value => [value.start, value.end]), [[before(3), now], [before(6), before(3)]]);
});

test('retry union counts each scanned instant once, leaves sibling gap and records reasons', () => {
  const state = createCoverageState(now);
  recordCoverageAttempt(state, interval(6, 0), result(interval(6, 0), 'page_budget', { scanned: false }), { now });
  recordCoverageAttempt(state, interval(3, 0), result(interval(3, 0)), { now });
  recordCoverageAttempt(state, interval(3, 0), result(interval(3, 0)), { now });
  recordCoverageAttempt(state, interval(4, 1), result(interval(4, 1)), { now });
  const report = coverageReport(state, now);
  assert.equal(report.windows['24h'].uiScannedHours, 4);
  assert.equal(report.windows['24h'].unscannedHours, 20);
  assert.equal(report.windows['48h'].unscannedHours, 44);
  assert.ok(report.windows['24h'].gaps.some(value => value.durationHours === 2 && value.reasons.includes('page_budget')));
  assert.ok(report.windows['24h'].gaps.some(value => value.reasons.includes('never_scanned')));
  assert.equal(report.unknownMissingPostCount, null);
});

test('false boundary claims and browser snapshots cannot close coverage gaps', () => {
  const state = createCoverageState(now), window = interval(6, 0);
  recordCoverageAttempt(state, window, result(window, 'time_boundary', { boundaryEvidence: null }), { now });
  assert.equal(coverageReport(state, now).windows['24h'].uiScannedHours, 0);
  recordCollectionCoverage(state, { collectionId: 'synthetic-browser', collectedAt: now,
    provenance: { transport: 'gos-supported-browser' }, coverage: { reports: { xFollowing: [result(window).coverage] } }, sources: { xFollowing: [] } });
  assert.equal(coverageReport(state, now).windows['24h'].uiScannedHours, 0);
});

test('rolling clipping and fixed end preserve a new newest-end gap', () => {
  const state = createCoverageState(before(1));
  recordCoverageAttempt(state, interval(49, 1), result(interval(49, 1)), { now: before(1) });
  const report = coverageReport(state, now);
  assert.equal(report.windows['48h'].uiScannedHours, 47);
  assert.equal(report.windows['48h'].unscannedHours, 1);
  assert.deepEqual(report.windows['48h'].gaps.map(value => [value.start, value.end]), [[before(1), now]]);
});

test('minimum-width failure is deferred rather than infinitely split or retried this run', async () => {
  const state = createCoverageState(now);
  // Mark all but the final half hour observed so only the terminal leaf remains.
  recordCoverageAttempt(state, interval(48, .5), result(interval(48, .5)), { now });
  let calls = 0;
  const run = await runCoveragePlan(runtime, state, { now: () => new Date(now), clock: () => 0, startMs: 0,
    scan: async window => { calls++; return result(window, 'stalled', { scanned: false, boundaryEvidence: null }); } });
  assert.equal(calls, 1);
  assert.equal(state.pending.length, 1);
  assert.equal(run.stopReason, 'deferred_incomplete_intervals');
  assert.equal(run.coverage.windows['24h'].unscannedHours, .5);
});

test('global deadline stops new windows, checkpoints results and keeps remaining intervals resumable', async () => {
  const state = createCoverageState(now); let time = 0, checkpoints = 0, calls = 0;
  const run = await runCoveragePlan({ ...runtime, totalBudgetMs: 1000 }, state, { now: () => new Date(now), clock: () => time, startMs: 0,
    checkpoint: async value => { checkpoints++; assert.ok(value.attempts.length); },
    scan: async (window, budget) => { calls++; assert.equal(budget.maxMs, 1000); time += 1000; return result(window); } });
  assert.equal(calls, 1); assert.equal(checkpoints, 1);
  assert.equal(run.stopReason, 'total_time_budget');
  assert.equal(planCoverage(state, { now }).length, 7);
  assert.equal(run.coverage.windows['48h'].unscannedHours, 42);
});

test('login/rate-limit failure halts scanning without splitting into more blocked windows', async () => {
  for (const reason of ['login_required', 'rate_limited']) {
    const state = createCoverageState(now); let calls = 0;
    const run = await runCoveragePlan(runtime, state, { now: () => new Date(now), clock: () => 0, startMs: 0,
      scan: async window => { calls++; return result(window, reason, { scanned: false, boundaryEvidence: null }); } });
    assert.equal(calls, 1); assert.equal(run.stopReason, reason);
    assert.equal(state.pending.length, 8);
  }
});

test('CUA always serializes; only explicitly isolated cancellation-capable adapters can use two workers', async () => {
  assert.equal(executionPolicy(runtime, { transport: 'cua', independentTargets: true, cancellation: true }).effectiveConcurrency, 1);
  assert.equal(executionPolicy(runtime, { transport: 'cdp' }).effectiveConcurrency, 1);
  for (const [capability, expected] of [[{ transport: 'cua' }, 1], [{ transport: 'cdp', independentTargets: true, cancellation: true }, 2]]) {
    const state = createCoverageState(now); let active = 0, peak = 0;
    await runCoveragePlan(runtime, state, { now: () => new Date(now), clock: () => 0, startMs: 0, capability,
      scan: async window => { active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 2)); active--; return result(window); } });
    assert.equal(peak, expected);
    assert.equal(state.attempts.length, 8);
    assert.equal(coverageReport(state, now).windows['48h'].unscannedHours, 0);
    assert.equal(coverageReport(state, now).unknownMissingPostCount, null);
  }
});

test('fresh remote state is durable/atomic, lock-protected and resumes after reopen', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-coverage-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configured = makeRuntime({ dataDir: dir });
  const first = openCoverageStore(configured, now);
  recordCoverageAttempt(first.state, interval(6, 0), result(interval(6, 0), 'time_budget', { scanned: false }), { now });
  first.save(first.state);
  assert.throws(() => openCoverageStore(configured, now), /Another collector/);
  first.close();
  const second = openCoverageStore(configured, now);
  assert.equal(second.state.attempts.length, 1); assert.equal(second.state.pending.length, 2);
  assert.equal(second.state.origin, 'gos-independent-coverage-v1');
  second.close();
  assert.deepEqual(fs.readdirSync(configured.stateDir), ['coverage.json']);
  assert.equal(loadCoverageState(configured, now).revision, 1);
});

test('known filters and deep-read backlog are separate from unknown omissions and survive concise delivery', () => {
  const state = createCoverageState(now);
  const collection = { collectionId: 'synthetic-counts', collectedAt: now, sources: { xFollowing: [] },
    coverage: { reports: { xFollowing: [] } }, deepLinkAudit: [
      { href: 'https://goodfire.ai/', eligible: true, selected: true, reason: 'ranked_for_deep_read', readStatus: 'failed' },
      { href: 'https://example.org/paper', eligible: true, selected: false, reason: 'deep_read_budget' },
      { href: 'https://example.org/', eligible: false, selected: false, reason: 'filtered_nontechnical_root' },
    ] };
  collection.coverage.accounting = recordCollectionCoverage(state, collection);
  const counts = collection.coverage.accounting.knownCandidates;
  assert.equal(counts.filterDrops, 1); assert.equal(counts.deepReadBacklog, 2); assert.equal(counts.deepReadFailures, 1);
  assert.equal(collection.coverage.accounting.unknownMissingPostCount, null);
  const body = larkMarkdown('# Synthetic\n- Main\n## 差异补充\nDetailed audit\n', collection);
  assert.ok(body.includes('近48小时有 48.00 小时'));
  assert.ok(body.includes('未看到的帖子数未知'));
  assert.ok(!body.includes('Detailed audit'));
});

test('offline CLI exposes a bounded plan/report without creating state or invoking a browser', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-coverage-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: path.join(dir, 'data') }));
  const plan = await main(['coverage-plan', '--config', configFile, '--now', now]);
  assert.equal(plan.windows.length, 8); assert.equal(plan.execution.effectiveConcurrency, 1);
  assert.equal(plan.budget.perWindowMs, 300000); assert.equal(plan.budget.maxPages, 200);
  const report = await main(['coverage-report', '--config', configFile, '--now', now]);
  assert.equal(report.windows['24h'].unscannedHours, 24);
  assert.equal(report.unknownMissingPostCount, null);
  assert.equal(fs.existsSync(path.join(dir, 'data')), false);
});

test('adaptive children never fall below minimum width and retry pass does not starve other coarse windows', async () => {
  const state = createCoverageState(now), narrow = interval(.75, 0);
  state.pending = [narrow];
  recordCoverageAttempt(state, narrow, result(narrow, 'time_budget', { scanned: false }), { now, minWindowMinutes: 30 });
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].deferredBecause, 'minimum_window_width');
  const fresh = createCoverageState(now); let elapsed = 0; const attempted = [];
  await runCoveragePlan({ ...runtime, totalBudgetMs: 2400000 }, fresh, { now: () => new Date(now), clock: () => elapsed, startMs: 0,
    scan: async window => { attempted.push(window); elapsed += 300000; return result(window, 'time_budget', { scanned: false, boundaryEvidence: null }); } });
  assert.equal(attempted.length, 8);
  assert.equal(attempted[0].end, now);
  assert.equal(attempted.at(-1).start, before(48));
  assert.ok(attempted.every(value => Date.parse(value.end) - Date.parse(value.start) === 6 * HOUR));
});
