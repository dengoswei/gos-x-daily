import fs from 'node:fs';
import path from 'node:path';
import { readPublicationFile } from '../../binding.mjs';
import { orchestrate } from '../../prototype/orchestrate.mjs';

const model = 'gpt-6.1-sol';
const effort = 'high';
const endpoint = 'https://api.openai.com/v1/chat/completions';
const keyName = 'CODEX_API_KEY';

function readApiKey(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Configure an absolute OpenAI draft key file');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const entries = lines.filter(line => /^\s*CODEX_API_KEY\s*[:=]/.test(line));
  const match = entries[0]?.match(/^\s*CODEX_API_KEY\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#.*)?\s*$/);
  if (entries.length !== 1 || !match) throw new Error('Expected one CODEX_API_KEY value in the configured key file');
  return match[1] ?? match[2] ?? match[3];
}

export async function draftOpenAI({ runsDir, runDir, keyFile, resume = false, fetchImpl = globalThis.fetch }) {
  const root = fs.realpathSync(runsDir);
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || path.dirname(runDir) !== root || fs.realpathSync(runDir) !== runDir) {
    throw new Error('API draft requires a real run directly inside the configured runs directory');
  }
  const run = JSON.parse(readPublicationFile(runDir, 'run.json'));
  const sources = JSON.parse(readPublicationFile(runDir, 'sources.json'));
  if (typeof run.date !== 'string' || sources.date !== run.date || !path.basename(runDir).startsWith(run.date + '-')) {
    throw new Error('API draft source date does not match the frozen run');
  }

  const key = readApiKey(keyFile);
  const role = (maxTokens, concurrency) => ({
    kind: 'openai', baseUrl: 'https://api.openai.com/v1', model, apiKeyEnv: keyName,
    maxTokens, maxTokensRetry: maxTokens * 2, maxTokensParam: 'max_completion_tokens', concurrency,
  });
  const modelConfig = JSON.stringify({
    reasoningEffort: effort,
    budget: { maxCalls: 100, maxInputTokens: 500000, maxOutputTokens: 150000 },
    roles: { screen: role(8000, 4), story: role(8000, 4), compose: role(18000, 1) },
  }, null, 2) + '\n';
  const modelsFile = path.join(runDir, 'api-draft-models.json');
  const outDir = path.join(runDir, 'api-draft');
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
          if (url !== endpoint || init.method !== 'POST' || body.model !== model || body.tools) {
            throw new Error('Unexpected OpenAI draft request');
          }
          const response = await fetchImpl(endpoint, {
            ...init, redirect: 'error',
            body: JSON.stringify({ ...body, reasoning_effort: effort, store: false }),
          });
          if (response.status === 401 || response.status === 403) {
            return new Response('OpenAI denied the configured key or model access', { status: response.status });
          }
          if (response.ok) {
            const actual = (await response.clone().json()).model;
            if (actual !== model && !actual?.startsWith(model + '-')) throw new Error('OpenAI returned a different draft model');
          }
          return response;
        },
      },
    });
    if (!report.validation.passed) throw new Error(`OpenAI draft rejected. Inspect ${outDir}/report.json`);
    return {
      status: 'api_draft_validated', model, reasoningEffort: effort, outDir,
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
