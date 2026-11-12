import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeDeliveryLedger } from '../delivery-ledger.mjs';
import { larkMarkdown } from '../digest.mjs';
import { larkPostJson, larkPostVisibleText } from '../lark-post.mjs';
import { approveSyntheticReview } from './helpers/review-fixture.mjs';
import { chatId as fixtureChatId, macHome, sentId } from './helpers/mac-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

test('Mac failure notice uses the configured chat and an independent once-per-day reservation', t => {
  const f = macHome(t);
  const alert = stage => f.local(['alert', '--date', f.date, '--stage', stage]);
  assert.equal(alert('arbitrary text').status, 1);
  assert.equal(f.sends().length, 0);
  assert.deepEqual(alert('finalize').json, { status: 'alert_accepted', date: f.date, messageId: sentId });
  assert.equal(alert('publish').json.status, 'alert_already_accepted');
  assert.equal(f.local(['status', '--date', f.date]).json.status, 'no_local_attempt');
  assert.deepEqual(f.ledgerFiles(), []);
  assert.equal(f.sends().length, 1);
  const args = f.sends()[0].args;
  assert.equal(args[args.indexOf('--chat-id') + 1], fixtureChatId);
  assert.equal(args[args.indexOf('--idempotency-key') + 1], f.key + '-failure-alert');
  assert.match(args[args.indexOf('--text') + 1], /终稿或审校/);
});

test('Mac failure notice never retries an uncertain send', t => {
  const f = macHome(t);
  f.stubWith({ send: 'fail' });
  const args = ['alert', '--date', f.date, '--stage', 'finalize'];
  assert.match(f.local(args).stderr, /outcome uncertain/);
  assert.equal(f.local(args).json.status, 'alert_attempt_requires_reconciliation');
  assert.equal(f.sends().length, 1);
});
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

