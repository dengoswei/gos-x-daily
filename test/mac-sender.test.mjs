import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareDelivery, sendDelivery } from '../digest.mjs';
import { SENDER_BUDGET } from '../deployment/mac/mac-sender.mjs';
import { macHome, sender, userId } from './helpers/mac-fixture.mjs';

const reserve = (f, plan = f.directPlan(), attempt = { planSha256: plan.planSha256 }) => {
  f.write(f.prefix+'.plan.json', plan);
  if (attempt) f.write(f.prefix+'.attempt.json', attempt);
  return plan;
};
const direct = (f, args, env = { X_DAILY_ALLOW_SEND: '1' }) => spawnSync(sender, args, { encoding: 'utf8', env: { ...f.env, ...env } });
// Budget injection is test-only; the executable entry always uses SENDER_BUDGET.
const budgeted = (f, args, budget) => {
  const started = Date.now();
  const code = `const m=await import(${JSON.stringify(new URL('../deployment/mac/mac-sender.mjs', import.meta.url).href)});
try { process.exitCode=m.runSender(${JSON.stringify(args)},{budget:${JSON.stringify(budget)},startedAt:Date.now()}); } catch(e) { console.error(e.message); process.exitCode=1; }`;
  const r = spawnSync(f.node, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...f.env, X_DAILY_ALLOW_SEND: '1' } });
  return { ...r, elapsed: Date.now() - started };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('sender rejects every unexpected argument shape before reading the ledger or spawning the CLI', t => {
  const f = macHome(t);
  const args = reserve(f).args;
  for (const bad of [args.slice(0, 9), [...args, 'extra'], args.with(1, '+messages-reply'), args.with(3, 'user'), args.with(5, 'ou_' + 'b'.repeat(32)),
    args.with(6, '--content'), args.with(8, '--uuid'), args.with(9, 'xdaily-other-' + f.date), args.with(9, `xdaily-gos-daily-${f.date}-revision`)]) {
    const r = direct(f, bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unexpected sender arguments/);
  }
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.prefix+'.invoked.json'), false);
});

test('sender requires an exact durable plan/attempt reservation and send authorization', t => {
  const f = macHome(t);
  const plan = reserve(f, undefined, null);
  assert.match(direct(f, plan.args).stderr, /ENOENT/); // missing attempt
  reserve(f, plan, { planSha256: 'other-plan' });
  assert.match(direct(f, plan.args).stderr, /Missing exact durable send reservation/);
  reserve(f, plan);
  assert.match(direct(f, plan.args.with(7, plan.args[7]+'altered')).stderr, /Missing exact durable send reservation/);
  assert.match(direct(f, plan.args, {}).stderr, /Missing exact durable send reservation/);
  reserve(f, { ...plan, transport: { ...plan.transport, content: plan.transport.content+' ' } });
  assert.match(direct(f, plan.args).stderr, /does not match reviewed transport/);
  fs.rmSync(f.prefix+'.plan.json');
  assert.match(direct(f, plan.args).stderr, /ENOENT/); // missing plan
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.prefix+'.invoked.json'), false);
});

test('sender verifies identity before the exclusive gate, sends once natively and refuses a replay', t => {
  const f = macHome(t);
  const plan = reserve(f);
  f.stubWith({ auth: { appId: 'cli_' + 'b'.repeat(16), brand: 'feishu', userOpenId: userId, identities: { bot: { available: true, status: 'ready' } } } });
  assert.match(direct(f, plan.args).stderr, /identity mismatch/);
  assert.equal(fs.existsSync(f.prefix+'.invoked.json'), false);
  f.stubWith({});
  const sent = direct(f, plan.args);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).data.message_id, 'om_syntheticsent');
  assert.deepEqual(f.calls().map(c => c.op), ['auth', 'auth', '+messages-send']);
  const [send] = f.sends();
  assert.deepEqual(send.args.slice(0, 2), ['--profile', 'cli_' + 'a'.repeat(16)]);
  assert.deepEqual(send.args.slice(2), [...plan.args.slice(0, 6), '--msg-type', 'post', '--content', plan.transport.content, ...plan.args.slice(8)]);
  const gate = JSON.parse(fs.readFileSync(f.prefix+'.invoked.json', 'utf8'));
  assert.deepEqual([gate.idempotencyKey, gate.planSha256], [f.key, plan.planSha256]);
  assert.equal(fs.statSync(f.prefix+'.invoked.json').mode & 0o777, 0o600);
  const replay = direct(f, plan.args);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /EEXIST/);
  assert.equal(f.sends().length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.prefix+'.invoked.json', 'utf8')), gate);
});

