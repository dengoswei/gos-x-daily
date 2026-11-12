import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { macHome, sentId, profile, userId, chatId } from './helpers/mac-fixture.mjs';
import { effectiveSources } from '../source-config.mjs';

const history = f => path.join(f.ledger, 'published-urls.jsonl');

test('publish sends once through the pinned sender, records the full ledger and never resends', t => {
  const f = macHome(t);
  const publish = ['publish', '--publication', f.publication];
  const r = f.local(publish);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'sent_and_verified');
  assert.equal(r.json.messageId, sentId);
  assert.equal(r.json.publishedUrlsRecorded, true);
  assert.deepEqual(f.calls().map(c => c.op), ['auth', '+chat-messages-list', 'auth', '+messages-send', '+messages-mget']);
  assert.deepEqual(f.ledgerFiles(), ['.attempt.json', '.invoked.json', '.plan.json', '.readback.json', '.receipt.json']);
  const plan = JSON.parse(fs.readFileSync(f.prefix+'.plan.json', 'utf8'));
  const attempt = JSON.parse(fs.readFileSync(f.prefix+'.attempt.json', 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(f.prefix+'.receipt.json', 'utf8'));
  assert.equal(attempt.planSha256, plan.planSha256);
  assert.deepEqual([receipt.status, receipt.messageId, receipt.idempotencyKey], ['api_accepted_not_read_confirmed', sentId, f.key]);
  assert.equal(JSON.parse(fs.readFileSync(f.prefix+'.invoked.json', 'utf8')).planSha256, plan.planSha256);
  assert.deepEqual(fs.readFileSync(history(f), 'utf8').trim().split('\n').map(line => JSON.parse(line).idempotencyKey), [f.key]);
  assert.equal(f.sends().length, 1);
  const again = f.local(publish);
  assert.equal(again.json.status, 'already_accepted');
  assert.equal(f.local(['status', '--date', f.date]).json.messageId, sentId);
  assert.equal(f.local(['start-run']).json.status, 'already_accepted');
  assert.equal(f.local(['reconcile', '--date', f.date]).json.status, 'sent_and_verified');
  assert.equal(f.sends().length, 1);
  assert.equal(fs.readFileSync(history(f), 'utf8').trim().split('\n').length, 1);
});

test('a same-day report already in recipient history blocks publish before any reservation', t => {
  const f = macHome(t);
  f.stubWith({ history: [{ message_id: 'om_syntheticprior', chat_id: chatId, sender: { id: profile }, content: `X AI 日报 ${f.date}` }] });
  const r = f.local(['publish', '--publication', f.publication]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { status: 'already_present_requires_reconciliation', messageIds: ['om_syntheticprior'], date: f.date });
  assert.deepEqual(f.ledgerFiles(), []);
  assert.equal(f.sends().length, 0);
});

test('a failing CLI send retains an uncertain attempt that blocks every retry and new run', t => {
  const f = macHome(t);
  f.stubWith({ send: 'fail' });
  const publish = ['publish', '--publication', f.publication];
  const r = f.local(publish);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Delivery outcome uncertain; attempt retained/);
  assert.deepEqual(f.ledgerFiles(), ['.attempt.json', '.invoked.json', '.plan.json', '.uncertain.json']);
  assert.equal(JSON.parse(fs.readFileSync(f.prefix+'.uncertain.json', 'utf8')).status, 'uncertain_stop_reconcile');
  assert.equal(fs.existsSync(history(f)), false);
  f.stubWith({});
  assert.match(f.local(publish).stderr, /Prior delivery attempt\/receipt exists/);
  assert.match(f.local(['start-run']).stderr, /Prior delivery attempt\/receipt exists/);
  assert.equal(f.local(['status', '--date', f.date]).json.status, 'attempt_requires_reconciliation');
  assert.equal(f.local(['reconcile', '--date', f.date]).json.status, 'attempt_requires_reconciliation');
  assert.equal(f.sends().length, 1);
  assert.deepEqual(f.ledgerFiles(), ['.attempt.json', '.invoked.json', '.plan.json', '.uncertain.json']);
});

