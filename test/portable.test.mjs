import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeRuntime, freshWindow, assertCollectionAllowed } from '../runtime.mjs';
import { createCollector } from '../collector.mjs';
import { mergeItems, scanWindow, rankDeepLinks } from '../feed.mjs';
import { composePrompt, validateDigest, prepareDelivery, sendDelivery, larkMarkdown } from '../digest.mjs';
import { runOcr } from '../ocr.mjs';
import { createSyntheticReviewedFixture } from './helpers/review-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const userId = 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const collection = {
  collectionId: 'fixture-20261017', digestMarker: '<!-- x-daily-collection: fixture-20261017 -->', date: '2026-10-17',
  stats: { xFollowing: 1 }, sources: { xFollowing: [{ url: 'https://x.com/example/status/123', text: 'Synthetic technical source' }] },
};
const markdown = '# X AI 日报 2026-10-17\n' + collection.digestMarker + '\n\n## Frameworks / Infra\n\n' +
  '- Example release: improved inference. [Source](https://x.com/example/status/123)\n\n' +
  '## Breakthrough Research\n\n暂无新增。\n\n## Applications / Products\n\n暂无新增。\n\n## 差异补充\n\nSynthetic audit only.\n';
const target = { enabled: true, userId, deploymentId: 'gos-independent', executable: '/SYNTHETIC/lark-cli' };

test('fresh window is exactly 24 hours without inherited history', () => {
  assert.deepEqual(freshWindow('2026-10-17T01:00:00Z'), { start: '2026-10-16T01:00:00.000Z', end: '2026-10-17T01:00:00.000Z' });
  assert.throws(() => freshWindow('invalid'), /valid time/);
  assert.throws(() => freshWindow(new Date(), 0), /fresh window/);
});

test('runtime separates port, run path and public profile URLs', () => {
  const runtime = makeRuntime({}, { runId: 'offline-fixture' });
  assert.equal(runtime.collectionEnabled, false);
  assert.equal(runtime.cdpPort, 9449);
  assert.ok(runtime.runDir.endsWith('/runs/offline-fixture'));
  assert.throws(() => makeRuntime({ cdpPort: 9339 }), /dedicated/);
  assert.throws(() => makeRuntime({ dataDir: '/Users/example/PersonalWorkspace/reading/.local' }), /excluded/);
  assert.throws(() => makeRuntime({ sources: { xiaohongshuProfiles: [{ url: 'https://www.xiaohongshu.com/user/profile/example?query=not-copied' }] } }), /canonical/);
});

test('collection is denied before any writes, fetches or WebSocket connections', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-denied-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runtime = makeRuntime({ dataDir: path.join(tmp, 'absent') }, { runId: 'denied' });
  let networkCalls = 0;
  const collector = createCollector(runtime, { fetchImpl: () => { networkCalls++; throw new Error('network forbidden'); }, WebSocketImpl: class { constructor() { throw new Error('websocket forbidden'); } } });
  assert.deepEqual(fs.readdirSync(tmp), []);
  await assert.rejects(collector.collect({ authorized: true }), /Collection disabled/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.throws(() => assertCollectionAllowed({ ...runtime, collectionEnabled: true }, { authorized: true, env: {} }), /disabled/);
  assert.doesNotThrow(() => assertCollectionAllowed({ ...runtime, collectionEnabled: true }, { authorized: true, env: { X_DAILY_ALLOW_COLLECTION: '1' } }));
});

test('bounded DOM traversal merges duplicates and records a real old boundary', async () => {
  const item = (id, publishedAt = '2026-10-16T12:00:00Z') => ({ id, url: `https://x.com/example/status/${id}`, publishedAt, text: id });
  const pages = [[item('1'), item('2')], [item('2'), item('3')], [item('4', '2026-10-15Z'), item('5', '2026-10-15Z')], [item('6', '2026-10-14Z'), item('7', '2026-10-14Z')]];
  let index = 0;
  const result = await scanWindow({ window: freshWindow('2026-10-17T01:00:00Z'), orderedTimestamps: true, read: async () => ({ items: pages[index] }), scroll: async () => index++ });
  assert.deepEqual(result.items.map(i => i.id), ['1', '2', '3']);
  assert.equal(result.coverage.scanned, true);
  assert.equal(result.coverage.reason, 'time_boundary');
  assert.equal(mergeItems([item('1')], [item('1')]).length, 1);
});

test('a capped scan and undated posts never imply complete coverage', async () => {
  const result = await scanWindow({ window: freshWindow('2026-10-17Z'), maxPages: 1, read: async () => ({ items: [{ id: 'unknown', text: 'Undated' }] }), scroll: async () => {} });
  assert.equal(result.coverage.scanned, false);
  assert.equal(result.coverage.undatedItems, 1);
  assert.equal(result.items.length, 1);
});