test('a slow identity check is cut off inside the sender budget before the gate and never sends', t => {
  const f = macHome(t);
  const plan = reserve(f);
  // Leave room for the fixture's Node process to start on a loaded Mac.
  f.stubWith({ authDelayMs: 12000 });
  const r = budgeted(f, plan.args, { totalMs: 6000, identityMs: 1500, minSendMs: 500 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Lark operation failed: auth status/);
  assert.ok(r.elapsed < 6000, `identity budget not enforced (${r.elapsed} ms)`);
  assert.equal(fs.existsSync(f.prefix+'.invoked.json'), false);
  assert.equal(f.sends().length, 0);
  assert.equal(alive(f.calls()[0].pid), false);
  const tooClose = budgeted(f, plan.args, { totalMs: 200, identityMs: 300, minSendMs: 500 });
  assert.match(tooClose.stderr, /deadline too close; not invoked/);
  assert.equal(f.calls().length, 1);
});

test('a hanging send is killed at the shared sender deadline, leaving the gate and no orphan CLI', t => {
  const f = macHome(t);
  const plan = reserve(f);
  f.stubWith({ send: 'hang', hangMs: 20000 });
  const r = budgeted(f, plan.args, { totalMs: 6000, identityMs: 3000, minSendMs: 500 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CLI send outcome is uncertain/);
  assert.ok(r.elapsed < 9000, `send deadline not enforced (${r.elapsed} ms)`);
  assert.equal(fs.existsSync(f.prefix+'.invoked.json'), true);
  const [send] = f.sends();
  assert.equal(alive(send.pid), false);
  assert.equal(fs.existsSync(path.join(f.home, 'late-delivery.marker')), false);
  assert.match(budgeted(f, plan.args, { totalMs: 6000, identityMs: 3000, minSendMs: 500 }).stderr, /EEXIST/);
  assert.equal(f.sends().length, 1);
});

test('the sender budget ends safely inside the outer sendDelivery timeout', t => {
  const f = macHome(t);
  assert.ok(Object.isFrozen(SENDER_BUDGET));
  assert.ok(SENDER_BUDGET.identityMs + SENDER_BUDGET.minSendMs <= SENDER_BUDGET.totalMs);
  const p = JSON.parse(fs.readFileSync(f.publication, 'utf8')); p.rootDir = f.home;
  const target = { enabled: true, deploymentId: 'gos-daily', userId, reviewMode: 'self', transport: 'feishu-post-v1', executable: sender };
  const plan = prepareDelivery(fs.readFileSync(path.join(f.home, 'digest.md'), 'utf8'), JSON.parse(fs.readFileSync(path.join(f.home, 'sources.json'), 'utf8')), target, p);
  let outer;
  assert.throws(() => sendDelivery(plan, { authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, target, spawnSyncImpl: (file, args, options) => { outer = options; return { status: 1 }; } }), /uncertain/);
  assert.equal(typeof outer.timeout, 'number');
  // Leave at least 10 s for Node startup, pinned-binary hashing and exit before the outer kill.
  assert.ok(SENDER_BUDGET.totalMs + 10000 <= outer.timeout, `sender budget ${SENDER_BUDGET.totalMs} ms vs outer ${outer.timeout} ms`);
});
