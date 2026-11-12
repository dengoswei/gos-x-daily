// The Mac adapter supplies credentials and publication review to the repository pipeline.
// Selection, enrichment, composition, backlog and telemetry live in run-daily.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { runDailyV2, validateV2Digest, normalizeDigestSectionOrder } from '../../run-daily.mjs';
import { extractBlock, tagged, modelJson } from '../../prototype/run-packets.mjs';
import { assertCollection, coverageStatusLine } from '../../digest.mjs';
import { canonicalUrl, citedUrls, candidateKeys } from '../../binding.mjs';
import { renderTelemetryMarkdown, acquireLeaseLock } from '../../telemetry.mjs';
import { frozenApiRun, readApiKey } from './openai-draft.mjs';
import { finalizeOpenAI } from './openai-final.mjs';

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

export function resumeGeneratedDraft(runDir, collectionId) {
  const file = path.join(runDir, 'generated-author.json');
  if (!fs.existsSync(file)) return null;
  const generated = read(file);
  const prepared = read(path.join(runDir, 'prepared-topics.json'));
  const packet = read(path.join(runDir, 'api-final-input.json'));
  const body = fs.readFileSync(path.join(runDir, 'digest.md'), 'utf8').split('\n### 运行自检')[0].trim();
  const authored = normalizeDigestSectionOrder(extractBlock(generated.content, 'markdown')).trim();
  const materialInput = tagged('selected_topics', modelJson(prepared));
  if (packet.collectionId !== collectionId || body !== authored ||
      !generated.id || !generated.actualModel || !generated.finishedAt ||
      !generated.messages?.some(message => message.role === 'user' && message.content.includes(materialInput))) {
    throw new Error('Saved composer transcript no longer matches the draft, selected material or collection');
  }
  return generated;
}

export function prepareGeneratedPublication(runDir, generated, revisionOf) {
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
      sources: row.material.observations.map(item => ({ url: item.url, contentStatus: item.contentStatus,
        preservedCharacters: item.text.length })) })) };
  const accountingText = 'Deterministic pipeline accounting from preserved prepare-state, prepared-topics, dispositions and telemetry snapshots:\n' + JSON.stringify(accounting);
  fs.writeFileSync(path.join(runDir, 'collection-coverage.md'), coverage + '\n\n' + accountingText + '\n', { mode: 0o600 });
  const revised = revisionOf
    ? body.replace(/^(# X AI 日报 [^\n]+)\n/, '$1\n' + Number(sources.date.slice(5, 7)) + ' 月 ' + Number(sources.date.slice(-2)) + ' 日修订版。本版替代今天此前的日报。\n')
    : body;
  const markdown = revised + '\n\n本次采集范围以本次冻结的来源与时间窗口为准。\n\n' +
    telemetry.replace(/^- /gm, '') + '\n\n' + scopeNote + '\n\n' + sources.digestMarker + '\n\n## 差异补充\n\n' + coverage + '\n';
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
    if (parsed.search || parsed.protocol !== 'https:') throw new Error('Publication needs an observed public URL without a query string');
    if (!text || text.trim().length < 8) throw new Error('Published URL has no readable evidence');
    const backing = 'publication-evidence/source-' + (index + 1) + '.txt';
    fs.writeFileSync(path.join(runDir, backing), url + '\n\n' + text + '\n', { mode: 0o600 });
    materialsPaths.push(backing);
    for (let start = 0, part = 1; start < text.length; start += 2800, part++) {
      const chunk = text.slice(Math.min(start, Math.max(0, text.length - 8)), start + 2800);
      if (chunk.trim().length >= 8) excerpts.push({ id: `source-${index + 1}-${part}`, kind: 'public', path: backing, url, text: chunk });
    }
  }
  excerpts.push({ id: 'pipeline-coverage', kind: 'coverage', path: 'collection-coverage.md', text: coverage });
  for (let start = 0, part = 1; start < accountingText.length; start += 2800, part++) {
    excerpts.push({ id: `pipeline-accounting-${part}`, kind: 'coverage', path: 'collection-coverage.md',
      text: accountingText.slice(Math.min(start, Math.max(0, accountingText.length - 8)), start + 2800) });
  }
  save(path.join(runDir, 'canonical-materials.json'), { sources: evidence.map(({ url }) => ({ url })), origin: 'prepared-topics.json' });
  save(path.join(runDir, 'api-final-input.json'), { schemaVersion: 1, collectionId: sources.collectionId,
    materialsPaths, evidencePaths: [], excerpts });
  save(path.join(runDir, 'generated-author.json'), generated);
  return markdown;
}

