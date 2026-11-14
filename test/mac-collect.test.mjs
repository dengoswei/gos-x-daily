import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectMacRun, createAppleEventsBrowserDriver, parseCollectFlags, validateGmailConfig } from '../deployment/mac/mac-collect.mjs';
import { macHome } from './helpers/mac-fixture.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function makeCollectRunFixture(t, {
  withCaptcha = false,
  gmail = { account: 'newsletter@example.com', mode: 'browser' },
  mailEmails = ['newsletter@example.com'],
  blogLinks = ['https://example.com/blog/post-one'],
  blockedBlog = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-mac-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, '2026-11-14-synth');
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = '2026-11-14T02:35:00.000Z';
  const postTime = '2026-11-14T01:00:00.000Z';
  const writeJson = (file, val) => fs.writeFileSync(path.join(runDir, file), JSON.stringify(val, null, 2) + '\n');

  writeJson('run.json', { date: '2026-11-14', startedAt, lookbackHours: 48, sourceRoster: 'sources.frozen.json' });
  const frozenSources = {
    watchProfiles: [{ handle: 'karpathy', name: 'Karpathy', required: true, latest: 10 }],
    xiaohongshuProfiles: [{ name: 'synth-xhs', url: 'https://www.xiaohongshu.com/user/profile/abc123', profileId: 'abc123', maxNotes: 2 }],
    blogs: [{ name: 'Synth Blog', type: 'html-index', indexUrl: 'https://example.com/blog', articleBaseUrl: 'https://example.com/blog/', maxArticles: 2 }],
    feeds: [{ name: 'Synth Feed', url: 'https://example.com/rss.xml', kind: 'rss', maxItems: 5 }],
    ...(gmail ? { gmail } : {}),
  };
  writeJson('sources.frozen.json', frozenSources);
  writeJson('runtime.json', { dataDir: path.join(root, 'data'), lookbackHours: 48, collectionEnabled: false, sourcesFile: path.join(runDir, 'sources.frozen.json') });

  let currentUrl = 'about:blank';
  let scrollCount = 0;
  let mailClicked = false;
  const openedUrls = [];
  const evidence = [];
  const evalLog = [];

  const browser = {
    async init() {},
    async openUrl(url) {
      openedUrls.push(url);
      currentUrl = url;
      scrollCount = 0;
      mailClicked = false;
    },
    async evalJson(jsBody) {
      evalLog.push({ url: currentUrl, jsBody: jsBody.slice(0, 80) });
      if (jsBody.includes('tabInfo') || jsBody.includes('loginWall')) {
        return { href: currentUrl, loginWall: false, tabs: [{ idx: 0, text: 'Following', selected: true }] };
      }
      if (jsBody.includes('window.scrollBy')) { scrollCount += 1; return true; }
      if (jsBody.includes('window.scrollTo')) return true;
      if (jsBody.includes('location.pathname') && jsBody.length < 40) return '/home';
      if (currentUrl.startsWith('https://x.com/home')) {
        return {
          href: currentUrl,
          pathname: '/home',
          items: [{
            url: 'https://x.com/alice/status/1001',
            text: `Synthetic Following item page ${scrollCount}`,
            publishedAt: postTime,
            links: [{ href: 'https://t.co/synthshort', text: 'example.com/paper' }],
          }],
        };
      }
      if (currentUrl.startsWith('https://x.com/search')) {
        return {
          href: currentUrl,
          pathname: '/search',
          items: [{ url: 'https://x.com/bob/status/1002', text: 'Synthetic search tweet', publishedAt: postTime, links: [] }],
        };
      }
      if (currentUrl.startsWith('https://x.com/karpathy')) {
        return {
          href: currentUrl,
          pathname: '/karpathy',
          items: [{ url: 'https://x.com/karpathy/status/1003', text: 'Synthetic Karpathy post', publishedAt: postTime, links: [] }],
        };
      }
      if (currentUrl.startsWith('https://substack.com/')) {
        if (jsBody.includes('isLogin')) return { href: currentUrl, hostname: 'substack.com', pathname: '/home/secondary/subscribed', isLogin: false };
        return [{ url: 'https://synthpub.substack.com/p/issue-1', text: 'Synthetic Substack post summary', publishedAt: postTime, links: [] }];
      }
      if (currentUrl.startsWith('https://www.xiaohongshu.com/user/profile/')) {
        if (withCaptcha) return { href: currentUrl, pathname: '/user/profile/abc123', hasCaptcha: true, candidates: [] };
        return { href: currentUrl, pathname: '/user/profile/abc123', hasCaptcha: false, candidates: [{ noteId: '0123456789abcdef', navUrl: 'https://www.xiaohongshu.com/explore/0123456789abcdef', canonicalUrl: 'https://www.xiaohongshu.com/explore/0123456789abcdef' }] };
      }
      if (currentUrl.startsWith('https://www.xiaohongshu.com/explore/')) {
        return { hasCaptcha: false, text: 'Synthetic XHS note body' };
      }
      if (currentUrl === 'https://example.com/blog') {
        if (jsBody.includes('blocked') && jsBody.includes('candidates')) {
          return {
            href: currentUrl,
            title: blockedBlog ? 'Just a moment...' : 'Synth Blog',
            blocked: blockedBlog,
            textSample: blockedBlog ? 'Verify you are human' : 'Engineering index',
            candidates: [{ tag: 'button', text: 'Load more', href: null, x: 120, y: 340 }],
          };
        }
        return blogLinks;
      }
      if (currentUrl === 'https://example.com/blog/post-one') {
        return { canonicalHref: currentUrl, text: 'Full blog article body '.repeat(12), pub: postTime, links: [] };
      }
      if (currentUrl.startsWith('https://mail.google.com/')) {
        if (jsBody.includes('loggedIn')) return { loggedIn: true, href: currentUrl, emails: mailEmails, rows: 1 };
        if (jsBody.includes('tr.zA')) { mailClicked = true; return true; }
        assert.equal(mailClicked, true);
        return ['https://example.com/newsletter-public-original'];
      }
      throw new Error(`Unhandled synthetic eval on ${currentUrl}: ${jsBody.slice(0, 80)}`);
    },
    async captureViewBase64() {
      return Buffer.from('SYNTHETIC-CUA-VIEW').toString('base64');
    },
    async screenshot(id, url) {
      if (url.includes('mail.google.com')) throw new Error('Must never screenshot private Gmail');
      const rel = `evidence/${id}.jpg`;
      const buf = Buffer.from(`SYNTHETIC-JPEG-${id}`);
      fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(runDir, rel), buf);
      const entry = { id, kind: 'screenshot', url, capturedAt: '2026-11-14T02:36:00.000Z', path: rel, sha256: sha256(buf) };
      evidence.push(entry);
      return entry;
    },
    getEvidence: () => evidence,
    async close() {},
  };

  const fetchFeeds = async (_sources, outDir) => {
    fs.mkdirSync(path.join(outDir, 'feeds'), { recursive: true });
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Synth</title><item><title>Feed Item</title><link>https://example.com/feed-item</link><pubDate>${postTime}</pubDate><description>Feed item summary text</description></item></channel></rss>`;
    const rel = 'feeds/feed-1.xml';
    fs.writeFileSync(path.join(outDir, rel), xml);
    const bundle = {
      schemaVersion: 1,
      transport: 'fetched-documents',
      startedAt,
      fetchedAt: '2026-11-14T02:36:30.000Z',
      documents: [{ id: 'feed-1', feed: 'Synth Feed', url: 'https://example.com/rss.xml', finalUrl: 'https://example.com/rss.xml', path: rel, sha256: sha256(xml), fetchedAt: '2026-11-14T02:36:30.000Z', contentType: 'application/rss+xml' }],
      failures: [],
    };
    fs.writeFileSync(path.join(outDir, 'feed-capture.json'), JSON.stringify(bundle, null, 2) + '\n');
    return { output: path.join(outDir, 'feed-capture.json'), documents: 1, failures: 0 };
  };

  const fetchImpl = async url => {
    const dest = url === 'https://t.co/synthshort' ? 'https://arxiv.org/abs/2611.99999' : url;
    const html = `<html><head><title>Public Article</title><meta property="article:published_time" content="${postTime}"></head><body><article>${'Public research details from verified original article. '.repeat(14)}</article></body></html>`;
    const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    Object.defineProperty(res, 'url', { value: dest });
    return res;
  };

  const clock = () => Date.parse('2026-11-14T02:40:00.000Z');
  const sleep = async () => {};
  return { root, runDir, startedAt, browser, evalLog, fetchFeeds, fetchImpl, clock, sleep };
}

