import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSyntheticReviewedFixture } from './helpers/review-fixture.mjs';
import { createReviewInput } from '../review.mjs';
import { larkMarkdown, prepareDelivery, sendDelivery } from '../digest.mjs';
import { initializeDeliveryLedger, inspectDeliveryLedger, recentPublishedUrls, recordDeliveryAttempt, recordPublishedUrls } from '../delivery-ledger.mjs';
import { main } from '../cli.mjs';

const authorized = target => ({ authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, target });
const planFor = f => prepareDelivery(f.markdown, f.collection, f.target, f.publication);

test('legacy no-review and missing-ledger preparation fail closed', t => {
  const f = createSyntheticReviewedFixture(t);
  assert.throws(() => prepareDelivery(f.markdown, f.collection, f.target), /review/);
  fs.rmSync(f.ledgerDir, { recursive: true });
  assert.throws(() => planFor(f), /ENOENT/);
});

test('preparation requires a dispositions ledger and an approval bound to its exact bytes', t => {
  const f = createSyntheticReviewedFixture(t);
  const { dispositionsPath, ...withoutLedger } = f.snapshotInputs;
  assert.throws(() => prepareDelivery(f.markdown, f.collection, f.target, { ...f.publication, snapshotInputs: withoutLedger }), /dispositionsPath is required/);
  const file = path.join(f.rootDir, dispositionsPath);
  const ledger = JSON.parse(fs.readFileSync(file));
  ledger.items[0].section = 'Frameworks / Infra ';
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.throws(() => planFor(f), /stale|tampered/);
  fs.writeFileSync(file, JSON.stringify({ ...ledger, items: [] }));
  assert.throws(() => planFor(f), /Missing disposition/);
});

test('pending or failed review cannot prepare a send plan', t => {
  const f = createSyntheticReviewedFixture(t);
  const file = path.join(f.rootDir, f.reviewPath);
  fs.writeFileSync(file, JSON.stringify(createReviewInput(f.options)));
  assert.throws(() => planFor(f), /approved/);
  f.review.status = 'failed'; fs.writeFileSync(file, JSON.stringify(f.review));
  assert.throws(() => planFor(f), /approved/);
});

test('every send revalidates exact draft, sources, materials, evidence and review bytes', t => {
  for (const file of ['digest.md', 'sources.json', 'dispositions.json', 'materials.json', 'evidence/source.txt', 'review.approved.json']) {
    const f = createSyntheticReviewedFixture(t), plan = planFor(f);
    fs.appendFileSync(path.join(f.rootDir, file), '\n');
    let calls = 0;
    assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: () => { calls++; } }));
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(f.ledgerDir), ['ledger.json']);
  }
});

test('modified plan payload, target, key, executable, schema or verified target is rejected before process', t => {
  const changes = [p => { p.args[7] += ' changed'; }, p => { p.args[5] = 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; },
    p => { p.args[9] += '-retry'; }, p => { p.executable = '/bin/sh'; }, p => { p.schemaVersion = 1; },
    p => { p.planSha256 = '0'.repeat(64); }];
  for (const change of changes) {
    const f = createSyntheticReviewedFixture(t), plan = planFor(f); change(plan);
    let calls = 0;
    assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: () => { calls++; } }));
    assert.equal(calls, 0);
  }
  const f = createSyntheticReviewedFixture(t), plan = planFor(f);
  assert.throws(() => sendDelivery(plan, { ...authorized({ ...f.target, enabled: false }) }), /target/);
  assert.throws(() => sendDelivery(plan, { ...authorized({ ...f.target, userId: 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) }), /modified/);
});

