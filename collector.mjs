// Derived from the audited Mac collector. See docs/PROVENANCE.md.
// Importing this module does not read profiles, write files, start a browser,
// connect to CDP, collect content, invoke a model, or send messages.
import fs from 'node:fs';
import path from 'node:path';
import { mergeItems, scanWindow, auditDeepLinks, readFeedDom, publicUrlRefusal } from './feed.mjs';
import { htmlToText, htmlElements, decodeEntities } from './feed-import.mjs';
import { runOcr } from './ocr.mjs';
import { assertCollectionAllowed, freshWindow, validateWatchProfiles, defaultWatchProfiles } from './runtime.mjs';
import { openCoverageStore, recordCollectionCoverage, runCoveragePlan, coverageReport } from './coverage.mjs';

// Article links on a blog index page: same origin, under articleBaseUrl, not the index itself.
// Relative hrefs resolve against indexUrl; articlePattern optionally narrows the pathname.
export function filterIndexLinks(links, blog) {
  const base = new URL(blog.articleBaseUrl);
  const basePath = base.origin + base.pathname;
  const pattern = blog.articlePattern ? new RegExp(blog.articlePattern) : null;
  const max = Number(blog.maxArticles || 3);
  const seen = new Set(), out = [];
  for (const link of links ?? []) {
    let url;
    try { url = new URL(link?.href, blog.indexUrl); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    const page = url.origin + url.pathname;
    if (!page.startsWith(basePath) || page.replace(/\/$/, '') === basePath.replace(/\/$/, '')) continue;
    if (pattern && !pattern.test(url.pathname)) continue;
    if (seen.has(page)) continue;
    seen.add(page);
    out.push({ source: 'blog', name: blog.name, title: typeof link.text === 'string' ? link.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '', url: page });
    if (out.length >= max) break;
  }
  return out;
}

// Static-HTML fallback for index pages that are not client-rendered. Anchors only, like the
// rendered path, so <link rel="alternate"> feeds and stylesheets never become articles.
export function indexLinksFromHtml(html) {
  return [...String(html).matchAll(/<a\b[^>]*?\shref=["']([^"']+)["']/gi)].map(match => ({ href: match[1].replace(/&amp;/g, '&'), text: '' }));
}

// Bounded body read: a declared or streamed size above maxBytes aborts the read.
export async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel?.().catch(() => {}); throw new Error(`Body exceeds ${maxBytes} bytes`); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`Body exceeds ${maxBytes} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Public HTTPS fetch for page-derived URLs: refuses loopback, IP-literal and LAN
// hosts before every hop (redirects are followed manually), and bounds the body.
export async function fetchPublicResource(fetchFn, url, options = {}, { timeoutMs = 20000, maxBytes = 4 * 1024 * 1024, maxRedirects = 3 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current;
  try { current = new URL(url); } catch { throw new Error(`Invalid URL: ${String(url).slice(0, 200)}`); }
  for (let hop = 0; ; hop++) {
    const refusal = publicUrlRefusal(current);
    if (refusal) throw new Error(`Refusing ${refusal} URL: ${current.origin}`);
    const res = await fetchFn(current.href, { ...options, redirect: 'manual', signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel?.().catch(() => {});
      if (hop >= maxRedirects) throw new Error(`More than ${maxRedirects} redirects from ${current.origin}`);
      const location = res.headers?.get?.('location');
      if (!location) throw new Error(`Redirect ${res.status} without Location from ${current.origin}`);
      current = new URL(location, current);
      continue;
    }
    return { res, bytes: await readBounded(res, maxBytes), url: current.href };
  }
}

// A browser deep read keeps text only if the page it finally landed on (after
// redirects or client-side navigation) is still a public HTTPS URL.
export function deepReadResult(link, page) {
  const refusal = publicUrlRefusal(page?.url ?? '');
  if (!refusal) return page;
  return { title: link.text || link.href, url: link.href, error: `Deep read landed on a refused URL (${refusal})` };
}

// readFeedDom output for a watch profile: blocked pages contribute nothing, and
// only URL-keyed, non-promoted posts count toward the profile's latest limit.
export function profileItemsFromFeedPage(page, limit, label, warnings = []) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.items)) { warnings.push(`${label} profile read returned no page`); return []; }
  if (page.blocked) { warnings.push(`${label} profile unavailable: ${page.blocked}`); return []; }
  const items = page.items.filter(item => typeof item?.url === 'string' && item.url && item.text).slice(0, limit);
  if (items.some(item => item.truncated)) warnings.push(`${label}: ${items.filter(item => item.truncated).length} post(s) truncated in the profile view`);
  if (items.some(item => !item.publishedAt)) warnings.push(`${label}: ${items.filter(item => !item.publishedAt).length} post(s) lack an observed date`);
  return items;
}

// Pure blog-page extraction. Page HTML is untrusted evidence; the helpers shared
// with feed import strip tags first, decode entities once and scan linearly.
const stripHtml = (html = '') => htmlToText(html, { drop: ['nav', 'footer', 'header'] });

function extractTagText(html, tagName) {
  const element = htmlElements(html, tagName)[0];
  return element ? stripHtml(element.raw) : '';
}

function parseJsonLdArticle(html) {
  for (const script of htmlElements(html, 'script')) {
    if (String(script.attrs.type).toLowerCase() !== 'application/ld+json') continue;
    try {
      let value;
      try { value = JSON.parse(script.raw); } catch { value = JSON.parse(decodeEntities(script.raw)); }
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (entry?.['@type'] === 'BlogPosting' || entry?.['@type'] === 'Article') {
          return {
            title: entry.headline || entry.name || '',
            author: typeof entry.author === 'string' ? entry.author : entry.author?.name || '',
            publishedAt: entry.datePublished || entry.dateModified || null,
          };
        }
      }
    } catch {}
  }
  return {};
}

export function extractBlogArticle(html, article) {
  const jsonLd = parseJsonLdArticle(html);
  const title = jsonLd.title || extractTagText(html, 'h1') || article.title || 'Untitled';
  const bodyHtml = htmlElements(html, 'article')[0]?.raw || htmlElements(html, 'main')[0]?.raw || html;
  const content = stripHtml(bodyHtml);
  return {
    ...article,
    title,
    author: jsonLd.author || '',
    publishedAt: jsonLd.publishedAt || null,
    content: content.slice(0, 12000),
    ...(content.length > 12000 ? { truncated: true } : {}),
  };
}

export function createCollector(runtime, { fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, clock = () => new Date() } = {}) {
  const LOCAL_DIR = runtime.runDir;
  const XIAOHONGSHU_ARTIFACT_DIR = path.join(LOCAL_DIR, 'xiaohongshu');
  const XIAOHONGSHU_ATTACHMENT_CACHE_DIR = path.join(XIAOHONGSHU_ARTIFACT_DIR, 'attachments');
  const VISION_OCR_SCRIPT = 'portable-ocr-adapter';
  const CDP_HOST = '127.0.0.1';
  const CDP_PORT = runtime.cdpPort;
  const XIAOHONGSHU_MAX_CAROUSEL_IMAGES = 20;
  const XIAOHONGSHU_MAX_OCR_IMAGES = 20;
  const XIAOHONGSHU_MAX_LINKS_PER_NOTE = 6;
  const XIAOHONGSHU_MAX_DIRECT_LINKS_PER_NOTE = 30;
  const XIAOHONGSHU_MAX_ATTACHMENT_LINKS = 30;
  const XIAOHONGSHU_MAX_NOTES_OVERRIDE = 0;
  const XIAOHONGSHU_NOTE_IDS_OVERRIDE = [];
  const BLOG_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const REQUIRED_PAGES = [
    { key: 'xFollowing', label: 'X Following', url: 'https://x.com/home?filter=following', match: url => url.includes('x.com/home?filter=following') },
    { key: 'substack', label: 'Substack Subscribed', url: 'https://substack.com/home/secondary/subscribed', match: url => url.includes('substack.com/home/secondary/subscribed') },
    ...validateWatchProfiles(runtime.sources?.watchProfiles ?? defaultWatchProfiles).map(profile => ({ key: `watch:${profile.handle}`, label: profile.name, url: `https://x.com/${profile.handle}`, profile,
      match: url => new RegExp(`^https://x\\.com/${profile.handle}(?:[/?#]|$)`, 'i').test(url) })),
  ];
  const pageUrl = key => REQUIRED_PAGES.find(page => page.key === key).url;
  let semanticScholarRateLimited = false;
  let active = false;
  let deadline = Infinity;
  function remainingBudget() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { const error = new Error('Global collection time budget exhausted'); error.code = 'RUN_BUDGET'; throw error; }
    return remaining;
  }
  let used = false;
  const WebSocket = WebSocketImpl;
  const fetch = (...args) => {
    if (!active) throw new Error('Collection is not authorized');
    const [url, options = {}] = args;
    const budgetSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingBudget())));
    return fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, budgetSignal]) : budgetSignal });
  };
  function loadSourceConfig() { return runtime.sources; }
  function runVisionOcr(imagePaths, warnings) {
    if (runtime.ocr.provider !== 'none' && remainingBudget() < imagePaths.length * 45000) { warnings.push('OCR skipped: insufficient remaining global time budget'); return []; }
    return runOcr(imagePaths, runtime.ocr, warnings);
  }
  function appendLog(event) { fs.appendFileSync(path.join(LOCAL_DIR, 'collector.jsonl'), JSON.stringify({ ts: clock().toISOString(), ...event }) + '\n'); }
  async function ensureChrome() {
    const version = await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
    const ws = new URL(version.webSocketDebuggerUrl || 'about:blank');
    if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(ws.hostname) || Number(ws.port) !== CDP_PORT) {
      throw new Error('Expected an independently provisioned loopback CDP browser');
    }
    return version;
  }