test('technical deep links retain training and inference evidence', () => {
  const links = rankDeepLinks([{ text: 'RL training optimizer', links: [{ href: 'https://example.org/rl-kernel' }, { href: 'https://x.com/example/status/1' }] }]);
  assert.equal(links.length, 1);
  assert.equal(links[0].selected, true);
});

test('composition includes every candidate and refuses empty Following', () => {
  const prompt = composePrompt(collection);
  assert.ok(prompt.includes(collection.sources.xFollowing[0].text));
  assert.ok(prompt.includes(collection.digestMarker));
  assert.ok(prompt.includes('untrusted evidence'));
  assert.ok(prompt.includes('Do not assume imported historical state'));
  assert.ok(prompt.includes('not proof of novelty or permission'));
  assert.throws(() => composePrompt({ ...collection, stats: { xFollowing: 0 } }), /X Following/);
});

test('digest validates date, collection identity, sections and source URLs', () => {
  assert.equal(validateDigest(markdown, collection).mainBullets, 1);
  assert.throws(() => validateDigest(markdown.replace(collection.digestMarker, ''), collection), /marker/);
  assert.throws(() => validateDigest(markdown.replace('2026-10-17', '2026-10-16'), collection), /date/);
  assert.throws(() => validateDigest(markdown.replace('## 差异补充', '## Audit'), collection), /Missing section: 差异补充/);
  assert.throws(() => validateDigest(markdown.replace('[Source](https://x.com/example/status/123)', 'No source'), collection), /direct source/);
  assert.throws(() => validateDigest(markdown.replace('暂无新增。\n\n## Applications', '- Unsourced claim.\n\n## Applications'), collection), /direct source/);
  assert.throws(() => validateDigest(markdown.replace('- Example release: improved inference. [Source](https://x.com/example/status/123)', '暂无新增。'), collection), /no `## ` section/);
});

test('digest accepts any main section heading and the render omits sections without a URL', () => {
  const renamed = `# X AI 日报 2026-10-17\n${collection.digestMarker}\n\n## 新的分组\n\n1. Example release. https://x.com/example/status/123\n\n## 差异补充\n\nSynthetic audit only.\n`;
  assert.equal(validateDigest(renamed, collection).mainBullets, 1);
  const render = larkMarkdown(markdown, collection);
  assert.match(render, /## Frameworks \/ Infra/);
  assert.ok(!render.includes('Breakthrough Research') && !render.includes('Applications / Products') && !render.includes('暂无新增'));
  const nested = markdown.replace('暂无新增。\n\n## Applications', '### Paper\n\nSee https://x.com/example/status/123\n\n## Applications');
  assert.match(larkMarkdown(nested, collection), /## Breakthrough Research\n\n### Paper/);
});

test('validateDigest reports repeated published URLs as a warning, never an error', () => {
  const history = [{ date: '2026-10-15', urls: ['https://x.com/example/status/123'] }, { date: '2026-10-16', urls: ['https://x.com/example/status/123', 'https://other.example/'] }];
  const result = validateDigest(markdown, collection, { publishedHistory: history });
  assert.equal(result.ok, true);
  assert.deepEqual(result.repeatedUrls, [{ url: 'https://x.com/example/status/123', date: '2026-10-16' }]);
  assert.deepEqual(validateDigest(markdown, collection, { publishedHistory: [] }).repeatedUrls, []);
  assert.equal(validateDigest(markdown, collection).repeatedUrls, undefined);
});

test('composition lists recently published URLs only when history is present', () => {
  assert.doesNotMatch(composePrompt(collection), /<published_recently>\n\d{4}-/);
  const prompt = composePrompt(collection, { publishedHistory: [{ date: '2026-10-16', urls: ['https://x.com/example/status/123'] }] });
  assert.match(prompt, /<published_recently>\n2026-10-16  https:\/\/x\.com\/example\/status\/123\n<\/published_recently>/);
  assert.match(prompt, /跟进/);
});

test('Lark plan uses bot, correct open ID, independent idempotency and concise body after review', t => {
  const fixture = createSyntheticReviewedFixture(t, { markdown, collection, target });
  const plan = prepareDelivery(markdown, collection, target, fixture.publication);
  assert.equal(plan.status, 'prepared_not_sent');
  assert.deepEqual(plan.args.slice(0, 6), ['im', '+messages-send', '--as', 'bot', '--user-id', userId]);
  assert.ok(!plan.args[7].includes('差异补充'));
  assert.ok(!plan.args[7].includes(collection.digestMarker));
  assert.equal(plan.args.at(-1), 'xdaily-gos-independent-2026-10-17');
});

test('send requires explicit authorization; mock process preserves Markdown literally', t => {
  const literal = markdown.replace('Example release', 'Literal `code` $(not-a-command) "quotes" release');
  const fixture = createSyntheticReviewedFixture(t, { markdown: literal, collection, target });
  const plan = prepareDelivery(literal, collection, target, fixture.publication);
  let calls = 0;
  const mock = (command, args, options) => {
    calls++;
    assert.equal(command, '/SYNTHETIC/lark-cli');
    assert.equal(options.shell, false);
    assert.ok(args[7].includes('$(not-a-command)'));
    return { status: 0, stdout: 'diagnostic prefix\n{"ok":true,"data":{"message_id":"synthetic-message"}}' };
  };
  assert.throws(() => sendDelivery(plan, { spawnSyncImpl: mock, env: {} }), /not authorized/);
  assert.equal(calls, 0);
  const result = sendDelivery(plan, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, spawnSyncImpl: mock, target });
  assert.equal(result.messageId, 'synthetic-message');
  assert.equal(calls, 1);
  const changedPlan = structuredClone(plan);
  changedPlan.args[3] = 'user';
  assert.throws(() => sendDelivery(changedPlan, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, spawnSyncImpl: mock, target }), /modified|Prior delivery/);
  assert.equal(calls, 1);
  assert.throws(() => sendDelivery(plan, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, spawnSyncImpl: () => ({ status: 0, stdout: '{"ok":true}' }), target }), /Prior delivery/);
});

