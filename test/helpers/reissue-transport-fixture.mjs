import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_PREFIX, prepareReissuePlan, pendingReissueReview, sha256 } from '../../reissue.mjs';
import { initializeDeliveryLedger, recordDeliveryAttempt, recordDeliveryReceipt } from '../../delivery-ledger.mjs';
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export const hashFile = file => sha256(fs.readFileSync(file));
export function transportFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-reissue-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'ledger'); initializeDeliveryLedger(ledger, { notBeforeDate: '2026-10-31', createdBy: 'synthetic-only' });
  const target = { transport: 'lark', as: 'bot', userId: `ou_${'a'.repeat(32)}`, deploymentId: 'synthetic-deployment' };
  const oldKey = 'xdaily-synthetic-daily-2026-10-31';
  const old = recordDeliveryAttempt(ledger, { date: '2026-10-31', idempotencyKey: oldKey, planSha256: '1'.repeat(64), target }); recordDeliveryReceipt(old, { messageId: 'synthetic-old-message' });
  const artifactPath = path.join(root, 'synthetic.md'), body = Buffer.from('# Synthetic approved historical artifact\n非事实测试。\n'); fs.writeFileSync(artifactPath, body);
  const artifact = { libraryFileId: 'libfile_SYNTHETIC', version: 0, fileName: 'synthetic.md', sizeBytes: body.length, sha256: sha256(body) };
  const requestPath = path.join(root, 'request.json'); write(requestPath, { schemaVersion: 1, kind: 'explicit-user-reissue-request', reference: 'synthetic-request', requestedDate: '2026-11-01', transcript: 'SYNTHETIC: resend this exact artifact.', artifact, target });
  const contractPath = path.join(root, 'contract.json'), key = 'xdaily-gos-refresh-2026-10-31-request-20261101';
  const contract = { schemaVersion: 1, kind: 'explicit-approved-artifact-reissue-contract', artifact, reportDate: '2026-10-31', originalWindowEndsAt: '2026-10-31T03:02:15Z', request: { reference: 'synthetic-request', date: '2026-11-01', sha256: hashFile(requestPath) }, target, prefix: ALLOWED_PREFIX, delimiter: '\n\n', idempotencyKey: key, ledger: { directory: ledger, metadataSha256: hashFile(path.join(ledger, 'ledger.json')), historicalEntries: ['.attempt.json', '.receipt.json'].map(suffix => ({ fileName: path.basename(old.prefix + suffix), sha256: hashFile(old.prefix + suffix), idempotencyKey: oldKey })) }, preparer: 'synthetic-preparer' };
  write(contractPath, contract);
  const inputs = { contractPath, artifactPath, requestPath }, expectedContractSha256 = hashFile(contractPath);
  const p = prepareReissuePlan(inputs, { expectedContractSha256 });
  // SYNTHETIC ONLY. This helper must never approve real work.
  const review = pendingReissueReview(p, contract.preparer); Object.assign(review, { status: 'approved', reviewer: 'synthetic-independent-reviewer', assignmentReference: 'synthetic-test-assignment', reviewedAt: new Date().toISOString() });
  for (const item of Object.values(review.checks)) { item.status = 'pass'; item.note = 'Synthetic assertion only.'; }
  const reviewPath = path.join(root, 'synthetic-review.json'); write(reviewPath, review);
  const reviewed = prepareReissuePlan(inputs, { expectedContractSha256, reviewPath }), reissuePlanPath = path.join(root, 'reviewed-plan.json'); write(reissuePlanPath, reviewed);
  const payloadPath = path.join(root, 'payload.md'); fs.writeFileSync(payloadPath, reviewed.payloadMarkdown);
  const executable = path.join(root, 'synthetic-wrapper'); fs.writeFileSync(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const binary = path.join(root, 'synthetic-binary'); fs.writeFileSync(binary, 'SYNTHETIC non-executed native bytes');
  const evidencePath = path.join(root, 'synthetic-identity-evidence.json'); write(evidencePath, { syntheticOnly: true });
  const runtimePath = path.join(root, 'runtime.json');
  const runtime = { schemaVersion: 1, kind: 'verified-lark-reissue-runtime', enabled: true, target, executable, executableSha256: hashFile(executable), dependencyFiles: [{ file: binary, sha256: hashFile(binary) }], environment: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' }, verification: { evidencePath, evidenceSha256: hashFile(evidencePath), verifiedAt: new Date().toISOString(), appId: 'cli_SYNTHETIC', botIdentityVerified: true, recipientVerified: true, authorizationReference: 'synthetic-only-authorization' } }; write(runtimePath, runtime);
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const sourceManifestPath = path.join(root, 'source-manifest.json');
  const manifest = { schemaVersion: 1, kind: 'reviewed-reissue-source-manifest', sourceRoot, files: ['delivery-ledger.mjs', 'reissue.mjs', 'reissue-transport.mjs', 'reissue-cli.mjs'].map(name => ({ name, sha256: hashFile(path.join(sourceRoot, name)) })) }; write(sourceManifestPath, manifest);
  const bindingPath = path.join(root, 'binding.json');
  const binding = { schemaVersion: 1, kind: 'explicit-approved-reissue-execution-binding', reissuePlanPath, expectedReissuePlanFileSha256: hashFile(reissuePlanPath), inputs, expectedContractSha256, reviewPath, expectedReviewSha256: hashFile(reviewPath), payloadPath, expectedPayloadSha256: hashFile(payloadPath), runtimePath, expectedRuntimeSha256: hashFile(runtimePath), sourceManifestPath, expectedSourceManifestSha256: hashFile(sourceManifestPath) }; write(bindingPath, binding);
  const f = { root, ledger, target, key, body, payload: reviewed.payloadMarkdown, bindingPath, binding, runtime, manifest, binary, newPrefix: path.join(ledger, sha256(key)) };
  f.pin = () => hashFile(bindingPath);
  f.repinRuntime = () => { write(runtimePath, runtime); binding.expectedRuntimeSha256 = hashFile(runtimePath); write(bindingPath, binding); };
  f.repinManifest = () => { write(sourceManifestPath, manifest); binding.expectedSourceManifestSha256 = hashFile(sourceManifestPath); write(bindingPath, binding); };
  f.options = plan => ({ bindingPath, expectedBindingSha256: f.pin(), expectedPlanSha256: plan.planSha256, authorized: true, env: { X_DAILY_ALLOW_REISSUE_SEND: '1', LARKSUITE_CLI_APP_SECRET: 'SYNTHETIC_NOT_REAL' } });
  return f;
}
