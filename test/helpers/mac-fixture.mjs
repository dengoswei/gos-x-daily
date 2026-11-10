// TEST-ONLY SYNTHETIC Mac deployment home. A stub CLI replaces the pinned Lark CLI;
// nothing here reaches a network, credential, real ledger or real recipient.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeDeliveryLedger } from '../../delivery-ledger.mjs';
import { larkMarkdown } from '../../digest.mjs';
import { larkPostJson, larkPostVisibleText } from '../../lark-post.mjs';
import { approveSyntheticReview } from './review-fixture.mjs';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
export const profile = 'cli_' + 'a'.repeat(16), userId = 'ou_' + 'a'.repeat(32), chatId = 'oc_' + 'a'.repeat(32);
export const sentId = 'om_syntheticsent';
const node = fs.realpathSync(process.execPath);
export const sender = fs.realpathSync(new URL('../../deployment/mac/mac-sender.mjs', import.meta.url));
const entry = new URL('../../deployment/mac/mac-local.mjs', import.meta.url).href;

// The stub's bytes are pinned like the real CLI; behaviour comes from stub.json at call time.
const stubSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const home=path.dirname(new URL(import.meta.url).pathname);
const s=JSON.parse(fs.readFileSync(path.join(home,'stub.json'),'utf8'));
const args=process.argv.slice(2), op=args.includes('auth')?'auth':args.find(a=>a.startsWith('+'));
fs.appendFileSync(path.join(home,'calls.log'),JSON.stringify({op,pid:process.pid,args})+'\\n');
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
let response;
if(op==='auth') { sleep(s.authDelayMs??0); response=s.auth; }
else if(op==='+chat-messages-list') response={ok:true,data:{messages:s.history??[]}};
else if(op==='+messages-mget') response={ok:true,data:{messages:[s.sent]}};
else if(op==='+messages-send') {
  if(s.send==='fail') { console.error('synthetic send failure'); process.exit(1); }
  if(s.send==='hang') { sleep(s.hangMs??20000); fs.writeFileSync(path.join(home,'late-delivery.marker'),'delivered after deadline'); }
  response={ok:true,data:{message_id:s.sent.message_id}};
} else { console.error('Unexpected CLI operation'); process.exit(2); }
console.log(JSON.stringify(response));
`;

export function macHome(t, { date = today(), notBeforeDate = date } = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mac-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = path.join(home, 'ledger');
  initializeDeliveryLedger(ledger, { notBeforeDate: date, createdBy: 'SYNTHETIC-test' });
  const key = `xdaily-gos-daily-${date}`, prefix = path.join(ledger, sha(key));
  const url = 'https://example.invalid/a', collectionId = 'synthetic-mac-send';
  const marker = `<!-- x-daily-collection: ${collectionId} -->`;
  const markdown = `# X AI 日报 ${date}\n${marker}\n\n## Section\n- **Finding.** Synthetic explanation. [Source](${url})\n\n## 差异补充\nSynthetic.\n`;
  const sources = { date, collectionId, digestMarker: marker, stats: { xFollowing: 1 }, sources: { xFollowing: [{ url: 'https://x.com/synthetic/status/123', links: [{ href: url }] }] } };
  const dispositions = { schemaVersion: 1, collectionId, items: [{ key: 'x:123', disposition: 'included', url, section: 'Section' }] };
  const snapshotInputs = { digestPath: 'digest.md', sourcesPath: 'sources.json', dispositionsPath: 'dispositions.json', materialsPaths: ['materials.json'], evidencePaths: ['evidence.txt'],
    reviewMode: 'self', renderStyle: 'concise', transport: 'feishu-post-v1', authorId: 'synthetic-writer' };
  const rendered = larkMarkdown(markdown, sources, { dispositions, renderStyle: 'concise' });
  const write = (file, value) => fs.writeFileSync(path.resolve(home, file), JSON.stringify(value));
  const stub = path.join(home, 'cli.mjs');
  fs.writeFileSync(stub, stubSource, { mode: 0o700 });
  const stubState = { auth: { appId: profile, brand: 'feishu', userOpenId: userId, identities: { bot: { available: true, status: 'ready' } } },
    history: [], send: 'ok', sent: { chat_id: chatId, message_id: sentId, sender: { id: profile }, content: larkPostVisibleText(rendered), message_app_link: 'https://example.invalid/message' } };
  const stubWith = change => write('stub.json', { ...stubState, ...change });
  stubWith({});
  write('mac.local.json', { schemaVersion: 1, namespace: 'gos-daily', reviewMode: 'self', ledgerDir: ledger, runsDir: path.join(home, 'runs'), profile, userId, chatId,
    cli: { path: stub, sha256: sha(fs.readFileSync(stub)), version: 'synthetic' }, node: { path: node, sha256: sha(fs.readFileSync(node)) } });
  write('mac-authority.json', { owner: 'mac', remoteScheduleDisabled: true, evidence: 'synthetic ownership fixture', notBeforeDate, ledgerDir: ledger });
  write('sources.local.json', { synthetic: true });
  write('runtime.local.json', { lookbackHours: 48, synthetic: true });
  write('sources.json', sources); write('dispositions.json', dispositions); write('materials.json', { url });
  fs.writeFileSync(path.join(home, 'evidence.txt'), 'SYNTHETIC evidence');
  fs.writeFileSync(path.join(home, 'digest.md'), markdown);
  const review = approveSyntheticReview({ ...snapshotInputs, rootDir: home, renderedMarkdown: rendered });
  review.reviewerId = snapshotInputs.authorId;
  for (const unit of review.units) unit.comprehension.sourceBlind = false;
  write('review.json', review);
  const publication = path.join(home, 'publication.json');
  write(publication, { rootDir: '.', ledgerDir: ledger, reviewPath: 'review.json', snapshotInputs });
  const env = { ...process.env, GOS_X_DAILY_HOME: home, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? '') };
  for (const name of Object.keys(env)) if (/^(LARK|FEISHU|XDG)_/.test(name) || name === 'NODE_OPTIONS' || name === 'X_DAILY_ALLOW_SEND') delete env[name];
  const local = args => {
    const r = spawnSync(node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await m.main(${JSON.stringify(args)})));`], { encoding: 'utf8', env });
    return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : undefined };
  };
  const calls = () => fs.existsSync(path.join(home, 'calls.log')) ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const sends = () => calls().filter(call => call.op === '+messages-send');
  const ledgerFiles = () => fs.readdirSync(ledger).filter(name => name.startsWith(sha(key))).map(name => name.slice(64)).sort();
  // A plan with exactly the native transport bindings nativeSenderArgs checks, for direct sender tests.
  const directPlan = () => {
    const content = larkPostJson(rendered), transportSha = sha(content);
    return { args: ['im', '+messages-send', '--as', 'bot', '--user-id', userId, '--markdown', rendered, '--idempotency-key', key],
      transport: { kind: 'feishu-post-v1', content, sha256: transportSha }, validation: { review: { bindings: { transport: { kind: 'feishu-post-v1', sha256: transportSha } } } },
      planSha256: 'synthetic-plan-sha' };
  };
  return { home, ledger, date, key, prefix, url, rendered, publication, env, node, stubWith, local, calls, sends, ledgerFiles, directPlan, write };
}