test('explicit same-day revision replies once, retains the original receipt and reconciles without sending', t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mac-revision-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = path.join(home, 'ledger');
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  initializeDeliveryLedger(ledger, { notBeforeDate: date, createdBy: 'SYNTHETIC-test' });
  const key = `xdaily-gos-daily-${date}`, prefix = path.join(ledger, sha(key));
  const originalId = 'om_syntheticoriginal', replyId = 'om_syntheticrevision';
  const profile = 'cli_' + 'a'.repeat(16), userId = 'ou_' + 'a'.repeat(32), chatId = 'oc_' + 'a'.repeat(32);
  const url = 'https://example.invalid/a', collectionId = 'synthetic-revision';
  const marker = `<!-- x-daily-collection: ${collectionId} -->`;
  const original = `# X AI 日报 ${date}\n## Section\n- Original [Source](${url})\n`;
  const markdown = `# X AI 日报 ${date}\n${marker}\n\n${Number(date.slice(5,7))} 月 ${Number(date.slice(-2))} 日修订版。\n\n## Section\n- **Revised.** [Source](${url})\n\n## 差异补充\nSynthetic.\n`;
  const sources = { date, collectionId, digestMarker: marker, stats: { xFollowing: 1 }, sources: { xFollowing: [{ url: 'https://x.com/synthetic/status/123', links: [{ href: url }] }] } };
  const dispositions = { schemaVersion: 1, collectionId, items: [{ key: 'x:123', disposition: 'included', url, section: 'Section' }] };
  const snapshotInputs = { digestPath:'digest.md', sourcesPath:'sources.json', dispositionsPath:'dispositions.json', materialsPaths:['materials.json'], evidencePaths:['evidence.txt'],
    reviewMode:'self', renderStyle:'concise', transport:'feishu-post-v1', authorId:'synthetic-writer' };
  const publication = { rootDir: '.', ledgerDir: ledger, reviewPath: 'review.json', snapshotInputs };
  const rendered = larkMarkdown(markdown, sources, { dispositions, renderStyle: 'concise' });
  const write = (file, value) => fs.writeFileSync(path.resolve(home, file), JSON.stringify(value));
  const publicationFile = path.join(home, 'publication.json');
  const stub = path.join(home, 'cli.mjs'), sendLog = path.join(home, 'reply.log');
  const msg = (id, content) => ({ chat_id: chatId, message_id: id, sender: { id: profile }, content });
  fs.writeFileSync(stub, '#!/usr/bin/env node\n' + `
import fs from 'node:fs';
import assert from 'node:assert/strict';
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
const original=${JSON.stringify(msg(originalId, original))}, reply=${JSON.stringify(msg(replyId, larkPostVisibleText(rendered)))};
let response;
if(args.includes('auth')) response=${JSON.stringify({ appId: profile, brand: 'feishu', userOpenId: userId, identities: { bot: { available: true, status: 'ready' } } })};
else if(args.includes('+chat-messages-list')) response={ok:true,data:{messages:[original]}};
else if(args.includes('+messages-mget')) response={ok:true,data:{messages:[value('--message-ids')===reply.message_id?reply:original]}};
else if(args.includes('+messages-reply')) {
  assert.equal(value('--message-id'),original.message_id);
  assert.equal(value('--idempotency-key'),${JSON.stringify(key+'-revision')});
  assert.equal(value('--content'),${JSON.stringify(larkPostJson(rendered))});
  fs.writeFileSync(${JSON.stringify(sendLog)},'one invocation',{flag:'wx'});
  response={ok:true,data:{message_id:reply.message_id}};
} else throw new Error('Unexpected CLI operation');
console.log(JSON.stringify(response));\n`, { mode: 0o700 });
  const node = fs.realpathSync(process.execPath);
  write('mac.local.json', { schemaVersion: 1, namespace: 'gos-daily', reviewMode: 'self', ledgerDir: ledger, runsDir: path.join(home, 'runs'), profile, userId, chatId,
    cli: { path: stub, sha256: sha(fs.readFileSync(stub)) }, node: { path: node, sha256: sha(fs.readFileSync(node)) } });
  write('mac-authority.json', { owner: 'mac', remoteScheduleDisabled: true, evidence: 'synthetic', notBeforeDate: date, ledgerDir: ledger });
  write(prefix+'.receipt.json', { messageId: originalId });
  write(prefix+'.plan.json', { args: ['im', '+messages-send', '--as', 'bot', '--user-id', userId, '--markdown', original, '--idempotency-key', key], publishedUrls: [url] });
  write('sources.json', sources); write('dispositions.json', dispositions); write(publicationFile, publication);
  write('materials.json', { url });
  fs.writeFileSync(path.join(home, 'evidence.txt'), 'SYNTHETIC evidence');
  fs.writeFileSync(path.join(home, 'digest.md'), markdown);
  const review = approveSyntheticReview({ ...snapshotInputs, rootDir: home, renderedMarkdown: rendered });
  review.reviewerId = snapshotInputs.authorId;
  for (const unit of review.units) unit.comprehension.sourceBlind = false;
  write('review.json', review);
  const entry = new URL('../deployment/mac/mac-local.mjs', import.meta.url).href;
  const env = { ...process.env, GOS_X_DAILY_HOME: home };
  for (const name of Object.keys(env)) if (/^(LARK|FEISHU|XDG)_/.test(name) || name === 'NODE_OPTIONS') delete env[name];
  const run = args => spawnSync(node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await m.main(${JSON.stringify(args)})));`], { encoding: 'utf8', env });
  const publish = ['publish-revision','--publication',publicationFile,'--reply-to',originalId];
  assert.match(run([...publish.slice(0,-1),'om_wrong']).stderr,/canonical accepted receipt/);
  assert.equal(fs.existsSync(sendLog),false);
  const sent = run(publish);
  assert.equal(sent.status,0,sent.stderr);
  assert.equal(JSON.parse(sent.stdout).messageId,replyId);
  assert.equal(JSON.parse(run(publish).stdout).status,'sent_and_verified');
  assert.equal(JSON.parse(run(['reconcile-revision','--date',date]).stdout).revisionOf,originalId);
  assert.equal(JSON.parse(fs.readFileSync(prefix+'.receipt.json')).messageId,originalId);
  assert.equal(fs.readFileSync(path.join(ledger,'published-urls.jsonl'),'utf8').trim().split('\n').length,1);
});
