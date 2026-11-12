// The Mac adapter supplies credentials and publication review to the repository pipeline.
// Selection, enrichment, composition, backlog and telemetry live in run-daily.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { runDailyV2, validateV2Digest } from '../../run-daily.mjs';
import { assertCollection, coverageStatusLine } from '../../digest.mjs';
import { canonicalUrl, citedUrls } from '../../binding.mjs';
import { renderTelemetryMarkdown, acquireLeaseLock } from '../../telemetry.mjs';
import { frozenApiRun, readApiKey } from './openai-draft.mjs';
import { finalizeOpenAI } from './openai-final.mjs';

const model = 'gpt-6.1-sol';
const endpoint = 'https://api.openai.com/v1/chat/completions';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function prepareGeneratedPublication(runDir, generated, revisionOf) {
  const state = read(path.join(runDir, 'prepare-state.json'));
  const sources = read(path.join(runDir, 'sources.merged.json'));
  const prepared = read(path.join(runDir, 'prepared-topics.json'));
  const original = fs.readFileSync(path.join(runDir, 'digest.md'), 'utf8');
  const body = original.split('\n### 运行自检')[0].trim();
  validateV2Digest(body, { date: sources.date, observedUrlSet: new Set(state.observedUrls) });
  const telemetry = renderTelemetryMarkdown(read(path.join(runDir, 'telemetry.json')));
  const coverage = coverageStatusLine(sources) + '\n\n' + telemetry;
  fs.writeFileSync(path.join(runDir, 'collection-coverage.md'), coverage + '\n', { mode: 0o600 });
  const revised = revisionOf
    ? body.replace(/^(# X AI 日报 [^\n]+)\n/, '$1\n' + Number(sources.date.slice(5, 7)) + ' 月 ' + Number(sources.date.slice(-2)) + ' 日修订版。本版替代今天此前的日报。\n')
    : body;
  const markdown = revised + '\n\n本次采集范围以本次冻结的来源与时间窗口为准。\n\n' +
    telemetry.replace(/^- /gm, '') + '\n\n' + sources.digestMarker + '\n\n## 差异补充\n\n' + coverage + '\n';
  fs.writeFileSync(path.join(runDir, 'digest.publication.md'), markdown, { mode: 0o600 });

  const urls = [...new Set(citedUrls(body))];
  const materials = prepared.map(row => row.material);
  const excerpts = [];
  const materialsPaths = ['canonical-materials.json', 'collection-coverage.md', 'prepared-topics.json'];
  const publicDir = path.join(runDir, 'publication-evidence');
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o700 });
  const perUrl = Math.min(24000, Math.floor(150000 / Math.max(1, urls.length)));
  for (const [index, url] of urls.entries()) {
    const parsed = new URL(url);
    if (parsed.search || parsed.protocol !== 'https:') throw new Error('Publication needs an observed public URL without a query string');
    const topic = materials.find(item => [item.primaryUrl, ...(item.discussionUrls ?? []), ...(item.companionUrls ?? [])]
      .some(candidate => canonicalUrl(candidate) === canonicalUrl(url)));
    if (!topic) throw new Error('Published URL has no selected source material');
    const direct = topic.observations.filter(item => item.url && canonicalUrl(item.url) === canonicalUrl(url));
    const text = topic.fetchedFullText && [topic.fetchedFullText.url, topic.primaryUrl].some(item => canonicalUrl(item) === canonicalUrl(url))
      ? topic.fetchedFullText.text : (direct.length ? direct : topic.observations).map(item => item.text).join('\n\n');
    if (!text || text.trim().length < 8) throw new Error('Published URL has no readable evidence');
    const backing = 'publication-evidence/source-' + (index + 1) + '.txt';
    fs.writeFileSync(path.join(runDir, backing), url + '\n\n' + text + '\n', { mode: 0o600 });
    materialsPaths.push(backing);
    const visible = text.slice(0, perUrl);
    for (let start = 0, part = 1; start < visible.length; start += 2800, part++) {
      const chunk = visible.slice(start, start + 2800);
      if (chunk.trim().length >= 8) excerpts.push({ id: `source-${index + 1}-${part}`, kind: 'public', path: backing, url, text: chunk });
    }
  }
  excerpts.push({ id: 'pipeline-coverage', kind: 'coverage', path: 'collection-coverage.md', text: coverage });
  save(path.join(runDir, 'canonical-materials.json'), { sources: urls.map(url => ({ url })), origin: 'prepared-topics.json' });
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
      const artifactDir = fs.mkdtempSync(path.join(runDir, 'daily-model-artifacts-'));
      const result = await runDailyV2({ dataDir, runDir, sourcesFile: path.join(runDir, 'sources.frozen.json'),
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
