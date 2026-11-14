// Scripted source collector for Gos X Daily. One collection flow, pluggable browser drivers:
// apple-events (macOS Dia/Chromium), cdp (any OS, loopback DevTools endpoint) or codex exec; plus public feeds,
// writing browser-capture.json, feed-capture.json, sources.json, sources.merged.json, and supplements.public.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeRuntime, validateWatchProfiles, defaultWatchProfiles } from '../../runtime.mjs';
import { publicUrlRefusal } from '../../feed.mjs';
import { htmlToText } from '../../feed-import.mjs';
import { fetchFeeds } from '../../tools/fetch-feeds.mjs';
import { collectionFromBrowserArtifacts, verifyEvidenceFiles } from '../../browser-artifacts.mjs';
import { main as runCli } from '../../cli.mjs';
import { readApiKey } from './openai-draft.mjs';
import { createCdpBrowserDriver, recordScreenshotEvidence, loopbackCdpEndpoint, DEFAULT_CDP_ENDPOINT } from './cdp-browser-driver.mjs';
import { assertCollectionAllowed } from '../../runtime.mjs';

const CAPTURE_WINDOW_GUARD_MS = 115 * 60 * 1000;
const SUPPLEMENTS_MAX_CHARS = 32000;
const BLOG_MAX_CHARS = 24000;
const LIMITATIONS_FILE = 'collection-limitations.json';
const SOCIAL_DISCOVERY_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 't.co']);
const NON_ARTICLE_HOSTS = /(?:^|\.)(?:x\.com|twitter\.com|youtube\.com|youtu\.be|instagram\.com|facebook\.com|linkedin\.com)$/i;

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writePrivateJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const X_EXTRACT_SCRIPT = `
  const showMore = document.querySelectorAll('article[data-testid="tweet"] button[data-testid="tweet-text-show-more-link"]');
  for (const btn of showMore) {
    try { btn.click(); } catch {}
  }
  const items = [];
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const labels = [...art.querySelectorAll('span')].map(el => (el.innerText || '').trim());
    if (labels.includes('Ad') || labels.includes('Promoted') || labels.includes('推广')) continue;

    let statusUrl = null;
    let publishedAt = null;
    for (const anchor of art.querySelectorAll('a[href*="/status/"]')) {
      const timeEl = anchor.querySelector('time[datetime]');
      if (!timeEl) continue;
      try {
        const u = new URL(anchor.getAttribute('href'), 'https://x.com');
        const m = u.pathname.match(/^\\/([A-Za-z0-9_]+)\\/status\\/(\\d+)/);
        if (m) {
          statusUrl = 'https://x.com/' + m[1] + '/status/' + m[2];
          publishedAt = timeEl.getAttribute('datetime') || null;
          break;
        }
      } catch {}
    }
    if (!statusUrl) continue;

    const textNodes = [...art.querySelectorAll('[data-testid="tweetText"]')];
    let text = '';
    if (textNodes.length === 1) {
      text = (textNodes[0].innerText || '').trim();
    } else if (textNodes.length > 1) {
      const main = (textNodes[0].innerText || '').trim();
      const quote = (textNodes[1].innerText || '').trim();
      text = quote ? (main + (main ? '\\n\\n[Quote] ' : '[Quote] ') + quote) : main;
    }
    if (!text) {
      const card = art.querySelector('[data-testid="card.wrapper"], [data-testid="article-cover"]');
      if (card) text = (card.innerText || '').trim();
    }
    if (!text) continue;

    const linkMap = new Map();
    for (const anchor of art.querySelectorAll('a[href]')) {
      try {
        const u = new URL(anchor.getAttribute('href'), 'https://x.com');
        if (u.protocol !== 'https:' || u.username || u.password) continue;
        if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname.toLowerCase())) continue;
        if (!linkMap.has(u.href)) linkMap.set(u.href, { href: u.href, text: (anchor.innerText || '').trim() });
      } catch {}
    }
    items.push({ url: statusUrl, text, publishedAt, links: [...linkMap.values()] });
  }
  return { href: location.href, pathname: location.pathname, items };
`;

const BACKENDS = ['apple-events', 'cdp', 'codex-exec'];
// Apple Events exists only on macOS; everywhere else the signed-in browser is reached over CDP.
export const defaultBackend = (platform = process.platform) => (platform === 'darwin' ? 'apple-events' : 'cdp');

export function parseCollectFlags(argv = [], { requireRun = true } = {}) {
  let runDir = null;
  let backend = defaultBackend();
  let browserApp = 'Dia';
  let cdpEndpoint = DEFAULT_CDP_ENDPOINT;
  let codexBin = 'codex';
  let includeGmailLeads = true;
  let cuaModel = 'gpt-6.1-terra';
  let enableCua = true;
  let apiKeyFile = null;

  const takeValue = (index, flag) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') { runDir = path.resolve(takeValue(i, arg)); i++; }
    else if (arg === '--backend') { backend = takeValue(i, arg); i++; }
    else if (arg === '--browser') { browserApp = takeValue(i, arg); i++; }
    else if (arg === '--cdp-endpoint') { cdpEndpoint = loopbackCdpEndpoint(takeValue(i, arg)).origin; i++; }
    else if (arg === '--codex-bin') { codexBin = takeValue(i, arg); i++; }
    else if (arg === '--cua-model') { cuaModel = takeValue(i, arg); i++; }
    else if (arg === '--api-key-file') { apiKeyFile = path.resolve(takeValue(i, arg)); i++; }
    else if (arg === '--no-cua') { enableCua = false; }
    else if (arg === '--no-gmail') { includeGmailLeads = false; }
    else throw new Error(`Unknown collection option: ${arg}`);
  }
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Unsupported collection backend: ${backend}`);
  }
  if (requireRun && !runDir) throw new Error('Use --run RUN_DIR to collect into a frozen run directory');
  return { runDir, backend, browserApp, cdpEndpoint, codexBin, includeGmailLeads, cuaModel, enableCua, apiKeyFile };
}

export function validateGmailConfig(gmail) {
  if (!gmail || gmail.enabled === false) return null;
  const account = typeof gmail.account === 'string' ? gmail.account.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) {
    throw new Error('sources.gmail.account must be an explicit email address when Gmail discovery is enabled');
  }
  const mode = gmail.mode ?? 'auto';
  if (!['auto', 'gmail-cli', 'browser'].includes(mode)) {
    throw new Error(`Unsupported sources.gmail.mode: ${mode}`);
  }
  const query = typeof gmail.query === 'string' && gmail.query.trim()
    ? gmail.query.trim()
    : 'from:news@alphasignal.ai newer_than:2d';
  const maxMessages = Number.isInteger(gmail.maxMessages) && gmail.maxMessages > 0 ? gmail.maxMessages : 3;
  return { account, mode, query, maxMessages };
}

function sanitizeXItems(items) {
  const seen = new Map();
  for (const item of items ?? []) {
    if (!item?.url || !item?.text?.trim()) continue;
    let publishedAt = null;
    if (item.publishedAt) {
      const parsed = Date.parse(item.publishedAt);
      if (Number.isFinite(parsed)) publishedAt = new Date(parsed).toISOString();
    }
    const links = (item.links ?? []).filter(link => {
      try {
        const u = new URL(link.href);
        return u.protocol === 'https:' && !u.username && !u.password;
      } catch {
        return false;
      }
    }).map(link => ({ href: new URL(link.href).href, text: String(link.text ?? '') }));
    seen.set(item.url, { url: item.url, text: item.text.trim(), publishedAt, links });
  }
  return [...seen.values()];
}

function defaultOsascript(script, args = []) {
  return execFileSync('/usr/bin/osascript', ['-e', script, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

// Binds only the window whose title carries our marker; any other window of the browser is the user's.
function defaultFindCgWindowId(browserApp, markerTitle = '') {
  if (!markerTitle) return null;
  const swiftCode = `
