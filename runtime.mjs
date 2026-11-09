import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export function freshWindow(now = new Date(), lookbackHours = 24) {
  const end = new Date(now);
  if (!Number.isFinite(end.valueOf()) || !Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 48) {
    throw new Error('Expected a valid time and a fresh window of 0..48 hours');
  }
  return { start: new Date(end.valueOf() - lookbackHours * 3600000).toISOString(), end: end.toISOString() };
}

export const defaultWatchProfiles = Object.freeze([Object.freeze({ handle: 'karpathy', name: 'Karpathy', required: true, latest: 10 })]);
// Handles become object keys (bundle.feeds, checks.watch); they must not shadow the fixed groups or the prototype.
const reservedHandles = new Set(['xfollowing', 'xfollowingsearch', 'substack', '__proto__']);

export function validateWatchProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new Error('sources.watchProfiles must be an array');
  const seen = new Set();
  return profiles.map(profile => {
    const { handle, name, required, latest } = profile ?? {};
    if (typeof handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Watch profile handle must match ^[A-Za-z0-9_]{1,15}$');
    if (seen.has(handle.toLowerCase()) || reservedHandles.has(handle.toLowerCase())) throw new Error(`Duplicate or reserved watch profile handle: ${handle}`);
    seen.add(handle.toLowerCase());
    if (typeof name !== 'string' || !name.trim()) throw new Error(`Watch profile ${handle} needs a non-empty name`);
    if (typeof required !== 'boolean') throw new Error(`Watch profile ${handle} required must be a boolean`);
    if (!Number.isInteger(latest) || latest < 1 || latest > 20) throw new Error(`Watch profile ${handle} latest must be an integer 1..20`);
    return { handle, name, required, latest };
  });
}

export function makeRuntime(config, { runId = randomUUID() } = {}) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(runId)) throw new Error('Invalid run ID');
  const cdpPort = config.cdpPort ?? 9449;
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535 || cdpPort === 9339) {
    throw new Error('Use a dedicated CDP port; the original Mac port 9339 is excluded');
  }
  const maxPages = config.maxPages ?? 200;
  const maxFeedMs = config.maxFeedMs ?? 300000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 || !Number.isFinite(maxFeedMs) || maxFeedMs <= 0 || maxFeedMs > 600000) {
    throw new Error('Invalid feed budgets');
  }
  const totalBudgetMs = config.totalBudgetMs ?? 3000000; // 50 minutes; unverified live default
  const maxConcurrency = config.maxConcurrency ?? 2;
  const initialWindowHours = config.initialWindowHours ?? 6;
  const minWindowMinutes = config.minWindowMinutes ?? 30;
  const deepReadLimit = config.deepReadLimit ?? 24;
  if (!Number.isFinite(totalBudgetMs) || totalBudgetMs < 60000 || totalBudgetMs > 3600000 ||
      !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 2 ||
      !Number.isFinite(initialWindowHours) || initialWindowHours <= 0 || initialWindowHours > 6 ||
      !Number.isFinite(minWindowMinutes) || minWindowMinutes < 5 || minWindowMinutes > initialWindowHours * 60 ||
      !Number.isInteger(deepReadLimit) || deepReadLimit < 1 || deepReadLimit > 100) throw new Error('Invalid total/concurrency/coverage/deep-read budgets');
  const dataDir = path.resolve(root, config.dataDir ?? './data');
  const sources = structuredClone(config.sources ?? { blogs: [], xiaohongshuProfiles: [] });
  for (const profile of sources.xiaohongshuProfiles ?? []) {
    const url = new URL(profile.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || url.search || url.hash) {
      throw new Error('Profile URLs must be canonical public Xiaohongshu URLs without query strings');
    }
  }
  sources.watchProfiles = validateWatchProfiles(sources.watchProfiles ?? defaultWatchProfiles);
  const lookbackHours = config.lookbackHours ?? 24;
  freshWindow(new Date(), lookbackHours);
  return {
    runId, cdpPort, maxPages, maxFeedMs, lookbackHours, sources, totalBudgetMs, maxConcurrency, initialWindowHours, minWindowMinutes, deepReadLimit,
    coverageHorizonHours: 48, stateDir: path.join(dataDir, 'state'),
    budgetDefaultsLiveVerified: false,
    runDir: path.join(dataDir, 'runs', runId),
    ocr: { provider: config.ocr?.provider ?? 'none', binary: config.ocr?.binary ?? 'tesseract', languages: config.ocr?.languages ?? 'eng+chi_sim+chi_tra' },
    collectionEnabled: config.collectionEnabled === true,
  };
}

export function assertCollectionAllowed(runtime, { authorized = false, env = process.env } = {}) {
  if (!authorized || !runtime.collectionEnabled || env.X_DAILY_ALLOW_COLLECTION !== '1') {
    throw new Error('Collection disabled: provision the independent browser, then explicitly enable collection in config and environment');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
}