export async function runProductionDaily({ runDir, runsDir, dataDir, ledgerDir, keyFile,
  screenModel = model, fetchImpl = globalThis.fetch }) {
  const { run, sources, sourcesPath } = frozenApiRun(runsDir, runDir);
  assertCollection(sources);
  if (![model, 'gpt-6.1-terra'].includes(screenModel)) throw new Error('Unsupported configured screening model');
  const resultPath = path.join(runDir, 'daily-result.json');
  if (fs.existsSync(resultPath)) return read(resultPath);
  const key = readApiKey(keyFile);
  const lock = acquireLeaseLock(path.join(runDir, 'daily.lock'));
  const heartbeat = setInterval(() => lock.heartbeat('daily'), 60000);
  heartbeat.unref();
  const previousKey = process.env.CODEX_API_KEY;
  const usagePath = path.join(runDir, 'daily-usage.jsonl');
  const log = value => fs.appendFileSync(usagePath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  const role = name => ({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: name,
    apiKeyEnv: 'CODEX_API_KEY', maxTokens: 16000, maxTokensRetry: 24000, maxTokensParam: 'max_completion_tokens' });
  const modelsFile = path.join(runDir, 'daily-models.json');
  save(modelsFile, { roles: { screen: role(screenModel), compose: role(model) } });
  const supplementsPath = path.join(runDir, 'supplements.public.json');
  const supplements = fs.existsSync(supplementsPath) ? read(supplementsPath) : [];
  let generated;
  let feedback;
  try {
    process.env.CODEX_API_KEY = key;
    for (let attempt = 1; attempt <= 2; attempt++) {
      generated = attempt === 1 ? resumeGeneratedDraft(runDir, sources.collectionId) : null;
      let result = { runDir, digestPath: path.join(runDir, 'digest.md'), telemetryPath: path.join(runDir, 'telemetry.json') };
      if (generated) log({ event: 'resumed_generated_draft', requestId: generated.id });
      else {
        const artifactDir = fs.mkdtempSync(path.join(runDir, 'daily-model-artifacts-'));
        result = await runDailyV2({ dataDir, runDir, sourcesFile: path.join(runDir, 'sources.frozen.json'),
          premergedSourcesPath: path.join(runDir, sourcesPath), supplements, modelsFile,
          publishedHistoryFile: path.join(ledgerDir, 'published-urls.jsonl'),
          runtimeHooks: { modelArtifactsDir: artifactDir, editorialFeedback: feedback, publicationPending: true,
            fetch: async (url, init) => {
              if (url !== endpoint) return fetchImpl(url, init);
              const body = JSON.parse(init.body);
              if (init.method !== 'POST' || ![model, screenModel].includes(body.model) || body.tools) throw new Error('Unexpected daily model request');
              log({ event: 'started', model: body.model, inputBytes: Buffer.byteLength(init.body) });
              const response = await fetchImpl(endpoint, { ...init, redirect: 'error',
                body: JSON.stringify({ ...body, reasoning_effort: 'high', service_tier: 'default', store: false }) });
              const payload = await response.clone().json().catch(() => null);
              log({ event: 'response', status: response.status, requestId: payload?.id, model: payload?.model, usage: payload?.usage });
              if (response.ok && payload?.model !== body.model && !payload?.model?.startsWith(body.model + '-')) throw new Error('Unexpected daily model response');
              if (body.messages[0]?.content.includes('digest composition (v2)') && payload?.choices?.[0]?.finish_reason === 'stop') {
                generated = { messages: body.messages, content: payload.choices[0].message.content,
                  id: payload.id, actualModel: payload.model, finishedAt: new Date().toISOString() };
              }
              return response;
            } },
        });
      }
      if (!generated) throw new Error('Missing original composer transcript');
      prepareGeneratedPublication(runDir, generated, run.revisionOf);
      try {
        const reviewed = await finalizeOpenAI({ runDir, runsDir, keyFile, ledgerDir,
          revision: Boolean(run.revisionOf), generated, fetchImpl });
        const completed = { ...result, ...reviewed, status: 'daily_reviewed_not_sent',
          pipeline: 'run-daily.mjs', revisionOf: run.revisionOf ?? null };
        save(resultPath, completed);
        return completed;
      } catch (error) {
        if (!error.findings?.length || attempt === 2) throw error;
        feedback = error.findings;
        log({ event: 'review_requires_revision', findings: feedback });
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (previousKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousKey;
    lock.release();
  }
}