import CoreGraphics
let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Dia"
let marker = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
if let list = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
  var matched: Int? = nil
  for w in list {
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    guard !marker.isEmpty, owner == target else { continue }
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    guard let bounds = w[kCGWindowBounds as String] as? [String: Any],
          let h = bounds["Height"] as? Double, h >= 400,
          let num = w[kCGWindowNumber as String] as? Int else { continue }
    let name = (w[kCGWindowName as String] as? String) ?? ""
    if name.contains(marker) {
      matched = num
      break
    }
  }
  if let num = matched {
    print(num)
  }
}`;
  const out = execFileSync('/usr/bin/swift', ['-e', swiftCode, browserApp, markerTitle], { encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/)[0] : null;
}

function defaultScreencapture(cgWindowId, absPath) {
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-t', 'jpg', '-l', String(cgWindowId), absPath]);
}

export function createAppleEventsBrowserDriver({
  browserApp = 'Dia',
  runDir,
  startedAt,
  osascript = defaultOsascript,
  findCgWindowId = defaultFindCgWindowId,
  screencapture = defaultScreencapture,
  clock = Date.now,
  sleep = defaultSleep,
}) {
  let windowId = null;
  let cgWindowId = null;
  let ownedTabId = null;
  const evidenceDir = path.join(runDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const evidence = [];

  const isDia = browserApp.toLowerCase().includes('dia');
  const tryEvalJson = jsBody => {
    if (!ownedTabId) return { ok: false, reason: 'no_owned_tab' };
    const wrapped = `(function(){ try { const __res = (function(){ ${jsBody} })(); return JSON.stringify({ __ok: true, value: __res }); } catch (e) { return JSON.stringify({ __ok: false, error: String(e && e.message ? e.message : e) }); } })()`;
    let raw = '';
    try {
      raw = osascript(`on run argv
        tell application (item 1 of argv)
          if (item 4 of argv) is "dia" then
            return execute tab id (item 3 of argv) of window id (item 2 of argv) javascript (item 5 of argv)
          else
            return execute (active tab of window id (item 2 of argv)) javascript (item 5 of argv)
          end if
        end tell
      end run`, [browserApp, windowId, ownedTabId, isDia ? 'dia' : 'chromium', wrapped]);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    if (!raw || raw === 'missing value') return { ok: false, reason: raw ? 'missing_value' : 'empty' };
    try {
      let parsed = JSON.parse(raw);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'non_object_json' };
      if (!parsed.__ok) return { ok: false, reason: parsed.error || 'js_error' };
      return { ok: true, value: parsed.value };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  };

  const closeTab = tabId => {
    if (!tabId || !windowId) return;
    try {
      osascript(`on run argv
        tell application (item 1 of argv)
          if (item 4 of argv) is "dia" then
            close tab id (item 3 of argv) of window id (item 2 of argv)
          else
            close (first tab of window id (item 2 of argv) whose id is (item 3 of argv))
          end if
        end tell
      end run`, [browserApp, windowId, String(tabId), isDia ? 'dia' : 'chromium']);
    } catch { /* ignore already closed tab */ }
  };

  async function init() {
    const probeTitle = `gos-xdaily-bg-${randomBytes(4).toString('hex')}`;
    const probeUrl = `data:text/html,${encodeURIComponent(`<title>${probeTitle}</title><body>ok</body>`)}`;
    // Never call activate or focus: Dia/macOS keeps user focus on the foreground app while we bind our own background window.
    const created = osascript(`on run argv
      tell application (item 1 of argv)
        set w to make new window
        set initTid to ""
        try
          if (count of tabs of w) > 0 then set initTid to (id of item 1 of (tabs of w)) as text
        end try
        set probeT to make new tab at end of tabs of w with properties {URL:(item 2 of argv)}
        return ((id of w) as text) & linefeed & ((id of probeT) as text) & linefeed & initTid
      end tell
    end run`, [browserApp, probeUrl]);
    const [winLine = '', tabLine = '', initTabLine = ''] = String(created || '').split(/\r?\n/);
    windowId = winLine.trim();
    ownedTabId = tabLine.trim();
    const initTabId = initTabLine.trim();
    if (!windowId || !ownedTabId) {
      await close();
      throw new Error(`Failed to create dedicated background window in ${browserApp}.`);
    }
    if (initTabId && initTabId !== ownedTabId) closeTab(initTabId);

    const probeDeadline = clock() + 6000;
    let probe = { ok: false, reason: 'timeout' };
    while (clock() < probeDeadline) {
      await sleep(250);
      probe = tryEvalJson(`return { ok: 1 + 1 === 2, title: document.title, ready: document.readyState };`);
      if (probe.ok && probe.value?.ok && probe.value?.title === probeTitle) break;
    }
    if (!probe.ok || !probe.value?.ok) {
      await close();
      const hint = isDia
        ? 'Relaunch Dia with --enable-applescript-javascript'
        : 'Enable View > Developer > Allow JavaScript from Apple Events';
      throw new Error(`${browserApp} Apple Events JavaScript execution failed (${probe.reason}). ${hint}.`);
    }
    await sleep(200);
    cgWindowId = findCgWindowId(browserApp, probeTitle);
    if (!cgWindowId) {
      await close();
      throw new Error(`No capturable background window found for ${browserApp}. Verify Screen Recording permission.`);
    }
  }

  async function openUrl(targetUrl, { settleMs = 3500, waitSelector = null, maxWaitMs = 22000 } = {}) {
    const prevTabId = ownedTabId;
    const newTabId = osascript(`on run argv
      tell application (item 1 of argv)
        set w to window id (item 2 of argv)
        set newT to make new tab at end of tabs of w with properties {URL:(item 3 of argv)}
        return (id of newT) as text
      end tell
    end run`, [browserApp, windowId, targetUrl]);
    ownedTabId = newTabId;
    if (prevTabId && prevTabId !== newTabId) closeTab(prevTabId);

    const deadline = clock() + maxWaitMs;
    while (clock() < deadline) {
      await sleep(500);
      let loading = 'true';
      try {
        loading = osascript(`on run argv
          tell application (item 1 of argv)
            if (item 4 of argv) is "dia" then
              return (loading of tab id (item 3 of argv) of window id (item 2 of argv)) as text
            else
              return (loading of active tab of window id (item 2 of argv)) as text
            end if
          end tell
        end run`, [browserApp, windowId, ownedTabId, isDia ? 'dia' : 'chromium']);
      } catch { /* ignore transient state */ }
      if (loading === 'false') {
        const ready = tryEvalJson('return { readyState: document.readyState, href: location.href };');
        if (ready.ok && ready.value && ['interactive', 'complete'].includes(ready.value.readyState) && ready.value.href && ready.value.href !== 'about:blank') {
          break;
        }
      }
    }

    if (waitSelector) {
      const selDeadline = clock() + 12000;
      while (clock() < selDeadline) {
        const cnt = tryEvalJson(`return document.querySelectorAll(${JSON.stringify(waitSelector)}).length;`);
        if (cnt.ok && Number(cnt.value) > 0) break;
        await sleep(600);
      }
    }
    await sleep(settleMs);
  }

  async function evalJson(jsBody) {
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      last = tryEvalJson(jsBody);
      if (last.ok) return last.value;
      if (attempt < 4) await sleep(400);
    }
    throw new Error(`${browserApp} JS evaluation failed (${last?.reason ?? 'unknown'})`);
  }

  // A page title can equal a title in one of the user's windows, so re-bind through a fresh unique marker.
  async function rebindCgWindowId() {
    const marker = `gos-xdaily-bg-${randomBytes(4).toString('hex')}`;
    const swapped = tryEvalJson(`const prev = document.title; document.title = ${JSON.stringify(marker)}; return prev;`);
    if (!swapped.ok) throw new Error(`Cannot re-bind the dedicated ${browserApp} window (${swapped.reason}); refusing to capture another window.`);
    try {
      await sleep(300);
      const next = findCgWindowId(browserApp, marker);
      if (!next) throw new Error(`Dedicated ${browserApp} window was not found by its marker; refusing to capture another window.`);
      cgWindowId = next;
      return next;
    } finally {
      tryEvalJson(`document.title = ${JSON.stringify(String(swapped.value ?? ''))}; return true;`);
    }
  }

  async function captureViewBase64() {
    const tmpPath = path.join(runDir, `.tmp-cua-${randomBytes(4).toString('hex')}.jpg`);
    try {
      try {
        screencapture(cgWindowId, tmpPath);
      } catch {
        screencapture(await rebindCgWindowId(), tmpPath);
      }
      return fs.readFileSync(tmpPath).toString('base64');
    } finally {
      try { fs.rmSync(tmpPath, { force: true }); } catch {}
    }
  }

  async function screenshot(id, urlForManifest) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error(`Invalid evidence ID: ${id}`);
    await sleep(200);
    const absPath = path.join(runDir, `evidence/${id}.jpg`);
    try {
      screencapture(cgWindowId, absPath);
    } catch {
      screencapture(await rebindCgWindowId(), absPath);
    }
    if (fs.statSync(absPath).size < 4096) screencapture(await rebindCgWindowId(), absPath);
    return recordScreenshotEvidence(evidence, { runDir, id, url: urlForManifest, startedAt, clock, capture: () => {} });
  }

  async function close() {
    if (windowId) {
      try {
        osascript(`on run argv
          tell application (item 1 of argv)
            close window id (item 2 of argv)
          end tell
        end run`, [browserApp, String(windowId)]);
      } catch { /* ignore already closed window */ }
    } else {
      closeTab(ownedTabId);
    }
    ownedTabId = null;
    windowId = null;
    cgWindowId = null;
  }

  return { init, openUrl, evalJson, screenshot, captureViewBase64, close, getEvidence: () => evidence };
}

async function collectXFeedPages(driver, { targetUrl, evPrefix, evidenceUrl = targetUrl, maxPages, stopAtCount = null, ensureHomeTab = false, clock = Date.now, sleep = defaultSleep }) {
  const pages = [];
  const uniqueUrls = new Set();
  for (let step = 1; step <= maxPages; step++) {
    if (ensureHomeTab && step > 1) {
      const pathname = await driver.evalJson('return location.pathname;');
      if (pathname !== '/home') {
        await driver.openUrl('https://x.com/home', { settleMs: 3500, waitSelector: '[role="tab"], article[data-testid="tweet"], input[autocomplete="username"]' });
        await driver.evalJson(`
          const tab = [...document.querySelectorAll('[role="tab"]')].find(t => /^(following|正在关注)$/i.test((t.innerText || '').trim()));
          if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
          return true;
        `);
        await sleep(3000);
      }
    }
    const extracted = await driver.evalJson(X_EXTRACT_SCRIPT);
    await sleep(250);
    const evId = `${evPrefix}-${String(step).padStart(2, '0')}`;
    await driver.screenshot(evId, evidenceUrl);
    const items = sanitizeXItems(extracted?.items);
    for (const item of items) uniqueUrls.add(item.url);
    pages.push({ evidenceId: evId, items });
    if (stopAtCount && uniqueUrls.size >= stopAtCount && step >= Math.min(4, maxPages)) break;
    if (step < maxPages) {
      await driver.evalJson('window.scrollBy(0, 900); return true;');
      await sleep(1500);
    }
  }
  return { pages, uniqueUrls };
}

async function collectSubstackFeed(driver, { clock = Date.now, sleep = defaultSleep, limitations }) {
  try {
    await driver.openUrl('https://substack.com/home/secondary/subscribed', {
      settleMs: 3500,
      waitSelector: 'a[href*="/p/"], a[href*="/note/"], input[type="email"], main',
    });
    const state = await driver.evalJson('return { href: location.href, hostname: location.hostname, pathname: location.pathname, isLogin: /login|sign-in/i.test(location.pathname) };');
    if (state.hostname !== 'substack.com' || state.pathname !== '/home/secondary/subscribed' || state.isLogin) {
      limitations.push(`Substack /home/secondary/subscribed landed on ${state.href}; omitted from structured Substack feed.`);
      return { feed: undefined, discoveredUrls: [] };
    }
    const pages = [];
    const discoveredUrls = new Set();
    for (let step = 1; step <= 3; step++) {
      const extracted = await driver.evalJson(`
        const seen = new Set();
        const items = [];
        for (const a of document.querySelectorAll('a[href]')) {
          try {
            const u = new URL(a.getAttribute('href'), location.origin);
            if (u.protocol !== 'https:' || u.username || u.password) continue;
            if (!/\\/p\\/|\\/home\\/post\\/|\\/note\\//.test(u.pathname)) continue;
            u.hash = '';
            if (seen.has(u.href)) continue;
            const container = a.closest('article, [role="article"], div[class*="feed"], div[class*="item"], div[class*="post"]') || a.parentElement;
            const text = ((container ? container.innerText : a.innerText) || '').trim().slice(0, 1500);
            if (text.length < 15) continue;
            const tEl = container ? container.querySelector('time[datetime]') : null;
            seen.add(u.href);
            items.push({ url: u.href, text, publishedAt: tEl?.getAttribute('datetime') || null, links: [] });
          } catch {}
        }
        return items;
      `);
      const evId = `substack-${String(step).padStart(2, '0')}`;
      await driver.screenshot(evId, 'https://substack.com/home/secondary/subscribed');
      const nowMs = clock();
      const items = (extracted ?? []).map(item => {
        let publishedAt = null;
        if (item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) && Date.parse(item.publishedAt) <= nowMs) {
          publishedAt = new Date(item.publishedAt).toISOString();
        }
        if (/\.substack\.com\/p\//.test(item.url)) discoveredUrls.add(item.url);
        return { url: item.url, text: item.text.trim(), publishedAt, links: [] };
      });
      pages.push({ evidenceId: evId, items });
      if (step < 3) {
        await driver.evalJson('window.scrollBy(0, 900); return true;');
        await sleep(1500);
      }
    }
    const total = pages.reduce((acc, p) => acc + p.items.length, 0);
    return {
      feed: { status: total > 0 ? 'ok' : 'not_available', pages: total > 0 ? pages : [{ evidenceId: pages[0].evidenceId, items: [] }] },
      discoveredUrls: [...discoveredUrls],
    };
  } catch (error) {
    limitations.push(`Substack capture skipped due to error: ${error.message}`);
    return { feed: undefined, discoveredUrls: [] };
  }
}

async function collectXiaohongshu(driver, profiles, { sleep = defaultSleep, limitations }) {
  const results = [];
  for (const profile of profiles ?? []) {
    try {
      const profUrl = `https://www.xiaohongshu.com/user/profile/${profile.profileId}`;
      await driver.openUrl(profUrl, {
        settleMs: 3500,
        waitSelector: 'section.note-item, a[href*="/explore/"], [class*="captcha"], [id*="captcha"], body',
      });
      const state = await driver.evalJson(`
        const bodyText = (document.body ? document.body.innerText : '') || '';
        const hasCaptcha = /安全验证|滑块|请完成验证|captcha/i.test(bodyText) || !!document.querySelector('[class*="captcha"], [id*="captcha"]');
        const candidates = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('section.note-item a[href], a[href*="/explore/"], a[href*="/user/profile/"]')) {
          const rawHref = a.getAttribute('href') || '';
          if (!rawHref.includes('/explore/') && !rawHref.includes('xsec_token=')) continue;
          const u = new URL(rawHref, 'https://www.xiaohongshu.com');
          const m = u.pathname.match(/\\/(?:explore|(?:user\\/profile\\/[^/]+))\\/([a-f0-9]{16,32})/i);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          candidates.push({ noteId: m[1], navUrl: u.href, canonicalUrl: 'https://www.xiaohongshu.com/explore/' + m[1] });
        }
        return { href: location.href, pathname: location.pathname, hasCaptcha, candidates: candidates.slice(0, 4) };
      `);
      if (state.hasCaptcha || state.pathname !== `/user/profile/${profile.profileId}`) {
        limitations.push(`Xiaohongshu profile ${profile.name} blocked by ${state.hasCaptcha ? 'verification prompt (not interacted per anti-bot policy)' : state.href}.`);
        continue;
      }
      const profEv = await driver.screenshot(`xhs-profile-${profile.profileId.slice(0, 8)}`, profUrl);
      const notes = [];
      for (const [idx, cand] of state.candidates.slice(0, profile.maxNotes ?? 2).entries()) {
        await driver.openUrl(cand.navUrl, { settleMs: 3000, waitSelector: '#detail-title, .title, [class*="captcha"], [id*="captcha"], body' });
        const noteData = await driver.evalJson(`
          const bodyText = (document.body ? document.body.innerText : '') || '';
          const hasCaptcha = /安全验证|滑块|请完成验证|captcha/i.test(bodyText) || !!document.querySelector('[class*="captcha"], [id*="captcha"]');
          const title = (document.querySelector('#detail-title, .title')?.innerText || '').trim();
          const desc = (document.querySelector('#detail-desc, .desc, .note-content')?.innerText || '').trim();
          const dateRaw = (document.querySelector('.date, .bottom-container .date')?.innerText || '').trim();
          const text = [title, desc, dateRaw ? ('[Observed date label: ' + dateRaw + ']') : ''].filter(Boolean).join('\\n\\n').trim();
          return { hasCaptcha, text };
        `);
        if (noteData.hasCaptcha || !noteData.text) {
          limitations.push(`Xiaohongshu note ${cand.noteId} skipped (unavailable or verification wall).`);
          continue;
        }
        const evId = `xhs-${profile.profileId.slice(0, 8)}-note-0${idx + 1}`;
        await driver.screenshot(evId, cand.canonicalUrl);
        notes.push({ url: cand.canonicalUrl, text: noteData.text, publishedAt: null, links: [], evidenceId: evId });
        await sleep(300);
      }
      if (notes.length > 0) results.push({ profileId: profile.profileId, evidenceId: profEv.id, notes });
    } catch (error) {
      limitations.push(`Xiaohongshu ${profile.name} capture error: ${error.message}`);
    }
  }
  return results;
}

