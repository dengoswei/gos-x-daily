#!/usr/bin/env node
// Rolling editorial measurements for tuning curation: the pillar mix of composed Deep Dives
// (default 7 days) and per-source yield through the funnel (default 30 days). Stored in the
// private state directory, one row per report date; a rerun of a date replaces its row.
// These are internal measurements, never rendered to readers and never an approval signal.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, citesTopicSource } from './binding.mjs';

export const PILLARS = Object.freeze(['infra', 'intelligence', 'world_impact', 'open_door']);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 400;
const DOMAIN_PILLAR = { core_ml_systems: 'infra', intelligence_theory: 'intelligence' };

const safeCanonical = href => {
  try { return canonicalUrl(href); } catch { return null; }
};
/** The editor's pillar when valid; otherwise derived from the prior's domain tag, or `unclassified`. */
export function pillarFor(plan, topic) {
  if (PILLARS.includes(plan?.pillar)) return plan.pillar;
  return DOMAIN_PILLAR[topic?.curationSignals?.domainTag] ?? 'unclassified';
}

export function buildDailyEditorialStats({ date, topics = [], shortlistIds = null, selectedPlan = [], citedUrls = [] }) {
  const cited = new Set(citedUrls.map(safeCanonical).filter(Boolean));
  const byId = new Map(topics.map(topic => [topic.topicId, topic]));
  const isComposed = topic => citesTopicSource(topic, cited);
  const selected = new Map(selectedPlan.map(plan => [plan.topicId, plan]));
  const deep = Object.fromEntries([...PILLARS, 'unclassified'].map(pillar => [pillar, 0]));
  let quick = 0;
  for (const plan of selectedPlan) {
    const topic = byId.get(plan.topicId);
    if (!topic || !isComposed(topic)) continue;
    if (plan.tier === 'quick') quick += 1;
    else deep[pillarFor(plan, topic)] += 1;
  }
  const sources = {};
  for (const topic of topics) {
    if (topic.dedupStatus === 'seen_recently') continue;
    for (const label of new Set(topic.sources ?? [])) {
      const row = sources[label] ??= { ingested: 0, shortlisted: 0, selected: 0, composed: 0 };
      row.ingested += 1;
      if (shortlistIds?.has(topic.topicId)) row.shortlisted += 1;
      if (selected.has(topic.topicId)) row.selected += 1;
      if (selected.has(topic.topicId) && isComposed(topic)) row.composed += 1;
    }
  }
  return { schemaVersion: 2, date, shortlistMeasured: Boolean(shortlistIds), pillars: { deep, quick }, sources };
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()).flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? [row] : [];
    } catch { return []; }
  });
}

export function appendEditorialStats(file, row) {
  const cutoff = new Date(Date.parse(row.date) - RETAIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = [...readRows(file).filter(existing => existing.date !== row.date && existing.date >= cutoff), row]
    .sort((a, b) => a.date.localeCompare(b.date));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.writeFileSync(temp, rows.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return rows.length;
}

/** Sums the window ending on `asOf` (inclusive). Shares are null when nothing was composed. */
export function rollingEditorialStats(file, { asOf, pillarDays = 7, yieldDays = 30 } = {}) {
  const rows = readRows(file).filter(row => !asOf || row.date <= asOf);
  const end = asOf ?? rows.at(-1)?.date;
  if (!end) return { asOf: null, pillarWindow: { days: pillarDays, reports: 0 }, sourceWindow: { days: yieldDays, reports: 0 }, sources: [] };
  const since = days => new Date(Date.parse(end) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const pillarRows = rows.filter(row => row.date >= since(pillarDays));
  const deep = Object.fromEntries([...PILLARS, 'unclassified'].map(pillar => [pillar, 0]));
  let quick = 0;
  for (const row of pillarRows) {
    for (const key of Object.keys(deep)) deep[key] += row.pillars?.deep?.[key] ?? 0;
    quick += row.pillars?.quick ?? 0;
  }
  const deepTotal = Object.values(deep).reduce((a, b) => a + b, 0);
  const share = key => (deepTotal ? Number((deep[key] / deepTotal).toFixed(3)) : null);
  const yieldRows = rows.filter(row => row.date >= since(yieldDays));
  const totals = new Map();
  for (const row of yieldRows) {
    for (const [label, counts] of Object.entries(row.sources ?? {})) {
      const total = totals.get(label) ?? { source: label, reports: 0, ingested: 0, shortlisted: 0, selected: 0, composed: 0 };
      total.reports += 1;
      for (const key of ['ingested', 'shortlisted', 'selected']) total[key] += counts?.[key] ?? 0;
      // Version 1 also sampled at composition, under the old field name.
      total.composed += counts?.composed ?? (row.schemaVersion === 1 ? counts?.published : 0) ?? 0;
      totals.set(label, total);
    }
  }
  const sources = [...totals.values()].map(total => ({ ...total,
    composedPerIngested: total.ingested ? Number((total.composed / total.ingested).toFixed(3)) : null }))
    .sort((a, b) => b.composed - a.composed || b.ingested - a.ingested || a.source.localeCompare(b.source));
  return {
    asOf: end,
    pillarWindow: { days: pillarDays, reports: pillarRows.length, deep, deepTotal, quick,
      shares: Object.fromEntries(Object.keys(deep).map(key => [key, share(key)])) },
    sourceWindow: { days: yieldDays, reports: yieldRows.length, shortlistMeasuredReports: yieldRows.filter(row => row.shortlistMeasured).length },
    sources,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const dataDir = path.resolve(flag('--data-dir', './data'));
  const report = rollingEditorialStats(path.join(dataDir, 'state', 'editorial-stats.jsonl'), {
    asOf: flag('--as-of', undefined), pillarDays: Number(flag('--pillar-days', 7)), yieldDays: Number(flag('--yield-days', 30)) });
  console.log(JSON.stringify({ notApproval: true, ...report }, null, 2));
}