function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function collectFeedWindow(target, kind, window, allowExhausted = false, budget = {}) {
  const feedDeadline = Date.now() + (budget.maxMs ?? runtime.maxFeedMs);
  const feedRemaining = () => {
    const left = Math.min(feedDeadline - Date.now(), remainingBudget());
    if (left <= 0) { const error = new Error('Per-window scan time budget exhausted'); error.code = 'RUN_BUDGET'; throw error; }
    return left;
  };
  const client = new TargetClient(target);
  try {
    await client.waitForReady(Math.min(20000, feedRemaining()));
    await client.eval('window.scrollTo(0, 0)', Math.min(5000, feedRemaining()));
    await sleep(1200); // Virtualized feeds need a render after restoring the top.
    return await scanWindow({ window, allowExhausted,
      maxPages: budget.maxPages ?? runtime.maxPages,
      maxMs: feedRemaining(),
      orderedTimestamps: false, // Original-post dates do not prove repost/activity ordering.
      recover: async ({ signal }) => {
        if (signal.aborted) return;
        await client.eval('window.scrollBy(0, -Math.max(200, window.innerHeight * 0.3))', Math.min(2000, feedRemaining()));
        await sleep(600);
        if (signal.aborted) return;
        await client.eval('window.scrollBy(0, Math.max(500, window.innerHeight * 0.8))', Math.min(2000, feedRemaining()));
      },
      read: async () => {
        if (kind === 'x') await client.eval(`(async () => {
          for (const b of document.querySelectorAll('article [data-testid="tweet-text-show-more-link"]')) b.click();
          await new Promise(r => setTimeout(r, 250));
        })()`, Math.min(5000, feedRemaining()));
        return JSON.parse(await client.eval(`JSON.stringify((${readFeedDom.toString()})(${JSON.stringify(kind)}))`, Math.min(10000, feedRemaining())));
      },
      scroll: async () => {
        await client.eval('window.scrollBy(0, Math.max(500, window.innerHeight * 0.8))', Math.min(5000, feedRemaining()));
        if (feedRemaining() < 1500) { const error = new Error('Per-window scan time budget exhausted before scroll wait'); error.code = 'RUN_BUDGET'; throw error; }
        await sleep(1500);
      },
    });
  } finally { client.close(); }
}