function normalizeAndFilterBlogUrls(rawUrls, blog) {
  const base = new URL(blog.articleBaseUrl);
  const pattern = blog.articlePattern ? new RegExp(blog.articlePattern) : null;
  const links = [];
  const seen = new Set();
  for (const raw of rawUrls ?? []) {
    try {
      const u = new URL(String(raw), base.origin);
      u.hash = '';
      u.search = '';
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      if (u.origin !== base.origin) continue;
      if (!u.pathname.startsWith(base.pathname) || u.pathname === base.pathname) continue;
      const rest = u.pathname.slice(base.pathname.length).replace(/\/+$/, '');
      if (!rest || /^(page|tag|category|authors?)\b/i.test(rest)) continue;
      if (pattern && !pattern.test(u.pathname)) continue;
      if (!seen.has(u.href)) {
        seen.add(u.href);
        links.push(u.href);
      }
    } catch {}
  }
  return links.slice(0, blog.maxArticles ?? 3);
}

async function extractBlogLinksFromDom(driver, blog) {
  const discovered = await driver.evalJson(`
    const base = new URL(${JSON.stringify(blog.articleBaseUrl)});
    const pattern = ${blog.articlePattern ? `new RegExp(${JSON.stringify(blog.articlePattern)})` : 'null'};
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.getAttribute('href'), location.origin);
        u.hash = '';
        u.search = '';
        if (u.origin !== base.origin) continue;
        if (!u.pathname.startsWith(base.pathname) || u.pathname === base.pathname) continue;
        const rest = u.pathname.slice(base.pathname.length).replace(/\\/+$/, '');
        if (!rest || /^(page|tag|category|authors?)\\b/i.test(rest)) continue;
        if (pattern && !pattern.test(u.pathname)) continue;
        if (!seen.has(u.href)) { seen.add(u.href); links.push(u.href); }
      } catch {}
    }
    return links.slice(0, ${blog.maxArticles ?? 3});
  `);
  return normalizeAndFilterBlogUrls(discovered, blog);
}

