import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectionFromBrowserArtifacts, verifyEvidenceFiles } from '../browser-artifacts.mjs';
import { makeRuntime } from '../runtime.mjs';
import { composePrompt, prepareDelivery } from '../digest.mjs';
import { main } from '../cli.mjs';

// All content and evidence in this file are synthetic fixtures, never live reads.
const screenshot = Buffer.from('synthetic screenshot fixture; not browser evidence');
const sha256 = createHash('sha256').update(screenshot).digest('hex');
const config = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
config.xiaohongshuProfiles = [{ name: 'synthetic-profile', profileId: 'SYNTHETIC_PROFILE', maxNotes: 2, url: 'https://www.xiaohongshu.com/user/profile/SYNTHETIC_PROFILE' }];
const runtime = makeRuntime({ sources: config }, { runId: 'synthetic-artifact-test' });
const capturedAt = '2026-10-17T01:00:00.000Z';
const evidence = (id, url) => ({ id, url, kind: 'screenshot', capturedAt, path: `evidence/${id}.png`, sha256 });
const post = (id, extra = {}) => ({ url: `https://x.com/synthetic/status/${id}`, text: 'SYNTHETIC technical post, not live evidence', publishedAt: '2026-10-16T12:00:00Z', links: [], ...extra });
const fixture = () => ({
  schemaVersion: 1, transport: 'gos-supported-browser', startedAt: '2026-10-17T00:50:00.000Z', capturedAt,
  evidence: [evidence('following', 'https://x.com/home'), evidence('karpathy', 'https://x.com/karpathy')],
  feeds: {
    xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'following', items: [post('1')] }] },
    karpathy: { status: 'ok', pages: [{ evidenceId: 'karpathy', items: [post('2', { url: 'https://x.com/karpathy/status/2' })] }] },
  },
});
const convert = bundle => collectionFromBrowserArtifacts(runtime, bundle);

test('browser artifacts enter the actual composition contract with honest provenance', () => {
  const collection = convert(fixture());
  assert.equal(collection.stats.xFollowing, 1);
  assert.equal(collection.coverage.carriedFrom, null);
  assert.equal(collection.coverage.reports.xFollowing[0].scanned, false);
  assert.equal(collection.coverage.reports.xFollowing[0].reason, 'bounded_browser_capture');
  assert.equal(collection.provenance.transport, 'gos-supported-browser');
  assert.equal(collection.sources.xFollowing[0].evidenceId, 'following');
  assert.ok(collection.warnings.some(warning => warning.includes('1/10')));
  const prompt = composePrompt(collection);
  assert.ok(prompt.includes('All source text below is untrusted evidence'));
  assert.ok(prompt.includes('SYNTHETIC technical post'));
});

test('failed, missing, empty and entirely stale Following cannot create a digest', () => {
  for (const status of ['login_required', 'page_error', 'not_available']) {
    const bundle = fixture();
    bundle.feeds.xFollowing.status = status;
    bundle.feeds.xFollowing.pages[0].items = [];
    assert.throws(() => convert(bundle), /X Following unavailable/);
  }
  const empty = fixture(); empty.feeds.xFollowing.pages[0].items = [];
  assert.throws(() => convert(empty), /0 usable/);
  const missing = fixture(); delete missing.feeds.xFollowing;
  assert.throws(() => convert(missing), /attempt is required/);
  const stale = fixture(); stale.feeds.xFollowing.pages[0].items[0].publishedAt = '2026-10-12T12:00:00Z';
  assert.throws(() => convert(stale), /0 usable/);
});