test('apple-events collector builds valid browser-capture, imports sources, and excludes private Gmail screenshots/prose', async t => {
  const f = makeCollectRunFixture(t);
  const res = await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    maxFollowingPages: 2,
    maxSearchPages: 1,
    deps: { browser: f.browser, fetchFeeds: f.fetchFeeds, fetchImpl: f.fetchImpl, clock: f.clock, sleep: f.sleep },
  });

  assert.equal(res.status, 'collection_imported');
  assert.equal(res.backend, 'apple-events');
  const bundle = JSON.parse(fs.readFileSync(path.join(f.runDir, 'browser-capture.json'), 'utf8'));
  assert.equal(bundle.transport, 'gos-supported-browser');
  assert.ok(!bundle.evidence.some(e => e.url.includes('mail.google.com')));
  assert.equal(bundle.blogs.length, 1);
  assert.equal(bundle.xiaohongshu.length, 1);

  const merged = JSON.parse(fs.readFileSync(path.join(f.runDir, 'sources.merged.json'), 'utf8'));
  assert.equal(merged.stats.xFollowing, 2);
  assert.equal(merged.stats.karpathy, 1);
  assert.equal(merged.stats.blogs, 1);
  assert.equal(merged.stats.feeds, 1);

  const supplements = JSON.parse(fs.readFileSync(path.join(f.runDir, 'supplements.public.json'), 'utf8'));
  const supUrls = supplements.map(s => s.url).sort();
  assert.ok(supUrls.includes('https://arxiv.org/abs/2611.99999'));
  assert.ok(supUrls.includes('https://example.com/newsletter-public-original'));
  assert.ok(!JSON.stringify(supplements).includes('mail.google.com'));
});