async function inspectBlogIndexForCua(driver) {
  return driver.evalJson(`
    const title = document.title || '';
    const text = (document.body ? document.body.innerText : '').trim();
    const blocked = /verify you are human|just a moment|attention required|cf-challenge|captcha|recaptcha|hcaptcha|turnstile|access denied/i.test(title + '\\n' + text.slice(0, 2000));
    const candidates = [];
    for (const el of document.querySelectorAll('a[href], button, [role="link"], [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > window.innerHeight * 2) continue;
      candidates.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 100),
        href: el.getAttribute('href') || null,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      });
      if (candidates.length >= 60) break;
    }
    return { href: location.href, title, blocked, textSample: text.slice(0, 1200), candidates };
  `);
}

function leftBlogOrigin(snapshot, blog) {
  const allowed = new Set([new URL(blog.indexUrl).origin, new URL(blog.articleBaseUrl).origin]);
  try { return !allowed.has(new URL(snapshot?.href).origin); } catch { return true; }
}

async function assistBlogIndexWithTerra(driver, blog, { cua, sleep = defaultSleep, fetchImpl = globalThis.fetch, limitations }) {
  const snapshot = await inspectBlogIndexForCua(driver);
  if (snapshot?.blocked) {
    limitations.push(`Blog ${blog.name} index gated by anti-bot/CAPTCHA page; skipped without CUA bypass.`);
    return [];
  }
  if (leftBlogOrigin(snapshot, blog)) {
    limitations.push(`Blog ${blog.name} index landed outside its configured origin; skipped without sending the page to CUA.`);
    return [];
  }
  const responsesFetch = cua.responsesFetch ?? fetchImpl;
  const tools = [{
    type: 'function',
    name: 'inspect_blog_index',
    description: 'Scroll or click non-auth elements on a dynamic blog index page and return matching article URLs under articleBaseUrl.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'selector', 'scroll_y', 'article_urls'],
      properties: {
        action: { type: 'string', enum: ['scroll', 'click', 'extract', 'done'] },
        selector: { type: ['string', 'null'] },
        scroll_y: { type: ['integer', 'null'] },
        article_urls: { type: 'array', items: { type: 'string' } },
      },
    },
  }];

  const promptText = [
    `Inspect dynamic blog index for "${blog.name}".`,
    `indexUrl: ${blog.indexUrl}`,
    `articleBaseUrl: ${blog.articleBaseUrl}`,
    `articlePattern: ${blog.articlePattern ?? '(none)'}`,
    `maxArticles: ${blog.maxArticles ?? 3}`,
    'Goal: scroll or click non-auth tabs/load-more controls if needed, then return matching article_urls under articleBaseUrl.',
    'Do not bypass authentication or solve any CAPTCHA. If no qualifying articles exist, call action="done" with article_urls=[].',
    `Initial DOM snapshot: ${JSON.stringify(snapshot)}`,
  ].join('\n');

  const firstContent = [{ type: 'input_text', text: promptText }];
  if (typeof driver.captureViewBase64 === 'function') {
    const imgBase64 = await driver.captureViewBase64();
    if (imgBase64) firstContent.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${imgBase64}` });
  }

  // Stateless store=false loop: include encrypted reasoning items verbatim on every turn.
  const input = [{ role: 'user', content: firstContent }];
  const maxTurns = 3;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await responsesFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Bearer ${cua.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cua.model,
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'low' },
        tools,
        input,
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      limitations.push(`Blog ${blog.name} CUA (${cua.model}) HTTP ${response.status}: ${errText.trim().slice(0, 160)}`);
      return [];
    }
    const data = await response.json();
    const outputItems = Array.isArray(data.output) ? data.output : [];
    input.push(...outputItems);

    const calls = outputItems.filter(item => item && item.type === 'function_call' && item.name === 'inspect_blog_index');
    if (calls.length === 0) break;

    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const proposed = normalizeAndFilterBlogUrls(args.article_urls, blog);
      if (proposed.length > 0) return proposed;
      if (args.action === 'done') return extractBlogLinksFromDom(driver, blog);

      if (args.action === 'scroll') {
        const deltaY = Math.max(-2000, Math.min(2000, Number(args.scroll_y) || 700));
        await driver.evalJson(`window.scrollBy(0, ${deltaY}); return true;`);
        await sleep(800);
      } else if (args.action === 'click' && typeof args.selector === 'string' && args.selector.trim()) {
        await driver.evalJson(`const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.click(); return true;`);
        await sleep(1000);
      }

      const domUrls = await extractBlogLinksFromDom(driver, blog);
      if (domUrls.length > 0) return domUrls;

      const updatedSnapshot = await inspectBlogIndexForCua(driver);
      if (updatedSnapshot?.blocked) {
        limitations.push(`Blog ${blog.name} index gated by anti-bot/CAPTCHA page; skipped without CUA bypass.`);
        return [];
      }
      if (leftBlogOrigin(updatedSnapshot, blog)) {
        limitations.push(`Blog ${blog.name} CUA action navigated outside its configured origin; stopped without sending that page to CUA.`);
        return [];
      }
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(updatedSnapshot),
      });
    }

    if (turn < maxTurns && typeof driver.captureViewBase64 === 'function') {
      const nextImg = await driver.captureViewBase64();
      if (nextImg) {
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: 'Updated viewport after browser action.' },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${nextImg}` },
          ],
        });
      }
    }
  }
  return [];
}