function sleep(ms) {
  if (remainingBudget() < ms) { const error = new Error('Global collection time budget exhausted before wait'); error.code = 'RUN_BUDGET'; throw error; }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

// Every non-CDP fetch goes to a public HTTPS host, re-checked per redirect, with a bounded body.
async function fetchText(url, options = {}, timeoutMs = 20000) {
  const { res, bytes } = await fetchPublicResource(fetch, url, options, { timeoutMs });
  const text = bytes.toString('utf8');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function listTargets() {
  const targets = await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return targets.filter((target) => target.type === 'page');
}

async function createTarget(url) {
  const encoded = encodeURIComponent(url);
  try {
    return await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/new?${encoded}`, { method: 'PUT' });
  } catch {
    return fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/new?${encoded}`);
  }
}

// Cleanup bypasses the global budget (the budgeted wrapper throws once it is
// spent), so a finished or interrupted scan never leaks its tab. Loopback CDP only.
async function closeTarget(targetId) {
  if (!targetId || !active) return false;
  try {
    const res = await fetchImpl(`http://${CDP_HOST}:${CDP_PORT}/json/close/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(5000) });
    await res.text?.().catch(() => {});
    return res.ok !== false;
  } catch {
    return false;
  }
}

async function getOrCreateTarget(page) {
  const targets = await listTargets();
  const existing = targets.find((target) => page.match(target.url || ''));
  if (existing) return existing;
  const created = await createTarget(page.url);
  await sleep(2500);
  const refreshed = await listTargets();
  return refreshed.find((target) => target.id === created.id) || created;
}

async function getOrCreateExactUrlTarget(url) {
  const normalize = (value) => {
    try {
      const parsed = new URL(value);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return value;
    }
  };
  const normalizedUrl = normalize(url);
  const existing = (await listTargets()).find((target) => normalize(target.url || '') === normalizedUrl);
  if (existing) return { target: existing, created: false };
  const created = await createTarget(url);
  await sleep(2500);
  const refreshed = (await listTargets()).find((item) => item.id === created.id) || created;
  return { target: refreshed, created: true };
}

class TargetClient {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.target.webSocketDebuggerUrl) {
      throw new Error(`Target ${this.target.id} has no webSocketDebuggerUrl`);
    }
    const socket = new URL(this.target.webSocketDebuggerUrl);
    if (socket.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(socket.hostname) || Number(socket.port) !== CDP_PORT) throw new Error('Expected loopback CDP target');
    remainingBudget();
    this.ws = new WebSocket(socket.href);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to target ${this.target.id}`)), Math.min(10000, remainingBudget()));
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to target ${this.target.id}`));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
    const rejectPending = (message) => {
      for (const [id, { reject, timer }] of this.pending.entries()) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(message));
      }
    };
    this.ws.addEventListener('close', () => rejectPending(`CDP target ${this.target.id} closed`));
    this.ws.addEventListener('error', () => rejectPending(`CDP target ${this.target.id} websocket error`));
  }

  async send(method, params = {}, timeoutMs = 30000) {
    timeoutMs = Math.min(timeoutMs, remainingBudget());
    await this.connect();
    timeoutMs = Math.min(timeoutMs, remainingBudget());
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  async eval(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
    }
    return result.result?.value;
  }

  async waitForReady(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ready = await this.eval('document.readyState', 5000);
        if (ready === 'complete' || ready === 'interactive') return ready;
      } catch {}
      await sleep(500);
    }
    return 'timeout';
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Watch profiles use the same extraction as feed scans: expanded "show more",
// 16000 chars with a truncated flag, publishedAt and the status URL as key.
async function readXProfilePage(target, label, warnings, limit) {
  const client = new TargetClient(target);
  try {
    await client.waitForReady();
    await client.eval(`(async () => {
      for (const b of document.querySelectorAll('article [data-testid="tweet-text-show-more-link"]')) b.click();
      await new Promise(r => setTimeout(r, 250));
    })()`, 5000);
    const page = JSON.parse(await client.eval(`JSON.stringify((${readFeedDom.toString()})('x'))`, 10000));
    return profileItemsFromFeedPage(page, limit, label, warnings);
  } finally {
    client.close();
  }
}

async function pageSnapshot(target) {
  const client = new TargetClient(target);
  try {
    await client.waitForReady();
    const raw = await client.eval(`(() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').trim().slice(0, 2000)
    }))()`, 10000);
    return JSON.parse(raw);
  } finally {
    client.close();
  }
}

async function clickSeeNewPosts(target) {
  const client = new TargetClient(target);
  try {
    await client.waitForReady();
    const clicked = await client.eval(`(() => {
      const el = [...document.querySelectorAll('button, div[role=button]')]
        .find(node => /See new posts|Show new posts/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (clicked) await sleep(2500);
    return Boolean(clicked);
  } finally {
    client.close();
  }
}

async function scrollPage(target, y = 1600) {
  const client = new TargetClient(target);
  try {
    await client.eval(`(() => { window.scrollBy(0, ${Number(y)}); return { scrollY, height: document.body.scrollHeight }; })()`);
    await sleep(1200);
  } finally {
    client.close();
  }
}

async function reloadPage(target) {
  const client = new TargetClient(target);
  try {
    await client.send('Page.reload', { ignoreCache: false }, 10000);
    await sleep(4500);
    await client.waitForReady(15000);
  } finally {
    client.close();
  }
}

async function xTimelineQuickState(target) {
  const client = new TargetClient(target);
  try {
    await client.waitForReady(5000);
    const raw = await client.eval(`(() => JSON.stringify({
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      articleCount: document.querySelectorAll('article').length,
      tweetCount: document.querySelectorAll('[data-testid="tweet"]').length,
      statusLinkCount: document.querySelectorAll('a[href*="/status/"]').length,
      bodyText: (document.body?.innerText || '').trim().slice(0, 1000)
    }))()`, 10000);
    return JSON.parse(raw);
  } finally {
    client.close();
  }
}

function hasHydratedXTimeline(state) {
  return Boolean(state && (
    state.articleCount > 0 ||
    state.tweetCount > 0 ||
    state.statusLinkCount > 0
  ));
}

async function waitForXTimelineContent(target, timeoutMs = 15000) {
  const client = new TargetClient(target);
  try {
    const start = Date.now();
    let lastState = null;
    while (Date.now() - start < timeoutMs) {
      const raw = await client.eval(`(() => JSON.stringify({
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        articleCount: document.querySelectorAll('article').length,
        tweetCount: document.querySelectorAll('[data-testid="tweet"]').length,
        statusLinkCount: document.querySelectorAll('a[href*="/status/"]').length,
        bodyText: (document.body?.innerText || '').trim().slice(0, 1200)
      }))()`, 10000);
      lastState = JSON.parse(raw);
      if (lastState.articleCount > 0 || lastState.tweetCount > 0 || lastState.statusLinkCount > 0) return lastState;
      const text = `${lastState.title || ''}\n${lastState.bodyText || ''}`;
      if (/(log in|sign in|登录|create account|Try again|Something went wrong)/i.test(text) && lastState.readyState !== 'loading') {
        return lastState;
      }
      await sleep(600);
    }
    return lastState;
  } finally {
    client.close();
  }
}

async function extractHydratedXTimeline(target, label, warnings, limit = 10, timeoutMs = 30000) {
  const state = await waitForXTimelineContent(target, timeoutMs).catch((error) => {
    warnings.push(`${label} timeline readiness check failed: ${error.message}`);
    return null;
  });
  if (!hasHydratedXTimeline(state)) {
    warnings.push(`${label} timeline not hydrated: title="${state?.title || ''}", readyState="${state?.readyState || ''}", text="${(state?.bodyText || '').slice(0, 160).replace(/\s+/g, ' ')}"`);
    return [];
  }
  return readXProfilePage(target, label, warnings, limit);
}

function extractInterestingLinks(items) {
  return auditDeepLinks(items, runtime.deepReadLimit);
}

async function extractArticleBody(link) {
  const refused = publicUrlRefusal(link.href);
  if (refused) return { title: link.text || link.href, url: link.href, error: `Deep read refused: ${refused}` };
  const { target, created } = await getOrCreateExactUrlTarget(link.href);
  const client = new TargetClient(target);
  try {
    await client.waitForReady(15000);
    const raw = await client.eval(`(() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: (document.querySelector('article')?.innerText || document.body.innerText || '').trim().slice(0, 5000),
      truncated: (document.querySelector('article')?.innerText || document.body.innerText || '').trim().length > 5000
    }))()`, 30000);
    return deepReadResult(link, JSON.parse(raw));
  } catch (error) {
    return { title: link.text || link.href, url: link.href, error: error.message };
  } finally {
    client.close();
    if (created) await closeTarget(target.id);
  }
}

const BLOG_INDEX_TYPES = ['html-index', 'anthropic_engineering', 'claude_blog'];

async function renderedIndexLinks(blog) {
  const { target, created } = await getOrCreateExactUrlTarget(blog.indexUrl);
  const client = new TargetClient(target);
  try {
    await client.waitForReady(15000);
    const started = Date.now();
    for (;;) {
      const links = JSON.parse(await client.eval(`JSON.stringify([...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.innerText })))`, 10000));
      if (filterIndexLinks(links, blog).length || Date.now() - started >= 15000) return links;
      await sleep(1000);
    }
  } finally {
    client.close();
    if (created) await closeTarget(target.id);
  }
}

async function collectBlogs(warnings) {
  const config = loadSourceConfig();
  const blogs = Array.isArray(config.blogs) ? config.blogs : [];
  const results = [];
  const checks = {};
  const headers = {
    'User-Agent': BLOG_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  for (const blog of blogs) {
    checks[blog.name] = { attempted: true, items: 0, status: 'failed' };
    try {
      if (!BLOG_INDEX_TYPES.includes(blog.type ?? 'html-index')) throw new Error(`unsupported blog type ${blog.type}`);
      // Client-rendered indexes only expose article links after rendering; static HTML is the fallback.
      let candidates = [];
      try {
        candidates = filterIndexLinks(await renderedIndexLinks(blog), blog);
      } catch (error) {
        warnings.push(`Blog ${blog.name} rendered index unavailable: ${error.message}`);
      }
      if (!candidates.length) candidates = filterIndexLinks(indexLinksFromHtml(await fetchText(blog.indexUrl, { headers }, 25000)), blog);
      if (candidates.length === 0) {
        warnings.push(`Blog ${blog.name} produced 0 article candidates`);
        checks[blog.name].status = 'no_candidates';
        continue;
      }

      for (const candidate of candidates) {
        try {
          const articleHtml = await fetchText(candidate.url, { headers }, 25000);
          const article = extractBlogArticle(articleHtml, candidate);
          if (!article.url || !article.content) {
            warnings.push(`Blog ${blog.name} skipped article without url/content: ${candidate.url}`);
            continue;
          }
          results.push(article);
          checks[blog.name].items += 1;
          await sleep(300);
        } catch (error) {
          warnings.push(`Blog article extraction failed for ${candidate.url}: ${error.message}`);
        }
      }
      checks[blog.name].status = checks[blog.name].items ? 'ok' : 'articles_failed';
    } catch (error) {
      warnings.push(`Blog ${blog.name} extraction failed: ${error.message}`);
    }
  }

  return { items: uniqueBy(results, (item) => item.url), checks };
}

async function waitForText(target, pattern, timeoutMs = 15000) {
  const client = new TargetClient(target);
  try {
    const start = Date.now();
    let lastText = '';
    while (Date.now() - start < timeoutMs) {
      lastText = await client.eval(`(document.body?.innerText || '').slice(0, 5000)`, 10000);
      if (typeof pattern === 'function' ? pattern(lastText || '') : pattern.test(lastText || '')) return lastText;
      await sleep(700);
    }
    return lastText;
  } finally {
    client.close();
  }
}

function parseXiaohongshuProfileNotes(profile, snapshot) {
  const anchors = Array.isArray(snapshot.anchors) ? snapshot.anchors : [];
  const titleToUrl = new Map();
  const noteIdRegex = new RegExp(`/user/profile/${profile.profileId}/([a-z0-9]+)`, 'i');
  for (const anchor of anchors) {
    const title = (anchor.text || '').trim();
    const href = anchor.href || '';
    const match = href.match(noteIdRegex);
    if (!title || !match || title === profile.displayName || title === profile.name) continue;
    titleToUrl.set(title, { noteId: match[1], url: href });
  }

  const lines = (snapshot.text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const notes = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const title = lines[i];
    const linked = titleToUrl.get(title);
    if (!linked || seen.has(linked.noteId)) continue;
    const author = lines[i + 1] || '';
    const likes = /^\d+(\.\d+)?万?$/.test(lines[i + 2] || '') ? lines[i + 2] : null;
    notes.push({
      source: 'xiaohongshu',
      profile: profile.name,
      displayName: profile.displayName,
      profileId: profile.profileId,
      rednoteId: profile.rednoteId,
      noteId: linked.noteId,
      title,
      author,
      likes,
      url: linked.url,
    });
    seen.add(linked.noteId);
  }

  return notes.length
    ? notes
    : [...titleToUrl.entries()].map(([title, linked]) => ({
      source: 'xiaohongshu',
      profile: profile.name,
      displayName: profile.displayName,
      profileId: profile.profileId,
      rednoteId: profile.rednoteId,
      noteId: linked.noteId,
      title,
      author: profile.displayName,
      likes: null,
      url: linked.url,
    }));
}

function cleanXiaohongshuNoteText(text = '') {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const start = lines.findIndex((line) => /^\d+\/\d+$/.test(line));
  const endMarkers = new Set(['这是一片荒地点击评论', '说点什么...', '发送', '取消', '活动']);
  const useful = (start >= 0 ? lines.slice(start) : lines)
    .filter((line) => !endMarkers.has(line))
    .filter((line) => !/^沪ICP备|^© 2014-|^地址：|^电话：|^更多$|^关于我们$/.test(line));
  return useful.join('\n').slice(0, 2000);
}

function extractDirectHttpUrls(text = '') {
  const matches = String(text).match(/https?:\/\/[^\s<>"'）)】]+/gi) || [];
  return uniqueBy(matches.map((value) => value.replace(/[.,;:!?，。；：！？]+$/g, ''))
    .filter((value) => {
      try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) && !/xiaohongshu\.com$/i.test(parsed.hostname);
      } catch {
        return false;
      }
    }), (value) => value);
}

function extractXiaohongshuBodyUrls(text = '') {
  const direct = extractDirectHttpUrls(text);
  const bareMatches = String(text).match(/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.(?:com|org|net|io|ai|edu|gov))(?:\/[^\s<>"'）)】,，。；;!?！？]*)?/gi) || [];
  const bare = bareMatches.map((value) => /^https?:\/\//i.test(value) ? value : `https://${value}`);
  return uniqueBy([...direct, ...bare]
    .map((value) => value.replace(/[.,;:!?，。；：！？]+$/g, ''))
    .filter((value) => {
      try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) && !/xiaohongshu\.com$/i.test(parsed.hostname);
      } catch {
        return false;
      }
    }), (value) => value);
}

function expectedXiaohongshuItemCount(text = '') {
  const indexes = [...String(text).matchAll(/图\s*(\d{1,3})/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return indexes.length ? Math.max(...indexes) : 0;
}

function attachmentLinkTitle(url = '') {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parsed.hostname === 'github.com' && pathParts.length >= 2) return `${pathParts[0]}/${pathParts[1]}`;
    return pathParts.at(-1) || parsed.hostname;
  } catch {
    return url;
  }
}

function attachmentLinksAsResolvedLinks(links) {
  return links.map((url, index) => ({
    query: attachmentLinkTitle(url),
    candidateSource: 'related_file',
    imageIndex: index,
    sourceIndex: index + 1,
    source: new URL(url).hostname === 'github.com' ? 'github_attachment' : 'attachment',
    title: attachmentLinkTitle(url),
    url,
    summary: '',
    confidence: 1,
  }));
}

function bodyLinksAsResolvedLinks(links) {
  return links.map((url, index) => ({
    query: attachmentLinkTitle(url),
    candidateSource: 'note_body',
    sourceIndex: index + 1,
    source: 'xiaohongshu_body_link',
    title: attachmentLinkTitle(url),
    url,
    summary: '',
    confidence: 1,
  }));
}

function collectedXiaohongshuImageCount(note) {
  if (Array.isArray(note.carouselImages)) return note.carouselImages.length;
  return Array.isArray(note.imageUrls) ? note.imageUrls.length : 0;
}

function verifiedXiaohongshuImageCount(note) {
  if (!Array.isArray(note.ocr?.results) || note.ocr.results.length === 0) return 0;
  if (Array.isArray(note.verifiedImageIndexes)) return note.verifiedImageIndexes.length;
  return new Set((note.resolvedLinks || [])
    .map((link) => link.imageIndex)
    .filter((index) => Number.isInteger(index))).size;
}

function isUsefulXiaohongshuSourceUrl(value = '') {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (/(^|\.)xiaohongshu\.com$|(^|\.)xhscdn\.com$/.test(hostname)) return false;
    if (/(^|\.)(miit\.gov\.cn|beian\.gov\.cn|12377\.cn|shjbzx\.cn)$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function xiaohongshuAttachmentCachePath(docId) {
  return path.join(XIAOHONGSHU_ATTACHMENT_CACHE_DIR, `${safePathSegment(docId)}.json`);
}

function readXiaohongshuAttachmentCache(docId, expectedItems = 0) {
  const cached = readJsonFile(xiaohongshuAttachmentCachePath(docId));
  const links = Array.isArray(cached?.links) ? cached.links.filter(isUsefulXiaohongshuSourceUrl) : [];
  if (!links.length || (expectedItems && links.length < expectedItems)) return null;
  return { ...cached, links };
}

function writeXiaohongshuAttachmentCache(relatedFile, links, expectedItems) {
  if (!links.length || (expectedItems && links.length < expectedItems)) return;
  fs.writeFileSync(xiaohongshuAttachmentCachePath(relatedFile.docId), `${JSON.stringify({
    docId: relatedFile.docId,
    name: relatedFile.name || '',
    expectedItems,
    links,
    cachedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function xiaohongshuFilePreviewUrl(note, relatedFile) {
  const preview = new URL(`/file/${encodeURIComponent(relatedFile.docId)}`, 'https://www.xiaohongshu.com');
  preview.searchParams.set('noteId', note.noteId);
  preview.searchParams.set('fileName', relatedFile.name || 'attachment');
  const detailUrl = new URL(note.detailUrl || note.url);
  const xsecToken = detailUrl.searchParams.get('xsec_token');
  if (xsecToken) preview.searchParams.set('xsec_token', xsecToken);
  preview.searchParams.set('xsec_source', 'note_detail_file');
  preview.searchParams.set('preRoute', 'Empty');
  preview.searchParams.set('source', 'NoteCard');
  return preview.toString();
}

async function collectXiaohongshuRelatedFile(note, warnings) {
  const relatedFile = note.relatedFile;
  if (!relatedFile?.docId) return { relatedFile: null, attachmentLinks: [] };
  const previewUrl = xiaohongshuFilePreviewUrl(note, relatedFile);
  const expectedItems = expectedXiaohongshuItemCount(note.bodyText);
  const cached = readXiaohongshuAttachmentCache(relatedFile.docId, expectedItems);
  if (cached) {
    return {
      relatedFile: { ...relatedFile, previewUrl, expectedItems, links: cached.links, cacheHit: true, cachedAt: cached.cachedAt },
      attachmentLinks: cached.links,
    };
  }
  const { target, created } = await getOrCreateExactUrlTarget(previewUrl);
  try {
    await navigateExistingTarget(target, previewUrl);
    // Page-supplied names are text, never a regular expression.
    const needle = String(relatedFile.name || relatedFile.docId).toLowerCase();
    await waitForText(target, text => text.toLowerCase().includes(needle), 15000);
    const client = new TargetClient(target);
    try {
      let snapshot = {};
      let links = [];
      let stableRounds = 0;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 30000) {
        const raw = await client.eval(`(() => JSON.stringify({
          title: document.title,
          url: location.href,
          text: (document.body?.innerText || '').trim().slice(0, 30000),
          links: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean)
        }))()`, 20000);
        snapshot = JSON.parse(raw || '{}');
        const textLinks = extractDirectHttpUrls(snapshot.text || '').filter(isUsefulXiaohongshuSourceUrl);
        const anchorLinks = (snapshot.links || [])
          .filter(isUsefulXiaohongshuSourceUrl);
        const nextLinks = uniqueBy(textLinks.length ? textLinks : anchorLinks, (url) => url)
          .slice(0, XIAOHONGSHU_MAX_ATTACHMENT_LINKS);
        stableRounds = nextLinks.length === links.length ? stableRounds + 1 : 0;
        links = nextLinks;
        if ((expectedItems && links.length >= expectedItems) || (!expectedItems && links.length > 0 && stableRounds >= 2)) break;
        await sleep(700);
      }
      writeXiaohongshuAttachmentCache(relatedFile, links, expectedItems);
      return {
        relatedFile: {
          ...relatedFile,
          previewUrl: snapshot.url || previewUrl,
          previewTitle: snapshot.title || relatedFile.name,
          expectedItems,
          links,
        },
        attachmentLinks: links,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    warnings.push(`Xiaohongshu attachment extraction failed for ${note.noteId} (${relatedFile.name || relatedFile.docId}): ${error.message}`);
    return {
      relatedFile: { ...relatedFile, previewUrl, error: error.message },
      attachmentLinks: [],
    };
  } finally {
    if (created) await closeTarget(target.id);
  }
}

function safePathSegment(value = '') {
  return String(value)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function imageExtensionFromUrl(url = '') {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
}

async function collectXiaohongshuCarouselImages(target, maxImages = XIAOHONGSHU_MAX_CAROUSEL_IMAGES) {
  const client = new TargetClient(target);
  try {
    await client.waitForReady(20000);
    const raw = await client.eval(`(async () => {
      const maxImages = ${Number(maxImages)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (src) => {
        try {
          const url = new URL(src);
          url.searchParams.sort?.();
          return url.toString();
        } catch {
          return src;
        }
      };
      const collect = () => [...document.images]
        .map((img) => ({
          url: img.currentSrc || img.src,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          alt: img.alt || ''
        }))
        .filter((img) => img.url && /xhscdn\\.com/.test(img.url) && img.width >= 250 && img.height >= 250)
        .map((img) => ({ ...img, url: normalize(img.url) }));
      const labelOf = (node) => [
        node.innerText || '',
        node.textContent || '',
        node.getAttribute('aria-label') || '',
        node.className || ''
      ].join(' ').replace(/\\s+/g, ' ').trim();
      const seen = new Map();
      const add = () => {
        for (const image of collect()) {
          if (!seen.has(image.url)) seen.set(image.url, { ...image, index: seen.size });
        }
      };
      add();
      for (let step = 0; step < maxImages + 4 && seen.size < maxImages; step += 1) {
        const before = seen.size;
        const buttons = [...document.querySelectorAll('button, div[role=button], .slider, .arrow, .next')];
        const next = buttons.find((node) => {
          const label = labelOf(node);
          const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
          if (disabled) return false;
          return /next|right|arrow-right|下一|后|下一个|右/i.test(label);
        });
        if (next) next.click();
        else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
        }
        await sleep(900);
        add();
        if (seen.size === before && step > 2) {
          await sleep(700);
          add();
          if (seen.size === before) break;
        }
      }
      return JSON.stringify([...seen.values()].slice(0, maxImages));
    })()`, 45000);
    return JSON.parse(raw || '[]');
  } finally {
    client.close();
  }
}

async function downloadXiaohongshuImages(note, images, warnings) {
  const dir = path.join(XIAOHONGSHU_ARTIFACT_DIR, todayShanghai(), safePathSegment(note.noteId));
  fs.mkdirSync(dir, { recursive: true });
  const downloaded = [];
  for (const [i, image] of images.entries()) {
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}${imageExtensionFromUrl(image.url)}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      downloaded.push({ ...image, localPath: file, bytes: fs.statSync(file).size, cacheHit: true });
      continue;
    }
    try {
      // Page-supplied image URLs: upgraded to HTTPS, public hosts only, bounded size.
      const { res, bytes: buffer } = await fetchPublicResource(fetch, String(image.url).replace(/^http:\/\//i, 'https://'), {
        headers: {
          'user-agent': BLOG_USER_AGENT,
          referer: note.detailUrl || note.url || 'https://www.xiaohongshu.com/',
        },
      }, { timeoutMs: 20000, maxBytes: 15 * 1024 * 1024 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, buffer);
      downloaded.push({ ...image, localPath: file, bytes: buffer.length });
    } catch (error) {
      warnings.push(`Xiaohongshu image download failed for ${note.noteId} image ${i + 1}: ${error.message}`);
      downloaded.push({ ...image, error: error.message });
    }
  }
  return downloaded;
}

function ocrInputFingerprint(image) {
  const stat = fs.statSync(image.localPath);
  return {
    file: path.basename(image.localPath),
    bytes: stat.size,
  };
}

function runVisionOcrCached(note, ocrInputs, warnings) {
  if (!ocrInputs.length) return { results: [], cacheHit: false, cachePath: null };
  const cachePath = path.join(path.dirname(ocrInputs[0].localPath), 'ocr-cache.json');
  const fingerprints = ocrInputs.map(ocrInputFingerprint);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.version === 1 &&
        JSON.stringify(cached.fingerprints) === JSON.stringify(fingerprints) &&
        Array.isArray(cached.results) && cached.results.length === ocrInputs.length) {
      return { results: cached.results, cacheHit: true, cachePath };
    }
  } catch {
    // Missing or stale cache: regenerate it from the downloaded images.
  }

  const results = runVisionOcr(ocrInputs.map((image) => image.localPath), warnings);
  if (results.length === ocrInputs.length) {
    fs.writeFileSync(cachePath, `${JSON.stringify({
      version: 1,
      noteId: note.noteId,
      createdAt: new Date().toISOString(),
      fingerprints,
      results,
    }, null, 2)}\n`);
  }
  return { results, cacheHit: false, cachePath };
}

function normalizeQueryText(value = '') {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[“”"']/g, '')
    .replace(/^[\s\-–—•*#]+/, '')
    .trim();
}

function isNoisyPaperQueryLine(value = '') {
  const clean = normalizeQueryText(value);
  if (clean.length < 18 || clean.length > 180) return true;
  if (/^[\d\W_]+$/.test(clean)) return true;
  if (/^(https?:|www\.|#|@)/i.test(clean) || /\b[a-z0-9.-]+\.(edu|com|org|ai|io)\b/i.test(clean)) return true;
  if (/^(home|首页|comment|评论|关注|已关注|发送|取消|the end|figure|table|abstract|introduction|references|github|paper|论文)$/i.test(clean)) return true;
  if (/评论|回复|作者|图\d+|下周见|看不过来|推荐多|有点水|思路|没get到|合集第|关注|已关注|分享|收藏|点赞/.test(clean)) return true;
  if (/ar\s*xiv|submitted|subjects?:|cs\.[A-Z]{2}|doi:|journal|conference/i.test(clean)) return true;
  if (isLikelyAuthorOrAffiliationLine(clean)) return true;
  if ((clean.match(/[,，]/g) || []).length >= 3) return true;
  if ((clean.match(/[?？!！*§°®]/g) || []).length >= 3) return true;
  if ((clean.match(/[a-zA-Z]/g) || []).length < 10 && !/[\u4e00-\u9fff]/.test(clean)) return true;
  return false;
}

function isLikelyAuthorOrAffiliationLine(value = '') {
  const clean = normalizeQueryText(value);
  if (!clean) return true;
  if (/@|\b(Equal contribution|Correspondence|Project Page|Code:|Preprint|Blind)\b/i.test(clean)) return true;
  if (/\b(University|Institute|Department|Lab|Labs|School|College|NVIDIA|Meta AI|Stanford|MIT|EPFL|Salesforce|Tencent|Tsinghua|Cornell|Michigan|Wisconsin|Cambridge|Hong Kong|Madison)\b/i.test(clean) && !/:/.test(clean)) return true;
  if (/^\d+\s+[A-Z]/.test(clean)) return true;
  if (/[*,†‡§]/.test(clean) && /[A-Z][a-z]+/.test(clean)) return true;
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+.*[,，].*[A-Z][a-z]+ [A-Z][a-z]+/.test(clean)) return true;
  return false;
}

function cleanPaperQueryLine(value = '') {
  return normalizeQueryText(value)
    .replace(/\bar\s*xiv\s*[:：]?\s*\d{4}\.\d{4,6}(v\d+)?\b/ig, '')
    .replace(/\[[a-z]{2}\.[A-Z]{2}\]/g, '')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+[A-Z][a-z]{2}\s+20\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPaperMetadataLine(value = '') {
  const clean = normalizeQueryText(value);
  return !clean ||
    /ar\s*xiv|^\[[a-z]{2}\.[A-Z]{2}\]|^\d{1,2}\s+[A-Z][a-z]{2}\s+20\d{2}$|^May\s+20\d{2}$/i.test(clean) ||
    /^[\d\s]+$/.test(clean);
}

function extractPaperCandidateQueries(note, ocrResults) {
  const candidates = [];
  const add = (query, source, imageIndex = null) => {
    const clean = cleanPaperQueryLine(query);
    if (isNoisyPaperQueryLine(clean)) return;
    candidates.push({ query: clean, source, imageIndex });
  };

  if (note.title && !/合集第|paper推荐合集|论文推荐合集/i.test(note.title)) {
    add(note.title, 'note_title', null);
  }

  for (const [index, result] of ocrResults.entries()) {
    if (!result?.ok || !result.text) continue;
    const lines = result.text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      add(lines[i], 'ocr_line', index);
      if (i + 1 < lines.length) add(`${lines[i]} ${lines[i + 1]}`, 'ocr_2line', index);
    }
  }

  return uniqueBy(candidates, (item) => item.query.toLowerCase()).slice(0, 12);
}

function titleCandidatesFromLines(lines, start, end) {
  const candidates = [];
  for (let i = start; i <= end; i += 1) {
    const first = cleanPaperQueryLine(lines[i] || '');
    if (isNoisyPaperQueryLine(first)) continue;
    candidates.push({ title: first, index: i });
    const second = cleanPaperQueryLine(lines[i + 1] || '');
    if (i + 1 <= end && !isNoisyPaperQueryLine(second)) {
      candidates.push({ title: `${first} ${second}`, index: i });
    }
  }
  return candidates;
}

function bestNearbyTitleForArxiv(lines, lineIndex) {
  const candidates = [];

  let forwardStart = null;
  for (let i = lineIndex + 1; i <= Math.min(lines.length - 1, lineIndex + 10); i += 1) {
    if (isPaperMetadataLine(lines[i])) continue;
    if (isLikelyAuthorOrAffiliationLine(lines[i])) break;
    forwardStart = i;
    break;
  }
  if (forwardStart !== null) {
    let forwardEnd = forwardStart;
    for (let i = forwardStart + 1; i <= Math.min(lines.length - 1, forwardStart + 2); i += 1) {
      if (isPaperMetadataLine(lines[i]) || isLikelyAuthorOrAffiliationLine(lines[i])) break;
      forwardEnd = i;
    }
    candidates.push(...titleCandidatesFromLines(lines, forwardStart, forwardEnd));
  }

  const beforeEnd = lineIndex - 1;
  const beforeStart = Math.max(0, lineIndex - 12);
  candidates.push(...titleCandidatesFromLines(lines, beforeStart, beforeEnd));

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: candidate.title.length + (/:/.test(candidate.title) ? 20 : 0) - Math.abs(candidate.index - lineIndex) * 4,
    }))
    .sort((a, b) => b.score - a.score)[0]?.title || '';
}

function directArxivLinksFromText(text, metadata = {}) {
  const links = [];
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const [lineIndex, line] of lines.entries()) {
    const regex = /(?:\bar\s*xiv\s*[:：]?\s*)?(\d{4}\.\d{4,6})(v\d+)?\b/ig;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const arxivId = `${match[1]}${match[2] || ''}`;
      const title = metadata.title || bestNearbyTitleForArxiv(lines, lineIndex) || `arXiv ${arxivId}`;
      links.push({
        query: title,
        candidateSource: metadata.candidateSource || 'ocr_arxiv_id',
        imageIndex: metadata.imageIndex ?? null,
        source: metadata.source || 'arxiv_ocr',
        title,
        url: `https://arxiv.org/abs/${arxivId}`,
        summary: '',
        confidence: 1,
      });
    }
  }
  return uniqueBy(links, (item) => item.url);
}

function directArxivLinksFromOcr(ocrResults, preferredImageIndexes = []) {
  const preferred = new Set(preferredImageIndexes);
  return uniqueBy(ocrResults.flatMap((result, resultIndex) => {
    if (!result?.ok || !result.text) return [];
    const imageIndex = result.imageIndex ?? resultIndex;
    return directArxivLinksFromText(result.text, {
      candidateSource: 'ocr_arxiv_id',
      imageIndex,
      source: 'arxiv_ocr',
    }).map((link) => ({
      ...link,
      sourceIndex: imageIndex + 1,
      authorPreferred: preferred.has(imageIndex),
    }));
  }), (item) => item.url);
}

function preferredXiaohongshuImageIndexes(text = '') {
  const indexes = [];
  for (const line of String(text).split('\n')) {
    if (!/个人.{0,8}(?:喜欢|推荐)/.test(line)) continue;
    const regex = /图\s*(\d{1,2})/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const index = Number(match[1]) - 1;
      if (index >= 0) indexes.push(index);
    }
  }
  return [...new Set(indexes)];
}