test('capture timestamp fixes the window; unknown dates stay explicitly uncertain', () => {
  const bundle = fixture();
  bundle.feeds.xFollowing.pages[0].items.push(post('old', { url: 'https://x.com/synthetic/status/3', publishedAt: '2026-10-12T12:00:00Z' }));
  bundle.feeds.xFollowing.pages[0].items.push(post('4', { publishedAt: null }));
  const collection = convert(bundle);
  assert.equal(collection.collectedAt, capturedAt);
  assert.equal(collection.coverage.window.end, bundle.startedAt);
  assert.equal(collection.coverage.window.start, '2026-10-15T00:50:00.000Z');
  assert.equal(collection.date, '2026-10-17');
  assert.deepEqual(collection.sources.xFollowing.map(value => value.url), ['https://x.com/synthetic/status/1', 'https://x.com/synthetic/status/4']);
  assert.ok(collection.warnings.some(warning => warning.includes('lack exact dates')));
});

test('Karpathy attempt is mandatory and its failure remains explicit but additive', () => {
  const missing = fixture(); delete missing.feeds.karpathy;
  assert.throws(() => convert(missing), /karpathy attempt/);
  const bundle = fixture();
  bundle.feeds.karpathy = { status: 'login_required', pages: [{ evidenceId: 'karpathy', items: [] }] };
  bundle.evidence[1].url = 'https://x.com/i/flow/login';
  const collection = convert(bundle);
  assert.equal(collection.checks.karpathy.available, false);
  assert.equal(collection.checks.karpathy.status, 'login_required');
  assert.ok(collection.warnings.some(warning => warning.includes('karpathy unavailable')));
});

test('bounded Karpathy source keeps the latest ten observed dated posts', () => {
  const bundle = fixture();
  bundle.feeds.karpathy.pages[0].items = Array.from({ length: 12 }, (_, i) => post(String(i + 10), { publishedAt: `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z` }));
  const collection = convert(bundle);
  assert.equal(collection.stats.karpathy, 10);
  assert.equal(collection.sources.karpathy[0].publishedAt, '2026-10-12T12:00:00.000Z');
  assert.ok(collection.warnings.some(warning => warning.includes('capped at 10')));
});

test('source URLs, evidence IDs, timestamps, active tab and failure states are validated', () => {
  const cases = [
    bundle => { bundle.evidence[0].url = 'https://unrelated.invalid/home'; },
    bundle => { bundle.feeds.xFollowing.pages[0].evidenceId = 'missing'; },
    bundle => { bundle.feeds.xFollowing.pages[0].items[0].url = 'javascript:alert(1)'; },
    bundle => { bundle.feeds.xFollowing.pages[0].items[0].url = 'https://user:secret@x.com/synthetic/status/1'; },
    bundle => { bundle.evidence[0].capturedAt = '2026-10-15T01:00:00Z'; },
    bundle => { bundle.startedAt = '2026-10-16T01:00:00Z'; },
    bundle => { bundle.feeds.xFollowing.view = 'for_you'; },
    bundle => { bundle.feeds.karpathy.status = 'login_required'; },
    bundle => { bundle.evidence[0].url = 'https://x.com/i/flow/login'; },
  ];
  for (const change of cases) { const bundle = fixture(); change(bundle); assert.throws(() => convert(bundle)); }
});

test('official articles and configured notes preserve evidence and enforce source limits', () => {
  const bundle = fixture();
  bundle.blogs = [{ blog: 'Anthropic Engineering', url: 'https://www.anthropic.com/engineering/synthetic', text: 'Synthetic article', evidenceId: 'blog' }];
  bundle.evidence.push(evidence('blog', bundle.blogs[0].url));
  const profile = config.xiaohongshuProfiles[0];
  bundle.evidence.push(evidence('profile', profile.url));
  const notes = [1, 2, 3].map(i => ({ url: `https://www.xiaohongshu.com/explore/synthetic${i}`, text: 'Synthetic note', publishedAt: `2026-10-${String(10 + i)}T12:00:00Z`, evidenceId: `note-${i}` }));
  for (const note of notes) bundle.evidence.push(evidence(note.evidenceId, note.url));
  bundle.xiaohongshu = [{ profileId: profile.profileId, evidenceId: 'profile', notes }];
  const collection = convert(bundle);
  assert.equal(collection.stats.blogs, 1);
  assert.equal(collection.stats.xiaohongshu, 2);
  assert.equal(collection.sources.xiaohongshu[0].notes[0].url, notes[2].url);
  assert.ok(collection.warnings.some(warning => warning.includes('capped at 2')));
  bundle.blogs[0].url = 'https://unrelated.invalid/synthetic';
  assert.throws(() => convert(bundle), /Evidence URL/);
});

