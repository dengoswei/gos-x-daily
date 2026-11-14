// CDP browser driver for the scripted collector: drives one dedicated tab of an already running,
// already signed-in Chromium over a loopback DevTools endpoint. Same contract as the Apple Events
// driver (init, openUrl, evalJson, screenshot, captureViewBase64, close, getEvidence).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CDP_CALL_TIMEOUT_MS = 30000;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function loopbackCdpEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('CDP endpoint must be a loopback http URL'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || !url.port) {
    throw new Error('CDP endpoint must be a loopback http URL with an explicit port');
  }
  return url;
}

// Shared by every driver so evidence entries have one shape and one timestamp rule.
export function recordScreenshotEvidence(evidence, { runDir, id, url, startedAt, clock, capture }) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error(`Invalid evidence ID: ${id}`);
  const relPath = `evidence/${id}.jpg`;
  const absPath = path.join(runDir, relPath);
  capture(absPath);
  const sha256 = createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  const capturedAt = new Date(Math.max(clock(), Date.parse(startedAt) + 1000)).toISOString();
  const entry = { id, kind: 'screenshot', url, capturedAt, path: relPath, sha256 };
  evidence.push(entry);
  return entry;
}

export function createCdpBrowserDriver({
  endpoint = DEFAULT_CDP_ENDPOINT,
  runDir,
  startedAt,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  clock = Date.now,
  sleep = defaultSleep,
}) {
  const base = loopbackCdpEndpoint(endpoint);
  const evidenceDir = path.join(runDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const evidence = [];
  const pending = new Map();
  let ws = null;
  let nextId = 0;
  let targetId = null;
  let sessionId = null;

  const failPending = reason => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)); }
    pending.clear();
  };

  function send(method, params = {}, { session = sessionId } = {}) {
    if (!ws) return Promise.reject(new Error('CDP connection is closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, CDP_CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }

  async function init() {
    const response = await fetchImpl(new URL('/json/version', base), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`CDP endpoint ${base.host} answered HTTP ${response.status}`);
    const advertised = new URL((await response.json()).webSocketDebuggerUrl);
    if (advertised.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(advertised.hostname) || advertised.port !== base.port) {
      throw new Error('CDP endpoint advertised a non-loopback browser socket');
    }
    ws = new WebSocketImpl(advertised.href);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`Cannot connect to the CDP browser at ${base.host}`)), { once: true });
    });
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`CDP ${waiter.method} failed: ${message.error.message}`));
      else waiter.resolve(message.result ?? {});
    });
    ws.addEventListener('close', () => { ws = null; failPending('CDP connection closed'); });
    try {
      // A window of our own: the user's tabs are never navigated, focused or closed.
      ({ targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true }, { session: null }));
      ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, { session: null }));
      await send('Page.enable');
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function tryEvalJson(jsBody) {
    const expression = `(function(){ try { const __res = (function(){ ${jsBody} })(); return JSON.stringify({ __ok: true, value: __res }); } catch (e) { return JSON.stringify({ __ok: false, error: String(e && e.message ? e.message : e) }); } })()`;
    try {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (exceptionDetails || typeof result?.value !== 'string') return { ok: false, reason: exceptionDetails?.text ?? 'non_string_result' };
      const parsed = JSON.parse(result.value);
      return parsed.__ok ? { ok: true, value: parsed.value } : { ok: false, reason: parsed.error || 'js_error' };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  async function evalJson(jsBody) {
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      last = await tryEvalJson(jsBody);
      if (last.ok) return last.value;
      if (attempt < 4) await sleep(400);
    }
    throw new Error(`CDP JS evaluation failed (${last?.reason ?? 'unknown'})`);
  }

  async function openUrl(targetUrl, { settleMs = 3500, waitSelector = null, maxWaitMs = 22000 } = {}) {
    const navigated = await send('Page.navigate', { url: targetUrl });
    if (navigated.errorText && navigated.errorText !== 'net::ERR_ABORTED') {
      throw new Error(`Navigation failed (${navigated.errorText})`);
    }
    const deadline = clock() + maxWaitMs;
    while (clock() < deadline) {
      await sleep(500);
      const ready = await tryEvalJson('return { readyState: document.readyState, href: location.href };');
      if (ready.ok && ['interactive', 'complete'].includes(ready.value?.readyState) && ready.value.href && ready.value.href !== 'about:blank') break;
    }
    if (waitSelector) {
      const selDeadline = clock() + 12000;
      while (clock() < selDeadline) {
        const cnt = await tryEvalJson(`return document.querySelectorAll(${JSON.stringify(waitSelector)}).length;`);
        if (cnt.ok && Number(cnt.value) > 0) break;
        await sleep(600);
      }
    }
    await sleep(settleMs);
  }

  async function captureViewBase64() {
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    if (!data) throw new Error('CDP returned an empty screenshot');
    return data;
  }

  async function screenshot(id, urlForManifest) {
    const data = await captureViewBase64();
    return recordScreenshotEvidence(evidence, {
      runDir, id, url: urlForManifest, startedAt, clock,
      capture: absPath => fs.writeFileSync(absPath, Buffer.from(data, 'base64'), { mode: 0o600 }),
    });
  }

  async function close() {
    const owned = targetId;
    targetId = null;
    sessionId = null;
    if (ws && owned) {
      try { await send('Target.closeTarget', { targetId: owned }, { session: null }); } catch { /* already gone */ }
    }
    // Closing the socket only disconnects; the browser and the user's tabs keep running.
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
  }

  return { init, openUrl, evalJson, screenshot, captureViewBase64, close, getEvidence: () => evidence };
}