function normalizeOcrUrlLine(value = '') {
  return String(value)
    .replace(/https?\s*:\s*\/\s*\//ig, (match) => match.toLowerCase().startsWith('https') ? 'https://' : 'http://')
    .replace(/([a-z0-9])\.\s+(?=[a-z]{2,}(?:\/|\b))/ig, '$1.')
    .replace(/\?\s*/g, '?')
    .replace(/\s*([=&])\s*/g, '$1')
    .replace(/([?&])id-/ig, '$1id=');
}

function directSourceLinksFromOcr(ocrResults, preferredImageIndexes = []) {
  const preferred = new Set(preferredImageIndexes);
  return uniqueBy(ocrResults.flatMap((result, resultIndex) => {
    if (!result?.ok || !result.text) return [];
    const imageIndex = result.imageIndex ?? resultIndex;
    const title = bestPaperTitleCandidate(result.text)?.title || `Xiaohongshu image ${imageIndex + 1}`;
    return result.text.split('\n').flatMap((line) => extractDirectHttpUrls(normalizeOcrUrlLine(line)))
      .filter(isUsefulXiaohongshuSourceUrl)
      .filter((url) => {
        const parsed = new URL(url);
        return parsed.pathname.length > 1 || /^(?:www\.)?(?:arxiv\.org|openreview\.net|github\.com)$/i.test(parsed.hostname);
      })
      .map((url) => ({
        query: title,
        candidateSource: 'ocr_direct_url',
        imageIndex,
        sourceIndex: imageIndex + 1,
        source: 'ocr_direct_url',
        title,
        url,
        summary: '',
        confidence: 1,
        authorPreferred: preferred.has(imageIndex),
        resolutionMethod: 'direct_url',
        verified: false,
      }));
  }), (item) => `${item.imageIndex}:${item.url}`);
}

function bestPaperTitleCandidate(text = '') {
  return paperTitleCandidates(text)[0] || null;
}

function paperTitleCandidates(text = '') {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const isTitleContinuation = (value) => {
    const clean = cleanPaperQueryLine(value);
    if (clean.length < 12 || clean.length > 120) return false;
    if (/^(abstract|introduction|published|under review|accepted|reviewed)/i.test(clean)) return false;
    if (/@|https?:|\b(University|Institute|Department|Lab|Labs|School|College)\b/i.test(clean)) return false;
    if (/[*†‡§]/.test(clean) || (clean.match(/[,，]/g) || []).length >= 3) return false;
    const words = clean.split(/\s+/).filter(Boolean);
    const looksLikeSingleAuthor = words.length >= 2 && words.length <= 4 &&
      words.every((word) => /^[A-Z][a-z.'-]+$/.test(word));
    if (looksLikeSingleAuthor) return false;
    return /[a-zA-Z]{4}/.test(clean);
  };
  const candidates = [];
  for (let index = 0; index <= Math.min(lines.length - 1, 20); index += 1) {
    const first = cleanPaperQueryLine(lines[index]);
    if (/^(published|under review|accepted|reviewed)/i.test(first) || isNoisyPaperQueryLine(first)) continue;
    candidates.push({ title: first, index });
    const second = cleanPaperQueryLine(lines[index + 1] || '');
    if (isTitleContinuation(second)) candidates.push({ title: `${first} ${second}`, index });
    break;
  }
  return uniqueBy(candidates, (candidate) => candidate.title.toLowerCase()).slice(0, 2);
}

function exactTitleCandidatesFromOcr(ocrResults, excludedImageIndexes = []) {
  const excluded = new Set(excludedImageIndexes);
  return ocrResults.flatMap((result, resultIndex) => {
    if (!result?.ok || !result.text) return [];
    const imageIndex = result.imageIndex ?? resultIndex;
    if (excluded.has(imageIndex)) return [];
    return paperTitleCandidates(result.text).map((candidate, candidateIndex) => ({
      query: candidate.title,
      source: 'ocr_exact_title_author',
      imageIndex,
      sourceIndex: imageIndex + 1,
      candidateIndex,
      ocrText: result.text,
      localPath: result.localPath,
    }));
  });
}

function stripTags(value = '') {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
}

function queryScore(query, title) {
  const tokens = normalizeQueryText(query).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const titleText = normalizeQueryText(title).toLowerCase();
  if (!tokens.length || !titleText) return 0;
  const hits = tokens.filter((token) => titleText.includes(token)).length;
  return hits / Math.max(tokens.length, 1);
}

function titleSimilarity(left, right) {
  const tokens = (value) => normalizeQueryText(value).toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const overlap = [...aSet].filter((token) => bSet.has(token)).length;
  return (2 * overlap) / (aSet.size + bSet.size);
}

function matchingAuthors(authors, ocrText) {
  const haystack = normalizeQueryText(ocrText).toLowerCase();
  return authors.filter((author) => {
    const parts = normalizeQueryText(author).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const surname = parts.at(-1) || '';
    return surname.length >= 3 && haystack.includes(surname);
  });
}

function abstractKeywordScore(summary, ocrText) {
  const stop = new Set(['about', 'after', 'again', 'against', 'between', 'could', 'first', 'from', 'have', 'into', 'large', 'model', 'models', 'paper', 'their', 'there', 'these', 'this', 'through', 'using', 'which', 'with']);
  const keywords = [...new Set(normalizeQueryText(summary).toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 5 && !stop.has(token)))]
    .slice(0, 40);
  if (!keywords.length) return 0;
  const haystack = normalizeQueryText(ocrText).toLowerCase();
  return keywords.filter((token) => haystack.includes(token)).length / keywords.length;
}

async function searchArxivPaperByExactTitle(candidate) {
  const searchTitle = normalizeQueryText(candidate.query).replace(/[^\p{L}\p{N}\s:\-?]/gu, ' ').replace(/\s+/g, ' ').trim();
  const query = `ti:"${searchTitle.replace(/"/g, '')}"`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=3`;
  const xml = await fetchText(url, { headers: { 'user-agent': BLOG_USER_AGENT } }, 15000);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const title = stripTags(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/\s+/g, ' ');
    const rawUrl = stripTags(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] || '');
    const summary = stripTags(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\s+/g, ' ').slice(0, 1000);
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((authorMatch) => stripTags(authorMatch[1] || ''))
      .filter(Boolean);
    const similarity = titleSimilarity(candidate.query, title);
    const authorMatches = matchingAuthors(authors, candidate.ocrText);
    const keywordScore = abstractKeywordScore(summary, candidate.ocrText);
    const verified = similarity >= 0.82 && (authorMatches.length > 0 || keywordScore >= 0.3 || similarity >= 0.96);
    return {
      source: 'arxiv_exact_title_author',
      title,
      url: rawUrl.replace(/^http:\/\//, 'https://'),
      summary: summary.slice(0, 500),
      authors,
      titleSimilarity: similarity,
      authorMatches,
      keywordScore,
      confidence: Math.min(1, similarity * 0.75 + Math.min(authorMatches.length, 2) * 0.1 + keywordScore * 0.15),
      verified,
    };
  }).filter((item) => item.title && item.url && item.verified);
  return entries.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

async function resolveExactTitlePaperLinks(note, candidates, warnings) {
  if (!candidates.length) return [];
  const cachePath = path.join(path.dirname(candidates[0].localPath), 'source-resolution-cache.json');
  const cached = readJsonFile(cachePath) || { version: 1, noteId: note.noteId, entries: {} };
  const resolved = [];
  const resolvedImages = new Set();
  for (const candidate of candidates) {
    if (resolvedImages.has(candidate.imageIndex)) continue;
    const legacyKey = String(candidate.imageIndex);
    const key = `${candidate.imageIndex}:${candidate.query.toLowerCase()}`;
    const cachedEntry = cached.entries?.[key] ||
      (cached.entries?.[legacyKey]?.query === candidate.query ? cached.entries[legacyKey] : null);
    let match = cachedEntry?.query === candidate.query && cachedEntry?.result?.verified
      ? { ...cachedEntry.result, cacheHit: true }
      : null;
    if (!match) {
      try {
        match = await searchArxivPaperByExactTitle(candidate);
      } catch (error) {
        warnings.push(`Exact paper title resolution failed for image ${candidate.sourceIndex} "${candidate.query.slice(0, 80)}": ${error.message.slice(0, 180)}`);
      }
      cached.entries ||= {};
      cached.entries[key] = { query: candidate.query, result: match, checkedAt: new Date().toISOString() };
      await sleep(1000);
    }
    if (match) {
      resolved.push({
        query: candidate.query,
        candidateSource: candidate.source,
        imageIndex: candidate.imageIndex,
        sourceIndex: candidate.sourceIndex,
        resolutionMethod: 'exact_title_author_search',
        authorPreferred: (note.preferredImageIndexes || []).includes(candidate.imageIndex),
        ...match,
      });
      resolvedImages.add(candidate.imageIndex);
    }
  }
  fs.writeFileSync(cachePath, `${JSON.stringify({ ...cached, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  return uniqueBy(resolved, (item) => item.url);
}

async function searchArxivPaper(query) {
  const searchQuery = normalizeQueryText(query).replace(/[^\p{L}\p{N}\s:\-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(searchQuery)}&start=0&max_results=3`;
  const xml = await fetchText(url, { headers: { 'user-agent': BLOG_USER_AGENT } }, 15000);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const title = stripTags(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const id = stripTags(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] || '');
    const summary = stripTags(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\s+/g, ' ').slice(0, 500);
    return { source: 'arxiv', title, url: id, summary, confidence: queryScore(query, title) };
  }).filter((item) => item.title && item.url);
  return entries.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

async function searchSemanticScholarPaper(query) {
  if (semanticScholarRateLimited) return null;
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=3&fields=title,url,year,authors,externalIds,abstract`;
  let json;
  try {
    json = JSON.parse(await fetchText(url, { headers: { 'user-agent': BLOG_USER_AGENT } }, 15000));
  } catch (error) {
    if (/HTTP 429/.test(error.message)) {
      semanticScholarRateLimited = true;
      error.rateLimited = true;
    }
    throw error;
  }
  const papers = Array.isArray(json?.data) ? json.data : [];
  return papers
    .map((paper) => ({
      source: 'semantic_scholar',
      title: paper.title || '',
      url: paper.url || (paper.externalIds?.ArXiv ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}` : ''),
      year: paper.year,
      summary: (paper.abstract || '').replace(/\s+/g, ' ').slice(0, 500),
      confidence: queryScore(query, paper.title || ''),
    }))
    .filter((item) => item.title && item.url)
    .sort((a, b) => b.confidence - a.confidence)[0] || null;
}

async function resolvePaperLinks(candidates, warnings) {
  const resolved = [];
  let semanticScholarRateLimitWarned = false;
  for (const candidate of candidates) {
    const matches = [];
    for (const search of [searchArxivPaper, searchSemanticScholarPaper]) {
      try {
        const match = await search(candidate.query);
        if (match && match.confidence >= 0.45) matches.push(match);
      } catch (error) {
        if (error.rateLimited || /HTTP 429/.test(error.message)) {
          if (!semanticScholarRateLimitWarned) {
            warnings.push('Semantic Scholar link resolution rate-limited; continuing with direct arXiv IDs and arXiv API matches');
            semanticScholarRateLimitWarned = true;
          }
        } else {
          warnings.push(`Paper link search failed for "${candidate.query.slice(0, 80)}": ${error.message.slice(0, 220)}`);
        }
      }
      if (matches.length) break;
    }
    const best = matches.sort((a, b) => b.confidence - a.confidence)[0];
    if (best) {
      resolved.push({
        query: candidate.query,
        candidateSource: candidate.source,
        imageIndex: candidate.imageIndex,
        ...best,
      });
    }
    if (resolved.length >= XIAOHONGSHU_MAX_LINKS_PER_NOTE) break;
    await sleep(300);
  }
  return uniqueBy(resolved, (item) => item.url);
}

async function enrichXiaohongshuNoteImages(note, target, warnings) {
  const structuredImages = (note.stateImages || []).slice(0, XIAOHONGSHU_MAX_CAROUSEL_IMAGES);
  const carouselImages = structuredImages.length
    ? structuredImages
    : await collectXiaohongshuCarouselImages(target).catch((error) => {
      warnings.push(`Xiaohongshu carousel image collection failed for ${note.noteId}: ${error.message}`);
      return (note.imageUrls || []).map((url, index) => ({ url, index }));
    });
  const downloadedImages = await downloadXiaohongshuImages(note, carouselImages, warnings);
  const ocrInputs = downloadedImages
    .filter((image) => image.localPath && !image.error)
    .slice(0, XIAOHONGSHU_MAX_OCR_IMAGES);
  const cachedOcr = runVisionOcrCached(note, ocrInputs, warnings);
  const ocrResults = cachedOcr.results
    .map((result, index) => ({
      ...result,
      imageIndex: ocrInputs[index]?.index ?? index,
      imageUrl: ocrInputs[index]?.url,
      localPath: ocrInputs[index]?.localPath,
    }));
  const candidateQueries = extractPaperCandidateQueries(note, ocrResults);
  const preferredImageIndexes = note.preferredImageIndexes || [];
  const directLinks = directArxivLinksFromOcr(ocrResults, preferredImageIndexes);
  const directSourceLinks = directSourceLinksFromOcr(ocrResults, preferredImageIndexes);
  const directImageIndexes = new Set(directLinks.map((link) => link.imageIndex));
  const exactTitleCandidates = exactTitleCandidatesFromOcr(ocrResults, [...directImageIndexes]);
  const exactTitleLinks = await resolveExactTitlePaperLinks(note, exactTitleCandidates, warnings);
  const verifiedImageIndexes = new Set([
    ...directLinks.map((link) => link.imageIndex),
    ...exactTitleLinks.map((link) => link.imageIndex),
  ]);
  const fallbackFuzzyLinks = verifiedImageIndexes.size ? [] : await resolvePaperLinks(candidateQueries, warnings);
  const searchedLinks = [...exactTitleLinks, ...fallbackFuzzyLinks];
  const unresolvedImageIndexes = ocrResults
    .map((result) => result.imageIndex)
    .filter((index) => !verifiedImageIndexes.has(index));
  const unresolvedPreferredImageIndexes = preferredImageIndexes.filter((index) => !verifiedImageIndexes.has(index));
  const resolvedLinks = uniqueBy([...directLinks, ...directSourceLinks, ...searchedLinks], (item) => item.url)
    .slice(0, verifiedImageIndexes.size ? XIAOHONGSHU_MAX_DIRECT_LINKS_PER_NOTE : XIAOHONGSHU_MAX_LINKS_PER_NOTE);
  return {
    carouselImages: downloadedImages,
    ocr: {
      provider: runtime.ocr.provider,
      script: VISION_OCR_SCRIPT,
      cacheHit: cachedOcr.cacheHit,
      cachePath: cachedOcr.cachePath,
      imagesProcessed: ocrResults.filter((item) => item.ok).length,
      results: ocrResults,
    },
    preferredImageIndexes,
    verifiedImageIndexes: [...verifiedImageIndexes].sort((a, b) => a - b),
    unresolvedImageIndexes,
    unresolvedPreferredImageIndexes,
    candidateQueries,
    exactTitleCandidates,
    directIdentifierLinks: directLinks,
    directSourceLinks,
    exactTitleLinks,
    searchedLinks,
    resolvedLinks,
  };
}

async function extractXiaohongshuProfile(profile, warnings) {
  const { target, created } = await getOrCreateExactUrlTarget(profile.url);
  try {
    await navigateExistingTarget(target, profile.url);
    await waitForText(target, new RegExp(profile.rednoteId || profile.profileId, 'i'), 18000);
    await scrollPage(target, -10000).catch(() => {});
    const client = new TargetClient(target);
    try {
      const raw = await client.eval(`(() => JSON.stringify({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || '').trim().slice(0, 8000),
        anchors: [...document.querySelectorAll('a[href]')]
          .map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 160), href: a.href }))
          .filter(x => x.href)
          .slice(0, 160)
      }))()`, 20000);
      const snapshot = JSON.parse(raw);
      const maxNotes = XIAOHONGSHU_MAX_NOTES_OVERRIDE > 0 ? XIAOHONGSHU_MAX_NOTES_OVERRIDE : (profile.maxNotes || 2);
      const availableNotes = parseXiaohongshuProfileNotes(profile, snapshot);
      const notes = XIAOHONGSHU_NOTE_IDS_OVERRIDE.length
        ? XIAOHONGSHU_NOTE_IDS_OVERRIDE
          .map((noteId) => availableNotes.find((note) => note.noteId === noteId))
          .filter(Boolean)
          .slice(0, maxNotes)
        : availableNotes.slice(0, maxNotes);
      const missingNoteIds = XIAOHONGSHU_NOTE_IDS_OVERRIDE.filter((noteId) => !notes.some((note) => note.noteId === noteId));
      if (missingNoteIds.length) {
        warnings.push(`Xiaohongshu audit note IDs missing from profile snapshot: ${missingNoteIds.join(', ')}`);
      }
      return {
        source: 'xiaohongshu',
        profile: profile.name,
        displayName: profile.displayName,
        profileId: profile.profileId,
        rednoteId: profile.rednoteId,
        url: snapshot.url,
        title: snapshot.title,
        notes,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    warnings.push(`Xiaohongshu ${profile.name} profile extraction failed: ${error.message}`);
    return {
      source: 'xiaohongshu',
      profile: profile.name,
      displayName: profile.displayName,
      profileId: profile.profileId,
      rednoteId: profile.rednoteId,
      url: profile.url,
      notes: [],
      error: error.message,
    };
  } finally {
    if (created) await closeTarget(target.id);
  }
}

async function extractXiaohongshuNote(note, warnings) {
  const { target, created } = await getOrCreateExactUrlTarget(note.url);
  try {
    await navigateExistingTarget(target, note.url);
    await waitForText(target, new RegExp(note.noteId, 'i'), 12000).catch(() => null);
    let baseNote;
    const client = new TargetClient(target);
    try {
      const raw = await client.eval(`(() => {
        const stateNote = window.__INITIAL_STATE__?.note?.noteDetailMap?.[${JSON.stringify(note.noteId)}]?.note || null;
        const stateImages = (stateNote?.imageList || []).map((image, index) => ({
          url: image.urlDefault || image.urlPre || image.url || (image.infoList || []).map(info => info.url).find(Boolean) || '',
          width: image.width || 0,
          height: image.height || 0,
          index,
          source: 'initial_state'
        })).filter(image => image.url);
        return JSON.stringify({
          title: document.title,
          url: location.href,
          text: (document.body?.innerText || '').trim().slice(0, 6000),
          description: stateNote?.desc || '',
          relatedFile: stateNote?.relatedFile || null,
          stateImages,
          imageUrls: [...document.images]
            .map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight, alt: img.alt || '' }))
            .filter(img => img.src && /xhscdn\\.com/.test(img.src) && img.width >= 300 && img.height >= 300)
            .map(img => img.src)
            .filter((src, i, arr) => arr.indexOf(src) === i)
            .slice(0, 24)
        });
      })()`, 25000);
      const detail = JSON.parse(raw);
      baseNote = {
        ...note,
        detailTitle: detail.title,
        detailUrl: detail.url,
        bodyText: detail.description || cleanXiaohongshuNoteText(detail.text),
        rawText: detail.text,
        descriptionSource: detail.description ? 'initial_state_note_desc' : 'dom_text_fallback',
        relatedFile: detail.relatedFile,
        stateImages: detail.stateImages || [],
        imageUrls: detail.imageUrls,
      };
      baseNote.preferredImageIndexes = preferredXiaohongshuImageIndexes(baseNote.bodyText);
    } finally {
      client.close();
    }
    const attachmentEvidence = await collectXiaohongshuRelatedFile(baseNote, warnings);
    const bodyLinks = extractXiaohongshuBodyUrls(baseNote.bodyText);
    const bodyArxivLinks = directArxivLinksFromText(baseNote.bodyText, {
      candidateSource: 'note_body_arxiv_id',
      source: 'arxiv_note_body',
    });
    const bodyResolvedLinks = uniqueBy([...bodyLinksAsResolvedLinks(bodyLinks), ...bodyArxivLinks], (item) => item.url);
    const bodyLinkListDeclared = bodyLinks.length > 0 && /链接按序(?:如下|放在)|链接如下/.test(baseNote.bodyText || '');
    const expectedItems = attachmentEvidence.relatedFile?.expectedItems || 0;
    const attachmentComplete = attachmentEvidence.attachmentLinks.length > 0 &&
      (!expectedItems || attachmentEvidence.attachmentLinks.length >= expectedItems);
    const attachmentResolvedLinks = attachmentLinksAsResolvedLinks(attachmentEvidence.attachmentLinks);
    if (attachmentComplete) {
      return {
        ...baseNote,
        ...attachmentEvidence,
        carouselImages: [],
        ocr: {
          provider: runtime.ocr.provider,
          script: VISION_OCR_SCRIPT,
          imagesProcessed: 0,
          results: [],
          skippedReason: 'complete ordered attachment link list available',
        },
        candidateQueries: [],
        bodyLinks,
        bodyArxivLinks,
        resolvedLinks: uniqueBy([...attachmentResolvedLinks, ...bodyResolvedLinks], (item) => item.url),
        evidenceStrategy: 'description_and_attachment',
        evidenceClass: 'ordered_attachment_links',
        promotionPolicy: 'fetch_first_party_then_select',
      };
    }
    if (bodyLinkListDeclared) {
      return {
        ...baseNote,
        ...attachmentEvidence,
        bodyLinks,
        bodyArxivLinks,
        carouselImages: [],
        ocr: {
          provider: runtime.ocr.provider,
          script: VISION_OCR_SCRIPT,
          imagesProcessed: 0,
          results: [],
          skippedReason: 'explicit ordered link list available in note body',
        },
        candidateQueries: [],
        resolvedLinks: uniqueBy([...attachmentResolvedLinks, ...bodyResolvedLinks], (item) => item.url),
        evidenceStrategy: attachmentEvidence.attachmentLinks.length ? 'description_attachment_and_body_links' : 'description_and_body_links',
        evidenceClass: 'ordered_body_links',
        promotionPolicy: 'fetch_first_party_then_select',
      };
    }
    const imageEvidence = await enrichXiaohongshuNoteImages(baseNote, target, warnings);
    const hasDirectImageIdentifiers = (imageEvidence.directIdentifierLinks || []).length > 0;
    const hasSearchedLinks = (imageEvidence.searchedLinks || []).length > 0;
    const fallbackStrategy = hasDirectImageIdentifiers
      ? 'ocr_direct_identifier_fallback'
      : hasSearchedLinks ? 'ocr_search_fallback' : 'ocr_unresolved';
    const evidencePrefix = attachmentEvidence.attachmentLinks.length
      ? 'attachment_plus_'
      : bodyResolvedLinks.length ? 'body_links_plus_' : '';
    return {
      ...baseNote,
      ...attachmentEvidence,
      ...imageEvidence,
      bodyLinks,
      bodyArxivLinks,
      resolvedLinks: uniqueBy([...attachmentResolvedLinks, ...bodyResolvedLinks, ...(imageEvidence.resolvedLinks || [])], (item) => item.url),
      evidenceStrategy: `${evidencePrefix}${fallbackStrategy}`,
      evidenceClass: hasDirectImageIdentifiers ? 'screenshot_direct_identifiers' : hasSearchedLinks ? 'screenshot_fuzzy_matches' : 'screenshot_unresolved',
      promotionPolicy: hasDirectImageIdentifiers ? 'fetch_first_party_then_select' : 'local_audit_only_unless_semantically_verified',
    };
  } catch (error) {
    warnings.push(`Xiaohongshu note ${note.noteId} extraction failed: ${error.message}`);
    return { ...note, error: error.message, imageUrls: [] };
  } finally {
    if (created) await closeTarget(target.id);
  }
}

async function collectXiaohongshu(warnings) {
  const config = loadSourceConfig();
  const profiles = Array.isArray(config.xiaohongshuProfiles) ? config.xiaohongshuProfiles : [];
  const results = [];

  for (const profile of profiles) {
    const profileResult = await extractXiaohongshuProfile(profile, warnings);
    const notes = [];
    for (const note of profileResult.notes || []) {
      notes.push(await extractXiaohongshuNote(note, warnings));
      await sleep(700);
    }
    results.push({ ...profileResult, notes });
  }

  return results;
}

async function navigateExistingTarget(target, url) {
  const client = new TargetClient(target);
  try {
    let navigateError = null;
    try {
      await client.send('Page.navigate', { url }, 10000);
    } catch (error) {
      navigateError = error;
    }
    await sleep(3500);
    await client.waitForReady(15000);
    if (navigateError) {
      const state = JSON.parse(await client.eval(`(() => JSON.stringify({
        url: location.href,
        readyState: document.readyState,
        hasBody: Boolean(document.body?.innerText?.trim())
      }))()`, 5000) || '{}');
      const requested = new URL(url);
      const current = new URL(state.url || 'about:blank');
      const reachedRequestedPage = current.origin === requested.origin && current.pathname === requested.pathname && state.hasBody;
      if (!reachedRequestedPage) throw navigateError;
    }
  } finally {
    client.close();
  }
}

  async function collectSources({ authorized = false } = {}) {
    assertCollectionAllowed(runtime, { authorized });
    if (used) throw new Error('Create a fresh collector and run directory for each run');
    used = true;
    active = true;
    const startedMs = Date.now();
    const runStartedAt = clock();
    deadline = startedMs + runtime.totalBudgetMs;
    let store;
    let stage = 'browser_connection';
    try {
      store = openCoverageStore(runtime, runStartedAt);
      fs.mkdirSync(XIAOHONGSHU_ATTACHMENT_CACHE_DIR, { recursive: true });
      await ensureChrome();
      stage = 'required_following';
      const window = freshWindow(runStartedAt, runtime.lookbackHours);
      const warnings = [];
      const pages = {};
      for (const page of REQUIRED_PAGES) {
        try { pages[page.key] = await getOrCreateTarget(page); }
        catch (error) {
          if (page.key === 'xFollowing') throw error;
          warnings.push(`${page.label} page unavailable: ${error.message}`);
        }
      }
      await navigateExistingTarget(pages.xFollowing, pageUrl('xFollowing'));
      await waitForXTimelineContent(pages.xFollowing, 20000);
      await clickSeeNewPosts(pages.xFollowing);
      const following = await collectFeedWindow(pages.xFollowing, 'x', window);
      let xItems = following.items.map(item => ({ ...item, discovery: 'following_timeline' }));
      const reports = { xFollowing: [following.coverage], substack: [] };
      recordCollectionCoverage(store.state, { collectionId: runtime.runId + '-following', collectedAt: runStartedAt.toISOString(),
        coverage: { reports: { xFollowing: [following.coverage] } }, sources: { xFollowing: xItems }, deepLinkAudit: [] });
      store.save(store.state);
      if (['login_required', 'page_error', 'rate_limited'].includes(following.coverage.reason)) throw new Error(`Required X Following failed: ${following.coverage.reason}`);
      if (!following.items.length) throw new Error('X Following produced 0 usable items; no digest may be composed');
      stage = 'coverage_recovery';
      const catchup = await runCoveragePlan({ ...runtime, totalBudgetMs: Math.max(1, runtime.totalBudgetMs - Math.min(600000, runtime.totalBudgetMs / 5)) }, store.state, {
        now: () => runStartedAt, startMs: startedMs,
        // Current CDP adapter has no verified isolated cancellation; CUA is also serial.
        capability: { transport: 'cdp', independentTargets: false, cancellation: false },
        checkpoint: state => store.save(state),
        scan: async (slice, budget) => {
          let target;
          const sliceStarted = Date.now();
          try {
            const since = Math.floor(Date.parse(slice.start) / 1000), until = Math.ceil(Date.parse(slice.end) / 1000);
            const url = `https://x.com/search?q=${encodeURIComponent(`filter:follows since_time:${since} until_time:${until}`)}&f=live`;
            target = await createTarget(url);
            await sleep(2500);
            const maxMs = budget.maxMs - (Date.now() - sliceStarted);
            if (maxMs <= 0) { const error = new Error('Window budget exhausted opening search'); error.code = 'RUN_BUDGET'; throw error; }
            const search = await collectFeedWindow(target, 'x', slice, true, { ...budget, maxMs });
            if ((search.coverage.newestObserved && Date.parse(search.coverage.newestObserved) >= until * 1000) ||
                (search.coverage.oldestObserved && Date.parse(search.coverage.oldestObserved) < since * 1000)) {
              search.coverage.scanned = false;
              search.coverage.boundaryEvidence = null;
              search.coverage.timeFilterNotRespected = true;
              if (!['login_required', 'rate_limited', 'page_error', 'interrupted', 'read_error', 'scroll_error', 'recovery_error'].includes(search.coverage.reason)) search.coverage.reason = 'search_time_filter_not_respected';
            }
            search.items = search.items.map(item => ({ ...item, discovery: 'gos_48h_follows_search' }));
            search.coverage = { ...search.coverage, query: url, source: 'xFollowingSearch' };
            reports.xFollowing.push(search.coverage);
            return search;
          } finally { if (target) await closeTarget(target.id); }
        },
      });
      warnings.push(`Recent-48h recovery: ${catchup.stopReason}; effective browser concurrency ${catchup.policy.effectiveConcurrency}`);
      xItems = mergeItems(xItems, store.state.items);
      stage = 'optional_sources';
      let substackItems = [];
      if (pages.substack) {
        try {
          await navigateExistingTarget(pages.substack, pageUrl('substack'));
          const sub = await collectFeedWindow(pages.substack, 'substack', window);
          substackItems = sub.items;
          reports.substack.push(sub.coverage);
        } catch (error) { warnings.push(`Substack unavailable: ${error.message}`); }
      }
      const watchProfiles = [], watchChecks = {};
      for (const { key, url, profile } of REQUIRED_PAGES.filter(page => page.profile)) {
        let items = [];
        if (pages[key]) {
          try {
            await navigateExistingTarget(pages[key], url);
            items = await extractHydratedXTimeline(pages[key], profile.name, warnings, profile.latest);
          } catch (error) { warnings.push(`${profile.name} sanity check unavailable: ${error.message}`); }
        }
        watchProfiles.push({ handle: profile.handle, name: profile.name, required: profile.required, items });
        watchChecks[profile.handle] = { attempted: true, available: Boolean(pages[key]), items: items.length };
      }
      // digest.mjs and the prompts read the karpathy group by name; mirror that profile here.
      const karpathy = watchProfiles.find(profile => profile.handle.toLowerCase() === 'karpathy');
      const karpathyItems = karpathy?.items ?? [];
      const karpathyCheck = karpathy ? watchChecks[karpathy.handle] : { attempted: false };
      for (const [source, values] of Object.entries(reports)) {
        for (const report of values) if (!report.scanned) warnings.push(`${source} fresh-window scan incomplete: ${report.reason}`);
      }
      const { items: blogs, checks: blogChecks } = await collectBlogs(warnings).catch(error => { warnings.push(`Blogs unavailable: ${error.message}`); return { items: [], checks: {} }; });
      const xiaohongshu = await collectXiaohongshu(warnings).catch(error => { warnings.push(`Xiaohongshu unavailable: ${error.message}`); return []; });
      const deepLinkAudit = extractInterestingLinks([...xItems, ...substackItems]);
      const deepArticles = [];
      for (const link of deepLinkAudit.filter(link => link.selected)) {
        try {
          const article = await extractArticleBody(link);
          deepArticles.push({ ...article, sourceHref: link.href });
          link.readStatus = article.error ? 'failed' : 'read';
          link.truncated = article.truncated === true;
          if (article.error) warnings.push(`Deep read failed: ${link.href}`);
        } catch (error) { link.readStatus = 'failed'; link.failureReason = error.code === 'RUN_BUDGET' ? 'total_time_budget' : 'deep_read_error'; warnings.push(`Deep read failed: ${link.href}: ${error.message}`); }
      }
      const result = {
        schemaVersion: 1, collectionId: runtime.runId,
        digestMarker: `<!-- x-daily-collection: ${runtime.runId} -->`,
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock()),
        collectedAt: clock().toISOString(),
        coverage: { window: freshWindow(runStartedAt, 48), digestWindow: window, assurance: 'best_effort_ui_not_all_posts', reports, carriedFrom: 'gos_new_remote_state_only', execution: catchup },
        checks: { xFollowing: { attempted: true, available: true, status: 'ok', items: following.items.length }, karpathy: karpathyCheck, watch: watchChecks, blogs: blogChecks },
        warnings, deepLinkAudit,
        sources: { xFollowing: xItems, substack: substackItems, karpathy: karpathyItems, watchProfiles, blogs, xiaohongshu, deepArticles },
        stats: { xFollowing: xItems.length, freshXFollowing: following.items.length, substack: substackItems.length,
          karpathy: karpathyItems.length, watchProfiles: watchProfiles.reduce((n, p) => n + p.items.length, 0), blogs: blogs.length, xiaohongshu: xiaohongshu.reduce((n, p) => n + p.notes.length, 0), deepArticles: deepArticles.length },
      };
      result.coverage.accounting = recordCollectionCoverage(store.state, result);
      store.save(store.state);
      fs.writeFileSync(path.join(LOCAL_DIR, 'sources.json'), JSON.stringify(result, null, 2) + '\n');
      appendLog({ event: 'collect_completed', stats: result.stats });
      return result;
    } catch (error) {
      if (store) {
        recordCollectionCoverage(store.state, { collectionId: runtime.runId + '-failed', collectedAt: clock().toISOString(),
          coverage: { reports: { xFollowing: [{ ...freshWindow(runStartedAt, 48), scanned: false, boundaryEvidence: null, undatedItems: 0,
            assurance: 'best_effort_ui', reason: stage === 'browser_connection' ? 'runtime_blocked' : stage === 'required_following' ? 'required_following_failed' : 'collection_interrupted', error: error.message }] } }, sources: { xFollowing: [] }, deepLinkAudit: [] });
        store.save(store.state);
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, 'failure.json'), JSON.stringify({ status: 'collection_failed_no_digest', stage, error: error.message, coverage: coverageReport(store.state, clock()) }, null, 2) + '\n');
      }
      throw error;
    } finally { active = false; store?.close(); }
  }
  return { collect: collectSources };
}
