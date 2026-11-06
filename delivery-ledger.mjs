import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

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

const PUBLISHED = 'published-urls.jsonl';
const DAY = 24 * 60 * 60 * 1000;

/** Appends one line per accepted delivery; the history file is never rewritten. */
export function recordPublishedUrls(directory, { date, idempotencyKey, urls, now = new Date().toISOString() } = {}) {
  const root = ledgerRoot(directory);
  if (!validDate(date)) throw new Error('Invalid published URL date');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{1,150}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string' || !url)) throw new Error('Published URLs must be non-empty strings');
  const file = path.join(root, PUBLISHED), created = !fs.existsSync(file);
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, JSON.stringify({ date, idempotencyKey, urls, recordedAt: now }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (created) {
    const handle = fs.openSync(root, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  }
}

/** Published URLs dated in [before - days, before), merged per date; a corrupt history line fails closed. */
export function recentPublishedUrls(directory, { before, days = 7 } = {}) {
  const root = ledgerRoot(directory);
  if (!validDate(before) || !Number.isSafeInteger(days) || days < 1) throw new Error('Published URL history needs a valid date and day count');
  const file = path.join(root, PUBLISHED);
  try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const from = new Date(Date.parse(before) - days * DAY).toISOString().slice(0, 10);
  const byDate = new Map();
  for (const [index, line] of fs.readFileSync(regular(file), 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Corrupt published URL history line ${index + 1}`); }
    if (!validDate(record?.date) || !Array.isArray(record.urls) || record.urls.some(url => typeof url !== 'string')) throw new Error(`Invalid published URL history line ${index + 1}`);
    if (record.date < from || record.date >= before) continue;
    byDate.set(record.date, new Set([...(byDate.get(record.date) ?? []), ...record.urls]));
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, urls]) => ({ date, urls: [...urls] }));
}