async function collectBlogs(driver, blogs, { clock = Date.now, sleep = defaultSleep, fetchImpl = globalThis.fetch, cua = null, limitations }) {
  const out = [];
  let counter = 0;
  for (const blog of blogs ?? []) {
    try {
      const basePath = new URL(blog.articleBaseUrl).pathname;
      await driver.openUrl(blog.indexUrl, { settleMs: 3000, waitSelector: `main a[href*="${basePath}"], article a[href]` });
      let discovered = await extractBlogLinksFromDom(driver, blog);
      if (discovered.length === 0 && cua?.enabled && !cua.apiKey) {
        limitations.push(`Blog ${blog.name} index yielded 0 links and CUA (${cua.model}) had no usable API key (${cua.keyProblem}).`);
      }
      if (discovered.length === 0 && cua?.enabled && cua?.apiKey) {
        try {
          discovered = await assistBlogIndexWithTerra(driver, blog, { cua, sleep, fetchImpl, limitations });
        } catch (cuaError) {
          limitations.push(`Blog ${blog.name} CUA (${cua.model}) error: ${cuaError.message}`);
        }
      }
      for (const artUrl of (discovered ?? []).slice(0, blog.maxArticles ?? 3)) {
        await driver.openUrl(artUrl, { settleMs: 3000, waitSelector: 'article, main, time[datetime]' });
        const art = await driver.evalJson(`
          const u = new URL(location.href);
          u.hash = '';
          u.search = '';
          const container = document.querySelector('article, main') || document.body;
          const text = (container ? container.innerText : '').trim().slice(0, ${BLOG_MAX_CHARS});
          let pub = document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
          if (!pub) pub = document.querySelector('meta[property="article:published_time"], meta[name="pubdate"], meta[name="date"]')?.getAttribute('content') || null;
          const links = [];
          const seen = new Set();
          for (const a of (container ? container.querySelectorAll('a[href]') : [])) {
            try {
              const lu = new URL(a.getAttribute('href'), location.origin);
              if (lu.protocol !== 'https:' || lu.username || lu.password || seen.has(lu.href)) continue;
              seen.add(lu.href);
              links.push({ href: lu.href, text: (a.innerText || '').trim().slice(0, 120) });
            } catch {}
          }
          return { canonicalHref: u.href, text, pub, links: links.slice(0, 25) };
        `);
        const baseObj = new URL(blog.articleBaseUrl);
        const artObj = new URL(art.canonicalHref);
        if (!art.text || art.text.length < 120 || artObj.origin !== baseObj.origin ||
            !artObj.pathname.startsWith(baseObj.pathname) || artObj.pathname === baseObj.pathname) continue;
        const publishedAt = (art.pub && Number.isFinite(Date.parse(art.pub)) && Date.parse(art.pub) <= clock())
          ? new Date(art.pub).toISOString() : null;
        counter += 1;
        const evId = `blog-${String(counter).padStart(2, '0')}`;
        await driver.screenshot(evId, artObj.href);
        out.push({ blog: blog.name, url: artObj.href, text: art.text, publishedAt, links: art.links, evidenceId: evId });
      }
    } catch (error) {
      limitations.push(`Blog ${blog.name} capture error: ${error.message}`);
    }
  }
  return out;
}

function filterPublicNewsletterUrls(rawHrefs) {
  const out = [];
  const seen = new Set();
  for (let href of rawHrefs ?? []) {
    try {
      if (String(href).includes('google.com/url?')) {
        const gu = new URL(String(href));
        href = gu.searchParams.get('q') || gu.searchParams.get('url') || href;
      }
      const u = new URL(String(href));
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      if (/unsubscribe|manage|preferences|mailto:|alphasignal\.ai\/(?:unsubscribe|login|sponsor)|google\.com|gmail\.com/i.test(u.href)) continue;
      if (!seen.has(u.href)) {
        seen.add(u.href);
        out.push(u.href);
      }
    } catch {}
  }
  return out.slice(0, 20);
}

function decodeBase64Url(data) {
  if (!data || typeof data !== 'string') return '';
  const norm = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf8');
}

function collectMimeBodies(node, chunks) {
  if (!node || typeof node !== 'object') return;
  if (node.body?.data) chunks.push(decodeBase64Url(node.body.data));
  if (Array.isArray(node.parts)) {
    for (const part of node.parts) collectMimeBodies(part, chunks);
  }
}

function extractUrlsFromTextAndHtml(text) {
  const found = [];
  const str = String(text || '');
  for (const m of str.matchAll(/href=["'](https:\/\/[^"']+)["']/gi)) found.push(m[1]);
  for (const m of str.matchAll(/https:\/\/[^\s<>"')]+/gi)) found.push(m[0]);
  return found;
}

function extractUrlsFromGmailCliResult(raw) {
  if (!raw) return [];
  if (Array.isArray(raw?.urls)) return filterPublicNewsletterUrls(raw.urls);
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = trimmed; }
    }
  }
  if (typeof parsed === 'string') {
    return filterPublicNewsletterUrls(extractUrlsFromTextAndHtml(parsed));
  }
  if (Array.isArray(parsed?.urls)) {
    return filterPublicNewsletterUrls(parsed.urls);
  }
  const messages = Array.isArray(parsed)
    ? parsed
    : (parsed?.messages ?? parsed?.data?.messages ?? (parsed?.payload ? [parsed] : []));
  const rawUrls = [];
  for (const msg of messages) {
    if (Array.isArray(msg?.urls)) rawUrls.push(...msg.urls);
    if (typeof msg?.body === 'string') rawUrls.push(...extractUrlsFromTextAndHtml(msg.body));
    if (typeof msg?.html === 'string') rawUrls.push(...extractUrlsFromTextAndHtml(msg.html));
    if (typeof msg?.text === 'string') rawUrls.push(...extractUrlsFromTextAndHtml(msg.text));
    const chunks = [];
    collectMimeBodies(msg?.payload, chunks);
    for (const chunk of chunks) rawUrls.push(...extractUrlsFromTextAndHtml(chunk));
  }
  if (rawUrls.length === 0 && parsed) {
    rawUrls.push(...extractUrlsFromTextAndHtml(JSON.stringify(parsed)));
  }
  return filterPublicNewsletterUrls(rawUrls);
}