test('accepted mock send durably records exactly one attempt and receipt, then blocks duplicates', t => {
  const f = createSyntheticReviewedFixture(t), plan = planFor(f);
  let calls = 0;
  const mock = (executable, args, options) => {
    calls++; assert.equal(executable, f.target.executable); assert.equal(options.shell, false);
    const entries = fs.readdirSync(f.ledgerDir);
    assert.equal(entries.filter(x => x.endsWith('.attempt.json')).length, 1);
    assert.ok(!entries.includes('published-urls.jsonl'));
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'SYNTHETIC-accepted' } }) };
  };
  const result = sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: mock });
  assert.equal(result.status, 'sent_api_accepted'); assert.equal(result.readConfirmed, false);
  assert.equal(JSON.parse(fs.readFileSync(result.receiptPath)).status, 'api_accepted_not_read_confirmed');
  assert.equal(result.publishedUrlsRecorded, true);
  const [line, ...rest] = fs.readFileSync(path.join(f.ledgerDir, 'published-urls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(JSON.parse(line)), ['date', 'idempotencyKey', 'urls', 'recordedAt']);
  assert.deepEqual(JSON.parse(line).urls, ['https://example.invalid/SYNTHETIC']);
  assert.equal(fs.statSync(path.join(f.ledgerDir, 'published-urls.jsonl')).mode & 0o777, 0o600);
  assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: mock }), /Prior delivery/);
  assert.throws(() => planFor(f), /Prior delivery/); assert.equal(calls, 1);
});

test('process exception, timeout, malformed or missing acknowledgment all retain uncertain attempts and forbid retry', t => {
  const outcomes = [() => { throw new Error('SYNTHETIC exception'); }, () => ({ error: new Error('SYNTHETIC timeout'), status: null }),
    () => ({ status: 1, stdout: '' }), () => ({ status: 0, stdout: 'not json' }),
    () => ({ status: 0, stdout: '{"ok":true}' }),
    () => ({ status: 0, stdout: '{"ok":true,"data":{"message_id":"SYNTHETIC","receive_id":"other"}}' })];
  for (const outcome of outcomes) {
    const f = createSyntheticReviewedFixture(t), plan = planFor(f);
    let calls = 0;
    assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: () => { calls++; return outcome(); } }), /uncertain/);
    assert.equal(fs.readdirSync(f.ledgerDir).filter(x => x.endsWith('.uncertain.json')).length, 1);
    assert.ok(!fs.existsSync(path.join(f.ledgerDir, 'published-urls.jsonl')));
    assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: () => { calls++; } }), /Prior delivery/);
    assert.equal(calls, 1);
  }
});

test('new recovery ledger rejects historical replay, reinitialization, and changed boundary', t => {
  const f = createSyntheticReviewedFixture(t, { notBeforeDate: '2026-10-31' });
  assert.throws(() => planFor(f), /predates/);
  assert.throws(() => initializeDeliveryLedger(f.ledgerDir, { notBeforeDate: '2026-10-30', createdBy: 'SYNTHETIC' }), /EEXIST/);
  const g = createSyntheticReviewedFixture(t), plan = planFor(g);
  const metadataPath = path.join(g.ledgerDir, 'ledger.json');
  const meta = JSON.parse(fs.readFileSync(metadataPath)); meta.createdBy = 'changed';
  fs.writeFileSync(metadataPath, JSON.stringify(meta));
  assert.throws(() => sendDelivery(plan, { ...authorized(g.target), spawnSyncImpl: () => assert.fail('No process') }), /modified/);
});

test('exclusive ledger attempt gate blocks a concurrent or interrupted second controller', t => {
  const f = createSyntheticReviewedFixture(t), plan = planFor(f);
  recordDeliveryAttempt(f.ledgerDir, { date: f.collection.date, idempotencyKey: plan.args[9], planSha256: plan.planSha256, target: plan.target });
  assert.throws(() => inspectDeliveryLedger(f.ledgerDir, { date: f.collection.date, idempotencyKey: plan.args[9] }), /Prior delivery/);
  assert.throws(() => sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: () => assert.fail('No process') }), /Prior delivery/);
});