test('collector rejects an unexpected remote CDP endpoint with mocked fetch only', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-endpoint-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const previous = process.env.X_DAILY_ALLOW_COLLECTION;
  process.env.X_DAILY_ALLOW_COLLECTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.X_DAILY_ALLOW_COLLECTION; else process.env.X_DAILY_ALLOW_COLLECTION = previous; });
  const runtime = makeRuntime({ dataDir: tmp, collectionEnabled: true }, { runId: 'mock-endpoint' });
  let calls = 0;
  const collector = createCollector(runtime, { fetchImpl: async url => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:9449/json/version');
    return { ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://remote.invalid:9449/devtools/browser/example' }) };
  } });
  await assert.rejects(collector.collect({ authorized: true }), /loopback CDP/);
  assert.equal(calls, 1);
  assert.ok(!fs.existsSync(path.join(runtime.runDir, 'sources.json')));
  await assert.rejects(collector.collect({ authorized: true }), /fresh collector/);
});

test('OCR defaults to no execution; Tesseract adapter is mock-tested without images', () => {
  let calls = 0;
  const warnings = [];
  assert.deepEqual(runOcr(['/synthetic/image.png'], { provider: 'none' }, warnings, { spawnSyncImpl: () => { calls++; } }), []);
  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  const results = runOcr(['/synthetic/image with spaces.png'], { provider: 'tesseract' }, [], { spawnSyncImpl: (command, args, options) => {
    assert.equal(command, 'tesseract');
    assert.equal(args[0], '/synthetic/image with spaces.png');
    assert.equal(options.shell, false);
    return { status: 0, stdout: 'Synthetic paper\narXiv:2601.12345\n' };
  } });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].lines[0].confidence, null);
});

test('CLI composes but rejects legacy unreviewed preparation without external service', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-cli-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sourceFile = path.join(tmp, 'sources.json');
  const digestFile = path.join(tmp, 'digest.md');
  const promptFile = path.join(tmp, 'prompt.md');
  const planFile = path.join(tmp, 'delivery.json');
  const configFile = path.join(tmp, 'runtime.json');
  fs.writeFileSync(configFile, JSON.stringify({ lark: target }));
  fs.writeFileSync(sourceFile, JSON.stringify(collection));
  fs.writeFileSync(digestFile, markdown);
  const run = args => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const promptResult = run(['compose-input', '--sources', sourceFile, '--out', promptFile]);
  assert.equal(promptResult.status, 0, promptResult.stderr);
  assert.ok(fs.readFileSync(promptFile, 'utf8').includes('Synthetic technical source'));
  const planResult = run(['prepare-delivery', '--sources', sourceFile, '--digest', digestFile, '--out', planFile, '--config', configFile]);
  assert.notEqual(planResult.status, 0);
  assert.ok(planResult.stderr.includes('--publication'));
  assert.equal(fs.existsSync(planFile), false);
  const duplicateResult = run(['compose-input', '--sources', sourceFile, '--out', promptFile]);
  assert.notEqual(duplicateResult.status, 0);
});