function defaultGmailCli({ account, query, maxMessages = 3 }) {
  const envCli = process.env.GOS_GMAIL_CLI;
  const localAntigravityCli = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'gmail');
  const bin = envCli || (fs.existsSync(localAntigravityCli) ? localAntigravityCli : 'gmail');
  const execOpts = {
    encoding: 'utf8',
    env: { ...process.env, AGY_ACCOUNT: account },
    maxBuffer: 2 * 1024 * 1024,
  };
  const sendAsRaw = execFileSync(bin, ['readonly', 'sendas', '--json'], execOpts);
  let sendAsParsed;
  try {
    sendAsParsed = JSON.parse(sendAsRaw || '{}');
  } catch (err) {
    throw new Error(`Gmail CLI account check failed for ${account}: ${String(sendAsRaw || err.message).trim().slice(0, 200)}`);
  }
  const sendAsList = sendAsParsed.sendAs ?? sendAsParsed.data?.sendAs ?? [];
  const lower = account.toLowerCase();
  if (!Array.isArray(sendAsList) || !sendAsList.some(entry => String(entry?.sendAsEmail || '').toLowerCase() === lower)) {
    throw new Error(`Gmail CLI did not confirm ${account} as the active mailbox`);
  }
  return execFileSync(bin, ['readonly', 'read', '--max', String(maxMessages), '--json', '--', query], execOpts);
}

// Private discovery only: extract public outbound article URLs without capturing screenshots or saving email prose.
async function discoverGmailPublicUrls(driver, { gmailConfig, gmailCli, sleep = defaultSleep, limitations }) {
  if (!gmailConfig) return [];
  let cliFailure = null;
  if (gmailConfig.mode === 'gmail-cli' || gmailConfig.mode === 'auto') {
    try {
      const cliFn = gmailCli ?? defaultGmailCli;
      const raw = await cliFn({ account: gmailConfig.account, query: gmailConfig.query, maxMessages: gmailConfig.maxMessages });
      return extractUrlsFromGmailCliResult(raw);
    } catch (error) {
      cliFailure = error.message;
      if (gmailConfig.mode === 'gmail-cli') {
        limitations.push(`Gmail CLI (${gmailConfig.account}) failed: ${cliFailure}`);
        return [];
      }
    }
  }

  try {
    const authUrl = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(gmailConfig.account)}#search/${encodeURIComponent(gmailConfig.query)}`;
    await driver.openUrl(authUrl, {
      settleMs: 4000,
      waitSelector: 'tr.zA, div[role="main"], input[type="email"]',
    });
    const state = await driver.evalJson(`
      const loggedIn = location.hostname === 'mail.google.com' && !/accounts\\.google\\.com|signin/i.test(location.href);
      const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi;
      const candidates = [];
      const pushMatches = s => {
        if (!s) return;
        for (const m of String(s).match(emailRe) || []) candidates.push(m.toLowerCase());
      };
      const titleParts = String(document.title || '').split(' - ');
      if (titleParts.length >= 2 && /gmail/i.test(titleParts[titleParts.length - 1])) {
        pushMatches(titleParts[titleParts.length - 2]);
      }
      for (const el of document.querySelectorAll('[data-email], [aria-label*="Google Account"], header a[aria-label*="@"], [role="banner"] a[aria-label*="@"], a[aria-label*="@"][href*="accounts.google.com"]')) {
        if (el.closest('[role="main"]')) continue;
        pushMatches(el.getAttribute('data-email'));
        pushMatches(el.getAttribute('aria-label'));
      }
      return {
        loggedIn,
        href: location.href,
        emails: [...new Set(candidates)],
        rows: loggedIn ? document.querySelectorAll('tr.zA').length : 0,
      };
    `);
    if (!state.loggedIn) {
      limitations.push(`Gmail was not logged in inside this browser profile for ${gmailConfig.account}; technical newsletter email leads were skipped.${cliFailure ? ` (CLI: ${cliFailure})` : ''}`);
      return [];
    }
    const expected = gmailConfig.account.toLowerCase();
    const observed = [...new Set((state.emails ?? []).map(e => String(e).toLowerCase()))];
    if (observed.length === 0 || !observed.includes(expected) || observed.some(e => e !== expected)) {
      limitations.push(`Gmail account verification failed for ${gmailConfig.account} (observed: ${observed.join(', ') || 'none'}); aborted before opening mail rows.${cliFailure ? ` (CLI: ${cliFailure})` : ''}`);
      return [];
    }
    if (!state.rows) return [];
    await driver.evalJson('const row = document.querySelector("tr.zA"); if (row) row.click(); return true;');
    await sleep(3000);
    const urls = await driver.evalJson(`
      const out = [];
      for (const a of document.querySelectorAll('div[role="main"] a[href]')) {
        out.push(a.getAttribute('href') || '');
      }
      return out;
    `);
    return filterPublicNewsletterUrls(urls);
  } catch (error) {
    limitations.push(`Gmail newsletter check skipped due to error: ${error.message}${cliFailure ? ` (CLI: ${cliFailure})` : ''}`);
    return [];
  }
}

