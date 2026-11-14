// The Mac adapter supplies configuration and binds the shared pipeline's editorial result.
// Selection, enrichment, composition, backlog and telemetry live in run-daily.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { runDailyV2, validateV2Digest } from '../../run-daily.mjs';
import { loadModels } from '../../prototype/run-packets.mjs';
import { assertCollection, coverageStatusLine } from '../../digest.mjs';
import { canonicalUrl, citedUrls, candidateKeys } from '../../binding.mjs';
import { renderCompactTelemetryLine, renderTelemetryMarkdown, acquireLeaseLock } from '../../telemetry.mjs';
import { frozenApiRun, readApiKey } from './openai-draft.mjs';
import { buildReviewSnapshot, validateReview } from '../../review.mjs';
import { publicationGates } from '../../digest.mjs';
import { recentPublishedUrls } from '../../delivery-ledger.mjs';

const model = 'gpt-6.1-sol';
const endpoint = 'https://api.openai.com/v1/chat/completions';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function selectedEvidence(materials, cited, collectedAt) {
  const records = new Map();
  const add = (url, text) => {
    if (!url || !text?.trim()) return;
    const key = canonicalUrl(url);
    if (!records.has(key)) records.set(key, { url, parts: new Set() });
    records.get(key).parts.add(text);
  };
  // Keep all evidence the composer could use, including the ends of articles and
  // recorded dates. Link fan-out must never reduce the text available to review.
  for (const topic of materials) {
    for (const item of topic.observations) {
      add(item.url, 'Recorded source metadata: ' + JSON.stringify({ publishedAt: item.publishedAt,
        paperPublishedAt: topic.paperPublishedAt, topicPublishedAt: topic.publishedAt,
        collectedAt, author: item.author, sourceLabel: item.sourceLabel, contentStatus: item.contentStatus }));
      add(item.url, item.text);
    }
    if (topic.fetchedFullText) add(topic.fetchedFullText.url, topic.fetchedFullText.text);
  }
  for (const url of cited) {
    if (records.has(canonicalUrl(url))) continue;
    const topic = materials.find(item => [item.primaryUrl, ...(item.discussionUrls ?? []), ...(item.companionUrls ?? [])]
      .some(candidate => canonicalUrl(candidate) === canonicalUrl(url)));
    if (!topic) throw new Error('Published URL has no selected source material');
    // A discovered link is not a second reading of the article or repository.
    add(url, 'Recorded outbound link discovery: ' + JSON.stringify({ url, topicTitle: topic.title,
      sourceUrls: topic.observations.map(item => item.url), readDepth: 'link_only',
      limitation: 'This address was observed with the source topic. Its destination body was not independently read.' }));
    for (const item of topic.observations) {
      const offset = item.text?.indexOf(url) ?? -1;
      if (offset >= 0) add(url, item.text.slice(Math.max(0, offset - 600), offset + url.length + 600));
    }
  }
  return [...records.values()].map(({ url, parts }) => ({ url, text: [...parts].join('\n\n') }));
}

