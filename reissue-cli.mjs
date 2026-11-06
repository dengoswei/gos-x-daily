#!/usr/bin/env node
import fs from 'node:fs';
import { prepareReissueTransportPlan, writeReissueTransportPlan, sendReissueTransport } from './reissue-transport.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = new Map();
try {
  if (!['check', 'prepare', 'send'].includes(command)) throw new Error('Usage: reissue-cli.mjs check|prepare|send --binding ABS_PATH --binding-sha SHA [--out ABS_PATH | --plan ABS_PATH --plan-sha SHA --allow-send]');
  const allowed = new Set(['--binding', '--binding-sha', ...(command === 'prepare' ? ['--out'] : command === 'send' ? ['--plan', '--plan-sha', '--allow-send'] : [])]);
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!allowed.has(name) || flags.has(name)) throw new Error('Unknown or duplicate CLI option');
    if (name === '--allow-send') flags.set(name, true);
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error('Missing CLI option value'); flags.set(name, value); }
  }
  const bindingPath = flags.get('--binding'), expectedBindingSha256 = flags.get('--binding-sha');
  if (command === 'send') {
    if (flags.get('--allow-send') !== true || process.env.X_DAILY_ALLOW_REISSUE_SEND !== '1') throw new Error('Sending requires --allow-send and X_DAILY_ALLOW_REISSUE_SEND=1');
    const planPath = flags.get('--plan');
    if (!planPath || !fs.lstatSync(planPath).isFile() || fs.realpathSync(planPath) !== planPath) throw new Error('An explicit durable regular transport plan file is required');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const result = sendReissueTransport(plan, { bindingPath, expectedBindingSha256, expectedPlanSha256: flags.get('--plan-sha'), authorized: true });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const plan = prepareReissueTransportPlan(bindingPath, expectedBindingSha256);
    if (command === 'prepare') { if (!flags.get('--out')) throw new Error('--out required'); writeReissueTransportPlan(flags.get('--out'), plan); }
    console.log(JSON.stringify({ status: plan.status, planSha256: plan.planSha256, payloadSha256: plan.payloadSha256, idempotencyKey: plan.idempotencyKey, sent: false }, null, 2));
  }
} catch (error) {
  // Parser/OS errors may embed input bytes. Never echo them, even before pin validation.
  const uncertain = 'Reissue delivery outcome uncertain; durable attempt retained. Stop and reconcile externally; never automatically retry or change the key.';
  console.error(error?.message === uncertain ? uncertain : 'Reissue preflight failed. Check required flags, pinned inputs, runtime verification and existing ledger without exposing file contents. If an attempt exists, stop and reconcile; never retry automatically.');
  process.exitCode = 1;
}