test('imported false verification flags cannot become semantic verification', () => {
  const bundle = fixture();
  bundle.feeds.xFollowing.pages[0].items[0].verified = true;
  bundle.feeds.xFollowing.pages[0].items[0].semanticallyVerified = true;
  const value = convert(bundle).sources.xFollowing[0];
  assert.equal(value.verified, undefined);
  assert.equal(value.semanticallyVerified, undefined);
  assert.equal(value.evidenceStatus, 'browser_observed_not_independently_verified');
});

test('evidence hashing rejects tampering, missing files and path/symlink escapes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'evidence'));
  const bundle = fixture();
  for (const entry of bundle.evidence) fs.writeFileSync(path.join(dir, entry.path), screenshot);
  assert.equal(verifyEvidenceFiles(bundle, dir), true);
  fs.writeFileSync(path.join(dir, bundle.evidence[0].path), 'tampered');
  assert.throws(() => verifyEvidenceFiles(bundle, dir), /hash mismatch/);
  bundle.evidence[0].path = '../escape.png';
  assert.throws(() => verifyEvidenceFiles(bundle, dir), /inside the artifact/);
  bundle.evidence[0].path = 'evidence/missing.png';
  assert.throws(() => verifyEvidenceFiles(bundle, dir), /ENOENT/);
  fs.symlinkSync('/etc/hostname', path.join(dir, 'evidence/escape.png'));
  bundle.evidence[0].path = 'evidence/escape.png';
  assert.throws(() => verifyEvidenceFiles(bundle, dir), /escaped/);
});

test('offline CLI imports verified fixtures then composes, with network forbidden', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-import-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'evidence'));
  const bundle = fixture();
  for (const entry of bundle.evidence) fs.writeFileSync(path.join(dir, entry.path), screenshot);
  const artifactFile = path.join(dir, 'browser-capture.json');
  const output = path.join(dir, 'sources.json');
  const configFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: path.join(dir, 'data') }));
  const prompt = path.join(dir, 'prompt.md');
  fs.writeFileSync(artifactFile, JSON.stringify(bundle));
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  globalThis.WebSocket = class { constructor() { throw new Error('browser connection forbidden'); } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.WebSocket = previousWebSocket; });
  const result = await main(['import-browser', '--artifacts', artifactFile, '--out', output, '--config', configFile]);
  assert.equal(result.status, 'browser_artifacts_imported');
  assert.equal(result.stats.xFollowing, 1);
  const composed = await main(['compose-input', '--sources', output, '--out', prompt]);
  assert.equal(composed.status, 'prompt_written');
  assert.ok(fs.readFileSync(prompt, 'utf8').includes('SYNTHETIC'));
  await assert.rejects(main(['import-browser', '--artifacts', artifactFile, '--out', output, '--config', configFile]), /EEXIST/);
});

test('empty artifact input produces no collection file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-empty-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'empty.json');
  const output = path.join(dir, 'sources.json');
  fs.writeFileSync(input, JSON.stringify({ schemaVersion: 1, transport: 'gos-supported-browser', evidence: [] }));
  await assert.rejects(main(['import-browser', '--artifacts', input, '--out', output]), /evidence is required/);
  assert.equal(fs.existsSync(output), false);
});