export function preparePublication(runDir, revisionOf) {
  const state = read(path.join(runDir, 'prepare-state.json'));
  const runMetadata = read(path.join(runDir, 'run.json'));
  if (revisionOf && runMetadata.revisionOf !== revisionOf) throw new Error('Revision intent differs from the frozen run');
  const sources = read(path.join(runDir, 'sources.merged.json'));
  const prepared = read(path.join(runDir, 'prepared-topics.json'));
  const original = fs.readFileSync(path.join(runDir, 'digest.md'), 'utf8');
  const body = original.split('\n### 运行自检')[0].trim();
  validateV2Digest(body, { date: sources.date, observedUrlSet: new Set(state.observedUrls) });
  const telemetryData = read(path.join(runDir, 'telemetry.json'));
  const available = prepared.filter(row => row.material.contentStatus === 'full_text').length;
  telemetryData.funnel.deepFetch = { ...telemetryData.funnel.deepFetch, attempted: prepared.length,
    fullText: available, snippetOnly: prepared.length - available };
  save(path.join(runDir, 'telemetry.json'), telemetryData);
  const telemetry = renderTelemetryMarkdown(telemetryData);
  const compactTelemetry = renderCompactTelemetryLine(telemetryData);
  const scopeNote = '统计口径：候选计数只包括本轮直接采集，话题计数还包括公开补充与历史缓存，一篇成稿可能综合多个来源。正文可用表示已保存正文材料，不代表已完整通读每个页面。';
  const coverage = coverageStatusLine(sources) + '\n\n' + telemetry + '\n\n' + scopeNote;
  const keys = new Set(candidateKeys(sources));
  const dispositions = read(path.join(runDir, 'dispositions.json'));
  const accounting = { publicationIntent: { date: sources.date,
    mode: revisionOf ? 'same_day_revision' : 'daily_report',
    priorAcceptedSameDayReport: Boolean(revisionOf),
    noticeMeaning: revisionOf ? 'The user requested this new report to replace the earlier accepted report for the same date. The controller validated the original receipt when creating this revision run.' : 'The regular report for this date.',
    deliveryState: 'not_sent; replacement takes effect when the reviewed report is delivered' },
    candidateKeys: keys.size, dispositionRows: dispositions.items.map(row => ({
    disposition: row.disposition, count: row.keys?.length ?? 1 })),
    pipelineCounters: telemetryData.funnel, rawCounts: state.counts, backlogSnapshot: state.backlogStats,
    selectedTopics: prepared.map(row => ({ topicId: row.topicId, section: row.section,
      sourceCandidateCount: (state.topics.find(topic => topic.topicId === row.topicId)?.candidateKeys ?? []).filter(key => keys.has(key)).length,
      fromBacklog: row.material.fromBacklog, contentStatus: row.material.contentStatus,
      ...(row.material.fetchedFullText ? {
        fetchedArticle: {
          url: row.material.fetchedFullText.url,
          contentStatus: row.material.fetchedFullText.contentStatus ?? row.material.contentStatus,
          preservedCharacters: row.material.fetchedFullText.text.length,
        },
      } : {}),
      sources: row.material.observations.map(item => ({ url: item.url, contentStatus: item.contentStatus,
        preservedCharacters: item.text.length })) })) };
  const accountingText = 'Deterministic pipeline accounting from preserved prepare-state, prepared-topics, dispositions and telemetry snapshots:\n' + JSON.stringify(accounting);
  fs.writeFileSync(path.join(runDir, 'collection-coverage.md'), compactTelemetry + '\n\n' + coverage + '\n\n' + accountingText + '\n', { mode: 0o600 });
  const revised = revisionOf
    ? body.replace(/^(# X AI 日报 [^\n]+)\n/, '$1\n' + Number(sources.date.slice(5, 7)) + ' 月 ' + Number(sources.date.slice(-2)) + ' 日修订版。本版替代今天此前的日报。\n')
    : body;
  // The self-check panel is rendered once, inside the audit section that the coverage evidence binds.
  const markdown = revised + '\n\n' + compactTelemetry + '\n\n' +
    sources.digestMarker + '\n\n## 差异补充\n\n' + coverage + '\n';
  fs.writeFileSync(path.join(runDir, 'digest.publication.md'), markdown, { mode: 0o600 });

  const urls = [...new Set(citedUrls(body))];
  const materials = prepared.map(row => row.material);
  const excerpts = [];
  const materialsPaths = ['canonical-materials.json', 'collection-coverage.md', 'prepared-topics.json', 'run.json'];
  const publicDir = path.join(runDir, 'publication-evidence');
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o700 });
  const evidence = selectedEvidence(materials, urls, sources.collectedAt);
  for (const [index, { url, text }] of evidence.entries()) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Publication needs an observed HTTPS URL');
    if (!text || text.trim().length < 8) throw new Error('Published URL has no readable evidence');
    const backing = 'publication-evidence/source-' + (index + 1) + '.txt';
    fs.writeFileSync(path.join(runDir, backing), url + '\n\n' + text + '\n', { mode: 0o600 });
    materialsPaths.push(backing);
    for (let start = 0, part = 1; start < text.length; start += 2800, part++) {
      const chunk = text.slice(Math.min(start, Math.max(0, text.length - 8)), start + 2800);
      if (chunk.trim().length >= 8) excerpts.push({ id: `source-${index + 1}-${part}`, kind: 'public', path: backing, url, text: chunk });
    }
  }
  excerpts.push({ id: 'pipeline-coverage', kind: 'coverage', path: 'collection-coverage.md', text: compactTelemetry + '\n\n' + coverage });
  for (let start = 0, part = 1; start < accountingText.length; start += 2800, part++) {
    excerpts.push({ id: `pipeline-accounting-${part}`, kind: 'coverage', path: 'collection-coverage.md',
      text: accountingText.slice(Math.min(start, Math.max(0, accountingText.length - 8)), start + 2800) });
  }
  save(path.join(runDir, 'canonical-materials.json'), { sources: evidence.map(({ url }) => ({ url })), origin: 'prepared-topics.json' });
  save(path.join(runDir, 'api-final-input.json'), { schemaVersion: 1, collectionId: sources.collectionId,
    materialsPaths, evidencePaths: [], excerpts });
  return markdown;
}

