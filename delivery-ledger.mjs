import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value;

function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Ledger entries must be regular files, not symlinks');
  return file;
}

function ledgerRoot(directory) {
  const absolute = path.resolve(directory);
  if (!fs.lstatSync(absolute).isDirectory() || fs.realpathSync(absolute) !== absolute) throw new Error('Ledger must be a real directory without symlinks');
  return absolute;
}

function exclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function initializeDeliveryLedger(directory, { notBeforeDate, createdBy, now = new Date().toISOString() } = {}) {
  if (!validDate(notBeforeDate) || typeof createdBy !== 'string' || !createdBy.trim()) throw new Error('Explicit forward-only date and creator are required');
  // Never import or fabricate lost historical receipts. This is a new boundary.
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const root = ledgerRoot(directory);
  const metadata = { schemaVersion: 1, kind: 'forward-recovery-ledger', notBeforeDate, dateTimezone: 'Asia/Shanghai', createdBy, createdAt: now,
    previousHistory: 'unavailable_not_reconstructed', automaticRetry: false };
  exclusive(path.join(root, 'ledger.json'), metadata);
  return metadata;
}

export function inspectDeliveryLedger(directory, { date, idempotencyKey } = {}) {
  const root = ledgerRoot(directory);
  const metadata = JSON.parse(fs.readFileSync(regular(path.join(root, 'ledger.json')), 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'forward-recovery-ledger' || metadata.dateTimezone !== 'Asia/Shanghai' || !validDate(metadata.notBeforeDate) ||
      metadata.previousHistory !== 'unavailable_not_reconstructed' || metadata.automaticRetry !== false) throw new Error('Invalid recovery ledger; do not silently recreate lost history');
  if (!validDate(date) || date < metadata.notBeforeDate) throw new Error('Report predates the explicitly established recovery boundary');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{1,150}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  const prefix = path.join(root, sha256(idempotencyKey));
  for (const suffix of ['.attempt.json', '.receipt.json', '.uncertain.json']) {
    if (fs.existsSync(prefix + suffix)) throw new Error('Prior delivery attempt/receipt exists; reconcile externally, never automatically retry');
  }
  return { root, metadata, prefix };
}

export function recordDeliveryAttempt(directory, { date, idempotencyKey, planSha256, target, now = new Date().toISOString() }) {
  const { prefix } = inspectDeliveryLedger(directory, { date, idempotencyKey });
  const attempt = { schemaVersion: 1, status: 'attempt_recorded_outcome_unknown', date, idempotencyKey, planSha256, target, startedAt: now };
  // Exclusive creation is the race gate. Any later error leaves this record blocking retries.
  exclusive(prefix + '.attempt.json', attempt);
  return { prefix, attempt };
}

export function recordDeliveryReceipt(handle, { messageId, now = new Date().toISOString() }) {
  if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('Missing confirmed API message ID');
  const receipt = { ...handle.attempt, status: 'api_accepted_not_read_confirmed', messageId, completedAt: now };
  exclusive(handle.prefix + '.receipt.json', receipt);
  return receipt;
}

export function recordDeliveryUncertain(handle, reason) {
  // Reason is a local classification, never CLI stdout or credential-bearing diagnostics.
  exclusive(handle.prefix + '.uncertain.json', { ...handle.attempt, status: 'uncertain_stop_reconcile', reason,
    recordedAt: new Date().toISOString() });
}