test('Xiaohongshu CAPTCHA / verification prompt is skipped without interaction and logged as a limitation', async t => {
  const f = makeCollectRunFixture(t, { withCaptcha: true });
  const res = await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: { browser: f.browser, fetchFeeds: f.fetchFeeds, fetchImpl: f.fetchImpl, clock: f.clock, sleep: f.sleep },
  });

  const bundle = JSON.parse(fs.readFileSync(path.join(f.runDir, 'browser-capture.json'), 'utf8'));
  assert.deepEqual(bundle.xiaohongshu, []);
  assert.ok(res.limitations.some(msg => /verification prompt \(not interacted per anti-bot policy\)/.test(msg)));
  assert.ok(!f.evalLog.some(e => e.url.startsWith('https://www.xiaohongshu.com/explore/')));
});

test('codex-exec backend disables codex_apps and fails closed when bundle is missing or invalid', async t => {
  const f = makeCollectRunFixture(t);
  let capturedArgs = null;
  await assert.rejects(
    collectMacRun({
      runDir: f.runDir,
      backend: 'codex-exec',
      deps: {
        fetchFeeds: f.fetchFeeds,
        clock: f.clock,
        codexExec: (_bin, args) => {
          capturedArgs = args;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    }),
    /without writing browser-capture\.json/,
  );
  assert.ok(capturedArgs.includes('exec'));
  assert.ok(capturedArgs.includes('--disable') && capturedArgs[capturedArgs.indexOf('--disable') + 1] === 'apps');
  assert.ok(capturedArgs.includes('--skip-git-repo-check'));

  const buf = Buffer.from('SYNTHETIC-SHOT');
  const writeValid = validXFollowing => () => {
    fs.mkdirSync(path.join(f.runDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(f.runDir, 'evidence/shot.jpg'), buf);
    const ev = { id: 'shot', kind: 'screenshot', url: validXFollowing ? 'https://x.com/home' : 'https://x.com/home', capturedAt: '2026-11-14T02:36:00.000Z', path: 'evidence/shot.jpg', sha256: sha256(buf) };
    const kEv = { id: 'kshot', kind: 'screenshot', url: 'https://x.com/karpathy', capturedAt: '2026-11-14T02:36:00.000Z', path: 'evidence/shot.jpg', sha256: sha256(buf) };
    fs.writeFileSync(path.join(f.runDir, 'browser-capture.json'), JSON.stringify({
      schemaVersion: 1,
      transport: 'gos-supported-browser',
      startedAt: f.startedAt,
      capturedAt: '2026-11-14T02:37:00.000Z',
      evidence: [ev, kEv],
      feeds: {
        xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'shot', items: validXFollowing ? [{ url: 'https://x.com/a/status/1', text: 'Post', publishedAt: '2026-11-14T01:00:00.000Z', links: [] }] : [] }] },
        karpathy: { status: 'page_error', pages: [{ evidenceId: 'kshot', items: [] }] },
      },
    }));
    return { status: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    collectMacRun({ runDir: f.runDir, backend: 'codex-exec', deps: { fetchFeeds: f.fetchFeeds, clock: f.clock, codexExec: writeValid(false) } }),
    /X Following produced 0 usable items/,
  );

  const ok = await collectMacRun({
    runDir: f.runDir,
    backend: 'codex-exec',
    deps: { fetchFeeds: f.fetchFeeds, clock: f.clock, codexExec: writeValid(true) },
  });
  assert.equal(ok.status, 'collection_imported');
});

test('collectMacRun resumes cleanly without re-invoking browser, feed fetch, or CLI when artifacts already exist', async t => {
  const f = makeCollectRunFixture(t);
  await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: { browser: f.browser, fetchFeeds: f.fetchFeeds, fetchImpl: f.fetchImpl, clock: f.clock, sleep: f.sleep },
  });

  const resumed = await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    deps: {
      clock: () => Date.parse('2026-11-14T09:00:00.000Z'),
      browser: { openUrl() { throw new Error('Should not reopen browser'); } },
      fetchFeeds() { throw new Error('Should not refetch feeds'); },
      runCli() { throw new Error('Should not re-import existing files'); },
    },
  });
  assert.equal(resumed.status, 'collection_imported');
});

