import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { transportFixture } from './helpers/reissue-transport-fixture.mjs';
const cli = fileURLToPath(new URL('../reissue-cli.mjs', import.meta.url));
const secretMarker = 'SYNTHETIC_SECRET_DO_NOT_PRINT';
const invoke = args => spawnSync(process.execPath, [cli, ...args], { env: { X_DAILY_ALLOW_REISSUE_SEND: '1' }, encoding: 'utf8', timeout: 5000 });
const safeFailure = result => { assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^Reissue preflight failed\./); assert.equal(result.stderr.includes(secretMarker), false); assert.equal(result.stderr.includes('SYNTHETIC_'), false); };
test('CLI malformed send plan never prints parser input bytes or invokes a sender', t => {
  const f = transportFixture(t), file = path.join(f.root, 'malformed-plan.json'); fs.writeFileSync(file, secretMarker);
  safeFailure(invoke(['send', '--binding', f.bindingPath, '--binding-sha', f.pin(), '--plan', file, '--plan-sha', '1'.repeat(64), '--allow-send']));
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
for (const cmd of ['check', 'prepare']) test(`CLI ${cmd} malformed binding emits no input bytes`, t => {
  const f = transportFixture(t); fs.writeFileSync(f.bindingPath, secretMarker);
  safeFailure(invoke([cmd, '--binding', f.bindingPath, '--binding-sha', f.pin(), ...(cmd === 'prepare' ? ['--out', path.join(f.root, 'out.json')] : [])]));
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
for (const args of [['check'], ['prepare', '--binding'], ['send', '--allow-send'], ['check', '--binding', 'x', '--binding', 'y'], ['send', '--allow-send', '--allow-send'], [secretMarker], ['check', '--unknown', secretMarker]]) test(`CLI missing/duplicate/unknown flags fail safely: ${JSON.stringify(args)}`, () => safeFailure(invoke(args)));
test('CLI no live authorization rejects before opening a malformed plan', t => {
  const f = transportFixture(t), file = path.join(f.root, 'malformed-plan.json'); fs.writeFileSync(file, secretMarker);
  safeFailure(invoke(['send', '--plan', file])); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
