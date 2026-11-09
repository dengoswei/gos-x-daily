/** Separately gated transport for a previously approved immutable-artifact reissue. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateReissuePlan, sha256 } from './reissue.mjs';
import { recordDeliveryAttempt, recordDeliveryReceipt, recordDeliveryUncertain } from './delivery-ledger.mjs';

const HASH = /^[a-f0-9]{64}$/;
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => stable(a) === stable(b);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const keys = (value, expected, name) => assert(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...expected].sort()), `${name}: unexpected/missing fields`);
const CORE = ['delivery-ledger.mjs', 'reissue.mjs', 'reissue-transport.mjs', 'reissue-cli.mjs'];

function readRegular(file) {
  assert(typeof file === 'string' && path.isAbsolute(file), 'Explicit absolute local file path required');
  assert(fs.lstatSync(file).isFile() && fs.realpathSync(file) === path.resolve(file), 'Only real regular files without symlinks are accepted');
  return fs.readFileSync(file);
}
function pinned(file, hash, label) {
  assert(HASH.test(hash ?? ''), `${label}: external expected hash required`);
  const bytes = readRegular(file);
  assert(sha256(bytes) === hash, `${label}: bound file changed`);
  return bytes;
}
function sourceManifest(binding) {
  const manifest = JSON.parse(pinned(binding.sourceManifestPath, binding.expectedSourceManifestSha256, 'Source manifest'));
  keys(manifest, ['schemaVersion', 'kind', 'sourceRoot', 'files'], 'source manifest');
  assert(manifest.schemaVersion === 1 && manifest.kind === 'reviewed-reissue-source-manifest' && path.isAbsolute(manifest.sourceRoot), 'Reviewed source manifest required');
  assert(Array.isArray(manifest.files) && manifest.files.length === CORE.length && same(manifest.files.map(entry => entry.name).sort(), [...CORE].sort()), 'Manifest must pin every core reissue transport module exactly once');
  for (const entry of manifest.files) {
    keys(entry, ['name', 'sha256'], 'source entry');
    pinned(path.join(manifest.sourceRoot, entry.name), entry.sha256, 'Reviewed source module');
  }
  // Bind the modules actually being executed, not a second clean tree.
  assert(fs.realpathSync(manifest.sourceRoot) === fs.realpathSync(new URL('.', import.meta.url)), 'Manifest does not describe the executing source tree');
  return manifest;
}
function runtime(binding, target, now = Date.now()) {
  const r = JSON.parse(pinned(binding.runtimePath, binding.expectedRuntimeSha256, 'Verified runtime'));
  keys(r, ['schemaVersion', 'kind', 'enabled', 'target', 'executable', 'executableSha256', 'dependencyFiles', 'environment', 'verification'], 'runtime');
  assert(r.schemaVersion === 1 && r.kind === 'verified-lark-reissue-runtime' && r.enabled === true, 'Separately verified enabled runtime required');
  assert(same(r.target, target), 'Runtime target differs from the exact reviewed historical recipient/deployment');
  pinned(r.executable, r.executableSha256, 'Verified wrapper');
  assert((fs.statSync(r.executable).mode & 0o111) !== 0, 'Verified wrapper is not executable');
  assert(Array.isArray(r.dependencyFiles) && r.dependencyFiles.length >= 1, 'Pin the installed CLI binary and wrapper dependencies');
  const seen = new Set([r.executable]);
  for (const entry of r.dependencyFiles) {
    keys(entry, ['file', 'sha256'], 'runtime dependency');
    assert(!seen.has(entry.file), 'Duplicate runtime dependency'); seen.add(entry.file);
    pinned(entry.file, entry.sha256, 'Runtime dependency');
  }
  assert(r.environment && typeof r.environment === 'object' && !Array.isArray(r.environment), 'Explicit safe subprocess environment required');
  for (const [key, value] of Object.entries(r.environment)) {
    assert(/^(PATH|HOME|LANG|LC_ALL|TMPDIR|XDG_(CONFIG|DATA|STATE|CACHE)_HOME|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key) && typeof value === 'string' && !value.includes('\0'), 'Ambient credentials, identity overrides and shell/node startup variables are forbidden');
  }
  assert(nonempty(r.environment.PATH) && nonempty(r.environment.HOME), 'Explicit isolated HOME and PATH required');
  const v = r.verification;
  keys(v, ['evidencePath', 'evidenceSha256', 'verifiedAt', 'appId', 'botIdentityVerified', 'recipientVerified', 'authorizationReference'], 'runtime verification');
  pinned(v.evidencePath, v.evidenceSha256, 'Current identity verification evidence');
  assert(/^cli_[a-zA-Z0-9]+$/.test(v.appId ?? '') && v.botIdentityVerified === true && v.recipientVerified === true && nonempty(v.authorizationReference), 'External bot/recipient/authorization verification required');
  const at = Date.parse(v.verifiedAt);
  assert(Number.isFinite(at) && at <= now + 60000 && now - at <= 24 * 60 * 60 * 1000, 'Current identity verification must be within the last 24 hours; refresh read-only verification, never credentials blindly');
  return r;
}

function boundInputs(bindingPath, expectedBindingSha256, now) {
  const b = JSON.parse(pinned(bindingPath, expectedBindingSha256, 'Execution binding'));
  keys(b, ['schemaVersion', 'kind', 'reissuePlanPath', 'expectedReissuePlanFileSha256', 'inputs', 'expectedContractSha256', 'reviewPath', 'expectedReviewSha256', 'payloadPath', 'expectedPayloadSha256', 'runtimePath', 'expectedRuntimeSha256', 'sourceManifestPath', 'expectedSourceManifestSha256'], 'execution binding');
  assert(b.schemaVersion === 1 && b.kind === 'explicit-approved-reissue-execution-binding', 'Only an explicit reissue execution binding is accepted');
  sourceManifest(b);
  const p = JSON.parse(pinned(b.reissuePlanPath, b.expectedReissuePlanFileSha256, 'Reviewed immutable-artifact plan'));
  pinned(b.reviewPath, b.expectedReviewSha256, 'Independent artifact-equivalence review');
  pinned(b.payloadPath, b.expectedPayloadSha256, 'Exact final payload');
  validateReissuePlan(p, b.inputs, { expectedContractSha256: b.expectedContractSha256, reviewPath: b.reviewPath, payloadPath: b.payloadPath, requireReviewed: true });
  assert(p.reviewSubject.payloadSha256 === b.expectedPayloadSha256, 'Payload hash does not match the reviewed subject');
  const r = runtime(b, p.reviewSubject.target, now);
  return { b, p, r };
}

export function prepareReissueTransportPlan(bindingPath, expectedBindingSha256, { now = Date.now() } = {}) {
  const { b, p, r } = boundInputs(bindingPath, expectedBindingSha256, now);
  const plan = { schemaVersion: 3, kind: 'explicit-approved-artifact-reissue-transport', status: 'prepared_not_sent', bindingPath: path.resolve(bindingPath), bindingSha256: expectedBindingSha256, reviewedReissuePlanSha256: p.planSha256, independentReviewSha256: b.expectedReviewSha256, sourceManifestSha256: b.expectedSourceManifestSha256, runtimeSha256: b.expectedRuntimeSha256, payloadSha256: b.expectedPayloadSha256, payloadSizeBytes: Buffer.byteLength(p.payloadMarkdown), target: { ...p.reviewSubject.target, appId: r.verification.appId, executable: r.executable, executableSha256: r.executableSha256 }, idempotencyKey: p.reviewSubject.idempotencyKey, ledgerDirectory: p.ledger.directory, ledgerSnapshotSha256: p.ledger.snapshotSha256, originalReportDate: p.reportDate, originalWindowEndsAt: p.originalWindowEndsAt, historicalArtifactOnly: true, newScanPerformed: false, freshFactualReviewPerformed: false, automaticRetry: false };
  return { ...plan, planSha256: sha256(stable(plan)) };
}

export function writeReissueTransportPlan(file, plan) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(plan, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function sendReissueTransport(plan, { bindingPath, expectedBindingSha256, expectedPlanSha256, authorized = false, env = process.env, spawnSyncImpl = spawnSync, now = Date.now() } = {}) {
  assert(authorized === true && env.X_DAILY_ALLOW_REISSUE_SEND === '1', 'Explicit reissue send flag and environment authorization are both required');
  assert(plan?.schemaVersion === 3 && plan.kind === 'explicit-approved-artifact-reissue-transport' && plan.status === 'prepared_not_sent', 'Distinct reviewed reissue transport plan required; generic daily plans are rejected');
  assert(HASH.test(expectedPlanSha256 ?? '') && expectedPlanSha256 === plan.planSha256, 'External expected transport plan hash required');
  const fresh = prepareReissueTransportPlan(bindingPath, expectedBindingSha256, { now });
  assert(same(plan, fresh), 'Transport plan or any bound artifact/runtime/target/ledger changed');
  const { b, p, r } = boundInputs(bindingPath, expectedBindingSha256, now);
  const args = ['im', '+messages-send', '--as', 'bot', '--user-id', p.reviewSubject.target.userId, '--markdown', p.payloadMarkdown, '--idempotency-key', p.reviewSubject.idempotencyKey];
  const subprocessEnv = { ...r.environment };
  // Exclusive + file fsync + directory fsync completes BEFORE any sender invocation.
  const handle = recordDeliveryAttempt(p.ledger.directory, { date: p.reportDate, idempotencyKey: p.reviewSubject.idempotencyKey, planSha256: fresh.planSha256, target: fresh.target });
  try {
    // Recheck executable and every dependency after reservation; any failure now is uncertain-stop.
    sourceManifest(b); runtime(b, p.reviewSubject.target, now);
    const result = spawnSyncImpl(r.executable, args, { env: subprocessEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, shell: false });
    assert(result && !result.error && !result.signal && result.status === 0, 'Unconfirmed subprocess outcome');
    assert(typeof result.stdout === 'string' && result.stdout.includes('{'), 'Missing JSON confirmation');
    let confirmation;
    try { confirmation = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))); } catch { throw new Error('Malformed JSON confirmation'); }
    assert(confirmation?.ok === true && nonempty(confirmation.data?.message_id), 'Missing confirmed API message ID');
    assert(!confirmation.data.receive_id || confirmation.data.receive_id === p.reviewSubject.target.userId, 'Receipt target mismatch');
    const receipt = recordDeliveryReceipt(handle, { messageId: confirmation.data.message_id });
    return { status: 'sent_api_accepted', messageId: receipt.messageId, userId: p.reviewSubject.target.userId, idempotencyKey: p.reviewSubject.idempotencyKey, planSha256: fresh.planSha256, payloadSha256: b.expectedPayloadSha256, receiptPath: handle.prefix + '.receipt.json', readConfirmed: false, publishedUrlsRecorded: false, historicalReissueOnly: true };
  } catch {
    try { recordDeliveryUncertain(handle, 'send_or_receipt_outcome_unconfirmed'); } catch { /* Durable attempt already blocks every retry. */ }
    // Never print raw child stdout/stderr or exception diagnostics, which may contain credentials.
    throw new Error('Reissue delivery outcome uncertain; durable attempt retained. Stop and reconcile externally; never automatically retry or change the key.');
  }
}
