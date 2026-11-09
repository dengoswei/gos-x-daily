import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDelivery, sendDelivery, readPublicationFile } from '../../digest.mjs';
import { recordPublishedUrls, inspectDeliveryLedger } from '../../delivery-ledger.mjs';

import { deploymentHome, sourceRepo } from './paths.mjs';
import { expectedReadback, normalizedReadback } from './transport.mjs';
const base = deploymentHome();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)+'\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && new Date(date).toISOString().slice(0,10) === date;
const keyFor = date => `xdaily-gos-daily-${date}`;
const prefixFor = (config, date) => path.join(config.ledgerDir, hash(keyFor(date)));

export function loadLocalConfig() {
  const config = read(path.join(base, 'mac.local.json'));
  if (config.schemaVersion !== 1 || config.namespace !== 'gos-daily' || config.reviewMode !== 'self' ||
      !path.isAbsolute(config.ledgerDir) || !path.isAbsolute(config.runsDir) ||
      !/^cli_[a-f0-9]+$/.test(config.profile) || !/^ou_[a-f0-9]{32}$/.test(config.userId) ||
      !/^oc_[a-f0-9]{32}$/.test(config.chatId)) throw new Error('Invalid Mac deployment configuration');
  if (Object.keys(process.env).some(name => /^(LARK|FEISHU|XDG)_/.test(name) || name === 'NODE_OPTIONS')) {
    throw new Error('Unexpected credential/configuration environment override');
  }
  for (const pin of [config.cli, config.node]) {
    if (fs.realpathSync(pin.path) !== pin.path || hash(fs.readFileSync(pin.path)) !== pin.sha256) throw new Error('Pinned dependency changed');
  }
  if (fs.realpathSync(process.execPath) !== config.node.path) throw new Error('Use the provisioned Node executable');
  return config;
}
function cli(config, args) {
  const result = spawnSync(config.cli.path, ['--profile', config.profile, ...args], {
    encoding: 'utf8', shell: false, timeout: 55000, maxBuffer: 8*1024*1024,
  });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Lark operation failed: ${args.slice(0,2).join(' ')} (${result.error?.code ?? result.status})`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Lark returned invalid JSON'); }
  return parsed;
}
export function verifyIdentity(config) {
  const state = cli(config, ['auth', 'status']);
  if (state.appId !== config.profile || state.brand !== 'feishu' || state.userOpenId !== config.userId ||
      state.identities?.bot?.available !== true || state.identities?.bot?.status !== 'ready') throw new Error('Provisioned bot/recipient identity mismatch');
  return { appId: state.appId, bot: 'ready' };
}
function authority(config, date) {
  const a = read(path.join(base, 'mac-authority.json'));
  if (a.owner !== 'mac' || a.remoteScheduleDisabled !== true || !a.evidence ||
      !validDate(a.notBeforeDate) || date < a.notBeforeDate || a.ledgerDir !== config.ledgerDir) {
    throw new Error('Mac cutover incomplete: establish retired remote schedule and sole Mac ownership once');
  }
  return a;
}
function receipt(config, date) {
  const prefix = prefixFor(config, date);
  return fs.existsSync(prefix+'.receipt.json') ? read(prefix+'.receipt.json') : null;
}
function sameDayMessages(config, date) {
  const next = new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  const messages = [];
  let token;
  const seen = new Set();
  do {
    const args = ['im', '+chat-messages-list', '--as', 'bot', '--chat-id', config.chatId,
      '--start', date+'T00:00:00+08:00', '--end', next+'T00:00:00+08:00', '--page-size', '50', '--sort', 'desc'];
    if (token) args.push('--page-token', token);
    const response = cli(config, args);
    if (response.ok !== true || !Array.isArray(response.data?.messages)) throw new Error('Could not verify current recipient history');
    messages.push(...response.data.messages);
    token = response.data.has_more ? response.data.page_token : null;
    if (response.data.has_more && (!token || seen.has(token) || seen.size >= 20)) throw new Error('Chat history pagination incomplete');
    seen.add(token);
  } while (token);
  return messages;
}
function readBack(config, date, accepted, plan) {
  const response = cli(config, ['im', '+messages-mget', '--as', 'bot', '--message-ids', accepted.messageId]);
  if (response.ok !== true) throw new Error('Accepted message could not be read back');
  const messages = response.data?.messages;
  const message = Array.isArray(messages) ? messages.find(item => item.message_id === accepted.messageId) : null;
  if (!message || message.chat_id !== config.chatId || message.deleted || message.sender?.id !== config.profile) {
    throw new Error('Readback message identity or recipient mismatch');
  }
  if (typeof message.content !== 'string' || normalizedReadback(message.content) !== normalizedReadback(expectedReadback(plan))) {
    throw new Error('Readback visible text differs from the bound report');
  }
  const body = JSON.stringify(response.data).replaceAll('https://www.', 'https://');
  const urls = plan.publishedUrls;
  if (!body.includes(accepted.messageId) || !body.includes(config.chatId) || !body.includes(`X AI 日报 ${date}`) ||
      urls.some(url => !body.includes(url))) throw new Error('Readback does not match the report ID, chat, title and complete source links');
  const result = { status:'sent_and_verified', date, messageId:accepted.messageId, chatId:config.chatId,
    renderedSha256:hash(plan.args[7]), readbackVerified:true, exactVisibleText:true, layoutVerified:false,
    ...(plan.transport ? {transportSha256:plan.transport.sha256} : {}),
    messageUrl:message.message_app_link, verifiedAt:new Date().toISOString(), verifiedSourceLinks:urls.length };
  const file=prefixFor(config,date)+'.readback.json';
  if (!fs.existsSync(file)) write(file, { ...result, response });
  return result;
}
function publicationAt(file, config) {
  const absolute = path.resolve(file);
  const p = read(absolute);
  p.rootDir=path.resolve(path.dirname(absolute),p.rootDir);
  p.ledgerDir=path.resolve(path.dirname(absolute),p.ledgerDir);
  if (p.ledgerDir !== config.ledgerDir || p.snapshotInputs?.reviewMode !== 'self' || p.snapshotInputs?.renderStyle !== 'concise') {
    throw new Error('Publication must use this Mac ledger, explicit self-review and concise render');
  }
  return p;
}
export async function main(args) {
  const config=loadLocalConfig();
  const command=args[0];
  const value=flag=>args[args.indexOf(flag)+1];
  if (command === 'doctor') {
    fs.accessSync(path.join(sourceRepo,'deployment/mac/mac-sender.mjs'), fs.constants.X_OK);
    const identity=verifyIdentity(config);
    const latest=cli(config,['im','+chat-messages-list','--as','bot','--chat-id',config.chatId,'--page-size','1']);
    if (latest.ok !== true) throw new Error('Configured recipient is unavailable');
    const a=read(path.join(base,'mac-authority.json'));
    return {status:'dependencies_verified',node:process.version,cli:config.cli.version,identity,
      authority:a.owner,remoteScheduleDisabled:a.remoteScheduleDisabled,ledgerDir:config.ledgerDir,
      readyForProduction:a.owner==='mac' && a.remoteScheduleDisabled===true};
  }
  if (command === 'start-run') {
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    authority(config,today);
    const prior=receipt(config,today);
    if(prior) return {status:'already_accepted',messageId:prior.messageId,date:today};
    inspectDeliveryLedger(config.ledgerDir, {date:today, idempotencyKey:keyFor(today)});
    fs.mkdirSync(config.runsDir,{recursive:true,mode:0o700});
    const run=fs.mkdtempSync(path.join(config.runsDir,today+'-'));
    fs.copyFileSync(path.join(base,'sources.local.json'),path.join(run,'sources.frozen.json'));
    write(path.join(run,'source-roster.json'), {
      frozenAt:new Date().toISOString(), configuredSources:'sources.frozen.json',
      required:['X Following selected and usable', 'Karpathy genuine latest-post check'],
      supplemental:['Following Latest time slices when useful','Gmail technical newsletters','Gmail exact sender news@alphasignal.ai','Substack Recent subscriptions','configured Xiaohongshu profiles','configured official blogs','original materials behind relevant leads'],
    });
    write(path.join(run,'run.json'),{date:today,startedAt:new Date().toISOString(),lookbackHours:48,sourceRoster:'sources.frozen.json'});
    write(path.join(run,'runtime.json'),{...read(path.join(base,'runtime.local.json')),sourcesFile:path.join(run,'sources.frozen.json')});
    return {status:'run_created',run,ledgerDir:config.ledgerDir};
  }
  if(command === 'status' || command === 'reconcile') {
    const date=value('--date');
    if(!validDate(date)) throw new Error('A valid --date is required');
    const accepted=receipt(config,date);
    const prefix=prefixFor(config,date);
    if(!accepted) return {status:fs.existsSync(prefix+'.attempt.json')?'attempt_requires_reconciliation':'no_local_attempt',date};
    if(command==='status') return {status:'already_accepted',date,messageId:accepted.messageId};
    verifyIdentity(config);
    const plan=read(prefix+'.plan.json');
    const result=readBack(config,date,accepted,plan);
    // Reconciliation may repair a history write that failed after API acceptance.
    const history=path.join(config.ledgerDir,'published-urls.jsonl');
    if(!fs.existsSync(history) || !fs.readFileSync(history,'utf8').split('\n').filter(Boolean).some(line=>JSON.parse(line).idempotencyKey===keyFor(date))) {
      recordPublishedUrls(config.ledgerDir,{date,idempotencyKey:keyFor(date),urls:plan.publishedUrls});
    }
    return result;
  }
  if(command !== 'publish' || !args.includes('--publication')) throw new Error('Use doctor, start-run, status --date, reconcile --date or publish --publication');
  const p=publicationAt(value('--publication'),config);
  const sources=JSON.parse(readPublicationFile(p.rootDir,p.snapshotInputs.sourcesPath));
  const date=sources.date;
  authority(config,date);
  const prior=receipt(config,date);
  if(prior) return {status:'already_accepted',date,messageId:prior.messageId,next:'reconcile to read back, never resend'};
  if(p.snapshotInputs.transport !== 'feishu-post-v1') throw new Error('New publication requires reviewed native post transport');
  fs.accessSync(path.join(sourceRepo,'deployment/mac/mac-sender.mjs'), fs.constants.X_OK);
  verifyIdentity(config);
  const existing=sameDayMessages(config,date).filter(m=>String(m.content).includes(`X AI 日报 ${date}`));
  if(existing.length) return {status:'already_present_requires_reconciliation',messageIds:existing.map(m=>m.message_id),date};
  const target={enabled:true,deploymentId:config.namespace,userId:config.userId,reviewMode:config.reviewMode,transport:'feishu-post-v1',executable:path.join(sourceRepo,'deployment/mac/mac-sender.mjs')};
  const markdown=readPublicationFile(p.rootDir,p.snapshotInputs.digestPath);
  const plan=prepareDelivery(markdown,sources,target,p);
  const planFile=prefixFor(config,date)+'.plan.json';
  if(fs.existsSync(planFile)) {
    if(JSON.stringify(read(planFile))!==JSON.stringify(plan)) throw new Error('Existing reserved plan differs; reconcile before changing it');
  } else write(planFile,plan);
  // The portable sender's env shebang must select the same already-verified Node.
  const sent=sendDelivery(plan,{authorized:true,env:{...process.env,PATH:path.dirname(config.node.path)+path.delimiter+(process.env.PATH ?? ''),X_DAILY_ALLOW_SEND:'1'},target});
  try { return {...sent,...readBack(config,date,{messageId:sent.messageId},plan)}; }
  catch(error) { return {...sent,status:'accepted_readback_pending',readbackError:error.message,next:'reconcile only; do not resend'}; }
}