async function fetchPublicSupplement(rawUrl, { fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  try {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.hostname.toLowerCase() !== 't.co' && (publicUrlRefusal(parsed) || NON_ARTICLE_HOSTS.test(parsed.hostname))) return null;

    const response = await fetchImpl(parsed.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'gos-x-daily-collector/1.0',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    if (!response.ok) return null;
    const finalUrl = new URL(response.url || parsed.href);
    if (publicUrlRefusal(finalUrl) || SOCIAL_DISCOVERY_HOSTS.has(finalUrl.hostname.toLowerCase()) || NON_ARTICLE_HOSTS.test(finalUrl.hostname)) {
      return null;
    }
    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) return null;

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : finalUrl.hostname + finalUrl.pathname;
    const mainMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    let text = htmlToText(mainMatch ? mainMatch[1] : html);
    if (text.length < 500 && mainMatch) text = htmlToText(html);
    if (text.length < 400) return null;

    let truncated = false;
    if (text.length > SUPPLEMENTS_MAX_CHARS) {
      text = text.slice(0, SUPPLEMENTS_MAX_CHARS);
      truncated = true;
    }
    let publishedAt = null;
    const pubMatch = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/name=["'](?:pubdate|publishdate|date|DC\.date\.issued)["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
    if (pubMatch && Number.isFinite(Date.parse(pubMatch[1])) && Date.parse(pubMatch[1]) <= clock()) {
      publishedAt = new Date(pubMatch[1]).toISOString();
    }
    const isArxivAbs = finalUrl.hostname.endsWith('arxiv.org') && finalUrl.pathname.startsWith('/abs/');
    return {
      title: title || finalUrl.href,
      url: finalUrl.href,
      text,
      publishedAt,
      observedAt: new Date(clock()).toISOString(),
      truncated,
      sourceLabel: 'Public Original',
      readingLimits: isArxivAbs
        ? 'Read public arXiv abstract page only; full PDF and figures were not read.'
        : (truncated ? 'Read public HTML article truncated at 32,000 characters; embedded figures/videos were not inspected.' : 'Read public HTML page text; embedded images/videos were not inspected.'),
    };
  } catch {
    return null;
  }
}

async function collectPublicSupplements(urls, { limit = 12, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const candidates = [...new Set(urls)].slice(0, Math.max(limit * 2, 18));
  const supplements = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length && supplements.length < limit; i += 6) {
    const results = await Promise.all(candidates.slice(i, i + 6).map(u => fetchPublicSupplement(u, { fetchImpl, clock })));
    for (const sup of results) {
      if (!sup || seen.has(sup.url)) continue;
      seen.add(sup.url);
      supplements.push(sup);
      if (supplements.length >= limit) break;
    }
  }
  return supplements;
}

async function collectViaDriver(driver, {
  runDir,
  startedAt,
  frozenSources,
  maxFollowingPages,
  maxSearchPages,
  includeGmailLeads,
  gmailConfig = null,
  gmailCli = null,
  cua = null,
  supplementsLimit,
  fetchImpl,
  clock,
  sleep,
}) {
  const limitations = [];
  const watchProfiles = validateWatchProfiles(frozenSources.watchProfiles ?? defaultWatchProfiles);
  const windowStartMs = Date.parse(startedAt) - 48 * 3600 * 1000;
  const windowEndMs = Date.parse(startedAt);

  if (driver.init) await driver.init();
  try {
    await driver.openUrl('https://x.com/home', {
      settleMs: 3500,
      waitSelector: '[role="tab"], article[data-testid="tweet"], input[autocomplete="username"]',
    });
    const homeState = await driver.evalJson(`
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((t, idx) => ({
        idx, text: (t.innerText || '').trim(), selected: t.getAttribute('aria-selected') === 'true'
      }));
      const loginWall = /\\/login|\\b\\/i\\/flow\\/login/.test(location.pathname) || (!tabs.length && !!document.querySelector('input[autocomplete="username"]'));
      return { href: location.href, loginWall, tabs };
    `);
    if (homeState.loginWall) throw new Error('X_LOGIN_REQUIRED: browser landed on X login wall');
    if (!homeState.tabs.some(t => /^(following|正在关注)$/i.test(t.text) && t.selected)) {
      const clicked = await driver.evalJson(`
        const tab = [...document.querySelectorAll('[role="tab"]')].find(t => /^(following|正在关注)$/i.test((t.innerText || '').trim()));
        if (!tab) return false;
        tab.click();
        return true;
      `);
      if (!clicked) throw new Error('X_FOLLOWING_TAB_NOT_FOUND: Following tab missing on X Home');
      await sleep(4500);
      await driver.evalJson('window.scrollTo(0, 0); return true;');
      await sleep(1500);
      const selected = await driver.evalJson(`
        const tab = [...document.querySelectorAll('[role="tab"]')].find(t => /^(following|正在关注)$/i.test((t.innerText || '').trim()));
        return Boolean(tab && tab.getAttribute('aria-selected') === 'true');
      `);
      if (!selected) throw new Error('X_FOLLOWING_NOT_SELECTED: Following tab did not stay selected');
    }

    const xFollowing = await collectXFeedPages(driver, {
      targetUrl: 'https://x.com/home', evPrefix: 'xFollowing', maxPages: maxFollowingPages, ensureHomeTab: true, clock, sleep,
    });

    const sinceSec = Math.ceil(windowStartMs / 1000) + 30;
    const untilSec = Math.floor(windowEndMs / 1000) - 5;
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(`filter:follows since_time:${sinceSec} until_time:${untilSec}`)}&src=typed_query&f=live`;
    await driver.openUrl(searchUrl, {
      settleMs: 4000,
      waitSelector: 'article[data-testid="tweet"], [data-testid="emptyState"], [data-testid="primaryColumn"]',
    });
    const xSearch = await collectXFeedPages(driver, {
      targetUrl: searchUrl, evPrefix: 'xFollowingSearch', evidenceUrl: searchUrl, maxPages: maxSearchPages, clock, sleep,
    });

    const watchFeeds = {};
    for (const profile of watchProfiles) {
      const profileUrl = `https://x.com/${profile.handle}`;
      await driver.openUrl(profileUrl, {
        settleMs: 4000,
        waitSelector: 'article[data-testid="tweet"], [data-testid="emptyState"], [data-testid="primaryColumn"]',
      });
      const cap = await collectXFeedPages(driver, {
        targetUrl: profileUrl,
        evPrefix: `watch-${profile.handle}`,
        maxPages: Math.min(Math.max(profile.latest, 4), 10),
        stopAtCount: profile.latest + 1,
        clock,
        sleep,
      });
      watchFeeds[profile.handle] = cap.uniqueUrls.size > 0
        ? { status: 'ok', pages: cap.pages }
        : { status: 'not_available', pages: [{ evidenceId: cap.pages[0].evidenceId, items: [] }] };
    }

    const substack = await collectSubstackFeed(driver, { clock, sleep, limitations });
    const xiaohongshu = await collectXiaohongshu(driver, frozenSources.xiaohongshuProfiles ?? [], { sleep, limitations });
    const blogs = await collectBlogs(driver, frozenSources.blogs ?? [], { clock, sleep, fetchImpl, cua, limitations });
    const gmailUrls = includeGmailLeads && gmailConfig
      ? await discoverGmailPublicUrls(driver, { gmailConfig, gmailCli, sleep, limitations })
      : [];

    const evidence = driver.getEvidence();
    const lastEvMs = evidence.reduce((mx, entry) => Math.max(mx, Date.parse(entry.capturedAt)), Date.parse(startedAt));
    const capturedAt = new Date(Math.max(clock(), lastEvMs + 500)).toISOString();

    const bundle = {
      schemaVersion: 1,
      transport: 'gos-supported-browser',
      startedAt,
      capturedAt,
      evidence,
      feeds: {
        xFollowing: { status: 'ok', view: 'following', pages: xFollowing.pages },
        xFollowingSearch: {
          status: xSearch.uniqueUrls.size > 0 ? 'ok' : 'not_available',
          pages: xSearch.uniqueUrls.size > 0 ? xSearch.pages : [{ evidenceId: xSearch.pages[0].evidenceId, items: [] }],
        },
        ...watchFeeds,
        ...(substack.feed ? { substack: substack.feed } : {}),
      },
      blogs,
      xiaohongshu,
      deepArticles: [],
    };
    writePrivateJson(path.join(runDir, 'browser-capture.json'), bundle);

    const discoveredUrls = [];
    for (const page of [...xFollowing.pages, ...xSearch.pages, ...Object.values(watchFeeds).flatMap(f => f.pages ?? [])]) {
      for (const item of page.items ?? []) {
        for (const link of item.links ?? []) discoveredUrls.push(link.href);
      }
    }
    discoveredUrls.push(...substack.discoveredUrls, ...gmailUrls);
    const supplements = await collectPublicSupplements(discoveredUrls, { limit: supplementsLimit, fetchImpl, clock });
    writePrivateJson(path.join(runDir, 'supplements.public.json'), supplements);
    writePrivateJson(path.join(runDir, LIMITATIONS_FILE), limitations);
    return { bundle, supplementsCount: supplements.length, limitations };
  } finally {
    await driver.close?.();
  }
}