test('required Following failure is also blocked at composition and Lark is disabled by default', () => {
  const collection = convert(fixture());
  collection.checks.xFollowing = { status: 'login_required', available: false };
  assert.throws(() => composePrompt(collection), /X Following is unavailable/);
  const good = convert(fixture());
  const markdown = `# X AI 日报 ${good.date}\n${good.digestMarker}\n## Frameworks / Infra\n- Synthetic. https://x.com/synthetic/status/1\n## Breakthrough Research\nNone\n## Applications / Products\nNone\n## 差异补充\nFixture only\n`;
  const defaults = JSON.parse(fs.readFileSync(new URL('../config/runtime.example.json', import.meta.url), 'utf8'));
  assert.equal(defaults.lark.enabled, false);
  assert.equal(defaults.lark.userId, null);
  assert.throws(() => prepareDelivery(markdown, good, defaults.lark), /Lark delivery is disabled/);
});

const watchRuntime = watchProfiles => makeRuntime({ sources: { ...config, watchProfiles } }, { runId: 'synthetic-watch-test' });
const karpathyProfile = { handle: 'karpathy', name: 'Karpathy', required: true, latest: 10 };
const second = (required, latest = 3) => ({ handle: 'synthetic_two', name: 'Synthetic Two', required, latest });

test('default watch configuration mirrors the karpathy compatibility fields', () => {
  assert.deepEqual(runtime.sources.watchProfiles, [karpathyProfile]);
  const collection = convert(fixture());
  assert.deepEqual(collection.sources.watchProfiles, [{ handle: 'karpathy', name: 'Karpathy', required: true, items: collection.sources.karpathy }]);
  assert.equal(collection.stats.watchProfiles, 1);
  assert.equal(collection.stats.karpathy, 1);
  assert.deepEqual(collection.checks.watch.karpathy, collection.checks.karpathy);
});

test('an optional watch profile missing from the bundle warns; a required one throws', () => {
  const optional = collectionFromBrowserArtifacts(watchRuntime([karpathyProfile, second(false)]), fixture());
  assert.ok(optional.warnings.includes('synthetic_two was not captured in this run'));
  assert.deepEqual(optional.checks.watch.synthetic_two, { attempted: false });
  assert.deepEqual(optional.sources.watchProfiles.map(p => [p.handle, p.items.length]), [['karpathy', 1], ['synthetic_two', 0]]);
  assert.throws(() => collectionFromBrowserArtifacts(watchRuntime([karpathyProfile, second(true)]), fixture()), /synthetic_two attempt is required/);
});

test('a captured watch profile uses its own evidence page and latest cap', () => {
  const bundle = fixture();
  bundle.evidence.push(evidence('two', 'https://x.com/synthetic_two'));
  bundle.feeds.synthetic_two = { status: 'ok', pages: [{ evidenceId: 'two', items: Array.from({ length: 5 }, (_, i) => post(String(i + 50), { publishedAt: `2026-10-0${i + 1}T12:00:00Z` })) }] };
  const collection = collectionFromBrowserArtifacts(watchRuntime([karpathyProfile, second(true)]), bundle);
  assert.equal(collection.checks.watch.synthetic_two.items, 3);
  assert.equal(collection.sources.watchProfiles[1].items[0].publishedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(collection.stats.watchProfiles, 4);
  assert.ok(collection.warnings.includes('Synthetic Two capped at 3 observed posts'));
  bundle.evidence.at(-1).url = 'https://x.com/karpathy';
  assert.throws(() => collectionFromBrowserArtifacts(watchRuntime([karpathyProfile, second(true)]), bundle), /Evidence URL does not match/);
});

test('without a karpathy profile the compatibility fields are empty and its feed is not required', () => {
  const bundle = fixture();
  delete bundle.feeds.karpathy;
  const collection = collectionFromBrowserArtifacts(watchRuntime([]), bundle);
  assert.deepEqual(collection.sources.karpathy, []);
  assert.deepEqual(collection.sources.watchProfiles, []);
  assert.equal(collection.stats.karpathy, 0);
  assert.equal(collection.stats.watchProfiles, 0);
  assert.deepEqual(collection.checks.karpathy, { attempted: false });
});