test('local collect/auto CLI gates invalid flags, outside run dirs, already accepted days, and uncertain attempts', t => {
  assert.throws(() => parseCollectFlags(['--backend', 'invalid'], { requireRun: false }), /Unsupported collection backend/);
  const f = macHome(t);
  assert.notEqual(f.local(['auto', '--bogus']).status, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'runs')), false);
  assert.match(f.local(['collect', '--run', f.home]).stderr, /existing frozen run/);

  const sent = f.local(['publish', '--publication', f.publication]);
  assert.equal(sent.status, 0);
  const autoReconciled = f.local(['auto']);
  assert.equal(autoReconciled.status, 0, autoReconciled.stderr);
  assert.equal(autoReconciled.json.status, 'sent_and_verified');
  assert.equal(f.sends().length, 1);

  const f2 = macHome(t);
  f2.stubWith({ send: 'fail' });
  assert.notEqual(f2.local(['publish', '--publication', f2.publication]).status, 0);
  f2.stubWith({});
  assert.match(f2.local(['auto']).stderr, /requires reconciliation/);
  assert.equal(f2.sends().length, 1);
});

test('Gmail discovery stays disabled without explicit account and aborts before opening mail on wrong mailbox', async t => {
  assert.equal(validateGmailConfig(undefined), null);
  assert.equal(validateGmailConfig({ enabled: false }), null);
  assert.throws(() => validateGmailConfig({ enabled: true }), /sources\.gmail\.account must be an explicit email address/);

  const noGmail = makeCollectRunFixture(t, { gmail: null });
  const r1 = await collectMacRun({
    runDir: noGmail.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: { browser: noGmail.browser, fetchFeeds: noGmail.fetchFeeds, fetchImpl: noGmail.fetchImpl, clock: noGmail.clock, sleep: noGmail.sleep },
  });
  assert.equal(r1.status, 'collection_imported');
  const sups1 = JSON.parse(fs.readFileSync(path.join(noGmail.runDir, 'supplements.public.json'), 'utf8'));
  assert.equal(sups1.some(s => s.url.includes('newsletter-public-original')), false);

  const wrongBox = makeCollectRunFixture(t, {
    gmail: { account: 'newsletter@example.com', mode: 'browser' },
    mailEmails: ['other@example.com'],
  });
  let clickedRows = false;
  const origEval = wrongBox.browser.evalJson;
  wrongBox.browser.evalJson = async js => {
    if (js.includes('tr.zA') && !js.includes('loggedIn')) clickedRows = true;
    return origEval(js);
  };
  const r2 = await collectMacRun({
    runDir: wrongBox.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: { browser: wrongBox.browser, fetchFeeds: wrongBox.fetchFeeds, fetchImpl: wrongBox.fetchImpl, clock: wrongBox.clock, sleep: wrongBox.sleep },
  });
  assert.equal(clickedRows, false);
  assert.ok(r2.limitations.some(msg => msg.includes('Gmail account verification failed for newsletter@example.com')));
  const sups2 = JSON.parse(fs.readFileSync(path.join(wrongBox.runDir, 'supplements.public.json'), 'utf8'));
  assert.equal(sups2.some(s => s.url.includes('newsletter-public-original')), false);
});

