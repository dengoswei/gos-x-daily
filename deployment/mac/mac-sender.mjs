#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {loadLocalConfig,verifyIdentity} from './mac-local.mjs';
import {nativeSenderArgs} from './transport.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
// The parent (digest.mjs sendDelivery) kills this process after 60 s. Every inner step shares one
// deadline measured from this process's start, so the sender itself ends (and SIGKILLs a stuck CLI)
// well before the outer kill could orphan a CLI that might still deliver.
export const SENDER_BUDGET=Object.freeze({totalMs:45000,identityMs:10000,minSendMs:20000});
export function runSender(args,{budget=SENDER_BUDGET,startedAt=performance.timeOrigin,env=process.env}={}) {
 const deadline=startedAt+Math.min(budget.totalMs,SENDER_BUDGET.totalMs);
 const remaining=()=>Math.floor(deadline-Date.now());
 const config=loadLocalConfig();
 if(args.length!==10 || args[0]!=='im' || args[1]!=='+messages-send' || args[2]!=='--as' || args[3]!=='bot' || args[4]!=='--user-id' || args[5]!==config.userId || args[6]!=='--markdown' || args[8]!=='--idempotency-key' || !/^xdaily-gos-daily-\d{4}-\d{2}-\d{2}$/.test(args[9])) throw new Error('Unexpected sender arguments');
 const prefix=path.join(config.ledgerDir,hash(args[9]));
 const plan=JSON.parse(fs.readFileSync(prefix+'.plan.json','utf8'));
 const attempt=JSON.parse(fs.readFileSync(prefix+'.attempt.json','utf8'));
 if(JSON.stringify(plan.args)!==JSON.stringify(args) || attempt.planSha256!==plan.planSha256 || env.X_DAILY_ALLOW_SEND!=='1') throw new Error('Missing exact durable send reservation');
 const nativeArgs=nativeSenderArgs(plan);
 const identityMs=Math.min(budget.identityMs,SENDER_BUDGET.identityMs,remaining()-budget.minSendMs);
 if(identityMs<=0) throw new Error('Sender deadline too close; not invoked');
 verifyIdentity(config,identityMs);
 // Refuse before the gate so a slow identity check never consumes the invocation or starts a send.
 if(remaining()<budget.minSendMs) throw new Error('Sender deadline too close; not invoked');
 const gate=fs.openSync(prefix+'.invoked.json','wx',0o600);
 try { fs.writeFileSync(gate,JSON.stringify({idempotencyKey:args[9],planSha256:plan.planSha256,invokedAt:new Date().toISOString()})); fs.fsyncSync(gate); }
 finally { fs.closeSync(gate); }
 const directory=fs.openSync(config.ledgerDir,'r');
 try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
 const result=spawnSync(config.cli.path,['--profile',config.profile,...nativeArgs],{stdio:'inherit',shell:false,timeout:Math.max(1,remaining()),killSignal:'SIGKILL'});
 if(result.error || result.signal) throw new Error('CLI send outcome is uncertain');
 return result.status ?? 1;
}
if(process.argv[1] && fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
 try { process.exitCode=runSender(process.argv.slice(2)); }
 catch(error) { console.error(JSON.stringify({status:'blocked',error:error.message})); process.exitCode=1; }
}
