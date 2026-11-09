import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareReissueTransportPlan, sendReissueTransport, writeReissueTransportPlan } from '../reissue-transport.mjs';
import { sendDelivery } from '../digest.mjs';
import { transportFixture, write } from './helpers/reissue-transport-fixture.mjs';
const good = user => ({ status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'synthetic-message', receive_id: user } }) });
const prepare = f => prepareReissueTransportPlan(f.bindingPath, f.pin());

test('synthetic full transport: durable attempt before exact fixed args, isolated env, durable receipt', t => {
  const f = transportFixture(t), p = prepare(f), old = fs.readdirSync(f.ledger).sort(); let calls = 0;
  const out = sendReissueTransport(p, { ...f.options(p), spawnSyncImpl: (exe, args, options) => {
    calls++; assert.equal(exe, f.runtime.executable); assert.deepEqual(args, ['im', '+messages-send', '--as', 'bot', '--user-id', f.target.userId, '--markdown', f.payload, '--idempotency-key', f.key]);
    assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), true); const attempt = JSON.parse(fs.readFileSync(f.newPrefix + '.attempt.json')); assert.equal(attempt.planSha256, p.planSha256); assert.equal(attempt.target.appId, 'cli_SYNTHETIC');
    assert.equal(options.shell, false); assert.equal(options.timeout, 60000); assert.equal(options.env.LARKSUITE_CLI_APP_SECRET, undefined); assert.deepEqual(options.env, f.runtime.environment);
    return good(f.target.userId);
  } });
  assert.equal(calls, 1); assert.equal(out.status, 'sent_api_accepted'); assert.equal(out.readConfirmed, false); assert.equal(out.publishedUrlsRecorded, false);
  assert.equal(fs.existsSync(f.newPrefix + '.receipt.json'), true); assert.equal(fs.existsSync(path.join(f.ledger, 'published-urls.jsonl')), false);
  for (const name of old) assert.equal(fs.existsSync(path.join(f.ledger, name)), true);
  assert.throws(() => prepare(f), /Prior delivery/);
});
test('both explicit send gates required; invalid flags never create attempt or subprocess', t => {
  const f = transportFixture(t), p = prepare(f);
  for (const o of [{ authorized: false }, { env: {} }]) assert.throws(() => sendReissueTransport(p, { ...f.options(p), ...o, spawnSyncImpl: () => assert.fail('must not invoke') }), /authorization/);
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('external binding and plan pins cannot be omitted or changed', t => {
  const f = transportFixture(t), p = prepare(f);
  assert.throws(() => prepareReissueTransportPlan(f.bindingPath), /expected hash/);
  assert.throws(() => sendReissueTransport(p, { ...f.options(p), expectedPlanSha256: '1'.repeat(64) }), /expected transport plan hash/);
});
test('generic daily gate cannot accept reissue transport plan and reissue cannot accept daily', t => {
  const f = transportFixture(t), p = prepare(f);
  assert.throws(() => sendDelivery(p, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, target: { enabled: true }, spawnSyncImpl: () => assert.fail() }), /schema-2/);
  assert.throws(() => sendReissueTransport({ schemaVersion: 2 }, f.options(p)), /generic daily plans are rejected/);
});
test('body/prefix tamper fails before attempt even if prepared plan is untouched', t => {
  const f = transportFixture(t), p = prepare(f); fs.appendFileSync(f.binding.payloadPath, '\n');
  assert.throws(() => sendReissueTransport(p, f.options(p)), /Exact final payload: bound file changed/); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('plan target/key/runtime edits are rejected before attempt', t => {
  const f = transportFixture(t), p = prepare(f); p.idempotencyKey += '-retry';
  assert.throws(() => sendReissueTransport(p, f.options(p)), /Transport plan or any bound/); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('wrong runtime target cannot be repinned into this artifact request', t => {
  const f = transportFixture(t); f.runtime.target.userId = `ou_${'b'.repeat(32)}`; f.repinRuntime(); assert.throws(() => prepare(f), /Runtime target differs/);
});
test('wrapper/native/dependency changes block before attempt', t => {
  const f = transportFixture(t), p = prepare(f); fs.appendFileSync(f.binary, '!'); assert.throws(() => sendReissueTransport(p, f.options(p)), /Runtime dependency: bound file changed/); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('ambient credential/startup/identity environment overrides cannot be configured', t => {
  const f = transportFixture(t); f.runtime.environment.NODE_OPTIONS = '--import=bad'; f.repinRuntime(); assert.throws(() => prepare(f), /Ambient credentials/);
});
test('source manifest must describe actual executing code and hashes', t => {
  const f = transportFixture(t); f.manifest.files[0].sha256 = '2'.repeat(64); f.repinManifest(); assert.throws(() => prepare(f), /Reviewed source module: bound file changed/);
});
test('source manifest cannot omit a module', t => {
  const f = transportFixture(t); f.manifest.files.pop(); f.repinManifest(); assert.throws(() => prepare(f), /every core/);
});
test('disabled runtime and unverified identity fail closed', t => {
  const f = transportFixture(t); f.runtime.enabled = false; f.repinRuntime(); assert.throws(() => prepare(f), /enabled runtime/);
  f.runtime.enabled = true; f.runtime.verification.botIdentityVerified = false; f.repinRuntime(); assert.throws(() => prepare(f), /bot\/recipient/);
});
test('stale or future identity verification requires fresh read-only check', t => {
  const f = transportFixture(t); f.runtime.verification.verifiedAt = new Date(Date.now() - 25 * 3600000).toISOString(); f.repinRuntime(); assert.throws(() => prepare(f), /last 24 hours/);
  f.runtime.verification.verifiedAt = new Date(Date.now() + 120000).toISOString(); f.repinRuntime(); assert.throws(() => prepare(f), /last 24 hours/);
});
test('identity evidence file cannot change behind a pinned runtime', t => {
  const f = transportFixture(t); fs.appendFileSync(f.runtime.verification.evidencePath, '!'); assert.throws(() => prepare(f), /identity verification evidence: bound file changed/);
});
for (const suffix of ['.attempt.json', '.receipt.json', '.uncertain.json']) test(`existing ${suffix} never invokes subprocess`, t => {
  const f = transportFixture(t), p = prepare(f); write(f.newPrefix + suffix, { synthetic: true }); assert.throws(() => sendReissueTransport(p, { ...f.options(p), spawnSyncImpl: () => assert.fail('must not invoke') }), /Prior delivery/);
});
for (const [name, result] of Object.entries({ exit: { status: 1, stdout: 'SYNTHETIC_SECRET' }, timeout: { status: null, signal: 'SIGTERM' }, error: { status: null, error: new Error('SYNTHETIC_SECRET') }, missing: { status: 0, stdout: '{}' }, malformed: { status: 0, stdout: 'not json' }, falseOk: { status: 0, stdout: '{"ok":"true","data":{"message_id":"bad"}}' }, missingId: { status: 0, stdout: '{"ok":true,"data":{}}' }, wrongTarget: good(`ou_${'b'.repeat(32)}`) })) test(`uncertain ${name}: one invocation, durable stop, no secret diagnostics`, t => {
  const f = transportFixture(t), p = prepare(f); let calls = 0;
  assert.throws(() => sendReissueTransport(p, { ...f.options(p), spawnSyncImpl: () => { calls++; return result; } }), error => /outcome uncertain/.test(error.message) && !error.message.includes('SYNTHETIC_SECRET'));
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), true); assert.equal(fs.existsSync(f.newPrefix + '.uncertain.json'), true); assert.equal(fs.existsSync(f.newPrefix + '.receipt.json'), false); assert.throws(() => prepare(f), /Prior delivery/);
});
test('thrown subprocess error retains attempt and uncertain marker without retry', t => {
  const f = transportFixture(t), p = prepare(f); assert.throws(() => sendReissueTransport(p, { ...f.options(p), spawnSyncImpl: () => { throw new Error('SYNTHETIC_SECRET'); } }), /outcome uncertain/); assert.equal(fs.existsSync(f.newPrefix + '.uncertain.json'), true);
});
test('receipt persistence failure remains uncertain and cannot retry', t => {
  const f = transportFixture(t), p = prepare(f);
  assert.throws(() => sendReissueTransport(p, { ...f.options(p), spawnSyncImpl: () => { fs.mkdirSync(f.newPrefix + '.receipt.json'); return good(f.target.userId); } }), /outcome uncertain/); assert.equal(fs.existsSync(f.newPrefix + '.uncertain.json'), true);
});
test('durable plan uses exclusive creation and never overwrites an earlier plan', t => {
  const f = transportFixture(t), p = prepare(f), file = path.join(f.root, 'transport-plan.json'); writeReissueTransportPlan(file, p); assert.deepEqual(JSON.parse(fs.readFileSync(file)), p); assert.throws(() => writeReissueTransportPlan(file, p), /EEXIST/);
});