test('ledger symlinks and corrupt metadata cannot silently create a fresh send history', t => {
  const f = createSyntheticReviewedFixture(t);
  const linked = path.join(f.rootDir, 'ledger-link'); fs.symlinkSync(f.ledgerDir, linked);
  assert.throws(() => inspectDeliveryLedger(linked, { date: f.collection.date, idempotencyKey: 'xdaily-SYNTHETIC-2026-10-30' }), /real directory/);
  fs.writeFileSync(path.join(f.ledgerDir, 'ledger.json'), '{');
  assert.throws(() => planFor(f));
  assert.equal(fs.readdirSync(f.ledgerDir).length, 1);
});

test('offline CLI creates only pending reviews, validates independent fixture, and prepares schema-2 plan without sending', async t => {
  const f = createSyntheticReviewedFixture(t);
  const publicationFile = path.join(f.rootDir, 'publication.json'), runtimeFile = path.join(f.rootDir, 'runtime.json');
  fs.writeFileSync(publicationFile, JSON.stringify(f.publication));
  fs.writeFileSync(runtimeFile, JSON.stringify({ lark: f.target }));
  const pendingFile = path.join(f.rootDir, 'review.pending.json');
  const pending = await main(['review-input', '--publication', publicationFile, '--out', pendingFile]);
  assert.equal(pending.status, 'pending_independent_review');
  assert.equal(JSON.parse(fs.readFileSync(pendingFile)).status, 'pending');
  const validation = await main(['validate-publication', '--publication', publicationFile]); assert.equal(validation.ok, true);
  const out = path.join(f.rootDir, 'plan.json');
  const result = await main(['prepare-delivery', '--sources', path.join(f.rootDir, 'sources.json'), '--digest', path.join(f.rootDir, 'digest.md'),
    '--publication', publicationFile, '--config', runtimeFile, '--out', out]);
  assert.equal(result.status, 'prepared_not_sent'); assert.equal(JSON.parse(fs.readFileSync(out)).schemaVersion, 2);
  assert.deepEqual(fs.readdirSync(f.ledgerDir), ['ledger.json']);
});

test('default recovered configuration remains disabled and describes a 48-hour horizon', async () => {
  const result = await main(['inspect-config']);
  assert.equal(result.collectionEnabled, false); assert.equal(result.sendEnabled, false);
  assert.equal(result.lark.enabled, false); assert.equal(result.lookbackHours, 48);
});

test('URL-free placeholder sections leave the render but stay in the review units', t => {
  const f = createSyntheticReviewedFixture(t);
  const render = larkMarkdown(f.markdown, f.collection, { dispositions: f.dispositions });
  assert.ok(f.markdown.includes('## Breakthrough Research') && !render.includes('Breakthrough Research') && !render.includes('No synthetic item.'));
  assert.equal(planFor(f).args[7], render);
  assert.ok(f.review.units.some(unit => unit.kind === 'main' && unit.text === 'No synthetic item.'));
  assert.ok(f.review.units.some(unit => unit.kind === 'render' && unit.text === render));
});

test('published URL history appends lines and reads back a 7-day window before the report date', t => {
  const f = createSyntheticReviewedFixture(t);
  assert.deepEqual(recentPublishedUrls(f.ledgerDir, { before: '2026-10-30' }), []);
  const record = (date, urls) => recordPublishedUrls(f.ledgerDir, { date, idempotencyKey: `xdaily-SYNTHETIC-${date}`, urls, now: `${date}T02:00:00.000Z` });
  record('2026-10-22', ['https://old.example/']);
  record('2026-10-23', ['https://edge.example/']);
  record('2026-10-29', ['https://a.example/', 'https://b.example/']);
  record('2026-10-29', ['https://a.example/']);
  record('2026-10-30', ['https://same-day.example/']);
  assert.deepEqual(recentPublishedUrls(f.ledgerDir, { before: '2026-10-30' }),
    [{ date: '2026-10-23', urls: ['https://edge.example/'] }, { date: '2026-10-29', urls: ['https://a.example/', 'https://b.example/'] }]);
  assert.deepEqual(recentPublishedUrls(f.ledgerDir, { before: '2026-10-30', days: 1 }), [{ date: '2026-10-29', urls: ['https://a.example/', 'https://b.example/'] }]);
  assert.equal(fs.readFileSync(path.join(f.ledgerDir, 'published-urls.jsonl'), 'utf8').trim().split('\n').length, 5);
  assert.throws(() => record('2026-13-01', []), /date/);
  fs.appendFileSync(path.join(f.ledgerDir, 'published-urls.jsonl'), '{broken\n');
  assert.throws(() => recentPublishedUrls(f.ledgerDir, { before: '2026-10-30' }), /Corrupt/);
});

