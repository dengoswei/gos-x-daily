import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_PREFIX, prepareReissuePlan, pendingReissueReview, validateReissuePlan, reserveReissueAttempt, recordReissueOutcome, sha256 } from '../reissue.mjs';
import { initializeDeliveryLedger, recordDeliveryAttempt, recordDeliveryReceipt } from '../delivery-ledger.mjs';

const write = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n');
const hashFile = file => sha256(fs.readFileSync(file));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-reissue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'ledger');
  initializeDeliveryLedger(ledger, { notBeforeDate: '2026-10-31', createdBy: 'synthetic-test-only' });
  const target = { transport: 'lark', as: 'bot', userId: `ou_${'a'.repeat(32)}`, deploymentId: 'synthetic-deployment' };
  const historicKey = 'xdaily-synthetic-daily-2026-10-31';
  const history = recordDeliveryAttempt(ledger, { date: '2026-10-31', idempotencyKey: historicKey, planSha256: '1'.repeat(64), target });
  recordDeliveryReceipt(history, { messageId: 'synthetic-historical-receipt' });
  const fileName = 'synthetic-approved.md', artifactPath = path.join(root, fileName);
  const body = Buffer.from('# Synthetic historical approved artifact\n非事实测试正文。\n');
  fs.writeFileSync(artifactPath, body);
  const artifact = { libraryFileId: 'libfile_SYNTHETIC_NOT_REAL', version: 0, fileName, sizeBytes: body.length, sha256: sha256(body) };
  const requestPath = path.join(root, 'request.json'), contractPath = path.join(root, 'contract.json');
  write(requestPath, { schemaVersion: 1, kind: 'explicit-user-reissue-request', reference: 'synthetic-user-message', requestedDate: '2026-11-01', transcript: 'SYNTHETIC ONLY: send this exact historical artifact again.', artifact, target });
  const contract = { schemaVersion: 1, kind: 'explicit-approved-artifact-reissue-contract', artifact, reportDate: '2026-10-31', originalWindowEndsAt: '2026-10-31T03:02:15Z', request: { reference: 'synthetic-user-message', date: '2026-11-01', sha256: hashFile(requestPath) }, target, prefix: ALLOWED_PREFIX, delimiter: '\n\n', idempotencyKey: 'xdaily-gos-refresh-2026-10-31-request-20261101', ledger: { directory: ledger, metadataSha256: hashFile(path.join(ledger, 'ledger.json')), historicalEntries: ['.attempt.json', '.receipt.json'].map(suffix => ({ fileName: path.basename(history.prefix + suffix), sha256: hashFile(history.prefix + suffix), idempotencyKey: historicKey })) }, preparer: 'synthetic-preparer' };
  write(contractPath, contract);
  const inputs = { contractPath, artifactPath, requestPath }, options = { expectedContractSha256: hashFile(contractPath) };
  const f = { root, ledger, target, contract, inputs, options, body, newPrefix: path.join(ledger, sha256(contract.idempotencyKey)) };
  f.repinSyntheticContract = () => { write(contractPath, contract); options.expectedContractSha256 = hashFile(contractPath); };
  f.plan = () => prepareReissuePlan(inputs, options);
  return f;
}
function approveSyntheticReissueReview(f) {
  // TEST ONLY. Never import or use this mechanical helper for real artifact review.
  const pending = f.plan(), review = pendingReissueReview(pending, f.contract.preparer);
  review.status = 'approved'; review.reviewer = 'synthetic-independent-reviewer';
  review.assignmentReference = 'synthetic-test-assignment'; review.reviewedAt = '2026-11-01T12:30:00Z';
  for (const field of Object.values(review.checks)) { field.status = 'pass'; field.note = 'Synthetic test assertion only, not factual review.'; }
  const reviewPath = path.join(f.root, 'synthetic-review.json'); write(reviewPath, review);
  f.options.reviewPath = reviewPath;
  return { review, reviewPath, plan: f.plan() };
}

