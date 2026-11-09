import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
test('Mac controller returns legacy accepted publication and reconciles without invoking sender', t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mac-controller-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = path.join(home, 'ledger'); fs.mkdirSync(ledger);
  const profile = 'cli_' + 'a'.repeat(16), userId = 'ou_' + 'a'.repeat(32), chatId = 'oc_' + 'a'.repeat(32);
  const date = '2026-11-09', key = `xdaily-gos-daily-${date}`, messageId = 'synthetic-message';
  const markdown = '# X AI 日报 2026-11-09\n## Section\n- **Finding.** [Source](https://example.invalid/a)\n';
  const write = (file, value) => fs.writeFileSync(path.join(home, file), JSON.stringify(value));
  const stub = path.join(home, 'cli.mjs');
  fs.writeFileSync(stub, '#!/usr/bin/env node\n' + `
const args=process.argv.slice(2);
let response;
if(args.includes('+messages-send')) throw new Error('Test must never send');
if(args.includes('auth')) response=${JSON.stringify({ appId: profile, brand: 'feishu', userOpenId: userId, identities: { bot: { available: true, status: 'ready' } } })};
else if(args.includes('+messages-mget')) response=${JSON.stringify({ ok: true, data: { messages: [{ chat_id: chatId, message_id: messageId, sender: { id: profile }, content: markdown, message_app_link: 'https://example.invalid/message' }] } })};
else throw new Error('Unexpected CLI operation');
console.log(JSON.stringify(response));\n`, { mode: 0o700 });
  const node = fs.realpathSync(process.execPath);
  write('mac.local.json', { schemaVersion: 1, namespace: 'gos-daily', reviewMode: 'self', ledgerDir: ledger, runsDir: path.join(home, 'runs'), profile, userId, chatId,
    cli: { path: stub, sha256: sha(fs.readFileSync(stub)) }, node: { path: node, sha256: sha(fs.readFileSync(node)) } });
  write('mac-authority.json', { owner: 'mac', remoteScheduleDisabled: true, evidence: 'synthetic ownership fixture', notBeforeDate: '2026-11-08', ledgerDir: ledger });
  const prefix = path.join(ledger, sha(key));
  fs.writeFileSync(prefix+'.receipt.json', JSON.stringify({ messageId }));
  fs.writeFileSync(prefix+'.plan.json', JSON.stringify({ args: ['im', '+messages-send', '--as', 'bot', '--user-id', userId, '--markdown', markdown, '--idempotency-key', key], publishedUrls: ['https://example.invalid/a'] }));
  fs.writeFileSync(path.join(ledger, 'published-urls.jsonl'), JSON.stringify({ idempotencyKey: key })+'\n');
  write('sources.json', { date });
  write('publication.json', { rootDir: '.', ledgerDir: ledger, snapshotInputs: { sourcesPath: 'sources.json', reviewMode: 'self', renderStyle: 'concise' } });
  const entry = new URL('../deployment/mac/mac-local.mjs', import.meta.url).href;
  const env = { ...process.env, GOS_X_DAILY_HOME: home };
  for (const name of Object.keys(env)) if (/^(LARK|FEISHU|XDG)_/.test(name) || name === 'NODE_OPTIONS') delete env[name];
  const run = args => {
    const result = spawnSync(node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await m.main(${JSON.stringify(args)})));`], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run(['publish', '--publication', path.join(home, 'publication.json')]).status, 'already_accepted');
  const reconciled = run(['reconcile', '--date', date]);
  assert.equal(reconciled.status, 'sent_and_verified');
  assert.equal(reconciled.layoutVerified, false);
  assert.equal(fs.existsSync(prefix+'.attempt.json'), false);
  assert.equal(fs.existsSync(prefix+'.invoked.json'), false);
});