function defaultCodexExec(codexBin, args, cwd) {
  const result = spawnSync(codexBin, args, { cwd, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  return result;
}

function resolveOpenAiApiKey({ apiKeyFile, deps }) {
  if (typeof deps?.apiKey === 'string' && deps.apiKey.trim()) return { key: deps.apiKey.trim(), problem: null };
  const problems = [];
  for (const file of [apiKeyFile, process.env.OPENAI_API_KEY_FILE || null].filter(Boolean)) {
    try {
      return { key: readApiKey(file), problem: null };
    } catch (error) {
      problems.push(`${path.basename(file)}: ${error.code ?? error.message}`);
    }
  }
  const envKey = (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || '').trim();
  if (envKey) return { key: envKey, problem: null };
  return { key: null, problem: problems.join('; ') || 'no key file or environment key configured' };
}

function buildCodexCollectionPrompt({ runDir, date, startedAt, windowStartIso, frozenSources, includeGmailLeads, gmailConfig }) {
  return [
    `Collect source evidence for Gos X Daily run ${date} inside ${runDir}.`,
    `Frozen startedAt: ${startedAt} (48h window start: ${windowStartIso}).`,
    `Frozen config: ${path.join(runDir, 'sources.frozen.json')}.`,
    'Rules: collect sources ONLY (do NOT invoke model composition, review, or Feishu delivery).',
    'Never bypass login walls or solve/interact with any CAPTCHA; record optional failures as omitted.',
    includeGmailLeads && gmailConfig
      ? `For Gmail account ${gmailConfig.account} (${gmailConfig.query}), use AGY_ACCOUNT=${gmailConfig.account} or ?authuser=${encodeURIComponent(gmailConfig.account)} and verify active mailbox ownership; extract public outbound article URLs only, abort on mismatch, and never screenshot mail or save private email prose.`
      : 'Skip Gmail newsletter discovery.',
    `Write valid schemaVersion=1 transport="gos-supported-browser" artifacts to ${path.join(runDir, 'browser-capture.json')} with SHA-256 verified screenshots under ${path.join(runDir, 'evidence')}.`,
    `Include watchProfiles (${(frozenSources.watchProfiles ?? defaultWatchProfiles).map(p => p.handle).join(', ')}), configured blogs, optional Substack/Xiaohongshu, and public outbound originals in ${path.join(runDir, 'supplements.public.json')}.`,
  ].join('\n');
}

export async function collectMacRun({
  runDir,
  backend = defaultBackend(),
  browserApp = 'Dia',
  cdpEndpoint = DEFAULT_CDP_ENDPOINT,
  codexBin = 'codex',
  maxFollowingPages = 14,
  maxSearchPages = 6,
  includeGmailLeads = true,
  cuaModel = 'gpt-6.1-terra',
  enableCua = true,
  apiKeyFile = null,
  supplementsLimit = 12,
  deps = {},
} = {}) {
  if (!runDir) throw new Error('runDir is required');
  const realRunDir = fs.realpathSync(runDir);
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const runJson = readJson(path.join(realRunDir, 'run.json'));
  const frozenSources = readJson(path.join(realRunDir, 'sources.frozen.json'));
  const gmailConfig = includeGmailLeads ? validateGmailConfig(frozenSources.gmail) : null;
  const resolvedKey = enableCua ? resolveOpenAiApiKey({ apiKeyFile, deps }) : { key: null, problem: null };
  const cua = { enabled: enableCua, model: cuaModel, apiKey: resolvedKey.key, keyProblem: resolvedKey.problem, responsesFetch: deps.responsesFetch };
  const runtimeFile = path.join(realRunDir, 'runtime.json');
  const runtimeConfig = readJson(runtimeFile);
  const startedAt = new Date(runJson.startedAt).toISOString();
  const windowStartIso = new Date(Date.parse(startedAt) - 48 * 3600 * 1000).toISOString();

  const browserBundlePath = path.join(realRunDir, 'browser-capture.json');
  const feedBundlePath = path.join(realRunDir, 'feed-capture.json');
  if (!fs.existsSync(browserBundlePath) && clock() - Date.parse(startedAt) > CAPTURE_WINDOW_GUARD_MS) {
    throw new Error('Frozen run capture window is too close to the 2-hour limit; create a fresh run before collecting');
  }

  const feedPromise = fs.existsSync(feedBundlePath)
    ? Promise.resolve({ output: feedBundlePath, reused: true })
    : (deps.fetchFeeds ?? fetchFeeds)(frozenSources, realRunDir, { fetchImpl, clock: () => new Date(clock()) });

  const limitationsPath = path.join(realRunDir, LIMITATIONS_FILE);
  let limitations = fs.existsSync(limitationsPath) ? readJson(limitationsPath) : [];
  let supplementsCount = fs.existsSync(path.join(realRunDir, 'supplements.public.json'))
    ? readJson(path.join(realRunDir, 'supplements.public.json')).length
    : 0;

  if (!fs.existsSync(browserBundlePath)) {
    if (backend === 'apple-events' || backend === 'cdp') {
      // The repository keeps CDP collection off by default; this backend needs both explicit switches.
      if (backend === 'cdp') {
        assertCollectionAllowed(makeRuntime({ ...runtimeConfig, sources: frozenSources }), { authorized: true, env: deps.env ?? process.env });
      }
      const driver = deps.browser ?? (backend === 'cdp'
        ? createCdpBrowserDriver({
          endpoint: cdpEndpoint, runDir: realRunDir, startedAt,
          fetchImpl: deps.cdpFetch, WebSocketImpl: deps.WebSocketImpl, clock, sleep,
        })
        : createAppleEventsBrowserDriver({
          browserApp,
          runDir: realRunDir,
          startedAt,
          osascript: deps.osascript,
          findCgWindowId: deps.findCgWindowId,
          screencapture: deps.screencapture,
          clock,
          sleep,
        }));
      const collected = await collectViaDriver(driver, {
        runDir: realRunDir,
        startedAt,
        frozenSources,
        maxFollowingPages,
        maxSearchPages,
        includeGmailLeads,
        gmailConfig,
        gmailCli: deps.gmailCli,
        cua,
        supplementsLimit,
        fetchImpl,
        clock,
        sleep,
      });
      supplementsCount = collected.supplementsCount;
      limitations = collected.limitations;
    } else if (backend === 'codex-exec') {
      const execFn = deps.codexExec ?? defaultCodexExec;
      const prompt = buildCodexCollectionPrompt({
        runDir: realRunDir, date: runJson.date, startedAt, windowStartIso, frozenSources, includeGmailLeads, gmailConfig,
      });
      const execArgs = ['exec', '--cd', realRunDir, '--add-dir', realRunDir, '--sandbox', 'workspace-write', '--disable', 'apps', '--skip-git-repo-check', prompt];
      const result = await execFn(codexBin, execArgs, realRunDir);
      if (result.status !== 0) {
        throw new Error(`codex exec collection failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
      }
      if (!fs.existsSync(browserBundlePath)) {
        throw new Error('codex exec completed without writing browser-capture.json');
      }
      try {
        const bundle = readJson(browserBundlePath);
        verifyEvidenceFiles(bundle, realRunDir);
        collectionFromBrowserArtifacts(makeRuntime({ ...runtimeConfig, sources: frozenSources }), bundle);
      } catch (err) {
        // Demote rejected fresh bundle so retries re-run collection rather than reusing corrupt output.
        fs.renameSync(browserBundlePath, path.join(realRunDir, 'browser-capture.invalid.json'));
        throw err;
      }
      if (fs.existsSync(path.join(realRunDir, 'supplements.public.json'))) {
        supplementsCount = readJson(path.join(realRunDir, 'supplements.public.json')).length;
      }
    } else {
      throw new Error(`Unsupported collection backend: ${backend}`);
    }
  }

  await feedPromise;

  const cliFn = deps.runCli ?? runCli;
  const sourcesPath = path.join(realRunDir, 'sources.json');
  if (!fs.existsSync(sourcesPath)) {
    await cliFn(['import-browser', '--artifacts', browserBundlePath, '--out', sourcesPath, '--config', runtimeFile]);
  }
  const mergedPath = path.join(realRunDir, 'sources.merged.json');
  if (!fs.existsSync(mergedPath)) {
    await cliFn([
      'import-feed', '--preserve-full-text', '--allow-window-skew',
      '--artifacts', feedBundlePath, '--sources', sourcesPath, '--out', mergedPath, '--config', runtimeFile,
    ]);
  }

  return {
    status: 'collection_imported',
    run: realRunDir,
    backend,
    sourcesMerged: mergedPath,
    supplementsCount,
    limitations,
  };
}
