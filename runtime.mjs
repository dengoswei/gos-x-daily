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
  if (dataDir.includes('/PersonalWorkspace/reading')) throw new Error('The original reading workspace is excluded');
  const sources = structuredClone(config.sources ?? { blogs: [], xiaohongshuProfiles: [] });
  for (const profile of sources.xiaohongshuProfiles ?? []) {
    const url = new URL(profile.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || url.search || url.hash) {
      throw new Error('Profile URLs must be canonical public Xiaohongshu URLs without query strings');
    }
  }
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