test('offline pending plan preserves exact bytes and only the literal prefix, never a generic sender plan', t => {
  const f = fixture(t), p = f.plan();
  assert.equal(p.status, 'pending_independent_review_not_sendable');
  assert.deepEqual(Buffer.from(p.payloadMarkdown), Buffer.concat([Buffer.from(ALLOWED_PREFIX + '\n\n'), f.body]));
  assert.equal(p.reviewSubject.payloadSha256, sha256(Buffer.from(p.payloadMarkdown)));
  assert.equal(p.guarantees.freshFactualReviewPerformed, false);
  assert.equal(p.guarantees.currentBotIdentityVerified, false);
  assert.equal(p.guarantees.sent, false); assert.equal(p.guarantees.sendAuthorized, false);
  assert.equal(p.schemaVersion, 1); assert.equal(p.executable, undefined); assert.equal(p.args, undefined); assert.equal(p.publication, undefined);
  assert.throws(() => validateReissuePlan(p, f.inputs, f.options), /review is pending/);
  assert.equal(validateReissuePlan(p, f.inputs, { ...f.options, requireReviewed: false }).valid, true);
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});

test('changed artifact bytes, including newline normalization, are rejected', t => {
  const f = fixture(t); fs.appendFileSync(f.inputs.artifactPath, '\n');
  assert.throws(f.plan, /artifact bytes/);
});
test('same-size body tamper is rejected', t => {
  const f = fixture(t), bytes = Buffer.from(f.body); bytes[0] = 33; fs.writeFileSync(f.inputs.artifactPath, bytes);
  assert.throws(f.plan, /artifact bytes/);
});
test('self-rehashed replacement artifact cannot bypass the external contract pin', t => {
  const f = fixture(t); f.contract.artifact.sha256 = '2'.repeat(64); write(f.inputs.contractPath, f.contract);
  assert.throws(f.plan, /contract bytes changed/);
});
test('missing external contract hash is rejected', t => {
  const f = fixture(t); assert.throws(() => prepareReissuePlan(f.inputs), /External expected contract hash/);
});
test('a wrong Library version fails even if all payload text is unchanged', t => {
  const f = fixture(t), request = JSON.parse(fs.readFileSync(f.inputs.requestPath)); request.artifact.version = 1;
  write(f.inputs.requestPath, request); f.contract.request.sha256 = hashFile(f.inputs.requestPath); f.repinSyntheticContract();
  assert.throws(f.plan, /explicit user request, artifact or target/);
});
test('missing explicit user request file/reference fails', t => {
  const f = fixture(t); fs.unlinkSync(f.inputs.requestPath); assert.throws(f.plan, /ENOENT/);
  write(f.inputs.requestPath, {}); f.contract.request.reference = ''; f.repinSyntheticContract(); assert.throws(f.plan, /Explicit Nov 1 request/);
});
test('changed request transcript cannot silently become authority', t => {
  const f = fixture(t); const r = JSON.parse(fs.readFileSync(f.inputs.requestPath)); r.transcript = 'Different request'; write(f.inputs.requestPath, r);
  assert.throws(f.plan, /request evidence changed/);
});
test('wrong recipient in plan is rejected', t => {
  const f = fixture(t), p = f.plan(); p.reviewSubject.target.userId = `ou_${'b'.repeat(32)}`;
  assert.throws(() => validateReissuePlan(p, f.inputs, { ...f.options, requireReviewed: false }), /Plan, payload, target/);
});
test('repinned wrong target still fails against historical receipts', t => {
  const f = fixture(t); f.contract.target.userId = `ou_${'b'.repeat(32)}`;
  const request = JSON.parse(fs.readFileSync(f.inputs.requestPath)); request.target = f.contract.target; write(f.inputs.requestPath, request);
  f.contract.request.sha256 = hashFile(f.inputs.requestPath); f.repinSyntheticContract(); assert.throws(f.plan, /Historical exact recipient/);
});
test('altered prefix is rejected even with a newly pinned contract', t => {
  const f = fixture(t); f.contract.prefix += ' 新采集已完成'; f.repinSyntheticContract(); assert.throws(f.plan, /literal allowed historical-status prefix/);
});
test('no altered idempotency key can bypass this request guard', t => {
  const f = fixture(t); f.contract.idempotencyKey += '-retry'; f.repinSyntheticContract(); assert.throws(f.plan, /fixed distinct same-request reissue key/);
});
test('generic new-daily contracts and plans cannot use the reissue gateway', t => {
  const f = fixture(t); f.contract.kind = 'new-daily'; f.repinSyntheticContract(); assert.throws(f.plan, /Only explicit approved-artifact/);
  assert.throws(() => validateReissuePlan({ schemaVersion: 2, status: 'prepared_not_sent' }, f.inputs, f.options), /generic new-daily/);
});
test('other historical report dates and windows cannot silently use this bounded adapter', t => {
  const f = fixture(t); f.contract.reportDate = '2026-11-01'; f.repinSyntheticContract(); assert.throws(f.plan, /only for the Oct 31/);
});
for (const suffix of ['.attempt.json', '.receipt.json', '.uncertain.json']) {
  test(`existing ${suffix} blocks duplicate preparation and reservation`, t => {
    const f = fixture(t), p = f.plan(); write(f.newPrefix + suffix, { alreadyExists: true });
    assert.throws(f.plan, /Prior delivery attempt\/receipt exists/);
    assert.throws(() => reserveReissueAttempt(p, f.inputs, { ...f.options, verifyExternalAuthorization: () => true }), /Prior delivery attempt\/receipt exists/);
  });
}
test('preserves historical anchors; deleted receipt or changed boundary cannot pass', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.ledger, f.contract.ledger.historicalEntries[1].fileName)); assert.throws(f.plan, /ENOENT/);
});
test('no silent empty/reset ledger substitution', t => {
  const f = fixture(t); const metadata = JSON.parse(fs.readFileSync(path.join(f.ledger, 'ledger.json'))); metadata.createdAt = '2026-11-01T00:00:00Z'; write(path.join(f.ledger, 'ledger.json'), metadata); assert.throws(f.plan, /ledger boundary changed/);
});
test('symlink artifact and dangling attempt fail closed', t => {
  const f = fixture(t), original = f.inputs.artifactPath + '.original'; fs.renameSync(f.inputs.artifactPath, original); fs.symlinkSync(original, f.inputs.artifactPath); assert.throws(f.plan, /without symlinks/);
  fs.unlinkSync(f.inputs.artifactPath); fs.renameSync(original, f.inputs.artifactPath); fs.symlinkSync(path.join(f.root, 'nonexistent'), f.newPrefix + '.attempt.json'); assert.throws(f.plan);
});
test('review rejects pending checks, self-review and false factual-review claims', t => {
  const f = fixture(t), approved = approveSyntheticReissueReview(f);
  approved.review.reviewer = f.contract.preparer; write(approved.reviewPath, approved.review); assert.throws(f.plan, /Independent reviewer/);
  approved.review.reviewer = 'synthetic-independent-reviewer'; approved.review.factualReviewPerformed = true; write(approved.reviewPath, approved.review); assert.throws(f.plan, /must not assert new factual review/);
  approved.review.factualReviewPerformed = false; approved.review.checks.bodyIdenticalBytes.status = 'pending'; write(approved.reviewPath, approved.review); assert.throws(f.plan, /not passed/);
});
test('fresh review binds payload, exact target and ledger; stale subject fails', t => {
  const f = fixture(t), approved = approveSyntheticReissueReview(f); approved.review.subject.payloadSha256 = '3'.repeat(64); write(approved.reviewPath, approved.review); assert.throws(f.plan, /Review is stale/);
});
test('final on-disk payload must equal literal prefix plus artifact without alteration', t => {
  const f = fixture(t), { plan } = approveSyntheticReissueReview(f), payloadPath = path.join(f.root, 'payload.md'); fs.writeFileSync(payloadPath, plan.payloadMarkdown);
  assert.equal(validateReissuePlan(plan, f.inputs, { ...f.options, payloadPath }).valid, true);
  fs.appendFileSync(payloadPath, '\n'); assert.throws(() => validateReissuePlan(plan, f.inputs, { ...f.options, payloadPath }), /Final payload file differs/);
});
test('JSON authorization claims or callbacks not returning true cannot reserve an attempt', t => {
  const f = fixture(t), { plan } = approveSyntheticReissueReview(f);
  for (const verifyExternalAuthorization of [undefined, true, { authorized: true }, () => false, async () => true]) assert.throws(() => reserveReissueAttempt(plan, f.inputs, { ...f.options, verifyExternalAuthorization }), /externally verified authorization/);
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('authorization callback changes trigger reread, never stale payload reservation', t => {
  const f = fixture(t), { plan } = approveSyntheticReissueReview(f);
  assert.throws(() => reserveReissueAttempt(plan, f.inputs, { ...f.options, verifyExternalAuthorization: () => { fs.appendFileSync(f.inputs.artifactPath, '!'); return true; } }), /artifact bytes/);
  assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), false);
});
test('synthetic durable attempt precedes receipt; receipt is API accepted, not read', t => {
  const f = fixture(t), { plan } = approveSyntheticReissueReview(f);
  const oldBytes = f.contract.ledger.historicalEntries.map(entry => fs.readFileSync(path.join(f.ledger, entry.fileName)));
  const r = reserveReissueAttempt(plan, f.inputs, { ...f.options, verifyExternalAuthorization: () => true });
  assert.equal(fs.existsSync(r.attemptPath), true); const attempt = JSON.parse(fs.readFileSync(r.attemptPath)); assert.equal(attempt.status, 'attempt_recorded_outcome_unknown');
  assert.throws(f.plan, /Prior delivery/);
  const receipt = recordReissueOutcome(r, { ok: true, data: { message_id: 'synthetic-new-receipt', receive_id: f.target.userId } }); assert.equal(receipt.status, 'api_accepted_not_read_confirmed'); assert.equal(receipt.readConfirmed, false);
  assert.throws(() => recordReissueOutcome(r, { ok: true, data: { message_id: 'duplicate' } }), /unclosed local reservation/);
  f.contract.ledger.historicalEntries.forEach((entry, i) => assert.deepEqual(fs.readFileSync(path.join(f.ledger, entry.fileName)), oldBytes[i]));
});
for (const confirmation of [null, { ok: 'true', data: { message_id: 'bad' } }, { ok: true, data: {} }, { ok: true, data: { message_id: 'bad-target', receive_id: `ou_${'b'.repeat(32)}` } }]) {
  test(`uncertain outcome never retries: ${JSON.stringify(confirmation)}`, t => {
    const f = fixture(t), { plan } = approveSyntheticReissueReview(f), r = reserveReissueAttempt(plan, f.inputs, { ...f.options, verifyExternalAuthorization: () => true });
    assert.throws(() => recordReissueOutcome(r, confirmation), /outcome uncertain/); assert.equal(fs.existsSync(f.newPrefix + '.uncertain.json'), true); assert.equal(fs.existsSync(f.newPrefix + '.attempt.json'), true); assert.throws(f.plan, /Prior delivery/);
  });
}
test('fabricated or restarted reservation cannot create a receipt', () => {
  assert.throws(() => recordReissueOutcome({ attemptPath: '/not-a-real-attempt' }, { ok: true, data: { message_id: 'forged' } }), /unclosed local reservation/);
});
test('post-plan ledger activity invalidates exact review without erasing history', t => {
  const f = fixture(t), { plan } = approveSyntheticReissueReview(f); write(path.join(f.ledger, 'other-event.json'), { status: 'synthetic-only' });
  assert.throws(() => validateReissuePlan(plan, f.inputs, f.options), /Review is stale/);
});
