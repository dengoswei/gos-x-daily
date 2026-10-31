import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewInput, validateReview, buildReviewSnapshot, deriveReviewUnits, sha256 } from '../review.mjs';

function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-review-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const markdown = '# X AI 日报 2026-10-30\n<!-- x-daily-collection: synthetic -->\n\n## Frameworks / Infra\n- First method and result. https://example.invalid/a\n\n- Second method. https://example.invalid/b\n\n## Breakthrough Research\nNo items.\n\n## Applications / Products\nNo items.\n\n## 差异补充\n- Incomplete coverage.\n\nSource dates are uncertain.\n';
  fs.writeFileSync(path.join(rootDir, 'digest.md'), markdown);
  fs.writeFileSync(path.join(rootDir, 'sources.json'), '{"synthetic":true}\n');
  fs.writeFileSync(path.join(rootDir, 'materials.json'), '{"synthetic":true,"not_live_evidence":true}\n');
  fs.mkdirSync(path.join(rootDir, 'evidence'));
  fs.writeFileSync(path.join(rootDir, 'evidence/source.txt'), 'SYNTHETIC only, not live evidence\n');
  return { rootDir, digestPath: 'digest.md', sourcesPath: 'sources.json', materialsPaths: ['materials.json'],
    evidencePaths: ['evidence/source.txt'], renderedMarkdown: markdown.split('## 差异补充')[0], authorId: 'synthetic-author', now: '2026-10-30T01:00:00Z' };
}

function syntheticApproval(options) {
  // Synthetic fixture only: no production auto-approval entry point exists.
  const review = createReviewInput(options);
  review.status = 'approved'; review.reviewerId = 'synthetic-independent-reviewer'; review.reviewedAt = '2026-10-30T01:03:00Z';
  for (const unit of review.units) {
    unit.status = 'approved';
    unit.comprehension = { status: 'pass', sourceBlind: true, checkedAt: '2026-10-30T01:01:00Z',
      reconstruction: { problem: 'Synthetic baseline', method: 'Synthetic method', result: 'Synthetic result', innovation: 'Synthetic mechanism, not a measured gain' }, notes: 'Synthetic blind-read notes' };
    unit.fidelity = { status: 'pass', checkedAt: '2026-10-30T01:02:00Z', sourcePaths: ['sources.json', 'materials.json', 'evidence/source.txt'], notes: 'Synthetic evidence comparison' };
  }
  return review;
}

test('review input is pending and binds physical bytes plus exact renderer output', t => {
  const options = setup(t), review = createReviewInput(options);
  assert.equal(review.status, 'pending'); assert.equal(review.reviewerId, null);
  assert.equal(review.bindings.files.length, 4);
  assert.equal(review.bindings.files.find(file => file.role === 'digest').sizeBytes, fs.statSync(path.join(options.rootDir, 'digest.md')).size);
  assert.ok(review.units.some(unit => unit.kind === 'audit'));
  assert.equal(review.units.at(-1).text, options.renderedMarkdown);
  assert.throws(() => validateReview(review, options), /approved/);
});

test('complete independent synthetic approval validates without network or send', t => {
  const options = setup(t), review = syntheticApproval(options);
  const result = validateReview(review, options);
  assert.equal(result.ok, true); assert.equal(result.reviewedUnits, review.units.length);
  assert.equal(result.snapshotSha256, buildReviewSnapshot(options).snapshotSha256);
});

test('missing, pending, failed, and self-reviewed records cannot pass', t => {
  const options = setup(t);
  assert.throws(() => validateReview(undefined, options), /approved/);
  for (const mutate of [r => { r.status = 'failed'; }, r => { r.reviewerId = r.authorId; }, r => { r.reviewerId = ' '; }, r => { r.schemaVersion = 2; }]) {
    const review = syntheticApproval(options); mutate(review); assert.throws(() => validateReview(review, options));
  }
});

test('every raw artifact change and exact-render change invalidate the review', t => {
  const options = setup(t), review = syntheticApproval(options);
  for (const file of ['digest.md', 'sources.json', 'materials.json', 'evidence/source.txt']) {
    const target = path.join(options.rootDir, file), original = fs.readFileSync(target);
    fs.appendFileSync(target, '\n');
    assert.throws(() => validateReview(review, options), /stale|tampered/);
    fs.writeFileSync(target, original);
  }
  assert.throws(() => validateReview(review, { ...options, renderedMarkdown: `${options.renderedMarkdown}\n` }), /stale|tampered/);
  assert.throws(() => validateReview(review, { ...options, authorId: 'another-author' }), /identity/);
});

