// Provider-agnostic single-shot model calls for the orchestrator prototype.
// A provider only turns a (system, prompt) pair into text plus usage; it holds no
// pipeline state, reads no evidence and never writes an artifact.
import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CALL_TIMEOUT_MS = 600000;
const KINDS = ['exec', 'openai', 'anthropic'];
const TOKEN_PARAMS = ['max_tokens', 'max_completion_tokens'];
const RETRY_DEFAULTS = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryAfterMs: 120000 };
const number = value => (Number.isFinite(value) ? value : undefined);
const trimSlash = value => String(value).replace(/\/+$/, '');
const positiveInteger = (value, label) => { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; };

// Key names travel in config; key values only ever come from the environment.
function apiKey(spec) {
  if (typeof spec.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.apiKeyEnv)) throw new Error('Provider needs apiKeyEnv, an environment variable name');
  const key = process.env[spec.apiKeyEnv];
  if (!key) throw new Error(`Environment variable ${spec.apiKeyEnv} is not set`);
  return key;
}

const transient = (message, extra) => Object.assign(new Error(message), { retryable: true, ...extra });

function parseClaudeJson(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('Provider did not return parsable claude JSON output'); }
  if (payload?.is_error === true || payload?.stop_reason === 'refusal') {
    throw new Error(`Model declined or errored (subtype=${payload?.subtype ?? 'none'}, stop_reason=${payload?.stop_reason ?? 'none'})`);
  }
  const text = typeof payload?.result === 'string' ? payload.result : '';
  const truncated = payload?.stop_reason === 'max_tokens';
  if (!truncated && !text.trim()) throw new Error('Model returned an empty result');
  return { text, truncated, usage: { inputTokens: number(payload.usage?.input_tokens), outputTokens: number(payload.usage?.output_tokens),
    cachedInputTokens: number(payload.usage?.cache_read_input_tokens), cacheWriteInputTokens: number(payload.usage?.cache_creation_input_tokens),
    costUsd: number(payload.total_cost_usd) } };
}

// stdin is the only channel, so the stable system part and the variable part are concatenated.
function execProvider(spec) {
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(part => typeof part !== 'string')) throw new Error('exec provider needs a command argv array');
  if (spec.parse !== undefined && spec.parse !== 'claude-json') throw new Error('Unsupported exec parse mode');
  const [command, ...args] = spec.command;
  return ({ system, prompt }) => new Promise((resolve, reject) => {
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
        if (!parsed.truncated && !parsed.text.trim()) throw new Error('Provider command produced no output');
        finish(null, { ...parsed, durationMs: Date.now() - started });
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => { /* A provider that exits before reading the prompt fails on its close code. */ });
    child.stdin.end(system ? `${system}\n\n${prompt}` : prompt);
  });
}

/** Seconds or an HTTP date, as milliseconds from now; null when absent or unreadable. */
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// Network errors and 408/409/429/5xx are transient; any other status fails at once.
// A client-side timeout is not retried: the request may still have been processed and billed.
async function postJson(fetchImpl, url, headers, body) {
  let response, raw;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    raw = await response.text();
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`Provider request exceeded ${CALL_TIMEOUT_MS} ms`);
    throw transient(`Provider request failed: ${error?.message ?? error}`);
  }
  if (!response.ok) {
    const status = response.status;
    const message = `Provider HTTP ${status}: ${String(raw).slice(0, 2000)}`;
    if ([408, 409, 429].includes(status) || status >= 500) throw transient(message, { status, retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')) });
    throw Object.assign(new Error(message), { status });
  }
  try { return JSON.parse(raw); } catch { throw new Error('Provider returned a non-JSON body'); }
}

// Covers OpenAI, DeepSeek and any OpenAI-compatible gateway; prefix caching there is automatic.
function openaiProvider(spec, fetchImpl) {
  if (typeof spec.baseUrl !== 'string' || typeof spec.model !== 'string') throw new Error('openai provider needs baseUrl and model');
  const tokenParam = spec.maxTokensParam ?? 'max_tokens';
  if (!TOKEN_PARAMS.includes(tokenParam)) throw new Error(`maxTokensParam must be one of: ${TOKEN_PARAMS.join(', ')}`);
  return async ({ system, prompt, maxTokens }) => {
    const key = apiKey(spec);
    const started = Date.now();
    const limit = maxTokens ?? spec.maxTokens;
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
    const payload = await postJson(fetchImpl, `${trimSlash(spec.baseUrl)}/chat/completions`, { authorization: `Bearer ${key}` },
      { model: spec.model, messages, ...(limit ? { [tokenParam]: limit } : {}) });
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new Error('Model response was filtered');
    const content = choice?.message?.content;
    // Only the answer counts; a reasoner's separate reasoning_content is never used as one.
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
    const truncated = choice?.finish_reason === 'length';
    if (!truncated && !text.trim()) {
      const reasoningOnly = typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content.trim();
      throw new Error(`Model returned no text (finish_reason=${choice?.finish_reason ?? 'none'}${reasoningOnly ? '; only reasoning_content was returned' : ''})`);
    }
    const usage = payload?.usage ?? {};
    return { text, truncated, durationMs: Date.now() - started,
      usage: { inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens),
        cachedInputTokens: number(usage.prompt_tokens_details?.cached_tokens) ?? number(usage.prompt_cache_hit_tokens) } };
  };
}