test('Gmail gmail-cli mode isolates target mailbox via AGY_ACCOUNT without touching browser', async t => {
  const f = makeCollectRunFixture(t, {
    gmail: { account: 'newsletter@example.com', mode: 'gmail-cli', query: 'from:news@alphasignal.ai newer_than:2d', maxMessages: 2 },
  });
  const fakeCliPath = path.join(f.runDir, 'fake-gmail.sh');
  const htmlBody = Buffer.from('<p>Lead <a href="https://example.com/newsletter-public-original">Story</a></p>').toString('base64url');
  fs.writeFileSync(fakeCliPath, `#!/bin/sh
if [ "$AGY_ACCOUNT" != "newsletter@example.com" ]; then
  echo "wrong account: $AGY_ACCOUNT" >&2
  exit 2
fi
if [ "$1" = "readonly" ] && [ "$2" = "sendas" ]; then
  echo '{"sendAs":[{"sendAsEmail":"newsletter@example.com"}]}'
  exit 0
fi
echo '{"messages":[{"payload":{"mimeType":"text/html","body":{"data":"${htmlBody}"}}}]}'
`, { mode: 0o755 });

  let openedMailUrl = false;
  const origOpen = f.browser.openUrl;
  f.browser.openUrl = async url => {
    if (url.includes('mail.google.com')) openedMailUrl = true;
    return origOpen(url);
  };

  const prevEnv = process.env.GOS_GMAIL_CLI;
  process.env.GOS_GMAIL_CLI = fakeCliPath;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.GOS_GMAIL_CLI;
    else process.env.GOS_GMAIL_CLI = prevEnv;
  });

  const res = await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: { browser: f.browser, fetchFeeds: f.fetchFeeds, fetchImpl: f.fetchImpl, clock: f.clock, sleep: f.sleep },
  });
  assert.equal(openedMailUrl, false);
  assert.equal(res.status, 'collection_imported');
  const sups = JSON.parse(fs.readFileSync(path.join(f.runDir, 'supplements.public.json'), 'utf8'));
  assert.ok(sups.some(s => s.url === 'https://example.com/newsletter-public-original'));
});

