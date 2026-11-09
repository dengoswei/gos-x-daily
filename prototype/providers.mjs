// Provider-agnostic single-shot model calls for the P1 orchestrator prototype.
// A provider only turns a prompt into text plus usage; it holds no pipeline state,
// reads no evidence and never writes an artifact.
import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CALL_TIMEOUT_MS = 600000;
const KINDS = ['exec', 'openai', 'anthropic'];
const number = value => (Number.isFinite(value) ? value : undefined);
const trimSlash = value => String(value).replace(/\/+$/, '');

// Key names travel in config; key values only ever come from the environment.
function apiKey(spec) {
  if (typeof spec.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.apiKeyEnv)) throw new Error('Provider needs apiKeyEnv, an environment variable name');
  const key = process.env[spec.apiKeyEnv];
  if (!key) throw new Error(`Environment variable ${spec.apiKeyEnv} is not set`);
  return key;
}

function parseClaudeJson(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('Provider did not return parsable claude JSON output'); }
  if (payload?.is_error === true || payload?.stop_reason === 'refusal') {
    throw new Error(`Model declined or errored (subtype=${payload?.subtype ?? 'none'}, stop_reason=${payload?.stop_reason ?? 'none'})`);
  }
  const text = typeof payload?.result === 'string' ? payload.result : '';
  if (!text.trim()) throw new Error('Model returned an empty result');
  return { text, usage: { inputTokens: number(payload.usage?.input_tokens), outputTokens: number(payload.usage?.output_tokens), costUsd: number(payload.total_cost_usd) } };
}

function execProvider(spec) {
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(part => typeof part !== 'string')) throw new Error('exec provider needs a command argv array');
  if (spec.parse !== undefined && spec.parse !== 'claude-json') throw new Error('Unsupported exec parse mode');
  const [command, ...args] = spec.command;
  return ({ prompt }) => new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let outBytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`Provider command exceeded ${CALL_TIMEOUT_MS} ms`)); }, CALL_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); finish(new Error(`Provider output exceeded ${MAX_OUTPUT_BYTES} bytes`)); return; }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`Provider command exited with ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 2000)}`));
      const raw = Buffer.concat(out).toString('utf8');
      try {
        const parsed = spec.parse === 'claude-json' ? parseClaudeJson(raw) : { text: raw, usage: {} };
        if (!parsed.text.trim()) throw new Error('Provider command produced no output');
        finish(null, { ...parsed, durationMs: Date.now() - started });
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => { /* A provider that exits before reading the prompt fails on its close code. */ });
    child.stdin.end(prompt);
  });
}

async function postJson(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${raw.slice(0, 2000)}`);
  try { return JSON.parse(raw); } catch { throw new Error('Provider returned a non-JSON body'); }
}

// Covers OpenAI, DeepSeek and any OpenAI-compatible gateway.
function openaiProvider(spec) {
  if (typeof spec.baseUrl !== 'string' || typeof spec.model !== 'string') throw new Error('openai provider needs baseUrl and model');
  return async ({ prompt }) => {
    const key = apiKey(spec);
    const started = Date.now();
    const payload = await postJson(`${trimSlash(spec.baseUrl)}/chat/completions`, { authorization: `Bearer ${key}` },
      { model: spec.model, messages: [{ role: 'user', content: prompt }], ...(spec.maxTokens ? { max_tokens: spec.maxTokens } : {}) });
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new Error('Model response was filtered');
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!text.trim()) throw new Error(`Model returned no text (finish_reason=${choice?.finish_reason ?? 'none'})`);
    return { text, durationMs: Date.now() - started,
      usage: { inputTokens: number(payload.usage?.prompt_tokens), outputTokens: number(payload.usage?.completion_tokens) } };
  };
}

function anthropicProvider(spec) {
  if (typeof spec.model !== 'string' || !Number.isInteger(spec.maxTokens) || spec.maxTokens < 1) throw new Error('anthropic provider needs model and an integer maxTokens');
  return async ({ prompt }) => {
    const key = apiKey(spec);
    const started = Date.now();
    const payload = await postJson(`${trimSlash(spec.baseUrl ?? 'https://api.anthropic.com')}/v1/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: spec.model, max_tokens: spec.maxTokens, messages: [{ role: 'user', content: prompt }] });
    if (payload?.stop_reason === 'refusal') throw new Error('Model declined to answer (stop_reason=refusal)');
    const text = (Array.isArray(payload?.content) ? payload.content : []).filter(block => block?.type === 'text').map(block => block.text).join('');
    if (!text.trim()) throw new Error(`Model returned no text (stop_reason=${payload?.stop_reason ?? 'none'})`);
    return { text, durationMs: Date.now() - started,
      usage: { inputTokens: number(payload.usage?.input_tokens), outputTokens: number(payload.usage?.output_tokens) } };
  };
}

/** createProvider(spec).call({stage, prompt}) resolves to {text, usage, durationMs}. */
export function createProvider(spec) {
  if (!spec || typeof spec !== 'object' || !KINDS.includes(spec.kind)) throw new Error(`Provider kind must be one of: ${KINDS.join(', ')}`);
  const call = spec.kind === 'exec' ? execProvider(spec) : spec.kind === 'openai' ? openaiProvider(spec) : anthropicProvider(spec);
  return {
    kind: spec.kind,
    describe: () => ({ kind: spec.kind, ...(spec.model ? { model: spec.model } : {}), ...(spec.kind === 'exec' ? { command: spec.command[0], parse: spec.parse ?? 'text' } : { baseUrl: trimSlash(spec.baseUrl ?? 'https://api.anthropic.com') }) }),
    call: async ({ stage, prompt }) => {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A provider call needs a prompt');
      try { return await call({ stage, prompt }); }
      catch (error) { throw new Error(`${stage} provider (${spec.kind}) failed: ${error.message}`, { cause: error }); }
    },
  };
}