// The stable system prefix carries an ephemeral cache breakpoint unless promptCache is false.
function anthropicProvider(spec, fetchImpl) {
  if (typeof spec.model !== 'string' || !Number.isInteger(spec.maxTokens) || spec.maxTokens < 1) throw new Error('anthropic provider needs model and an integer maxTokens');
  return async ({ system, prompt, maxTokens }) => {
    const key = apiKey(spec);
    const started = Date.now();
    const payload = await postJson(fetchImpl, `${trimSlash(spec.baseUrl ?? 'https://api.anthropic.com')}/v1/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: spec.model, max_tokens: maxTokens ?? spec.maxTokens,
        ...(system ? { system: [{ type: 'text', text: system, ...(spec.promptCache === false ? {} : { cache_control: { type: 'ephemeral' } }) }] } : {}),
        messages: [{ role: 'user', content: prompt }] });
    if (payload?.stop_reason === 'refusal') throw new Error('Model declined to answer (stop_reason=refusal)');
    const text = (Array.isArray(payload?.content) ? payload.content : []).filter(block => block?.type === 'text').map(block => block.text).join('');
    const truncated = payload?.stop_reason === 'max_tokens';
    if (!truncated && !text.trim()) throw new Error(`Model returned no text (stop_reason=${payload?.stop_reason ?? 'none'})`);
    const usage = payload?.usage ?? {};
    return { text, truncated, durationMs: Date.now() - started,
      usage: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
        cachedInputTokens: number(usage.cache_read_input_tokens), cacheWriteInputTokens: number(usage.cache_creation_input_tokens) } };
  };
}

function retryConfig(spec) {
  const config = { ...RETRY_DEFAULTS, ...(spec.retry ?? {}) };
  positiveInteger(config.maxAttempts, 'retry.maxAttempts');
  if (config.maxAttempts > 10) throw new Error('retry.maxAttempts must be at most 10');
  for (const field of ['baseDelayMs', 'maxDelayMs', 'maxRetryAfterMs']) {
    if (!Number.isInteger(config[field]) || config[field] < 0) throw new Error(`retry.${field} must be a non-negative integer`);
  }
  return config;
}

/**
 * createProvider(spec, runtime).call({stage, system, prompt, maxTokens?}) resolves to
 * {text, truncated, usage, durationMs, attempts}. runtime may inject fetch, sleep and random.
 */
export function createProvider(spec, runtime = {}) {
  if (!spec || typeof spec !== 'object' || !KINDS.includes(spec.kind)) throw new Error(`Provider kind must be one of: ${KINDS.join(', ')}`);
  const fetchImpl = runtime.fetch ?? ((...args) => globalThis.fetch(...args));
  const sleep = runtime.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = runtime.random ?? Math.random;
  const call = spec.kind === 'exec' ? execProvider(spec) : spec.kind === 'openai' ? openaiProvider(spec, fetchImpl) : anthropicProvider(spec, fetchImpl);
  const retry = retryConfig(spec);
  const concurrency = spec.concurrency === undefined ? (spec.kind === 'exec' ? 1 : 4) : positiveInteger(spec.concurrency, 'concurrency');
  if (concurrency > 64) throw new Error('concurrency must be at most 64');
  if (spec.maxTokensRetry !== undefined) {
    positiveInteger(spec.maxTokensRetry, 'maxTokensRetry');
    if (spec.kind === 'exec') throw new Error('maxTokensRetry needs an openai or anthropic provider; an exec command sets its own limit');
    if (Number.isInteger(spec.maxTokens) && spec.maxTokensRetry <= spec.maxTokens) throw new Error('maxTokensRetry must be larger than maxTokens');
  }
  const describe = () => ({ kind: spec.kind, ...(spec.model ? { model: spec.model } : {}), ...(spec.kind === 'exec' ? { command: spec.command[0], parse: spec.parse ?? 'text' } : { baseUrl: trimSlash(spec.baseUrl ?? 'https://api.anthropic.com') }) });
  return {
    kind: spec.kind, concurrency,
    maxTokens: Number.isInteger(spec.maxTokens) ? spec.maxTokens : null,
    maxTokensRetry: spec.maxTokensRetry ?? null,
    describe,
    // What a completed output depends on: limits, concurrency and retry settings are excluded,
    // so raising a limit after a failure does not invalidate stages that already passed.
    fingerprint: () => ({ ...describe(), ...(spec.kind === 'exec' ? { argv: spec.command } : {}) }),
    call: async ({ stage, system = '', prompt, maxTokens }) => {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A provider call needs a prompt');
      for (let attempt = 1; ; attempt++) {
        try { return { ...(await call({ stage, system, prompt, maxTokens })), attempts: attempt }; }
        catch (error) {
          const after = error.retryAfterMs ?? null;
          const tooLong = after !== null && after > retry.maxRetryAfterMs;
          if (!error.retryable || attempt >= retry.maxAttempts || tooLong) {
            const detail = tooLong ? ` (retry-after ${Math.round(after / 1000)} s exceeds retry.maxRetryAfterMs)` : '';
            throw new Error(`${stage} provider (${spec.kind}) failed${attempt > 1 ? ` after ${attempt} attempts` : ''}: ${error.message}${detail}`, { cause: error });
          }
          const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
          await sleep(after ?? Math.round(backoff / 2 + random() * backoff / 2));
        }
      }
    },
  };
}
