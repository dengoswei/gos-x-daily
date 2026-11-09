#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadLocalConfig,verifyIdentity} from './mac-local.mjs';
import {nativeSenderArgs} from './transport.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
try {
 const config=loadLocalConfig();
 const args=process.argv.slice(2);
 if(args.length!==10 || args[0]!=='im' || args[1]!=='+messages-send' || args[2]!=='--as' || args[3]!=='bot' || args[4]!=='--user-id' || args[5]!==config.userId || args[6]!=='--markdown' || args[8]!=='--idempotency-key' || !/^xdaily-gos-daily-\d{4}-\d{2}-\d{2}$/.test(args[9])) throw new Error('Unexpected sender arguments');
 const prefix=path.join(config.ledgerDir,hash(args[9]));
 const plan=JSON.parse(fs.readFileSync(prefix+'.plan.json','utf8'));
 const attempt=JSON.parse(fs.readFileSync(prefix+'.attempt.json','utf8'));
 if(JSON.stringify(plan.args)!==JSON.stringify(args) || attempt.planSha256!==plan.planSha256 || process.env.X_DAILY_ALLOW_SEND!=='1') throw new Error('Missing exact durable send reservation');
 const nativeArgs=nativeSenderArgs(plan);
 verifyIdentity(config);
 const gate=fs.openSync(prefix+'.invoked.json','wx',0o600);
 try { fs.writeFileSync(gate,JSON.stringify({idempotencyKey:args[9],planSha256:plan.planSha256,invokedAt:new Date().toISOString()})); fs.fsyncSync(gate); }
 finally { fs.closeSync(gate); }
 const directory=fs.openSync(config.ledgerDir,'r');
 try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
 const result=spawnSync(config.cli.path,['--profile',config.profile,...nativeArgs],{stdio:'inherit',shell:false,timeout:50000});
 if(result.error || result.signal) throw new Error('CLI send outcome is uncertain');
 process.exitCode=result.status ?? 1;
} catch(error) { console.error(JSON.stringify({status:'blocked',error:error.message})); process.exitCode=1; }