test('published URL history rejects a symlinked history file', t => {
  const f = createSyntheticReviewedFixture(t);
  const elsewhere = path.join(f.rootDir, 'elsewhere.jsonl'); fs.writeFileSync(elsewhere, '');
  fs.symlinkSync(elsewhere, path.join(f.ledgerDir, 'published-urls.jsonl'));
  assert.throws(() => recentPublishedUrls(f.ledgerDir, { before: '2026-10-30' }), /regular files/);
  assert.throws(() => recordPublishedUrls(f.ledgerDir, { date: '2026-10-30', idempotencyKey: 'xdaily-SYNTHETIC', urls: [] }), /ELOOP/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '');
});

test('repeated URLs from the ledger history are reported in the plan, not rejected', t => {
  const f = createSyntheticReviewedFixture(t);
  recordPublishedUrls(f.ledgerDir, { date: '2026-10-28', idempotencyKey: 'xdaily-SYNTHETIC-2026-10-28', urls: ['https://example.invalid/SYNTHETIC'] });
  const plan = planFor(f);
  assert.equal(plan.status, 'prepared_not_sent');
  assert.deepEqual(plan.validation.repeatedUrls, [{ url: 'https://example.invalid/SYNTHETIC', date: '2026-10-28' }]);
  assert.deepEqual(plan.publishedUrls, ['https://example.invalid/SYNTHETIC']);
});

test('a history write failure after acceptance is a warning on the result, never an exception', t => {
  const f = createSyntheticReviewedFixture(t), plan = planFor(f);
  const mock = () => {
    fs.mkdirSync(path.join(f.ledgerDir, 'published-urls.jsonl'));
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'SYNTHETIC-accepted' } }) };
  };
  const result = sendDelivery(plan, { ...authorized(f.target), spawnSyncImpl: mock });
  assert.equal(result.status, 'sent_api_accepted'); assert.equal(result.publishedUrlsRecorded, false);
  assert.match(result.publishedUrlsWarning, /Published URL history not recorded/);
  assert.equal(JSON.parse(fs.readFileSync(result.receiptPath)).status, 'api_accepted_not_read_confirmed');
  assert.equal(fs.readdirSync(f.ledgerDir).filter(x => x.endsWith('.uncertain.json')).length, 0);
});

test('compose-input reads recent published URLs from an explicit ledger directory', async t => {
  const f = createSyntheticReviewedFixture(t);
  recordPublishedUrls(f.ledgerDir, { date: '2026-10-29', idempotencyKey: 'xdaily-SYNTHETIC-2026-10-29', urls: ['https://example.invalid/SYNTHETIC'] });
  const sources = path.join(f.rootDir, 'sources.json');
  const plain = path.join(f.rootDir, 'plain.md'), withHistory = path.join(f.rootDir, 'history.md');
  await main(['compose-input', '--sources', sources, '--out', plain]);
  await main(['compose-input', '--sources', sources, '--published-history', f.ledgerDir, '--out', withHistory]);
  assert.doesNotMatch(fs.readFileSync(plain, 'utf8'), /<published_recently>\n\d{4}-/);
  assert.match(fs.readFileSync(withHistory, 'utf8'), /<published_recently>\n2026-10-29  https:\/\/example\.invalid\/SYNTHETIC\n/);
  await assert.rejects(main(['compose-input', '--sources', sources, '--published-history', '--out', path.join(f.rootDir, 'x.md')]), /Missing --published-history/);
});
