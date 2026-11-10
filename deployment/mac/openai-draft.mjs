import fs from 'node:fs';
import path from 'node:path';
import { readPublicationFile } from '../../binding.mjs';
import { orchestrate } from '../../prototype/orchestrate.mjs';

const sol = 'gpt-6.1-sol';
const terra = 'gpt-6.1-terra';
const defaultModels = { screen: sol, story: sol, compose: sol };
const effort = 'high';
const endpoint = 'https://api.openai.com/v1/chat/completions';
const keyName = 'CODEX_API_KEY';

export function readApiKey(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Configure an absolute OpenAI draft key file');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const entries = lines.filter(line => /^\s*CODEX_API_KEY\s*[:=]/.test(line));
  const match = entries[0]?.match(/^\s*CODEX_API_KEY\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#.*)?\s*$/);
  if (entries.length !== 1 || !match) throw new Error('Expected one CODEX_API_KEY value in the configured key file');
  return match[1] ?? match[2] ?? match[3];
}

export function frozenApiRun(runsDir, runDir) {
  const root = fs.realpathSync(runsDir);
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || path.dirname(runDir) !== root || fs.realpathSync(runDir) !== runDir) {
    throw new Error('API runner requires a real run directly inside the configured runs directory');
  }
  const run = JSON.parse(readPublicationFile(runDir, 'run.json'));
  const sourcesText = readPublicationFile(runDir, 'sources.json');
  const sources = JSON.parse(sourcesText);
  if (typeof run.date !== 'string' || sources.date !== run.date || !path.basename(runDir).startsWith(run.date + '-')) {
    throw new Error('API source date does not match the frozen run');
  }
  return { run, sources, sourcesText };
}

export async function draftOpenAI({ runsDir, runDir, keyFile, models = defaultModels, resume = false, fetchImpl = globalThis.fetch }) {
  frozenApiRun(runsDir, runDir);

  if (!models || ![sol, terra].includes(models.screen) || models.story !== sol || models.compose !== sol) {
    throw new Error('API draft needs a supported screen model and Sol for story and compose');
  }
  const key = readApiKey(keyFile);
  const role = (model, maxTokens, concurrency) => ({
    kind: 'openai', baseUrl: 'https://api.openai.com/v1', model, apiKeyEnv: keyName,
    maxTokens, maxTokensRetry: maxTokens * 2, maxTokensParam: 'max_completion_tokens', concurrency,
  });
  const modelConfig = JSON.stringify({
    reasoningEffort: effort,
    budget: { maxCalls: 100, maxInputTokens: 500000, maxOutputTokens: 150000 },
    roles: { screen: role(models.screen, 8000, 4), story: role(models.story, 8000, 4), compose: role(models.compose, 18000, 1) },
  }, null, 2) + '\n';
  const modelsFile = path.join(runDir, 'api-draft-models.json');
  const outDir = path.join(runDir, 'api-draft');
  const usagePath = path.join(outDir, 'api-usage.jsonl');
  const lock = path.join(runDir, 'api-draft.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const previous = process.env[keyName];
  const redact = text => String(text).replaceAll(key, '[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
  try {
    if (resume) {
      if (readPublicationFile(runDir, 'api-draft-models.json') !== modelConfig) throw new Error('API draft model configuration changed');
    } else {
      fs.writeFileSync(modelsFile, modelConfig, { flag: 'wx', mode: 0o600 });
    }
    process.env[keyName] = key;
    const report = await orchestrate({
      runDir, modelsFile, outDir, resume: resume && fs.existsSync(outDir),
      runtime: {
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          const stage = body.messages?.[0]?.content?.match(/^<!-- stage: (screen|story|compose) -->/)?.[1];
          if (url !== endpoint || init.method !== 'POST' || !stage || body.model !== models[stage] || body.tools) {
            throw new Error('Unexpected OpenAI draft request');
          }
          const response = await fetchImpl(endpoint, {
            ...init, redirect: 'error',
            body: JSON.stringify({ ...body, reasoning_effort: effort, service_tier: 'default', store: false }),
          });
          if (response.status === 401 || response.status === 403) {
            return new Response('OpenAI denied the configured key or model access', { status: response.status });
          }
          const payload = await response.clone().json().catch(() => null);
          const actual = payload?.model;
          if (response.ok && actual !== body.model && !actual?.startsWith(body.model + '-')) throw new Error('OpenAI returned a different draft model');
          const usage = payload?.usage;
          fs.appendFileSync(usagePath, JSON.stringify({
            stage, model: body.model, reasoningEffort: effort, status: response.status,
            serviceTier: payload?.service_tier, inputTokens: usage?.prompt_tokens,
            cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens,
            cacheWriteInputTokens: usage?.prompt_tokens_details?.cache_write_tokens,
            outputTokens: usage?.completion_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
          }) + '\n', { mode: 0o600 });
          return response;
        },
      },
    });
    if (!report.validation.passed) throw new Error(`OpenAI draft rejected. Inspect ${outDir}/report.json`);
    return {
      status: 'api_draft_validated', models, reasoningEffort: effort, outDir, usagePath,
      mainBullets: report.validation.digest.mainBullets, stages: report.stages, notApproval: true,
    };
  } catch (error) {
    throw new Error(redact(error.message));
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
    fs.rmdirSync(lock);
  }
}
