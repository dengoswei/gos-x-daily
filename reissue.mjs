/** Offline-only, separately scoped immutable-artifact reissue. No transport or credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectDeliveryLedger, recordDeliveryAttempt, recordDeliveryReceipt, recordDeliveryUncertain } from './delivery-ledger.mjs';

export const REVIEW_SCOPE = 'user_requested_artifact_and_exact_payload_equivalence_only';
export const ALLOWED_PREFIX = '10月31日同源刷新版，按你11月1日要求补发；以下保留当时预览原文，原文未发送表述是生成时状态；原始窗口截至10/31 11:02BJT';
export const DELIMITER = '\n\n';
const REVIEW_CHECKS = ['exactLibraryArtifactIdentity', 'bodyIdenticalBytes', 'prefixOnlyAllowedHistoricalLabel', 'explicitRequestMatchesArtifact', 'exactHistoricalRecipient', 'distinctSameRequestKey', 'originalWindowNotCurrentScan', 'noFreshFactualReviewClaim'];
const SHA = /^[a-f0-9]{64}$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => stable(a) === stable(b);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const keys = (value, expected, name) => assert(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...expected].sort()), `${name}: unexpected/missing fields`);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function readRegular(file) {
  assert(typeof file === 'string' && path.isAbsolute(file), 'Absolute explicit local file path required');
  const resolved = path.resolve(file);
  assert(fs.lstatSync(resolved).isFile() && fs.realpathSync(resolved) === resolved, 'Inputs must be real regular files without symlinks');
  return fs.readFileSync(resolved);
}
function jsonFile(file) { return JSON.parse(readRegular(file).toString('utf8')); }
function utf8(bytes) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(Buffer.from(value).equals(bytes), 'Artifact must round-trip exact UTF-8 bytes');
  return value;
}
function loadContract(contractPath, expectedContractSha256) {
  assert(SHA.test(expectedContractSha256 ?? ''), 'External expected contract hash required; a self-asserted JSON claim is not authority');
  const bytes = readRegular(contractPath);
  assert(sha256(bytes) === expectedContractSha256, 'Pinned contract bytes changed');
  const c = JSON.parse(bytes);
  keys(c, ['schemaVersion', 'kind', 'artifact', 'reportDate', 'originalWindowEndsAt', 'request', 'target', 'prefix', 'delimiter', 'idempotencyKey', 'ledger', 'preparer'], 'contract');
  assert(c.schemaVersion === 1 && c.kind === 'explicit-approved-artifact-reissue-contract', 'Only explicit approved-artifact reissue contracts accepted');
  keys(c.artifact, ['libraryFileId', 'version', 'fileName', 'sizeBytes', 'sha256'], 'artifact');
  assert(nonempty(c.artifact.libraryFileId) && Number.isSafeInteger(c.artifact.version) && c.artifact.version >= 0 && nonempty(c.artifact.fileName) && path.basename(c.artifact.fileName) === c.artifact.fileName && Number.isSafeInteger(c.artifact.sizeBytes) && c.artifact.sizeBytes > 0 && SHA.test(c.artifact.sha256), 'Exact Library version, filename, size and hash required');
  assert(c.reportDate === '2026-10-31' && c.originalWindowEndsAt === '2026-10-31T03:02:15Z', 'This bounded adapter is only for the Oct 31 historical artifact/window');
  keys(c.request, ['reference', 'date', 'sha256'], 'request binding');
  assert(nonempty(c.request.reference) && c.request.date === '2026-11-01' && SHA.test(c.request.sha256), 'Explicit Nov 1 request binding required');
  keys(c.target, ['transport', 'as', 'userId', 'deploymentId'], 'target');
  assert(c.target.transport === 'lark' && c.target.as === 'bot' && /^ou_[a-f0-9]{32}$/i.test(c.target.userId ?? '') && nonempty(c.target.deploymentId), 'Exact existing Lark bot recipient/deployment required');
  assert(c.prefix === ALLOWED_PREFIX && c.delimiter === DELIMITER, 'Only the literal allowed historical-status prefix is permitted');
  assert(c.idempotencyKey === 'xdaily-gos-refresh-2026-10-31-request-20261101', 'Only the fixed distinct same-request reissue key is permitted');
  assert(nonempty(c.preparer), 'Preparer identity is required');
  keys(c.ledger, ['directory', 'metadataSha256', 'historicalEntries'], 'ledger binding');
  assert(path.isAbsolute(c.ledger.directory) && SHA.test(c.ledger.metadataSha256), 'Pinned existing ledger required');
  assert(Array.isArray(c.ledger.historicalEntries) && c.ledger.historicalEntries.length > 0, 'Existing historical attempt/receipt anchors required');
  const seen = new Set();
  for (const entry of c.ledger.historicalEntries) {
    keys(entry, ['fileName', 'sha256', 'idempotencyKey'], 'historical entry');
    assert(typeof entry.idempotencyKey === 'string' && /^[A-Za-z0-9-]{1,150}$/.test(entry.idempotencyKey) && entry.idempotencyKey !== c.idempotencyKey, 'Historical keys cannot be changed or reused');
    assert([`${sha256(entry.idempotencyKey)}.attempt.json`, `${sha256(entry.idempotencyKey)}.receipt.json`].includes(entry.fileName) && SHA.test(entry.sha256) && !seen.has(entry.fileName), 'Invalid historical ledger anchor');
    seen.add(entry.fileName);
  }
  return c;
}

function inspectPinnedLedger(c) {
  const inspected = inspectDeliveryLedger(c.ledger.directory, { date: c.reportDate, idempotencyKey: c.idempotencyKey });
  assert(sha256(readRegular(path.join(inspected.root, 'ledger.json'))) === c.ledger.metadataSha256, 'Existing ledger boundary changed; never initialize or reset it');
  for (const anchor of c.ledger.historicalEntries) {
    const bytes = readRegular(path.join(inspected.root, anchor.fileName));
    assert(sha256(bytes) === anchor.sha256, 'Historical attempt/receipt changed or removed');
    const entry = JSON.parse(bytes);
    assert(entry.idempotencyKey === anchor.idempotencyKey && entry.target?.userId === c.target.userId && entry.target?.deploymentId === c.target.deploymentId, 'Historical exact recipient/deployment mismatch');
  }
  // Bind every recovered ledger byte as well as the old daily anchors. No history is manufactured.
  const entries = fs.readdirSync(inspected.root).sort().map(fileName => ({ fileName, sha256: sha256(readRegular(path.join(inspected.root, fileName))) }));
  return { directory: inspected.root, metadata: inspected.metadata, entries, snapshotSha256: sha256(stable(entries)), reissueState: 'absent_at_preflight_only' };
}

function subject(inputs, expectedContractSha256) {
  keys(inputs, ['contractPath', 'artifactPath', 'requestPath'], 'inputs');
  const c = loadContract(inputs.contractPath, expectedContractSha256);
  const artifact = readRegular(inputs.artifactPath);
  assert(path.basename(inputs.artifactPath) === c.artifact.fileName && artifact.length === c.artifact.sizeBytes && sha256(artifact) === c.artifact.sha256, 'Approved artifact bytes/hash/filename changed');
  utf8(artifact);
  const requestBytes = readRegular(inputs.requestPath);
  assert(sha256(requestBytes) === c.request.sha256, 'Explicit user request evidence changed');
  const request = JSON.parse(requestBytes);
  keys(request, ['schemaVersion', 'kind', 'reference', 'requestedDate', 'transcript', 'artifact', 'target'], 'request evidence');
  assert(request.schemaVersion === 1 && request.kind === 'explicit-user-reissue-request' && request.reference === c.request.reference && request.requestedDate === c.request.date && nonempty(request.transcript) && same(request.artifact, c.artifact) && same(request.target, c.target), 'Missing or mismatched explicit user request, artifact or target');
  const payload = Buffer.concat([Buffer.from(c.prefix + c.delimiter), artifact]);
  const ledger = inspectPinnedLedger(c);
  const reviewSubject = { contractSha256: expectedContractSha256, artifact: c.artifact, requestReference: c.request.reference, requestSha256: c.request.sha256, target: c.target, idempotencyKey: c.idempotencyKey, prefixSha256: sha256(c.prefix), payloadSha256: sha256(payload), payloadSizeBytes: payload.length, ledgerSnapshotSha256: ledger.snapshotSha256 };
  return { c, payload, ledger, reviewSubject };
}

function validateReview(reviewPath, s) {
  const bytes = readRegular(reviewPath), r = JSON.parse(bytes);
  keys(r, ['schemaVersion', 'kind', 'status', 'scope', 'reviewer', 'assignmentReference', 'reviewedAt', 'preparer', 'subject', 'checks', 'findings', 'factualReviewPerformed', 'newScanPerformed', 'previousApprovalClaimed'], 'independent reissue review');
  assert(r.schemaVersion === 1 && r.kind === 'approved-artifact-reissue-review' && r.status === 'approved' && r.scope === REVIEW_SCOPE, 'Fresh independent payload-equivalence review required, not old factual review');
  assert(r.preparer === s.c.preparer && nonempty(r.reviewer) && r.reviewer !== r.preparer && nonempty(r.assignmentReference) && nonempty(r.reviewedAt) && Number.isFinite(Date.parse(r.reviewedAt)), 'Independent reviewer identity, assignment and review timestamp required');
  assert(same(r.subject, s.reviewSubject), 'Review is stale or covers a different payload/request/target/ledger');
  keys(r.checks, REVIEW_CHECKS, 'review checks');
  for (const check of REVIEW_CHECKS) assert(r.checks[check]?.status === 'pass' && nonempty(r.checks[check]?.note), `Review check missing or not passed: ${check}`);
  assert(Array.isArray(r.findings) && r.findings.length === 0, 'Unresolved review findings block preparation');
  assert(r.factualReviewPerformed === false && r.newScanPerformed === false && r.previousApprovalClaimed === false, 'Reissue review must not assert new factual review, collection or recovered old approval');
  return { path: path.resolve(reviewPath), sha256: sha256(bytes), reviewer: r.reviewer, assignmentReference: r.assignmentReference, scope: REVIEW_SCOPE };
}

export function prepareReissuePlan(inputs, { expectedContractSha256, reviewPath } = {}) {
  const s = subject(inputs, expectedContractSha256);
  const review = reviewPath ? validateReview(reviewPath, s) : null;
  const p = { schemaVersion: 1, kind: 'approved-artifact-reissue-plan', status: review ? 'reviewed_offline_not_send_authorization' : 'pending_independent_review_not_sendable', operation: 'resend_exact_user_selected_artifact', inputs: Object.fromEntries(Object.entries(inputs).map(([key, file]) => [key, path.resolve(file)])), reviewSubject: s.reviewSubject, reportDate: s.c.reportDate, originalWindowEndsAt: s.c.originalWindowEndsAt, prefix: s.c.prefix, delimiter: DELIMITER, payloadMarkdown: utf8(s.payload), ledger: s.ledger, review, guarantees: { bodyUnchanged: true, newScanPerformed: false, freshFactualReviewPerformed: false, recoveredPriorApprovalAsserted: false, currentBotIdentityVerified: false, sendAuthorized: false, sent: false }, nextAction: 'root_must_verify_request_authenticity_review_independence_existing_bot_target_runtime_and_authorization_before_any_attempt' };
  return { ...p, planSha256: sha256(stable(p)) };
}

export function pendingReissueReview(plan, preparer) {
  assert(plan?.kind === 'approved-artifact-reissue-plan' && plan.status === 'pending_independent_review_not_sendable', 'Pending reissue plan required');
  return { schemaVersion: 1, kind: 'approved-artifact-reissue-review', status: 'pending', scope: REVIEW_SCOPE, reviewer: null, assignmentReference: null, reviewedAt: null, preparer, subject: plan.reviewSubject, checks: Object.fromEntries(REVIEW_CHECKS.map(check => [check, { status: 'pending', note: '' }])), findings: [], factualReviewPerformed: false, newScanPerformed: false, previousApprovalClaimed: false };
}

export function validateReissuePlan(plan, inputs, { expectedContractSha256, reviewPath, requireReviewed = true, payloadPath } = {}) {
  assert(plan?.schemaVersion === 1 && plan.kind === 'approved-artifact-reissue-plan', 'Not an approved-artifact reissue plan; generic new-daily plans are never accepted here');
  const fresh = prepareReissuePlan(inputs, { expectedContractSha256, reviewPath });
  assert(same(plan, fresh), 'Plan, payload, target, key, request, review or ledger changed');
  assert(!requireReviewed || fresh.status === 'reviewed_offline_not_send_authorization', 'Fresh independent review is pending');
  if (payloadPath) assert(readRegular(payloadPath).equals(Buffer.from(fresh.payloadMarkdown)), 'Final payload file differs from the exact prefix plus immutable artifact bytes');
  return { valid: true, reviewStatus: fresh.status, payloadSha256: fresh.reviewSubject.payloadSha256, planSha256: fresh.planSha256, sendAuthorized: false };
}

// Offline durable lifecycle only. No sender, subprocess, network, credential reader or retry exists here.
// The callback MUST check real external controller authority/identity, not JSON assertions.
const reservations = new WeakMap();
export function reserveReissueAttempt(plan, inputs, { expectedContractSha256, reviewPath, payloadPath, verifyExternalAuthorization } = {}) {
  validateReissuePlan(plan, inputs, { expectedContractSha256, reviewPath, payloadPath, requireReviewed: true });
  assert(typeof verifyExternalAuthorization === 'function' && verifyExternalAuthorization(Object.freeze({ planSha256: plan.planSha256, payloadSha256: plan.reviewSubject.payloadSha256, target: Object.freeze({ ...plan.reviewSubject.target }), idempotencyKey: plan.reviewSubject.idempotencyKey, requestReference: plan.reviewSubject.requestReference, reviewPath })) === true, 'Separate externally verified authorization required; plan/review JSON is not permission');
  // Re-read after authorization as well, before the existing exclusive durable race gate.
  validateReissuePlan(plan, inputs, { expectedContractSha256, reviewPath, payloadPath, requireReviewed: true });
  const handle = recordDeliveryAttempt(plan.ledger.directory, { date: plan.reportDate, idempotencyKey: plan.reviewSubject.idempotencyKey, planSha256: plan.planSha256, target: plan.reviewSubject.target });
  const reservation = Object.freeze({ attemptPath: handle.prefix + '.attempt.json', idempotencyKey: handle.attempt.idempotencyKey, planSha256: plan.planSha256, payloadSha256: plan.reviewSubject.payloadSha256, target: Object.freeze({ ...plan.reviewSubject.target }) });
  reservations.set(reservation, { handle, closed: false });
  return reservation;
}

export function recordReissueOutcome(reservation, confirmation) {
  const state = reservations.get(reservation);
  assert(state && !state.closed, 'Only a live unclosed local reservation can be finalized; reconcile all restarted/uncertain attempts externally');
  state.closed = true;
  try {
    assert(confirmation?.ok === true && nonempty(confirmation.data?.message_id), 'Missing confirmed API message ID');
    assert(!confirmation.data.receive_id || confirmation.data.receive_id === reservation.target.userId, 'Receipt target mismatch');
    const receipt = recordDeliveryReceipt(state.handle, { messageId: confirmation.data.message_id });
    return { status: receipt.status, messageId: receipt.messageId, receiptPath: state.handle.prefix + '.receipt.json', readConfirmed: false };
  } catch (error) {
    try { recordDeliveryUncertain(state.handle, 'send_or_receipt_outcome_unconfirmed'); } catch { /* The durable attempt already blocks every retry. */ }
    throw new Error('Reissue outcome uncertain; attempt retained, never automatically retry', { cause: error });
  }
}