test('createAppleEventsBrowserDriver opens dedicated background window without activate/focus and closes it cleanly', async t => {
  const runDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-driver-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const scripts = [];
  let markerSeen = '';
  let closedWinId = null;
  let tabSeq = 100;
  const driver = createAppleEventsBrowserDriver({
    browserApp: 'Dia',
    runDir,
    startedAt: '2026-11-14T02:35:00.000Z',
    clock: () => Date.parse('2026-11-14T02:36:00.000Z'),
    sleep: async () => {},
    osascript: (script, argv) => {
      scripts.push({ script, argv });
      if (script.includes('make new window')) {
        const m = String(argv[1] || '').match(/gos-xdaily-bg-[a-f0-9]+/);
        markerSeen = m ? m[0] : '';
        tabSeq += 1;
        return `win-900\ntab-${tabSeq}\ntab-init`;
      }
      if (script.includes('make new tab')) {
        tabSeq += 1;
        return `tab-${tabSeq}`;
      }
      if (script.includes('loading of tab id')) return 'false';
      if (script.includes('close window id')) {
        closedWinId = argv[1];
        return 'ok';
      }
      if (script.includes('close tab id')) return 'ok';
      if (script.includes('javascript')) {
        const js = argv[4] || '';
        if (js.includes('1 + 1 === 2')) return JSON.stringify({ __ok: true, value: { ok: true, title: markerSeen, ready: 'complete' } });
        if (js.includes('readyState')) return JSON.stringify({ __ok: true, value: { readyState: 'complete', href: 'https://example.com/' } });
        return JSON.stringify({ __ok: true, value: 42 });
      }
      return '';
    },
    findCgWindowId: (app, marker) => {
      assert.equal(app, 'Dia');
      assert.equal(marker, markerSeen);
      return '5126';
    },
    screencapture: (cgId, absPath) => {
      assert.equal(cgId, '5126');
      fs.writeFileSync(absPath, Buffer.alloc(5000, 0x41));
    },
  });

  await driver.init();
  await driver.openUrl('https://example.com/', { settleMs: 1 });
  assert.equal(await driver.evalJson('return 42;'), 42);
  const b64 = await driver.captureViewBase64();
  assert.equal(Buffer.from(b64, 'base64').length, 5000);
  await driver.screenshot('x-following-01', 'https://example.com/');
  await driver.close();

  assert.equal(closedWinId, 'win-900');
  assert.equal(fs.readdirSync(runDir).some(f => f.startsWith('.tmp-cua-')), false);
  for (const call of scripts) {
    assert.equal(/\bactivate\b/i.test(call.script), false, `Script must not call activate:\n${call.script}`);
    assert.equal(/\bfocus\b/i.test(call.script), false, `Script must not call focus:\n${call.script}`);
  }
});

test('gpt-6.1-terra Responses API assists empty dynamic blog indexes statelessly and skips CAPTCHAs', async t => {
  const f = makeCollectRunFixture(t, { blogLinks: [] });
  const calls = [];
  const responsesFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC_TOKEN_1' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'inspect_blog_index',
            arguments: JSON.stringify({ action: 'scroll', selector: null, scroll_y: 600, article_urls: [] }),
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      output: [
        {
          type: 'function_call',
          call_id: 'call_2',
          name: 'inspect_blog_index',
          arguments: JSON.stringify({
            action: 'done',
            selector: null,
            scroll_y: null,
            article_urls: ['https://example.com/blog/post-one', 'https://untrusted.example.org/blog/evil'],
          }),
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const res = await collectMacRun({
    runDir: f.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    cuaModel: 'gpt-6.1-terra',
    deps: {
      browser: f.browser,
      fetchFeeds: f.fetchFeeds,
      fetchImpl: f.fetchImpl,
      clock: f.clock,
      sleep: f.sleep,
      apiKey: 'test-openai-key',
      responsesFetch,
    },
  });
  assert.equal(res.status, 'collection_imported');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-openai-key');
  assert.equal(calls[0].body.model, 'gpt-6.1-terra');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.previous_response_id, undefined);
  assert.equal(calls[0].body.temperature, undefined);
  assert.deepEqual(calls[0].body.include, ['reasoning.encrypted_content']);
  assert.equal(calls[0].body.reasoning.effort, 'low');
  assert.ok(calls[0].body.input[0].content.some(c => c.type === 'input_image'));
  assert.ok(calls[1].body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'ENC_TOKEN_1'));
  assert.ok(calls[1].body.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_1'));

  const bundle = JSON.parse(fs.readFileSync(path.join(f.runDir, 'browser-capture.json'), 'utf8'));
  assert.deepEqual(bundle.blogs.map(b => b.url), ['https://example.com/blog/post-one']);

  const fBlocked = makeCollectRunFixture(t, { blogLinks: [], blockedBlog: true });
  let blockedCalls = 0;
  const blockedRes = await collectMacRun({
    runDir: fBlocked.runDir,
    backend: 'apple-events',
    maxFollowingPages: 1,
    maxSearchPages: 1,
    deps: {
      browser: fBlocked.browser,
      fetchFeeds: fBlocked.fetchFeeds,
      fetchImpl: fBlocked.fetchImpl,
      clock: fBlocked.clock,
      sleep: fBlocked.sleep,
      apiKey: 'test-openai-key',
      responsesFetch: async () => { blockedCalls += 1; throw new Error('Should not call CUA on CAPTCHA'); },
    },
  });
  assert.equal(blockedCalls, 0);
  assert.ok(blockedRes.limitations.some(msg => msg.includes('anti-bot/CAPTCHA')));
});
