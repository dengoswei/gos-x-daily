import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCdpBrowserDriver, loopbackCdpEndpoint } from '../deployment/mac/cdp-browser-driver.mjs';
import { collectMacRun, defaultBackend, parseCollectFlags } from '../deployment/mac/mac-collect.mjs';

function fakeBrowser({ advertised = 'ws://127.0.0.1:9222/devtools/browser/synthetic' } = {}) {
  const sent = [];
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    emit(type, event) { for (const fn of [...this.listeners[type]]) fn(event); }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      const results = {
        'Target.createTarget': { targetId: 'own-target' },
        'Target.attachToTarget': { sessionId: 'own-session' },
        'Page.navigate': { frameId: 'f1' },
        'Page.captureScreenshot': { data: Buffer.alloc(6000, 0x42).toString('base64') },
      };
      let result = results[message.method] ?? {};
      if (message.method === 'Runtime.evaluate') {
        const value = message.params.expression.includes('readyState')
          ? { readyState: 'complete', href: 'https://example.com/' } : 42;
        result = { result: { type: 'string', value: JSON.stringify({ __ok: true, value }) } };
      }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, result }) }));
    }
    close() { this.closed = true; }
  }
  const fetchImpl = async url => {
    assert.equal(String(url), 'http://127.0.0.1:9222/json/version');
    return new Response(JSON.stringify({ webSocketDebuggerUrl: advertised }), { status: 200 });
  };
  return { sent, sockets, FakeSocket, fetchImpl };
}

const tmpRun = t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-cdp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('CDP endpoint and advertised browser socket must both be loopback', async t => {
  for (const bad of ['https://127.0.0.1:9222', 'http://10.0.0.5:9222', 'http://browser.example.com:9222', 'http://user:pw@127.0.0.1:9222', 'http://127.0.0.1', 'not a url']) {
    assert.throws(() => loopbackCdpEndpoint(bad), /loopback http URL/, bad);
  }
  assert.throws(() => parseCollectFlags(['--run', '/tmp/x', '--cdp-endpoint', 'http://192.168.1.9:9222']), /loopback http URL/);
  assert.equal(parseCollectFlags(['--run', '/tmp/x', '--cdp-endpoint', 'http://localhost:9333/']).cdpEndpoint, 'http://localhost:9333');

  const remote = fakeBrowser({ advertised: 'ws://203.0.113.7:9222/devtools/browser/x' });
  const driver = createCdpBrowserDriver({ runDir: tmpRun(t), startedAt: '2026-11-14T02:35:00.000Z', fetchImpl: remote.fetchImpl, WebSocketImpl: remote.FakeSocket });
  await assert.rejects(driver.init(), /non-loopback browser socket/);
  assert.equal(remote.sockets.length, 0);
});

test('CDP driver works only inside its own new window and closes nothing else', async t => {
  const browser = fakeBrowser();
  const runDir = tmpRun(t);
  const driver = createCdpBrowserDriver({
    runDir, startedAt: '2026-11-14T02:35:00.000Z', fetchImpl: browser.fetchImpl, WebSocketImpl: browser.FakeSocket,
    clock: () => Date.parse('2026-11-14T02:36:00.000Z'), sleep: async () => {},
  });
  await driver.init();
  await driver.openUrl('https://example.com/', { settleMs: 1 });
  assert.equal(await driver.evalJson('return 42;'), 42);
  const entry = await driver.screenshot('x-following-01', 'https://example.com/');
  assert.deepEqual(driver.getEvidence(), [entry]);
  assert.equal(entry.capturedAt, '2026-11-14T02:36:00.000Z');
  assert.equal(fs.statSync(path.join(runDir, entry.path)).size, 6000);
  await driver.close();

  const create = browser.sent.find(m => m.method === 'Target.createTarget');
  assert.deepEqual(create.params, { url: 'about:blank', newWindow: true, background: true });
  for (const message of browser.sent.filter(m => /^(Page|Runtime)\./.test(m.method))) assert.equal(message.sessionId, 'own-session');
  assert.deepEqual(browser.sent.filter(m => m.method === 'Target.closeTarget').map(m => m.params.targetId), ['own-target']);
  const allowed = new Set(['Target.createTarget', 'Target.attachToTarget', 'Target.closeTarget', 'Page.enable', 'Page.navigate', 'Page.captureScreenshot', 'Runtime.evaluate']);
  assert.deepEqual(browser.sent.filter(m => !allowed.has(m.method)), []);
  assert.equal(browser.sockets[0].closed, true);
  await assert.rejects(driver.screenshot('../escape', 'https://example.com/'), /closed|Invalid evidence ID/);
});

test('backend defaults by platform and the cdp backend keeps the repository collection gate', async t => {
  assert.equal(defaultBackend('darwin'), 'apple-events');
  assert.equal(defaultBackend('linux'), 'cdp');

  const runDir = tmpRun(t);
  const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
  write('run.json', { date: '2026-11-14', startedAt: '2026-11-14T02:35:00.000Z' });
  write('sources.frozen.json', {});
  const opened = [];
  const browser = { init: async () => { opened.push('init'); throw new Error('reached browser'); } };
  const attempt = (runtime, env) => {
    write('runtime.json', { dataDir: path.join(runDir, 'data'), ...runtime });
    return collectMacRun({ runDir, backend: 'cdp', deps: { browser, env, clock: () => Date.parse('2026-11-14T02:36:00.000Z'), fetchFeeds: async () => ({}) } });
  };
  await assert.rejects(attempt({ collectionEnabled: false }, { X_DAILY_ALLOW_COLLECTION: '1' }), /Collection disabled/);
  await assert.rejects(attempt({ collectionEnabled: true }, {}), /Collection disabled/);
  assert.deepEqual(opened, []);
  await assert.rejects(attempt({ collectionEnabled: true }, { X_DAILY_ALLOW_COLLECTION: '1' }), /reached browser/);
});
