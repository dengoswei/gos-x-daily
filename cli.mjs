#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRuntime } from './runtime.mjs';
import { loadCoverageState, openCoverageStore, planCoverage, coverageReport, recordCollectionCoverage, executionPolicy } from './coverage.mjs';
import { createCollector } from './collector.mjs';
import { collectionFromBrowserArtifacts, verifyEvidenceFiles } from './browser-artifacts.mjs';
import { composePrompt, prepareDelivery, sendDelivery, publicationGates, readPublicationFile } from './digest.mjs';
import { createReviewInput, validateReview } from './review.mjs';
import { initializeDeliveryLedger, recentPublishedUrls } from './delivery-ledger.mjs';
import { writeWorkerPackets } from './worker-packets.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// An enabled target is pinned to the ledger its runtime config names (relative to that config file).
const pinnedTarget = (configFile, lark) => {
  if (lark?.enabled !== true) return lark;
  if (typeof lark.ledgerDir !== 'string' || !lark.ledgerDir) throw new Error('An enabled lark target must name its delivery ledgerDir in the runtime config');
  return { ...lark, ledgerDir: path.resolve(path.dirname(path.resolve(configFile)), lark.ledgerDir) };
};

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const required = flag => {
    const result = value(flag);
    if (!result || result.startsWith('--')) throw new Error(`Missing ${flag}`);
    return result;
  };
  const write = (file, text) => {
    // The caller chooses an explicit output file; never replace an existing one.
    fs.writeFileSync(file, text, { flag: 'wx' });
  };
  if (!command || ['help', '--help', '-h'].includes(command)) {
    return { commands: [
      'inspect-config [--config runtime.json]',
      'coverage-plan [--config runtime.json] [--now ISO] [--out plan.json]',
      'coverage-report [--config runtime.json] [--now ISO] [--out report.json]',
      'collect --config runtime.json --allow-collection',
      'import-browser --artifacts browser-capture.json --out sources.json [--config runtime.json]',
      'import-feed --artifacts feed-capture.json --sources sources.json --out sources.merged.json [--config runtime.json]',
      'compose-input --sources sources.json --out prompt.md [--published-history LEDGER_DIRECTORY] [--full]',
      'worker-input --sources sources.json --out NEW_DIRECTORY [--published-history LEDGER_DIRECTORY]',
      'prepare-delivery --sources sources.json --digest digest.md --publication publication.json --out delivery.json --config VERIFIED_RUNTIME.json',
      'review-input --publication publication.json --out review.pending.json',
      'validate-publication --publication publication.json',
      'init-delivery-ledger --directory NEW_DIRECTORY --not-before-date YYYY-MM-DD --created-by ID',
      'send --plan delivery.json --config VERIFIED_RUNTIME.json --allow-send',
    ], defaults: 'No collection or delivery is enabled. No model is invoked by this CLI.' };
  }
  if (command === 'compose-input') {
    const output = required('--out');
    const collection = readJson(required('--sources'));
    const publishedHistory = argv.includes('--published-history') ? recentPublishedUrls(required('--published-history'), { before: collection.date }) : [];
    write(output, composePrompt(collection, { publishedHistory, full: argv.includes('--full') }));
    return { status: 'prompt_written', output };
  }
  if (command === 'worker-input') {
    const sourcesFile = required('--sources');
    const collection = readJson(sourcesFile);
    const publishedHistory = argv.includes('--published-history') ? recentPublishedUrls(required('--published-history'), { before: collection.date }) : [];
    return writeWorkerPackets({ sourcesFile, outputDir: required('--out'), publishedHistory });
  }
  if (command === 'init-delivery-ledger') {
    return initializeDeliveryLedger(required('--directory'), { notBeforeDate: required('--not-before-date'), createdBy: required('--created-by') });
  }
  const publication = () => {
    const file = path.resolve(required('--publication'));
    const value = readJson(file);
    if (typeof value.rootDir !== 'string' || typeof value.ledgerDir !== 'string') throw new Error('Publication rootDir and ledgerDir must be explicit');
    return { ...value, rootDir: path.resolve(path.dirname(file), value.rootDir), ledgerDir: path.resolve(path.dirname(file), value.ledgerDir) };
  };
  if (command === 'review-input' || command === 'validate-publication') {
    const p = publication();
    const markdown = readPublicationFile(p.rootDir, p.snapshotInputs.digestPath);
    const collection = JSON.parse(readPublicationFile(p.rootDir, p.snapshotInputs.sourcesPath));
    const gates = publicationGates(p.rootDir, p.snapshotInputs, markdown, collection);
    const inputs = { ...p.snapshotInputs, rootDir: p.rootDir, renderedMarkdown: gates.renderedMarkdown };
    if (command === 'review-input') {
      const output = required('--out');
      write(output, JSON.stringify(createReviewInput(inputs), null, 2) + '\n');
      return { status: inputs.reviewMode === 'self' ? 'pending_author_self_review' : 'pending_independent_review', output, notApproval: true, digest: gates.validation };
    }
    return { status: 'structural_review_binding_passed_not_semantic_proof', digest: gates.validation, ...validateReview(JSON.parse(readPublicationFile(p.rootDir, p.reviewPath)), inputs) };
  }
  if (command === 'send') {
    const configFile = required('--config');
    const target = pinnedTarget(configFile, readJson(configFile).lark);
    return sendDelivery(readJson(required('--plan')), { authorized: argv.includes('--allow-send'), target });
  }
  if (!['inspect-config', 'collect', 'prepare-delivery', 'import-browser', 'import-feed', 'coverage-plan', 'coverage-report'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const configFile = path.resolve(value('--config', path.join(root, 'config/runtime.example.json')));
  const config = readJson(configFile);
  const sourcesFile = config.sourcesFile ? path.resolve(path.dirname(configFile), config.sourcesFile) : path.join(root, 'config/sources.json');
  const sources = readJson(sourcesFile);
  if (command === 'prepare-delivery') {
    const p = publication();
    const plan = prepareDelivery(fs.readFileSync(required('--digest'), 'utf8'), readJson(required('--sources')), pinnedTarget(configFile, config.lark), p);
    const output = required('--out');
    write(output, JSON.stringify(plan, null, 2) + '\n');
    return { status: plan.status, output, target: plan.target, validation: plan.validation };
  }
  const runtime = makeRuntime({ ...config, sources });
  if (command === 'import-browser') {
    const artifactFile = required('--artifacts');
    const bundle = readJson(artifactFile);
    verifyEvidenceFiles(bundle, path.dirname(path.resolve(artifactFile)));
    const collection = collectionFromBrowserArtifacts(runtime, bundle);
    const output = required('--out');
    const store = openCoverageStore(runtime, collection.collectedAt);
    try {
      collection.coverage.accounting = recordCollectionCoverage(store.state, collection);
      write(output, JSON.stringify(collection, null, 2) + '\n');
      store.save(store.state);
    } finally { store.close(); }
    return { status: 'browser_artifacts_imported', coverage: collection.coverage.accounting, output, collectionId: collection.collectionId, stats: collection.stats, warnings: collection.warnings };
  }
  if (command === 'import-feed') {
    const { verifyDocumentFiles, mergeFeedDocuments } = await import('./feed-import.mjs');
    const artifactFile = required('--artifacts');
    const bundle = readJson(artifactFile);
    const baseDir = path.dirname(path.resolve(artifactFile));
    verifyDocumentFiles(bundle, baseDir);
    const input = argv.includes('--sources') ? readJson(required('--sources')) : null;
    const maxText = argv.includes('--preserve-full-text') ? Infinity : undefined;
    const collection = mergeFeedDocuments(runtime, input, bundle, baseDir, maxText ? { maxText } : {});
    const output = required('--out');
    write(output, JSON.stringify(collection, null, 2) + '\n');
    return { status: 'feed_documents_imported', stats: collection.stats, warnings: collection.warnings.slice((input?.warnings ?? []).length), output };
  }
  if (command === 'coverage-plan' || command === 'coverage-report') {
    const now = value('--now', new Date().toISOString());
    const state = loadCoverageState(runtime, now);
    const result = command === 'coverage-report' ? coverageReport(state, now) : {
      status: 'offline_coverage_plan', windows: planCoverage(state, { now, initialWindowHours: runtime.initialWindowHours }),
      budget: { perWindowMs: runtime.maxFeedMs, maxPages: runtime.maxPages, totalMs: runtime.totalBudgetMs, liveVerified: false },
      execution: executionPolicy(runtime, { transport: 'cua' }), coverage: coverageReport(state, now) };
    const output = value('--out');
    if (output) write(output, JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  if (command === 'inspect-config') {
    return { status: 'offline_configuration', node: process.version, cdpPort: runtime.cdpPort,
      collectionEnabled: runtime.collectionEnabled, lookbackHours: runtime.lookbackHours,
      coverageHorizonHours: 48, budgets: { maxPages: runtime.maxPages, maxFeedMs: runtime.maxFeedMs, totalBudgetMs: runtime.totalBudgetMs, liveVerified: false },
      execution: executionPolicy(runtime, { transport: 'cua' }),
      ocr: runtime.ocr.provider, lark: config.lark,
      sourceCounts: { blogs: sources.blogs.length, xiaohongshuProfiles: sources.xiaohongshuProfiles.length },
      sendEnabled: false, requires: ['supported-browser capture artifacts, or separately authorized independent CDP browser', 'external model controller', 'separately verified Lark bot configuration and target'],
    };
  }
  const result = await createCollector(runtime).collect({ authorized: argv.includes('--allow-collection') });
  return { status: 'collected', output: path.join(runtime.runDir, 'sources.json'), collectionId: result.collectionId, stats: result.stats, warnings: result.warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