export async function runProductionDaily({ runDir, runsDir, dataDir, ledgerDir, keyFile,
  screenModel = model, composeModel = model, reviewModel = composeModel, modelsFile: configuredModelsFile, fetchImpl = globalThis.fetch }) {
  const { run, sources, sourcesPath } = frozenApiRun(runsDir, runDir);
  assertCollection(sources);
  const resultPath = path.join(runDir, 'daily-result.json');
  if (fs.existsSync(resultPath)) return read(resultPath);
  const lock = acquireLeaseLock(path.join(runDir, 'daily.lock'));
  const heartbeat = setInterval(() => lock.heartbeat('daily'), 60000);
  heartbeat.unref();
  const previousKey = process.env.CODEX_API_KEY;
  try {
    if (!configuredModelsFile) process.env.CODEX_API_KEY = readApiKey(keyFile);
    const role = name => ({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: name,
      apiKeyEnv: 'CODEX_API_KEY', maxTokens: 20000, maxTokensRetry: 28000,
      maxTokensParam: 'max_completion_tokens', reasoningEffort: 'high' });
    const modelsFile = configuredModelsFile ?? path.join(runDir, 'daily-models.json');
    if (!configuredModelsFile) save(modelsFile, { roles: { screen: role(screenModel), compose: role(composeModel), review: role(reviewModel) } });
    loadModels(modelsFile, ['screen', 'compose', 'review'], [], { fetch: fetchImpl });
    const supplementsPath = path.join(runDir, 'supplements.public.json');
    const supplements = fs.existsSync(supplementsPath) ? read(supplementsPath) : [];
    const result = await runDailyV2({ dataDir, runDir,
      sourcesFile: path.join(runDir, 'sources.frozen.json'),
      premergedSourcesPath: path.join(runDir, sourcesPath), supplements, modelsFile,
      publishedHistoryFile: path.join(ledgerDir, 'published-urls.jsonl'),
      runtimeHooks: { modelArtifactsDir: path.join(runDir, 'daily-model-artifacts'),
        resumeModels: true, publicationPending: true,
        fetch: async (url, init) => {
          if (url !== endpoint) return fetchImpl(url, init);
          const body = JSON.parse(init.body);
          return fetchImpl(endpoint, { ...init, redirect: 'error',
            body: JSON.stringify({ ...body, store: false }) });
        } },
    });
    // The shared v2 reviewer already returned the corrected final prose.
    // Publication packaging is deterministic and adds no second model review.
    preparePublication(runDir, run.revisionOf);
    const packet = read(path.join(runDir, 'api-final-input.json'));
    const snapshotInputs = { digestPath: 'digest.publication.md', dispositionsPath: 'dispositions.json',
      sourcesPath: 'sources.merged.json', materialsPaths: [...packet.materialsPaths, 'editorial-review.json'],
      evidencePaths: [...new Set([...(sources.provenance?.evidence ?? []).map(row => row.path), ...packet.evidencePaths])],
      authorId: 'pipeline:' + composeModel, reviewMode: 'self', reviewProtocol: 'v2-single-pass',
      renderStyle: 'concise', transport: 'feishu-post-v1' };
    const markdown = fs.readFileSync(path.join(runDir, snapshotInputs.digestPath), 'utf8');
    const gates = publicationGates(runDir, snapshotInputs, markdown, sources,
      { publishedHistory: recentPublishedUrls(ledgerDir, { before: run.date }) });
    const inputs = { rootDir: runDir, ...snapshotInputs, renderedMarkdown: gates.renderedMarkdown };
    const snapshot = buildReviewSnapshot(inputs);
    const review = { schemaVersion: 1, kind: 'x-daily-single-pass-review-v1', status: 'approved',
      reviewerId: 'pipeline:' + reviewModel, reviewedAt: new Date().toISOString(),
      snapshotSha256: snapshot.snapshotSha256, bindings: snapshot.bindings,
      editorialReviewPath: 'editorial-review.json' };
    validateReview(review, inputs);
    save(path.join(runDir, 'review.single-pass.json'), review);
    const publication = path.join(runDir, 'publication.json');
    save(publication, { rootDir: '.', snapshotInputs, reviewPath: 'review.single-pass.json', ledgerDir });
    const completed = { ...result, status: 'daily_reviewed_not_sent', publication,
      pipeline: 'run-daily.mjs', reviewProtocol: 'v2-single-pass', revisionOf: run.revisionOf ?? null };
    save(resultPath, completed);
    return completed;
  } finally {
    clearInterval(heartbeat);
    if (previousKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousKey;
    lock.release();
  }
}