test('publish refuses a changed identity, non-native transport, foreign ledger or pre-cutover date before reserving', t => {
  const f = macHome(t);
  f.stubWith({ auth: { appId: profile, brand: 'feishu', userOpenId: 'ou_' + 'b'.repeat(32), identities: { bot: { available: true, status: 'ready' } } } });
  assert.match(f.local(['publish', '--publication', f.publication]).stderr, /identity mismatch/);
  f.stubWith({});
  const original = JSON.parse(fs.readFileSync(f.publication, 'utf8'));
  f.write(f.publication, { ...original, snapshotInputs: { ...original.snapshotInputs, transport: undefined } });
  assert.match(f.local(['publish', '--publication', f.publication]).stderr, /native post transport/);
  f.write(f.publication, { ...original, ledgerDir: path.join(f.home, 'other-ledger') });
  assert.match(f.local(['publish', '--publication', f.publication]).stderr, /must use this Mac ledger/);
  f.write(f.publication, original);
  const authority = JSON.parse(fs.readFileSync(path.join(f.home, 'mac-authority.json'), 'utf8'));
  f.write('mac-authority.json', { ...authority, notBeforeDate: '2999-01-01' });
  assert.match(f.local(['publish', '--publication', f.publication]).stderr, /Mac cutover incomplete/);
  assert.deepEqual(f.ledgerFiles(), []);
  assert.equal(f.sends().length, 0);
});

test('doctor verifies pins, bot identity and recipient without sending', t => {
  const f = macHome(t);
  const r = f.local(['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'dependencies_verified');
  assert.deepEqual(r.json.identity, { appId: profile, bot: 'ready' });
  assert.equal(r.json.readyForProduction, true);
  assert.deepEqual(f.calls().map(c => c.op), ['auth', '+chat-messages-list']);
  f.stubWith({ auth: { appId: profile, brand: 'feishu', userOpenId: userId, identities: { bot: { available: true, status: 'expired' } } } });
  assert.match(f.local(['doctor']).stderr, /identity mismatch/);
  fs.appendFileSync(path.join(f.home, 'cli.mjs'), '// changed\n');
  assert.match(f.local(['doctor']).stderr, /Pinned dependency changed/);
  assert.equal(f.calls().length, 3);
  assert.equal(f.sends().length, 0);
});

test('start-run freezes the roster in a new run directory and refuses unsafe environments or cutover', t => {
  const f = macHome(t);
  const r = f.local(['start-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'run_created');
  assert.equal(path.dirname(r.json.run), path.join(f.home, 'runs'));
  assert.ok(path.basename(r.json.run).startsWith(f.date+'-'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.json.run, 'sources.frozen.json'), 'utf8')),
    effectiveSources(JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(f.home, 'sources.local.json'), 'utf8'))));
  const runtime = JSON.parse(fs.readFileSync(path.join(r.json.run, 'runtime.json'), 'utf8'));
  assert.equal(runtime.sourcesFile, path.join(r.json.run, 'sources.frozen.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.json.run, 'run.json'), 'utf8')).date, f.date);
  assert.notEqual(f.local(['start-run']).json.run, r.json.run);
  assert.deepEqual(f.calls(), []);
  const env = f.env;
  env.LARK_SYNTHETIC_OVERRIDE = '1';
  assert.match(f.local(['start-run']).stderr, /Unexpected credential\/configuration environment override/);
  delete env.LARK_SYNTHETIC_OVERRIDE;
  const authority = JSON.parse(fs.readFileSync(path.join(f.home, 'mac-authority.json'), 'utf8'));
  f.write('mac-authority.json', { ...authority, remoteScheduleDisabled: false });
  assert.match(f.local(['start-run']).stderr, /Mac cutover incomplete/);
  assert.equal(fs.readdirSync(path.join(f.home, 'runs')).length, 2);
});