test('an optional dispositions ledger is hashed into the snapshot and invalidates approval when edited', t => {
  const options = setup(t);
  fs.writeFileSync(path.join(options.rootDir, 'dispositions.json'), '{"schemaVersion":1,"items":[]}\n');
  const bound = { ...options, dispositionsPath: 'dispositions.json' }, review = syntheticApproval(bound);
  assert.equal(review.bindings.files.find(file => file.role === 'dispositions').path, 'dispositions.json');
  assert.equal(validateReview(review, bound).ok, true);
  assert.throws(() => validateReview(review, options), /stale|tampered/);
  fs.appendFileSync(path.join(options.rootDir, 'dispositions.json'), '\n');
  assert.throws(() => validateReview(review, bound), /stale|tampered/);
  const unit = syntheticApproval(bound); unit.units[0].fidelity.sourcePaths = ['dispositions.json'];
  assert.throws(() => validateReview(unit, bound), /fidelity/);
});

test('omitted, duplicated, reordered, or edited units cannot masquerade as full review', t => {
  const options = setup(t);
  for (const mutate of [r => r.units.pop(), r => { r.units[1] = structuredClone(r.units[0]); }, r => r.units.reverse(), r => { r.units[0].text += 'changed'; }, r => { r.units[0].sha256 = '0'.repeat(64); }]) {
    const review = syntheticApproval(options); mutate(review); assert.throws(() => validateReview(review, options), /unit/i);
  }
});

test('comprehension and fidelity must pass separately, with source-blind order and no issues', t => {
  const options = setup(t);
  for (const mutate of [
    r => { r.units[0].comprehension.status = 'fail'; },
    r => { r.units[0].comprehension.sourceBlind = false; },
    r => { r.units[0].comprehension.reconstruction.method = ''; },
    r => { r.units[0].fidelity.status = 'pending'; },
    r => { r.units[0].fidelity.notes = ''; },
    r => { r.units[0].fidelity.sourcePaths = ['unknown.txt']; },
    r => { r.units[0].fidelity.checkedAt = r.units[0].comprehension.checkedAt; },
    r => { r.units[0].comprehension.checkedAt = '2026-10-29T00:00:00Z'; },
    r => { r.reviewedAt = '2026-10-30T01:01:30Z'; },
    r => { r.units[0].unresolvedIssues.push('unclear method'); },
    r => { r.unresolvedIssues.push('missing evidence'); },
  ]) {
    const review = syntheticApproval(options); mutate(review); assert.throws(() => validateReview(review, options));
  }
});

test('missing evidence/materials, escaping paths, symlinks, and duplicate files fail closed', t => {
  const options = setup(t);
  for (const change of [
    { evidencePaths: [] }, { materialsPaths: [] }, { evidencePaths: ['../outside.txt'] },
    { evidencePaths: ['/etc/passwd'] }, { evidencePaths: ['evidence/./source.txt'] },
    { evidencePaths: ['evidence/missing.txt'] }, { evidencePaths: ['evidence'] },
    { evidencePaths: ['sources.json'] },
  ]) assert.throws(() => createReviewInput({ ...options, ...change }));
  fs.symlinkSync('source.txt', path.join(options.rootDir, 'evidence/link.txt'));
  assert.throws(() => createReviewInput({ ...options, evidencePaths: ['evidence/link.txt'] }), /symlink/);
});

test('all body and audit blocks plus exact render receive deterministic units', () => {
  const markdown = '# Heading\nIntro text.\n\n- Bullet A\n  continued\n\n- Bullet B\n## 差异补充\n- Audit A\n- Audit B\n';
  const units = deriveReviewUnits(markdown, 'exact-render\n');
  assert.equal(units.filter(unit => unit.kind === 'main').length, 3);
  assert.equal(units.filter(unit => unit.kind === 'audit').length, 2);
  assert.deepEqual(units, deriveReviewUnits(markdown, 'exact-render\n'));
});

test('source provenance cannot omit, duplicate, or falsify declared evidence bytes', t => {
  const options = setup(t);
  const sourcesFile = path.join(options.rootDir, options.sourcesPath);
  const source = { provenance: { transport: 'gos-supported-browser', evidence: [{ path: 'evidence/source.txt', sha256: sha256(fs.readFileSync(path.join(options.rootDir, 'evidence/source.txt'))) }] } };
  const save = value => fs.writeFileSync(sourcesFile, JSON.stringify(value));
  save(source);
  assert.equal(createReviewInput(options).status, 'pending');
  fs.writeFileSync(path.join(options.rootDir, 'evidence/other.txt'), 'SYNTHETIC different');
  assert.throws(() => createReviewInput({ ...options, evidencePaths: ['evidence/other.txt'] }), /omitted/);
  for (const mutate of [
    s => { s.provenance.evidence.push(structuredClone(s.provenance.evidence[0])); },
    s => { s.provenance.evidence[0].sha256 = '0'.repeat(64); },
    s => { s.provenance.evidence[0].path = undefined; },
    s => { s.provenance.evidence = []; },
    s => { delete s.provenance.evidence; },
  ]) {
    const changed = structuredClone(source); mutate(changed); save(changed);
    assert.throws(() => createReviewInput(options), /evidence/);
  }
  fs.writeFileSync(sourcesFile, 'invalid JSON');
  assert.throws(() => createReviewInput(options), /JSON/);
});
