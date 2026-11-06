/**
 * Recovery review gate. This validates recorded review coverage and exact bytes;
 * it cannot prove a reviewer's identity, independence, honesty, or comprehension.
 * No function approves a review automatically, invokes a model, or sends data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const KIND = 'x-daily-recovery-review-v1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = sha256;
const meaningful = value => typeof value === 'string' && value.trim().length > 0;
const instant = (value, label) => {
  if (!meaningful(value) || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${label} timestamp`);
  }
  return Date.parse(value);
};

function fileUnderRoot(rootDir, relativePath) {
  if (!meaningful(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') ||
      path.posix.isAbsolute(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Review artifact path must be a safe relative path');
  }
  const root = path.resolve(rootDir);
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error('Review root must be a real directory without symlinks');
  let target = root;
  for (const part of relativePath.split('/')) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Review artifact symlinks are forbidden');
  }
  if (!fs.statSync(target).isFile()) throw new Error('Review artifact must be a regular file');
  return { bytes: fs.readFileSync(target), path: relativePath };
}

/** Every body block is reviewed, including non-bullet and audit text. */
export function deriveReviewUnits(markdown, renderedMarkdown) {
  if (!meaningful(markdown) || !meaningful(renderedMarkdown)) throw new Error('Digest and exact render are required');
  const units = [];
  let block = [], role = 'main', fenced = false, bullet = false;
  const flush = () => {
    const text = block.join('\n').trim();
    if (text) {
      const sha256 = hash(text);
      units.push({ id: `${role}-${units.length + 1}-${sha256.slice(0, 12)}`, kind: role, sha256, text });
    }
    block = []; bullet = false;
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; block.push(line); continue; }
    if (!fenced && /^#{1,6}\s/.test(line)) {
      flush();
      if (/^##\s+差异补充\s*$/.test(line)) role = 'audit';
      continue;
    }
    if (!fenced && /^<!-- x-daily-collection: [a-zA-Z0-9-]+ -->\s*$/.test(line)) { flush(); continue; }
    if (!fenced && /^(?:[-*+]|\d+[.)])\s/.test(line)) { flush(); bullet = true; block.push(line); continue; }
    if (!fenced && !line.trim() && !bullet) { flush(); continue; }
    block.push(line);
  }
  flush();
  if (!units.some(unit => unit.kind === 'main')) throw new Error('Digest requires main review units');
  const sha256 = hash(renderedMarkdown);
  units.push({ id: `render-${sha256.slice(0, 12)}`, kind: 'render', sha256, text: renderedMarkdown });
  return units;
}

/**
 * All paths are relative to rootDir. A fresh material file and at least one
 * preserved evidence file are required: history notes are not original evidence.
 * renderedMarkdown must be the exact delivery payload; an optional dispositionsPath is bound like the digest.
 */
export function buildReviewSnapshot({ rootDir, digestPath, sourcesPath, dispositionsPath, materialsPaths, evidencePaths, renderedMarkdown, authorId }) {
  if (!meaningful(rootDir) || !meaningful(authorId)) throw new Error('Review root and author identity are required');
  if (!Array.isArray(materialsPaths) || !materialsPaths.length || !Array.isArray(evidencePaths) || !evidencePaths.length) {
    throw new Error('Review requires material and evidence files');
  }
  if (!meaningful(renderedMarkdown)) throw new Error('Exact rendered Markdown is required');
  const descriptors = [
    { role: 'digest', path: digestPath }, { role: 'sources', path: sourcesPath },
    ...(dispositionsPath === undefined ? [] : [{ role: 'dispositions', path: dispositionsPath }]),
    ...materialsPaths.map(file => ({ role: 'material', path: file })),
    ...evidencePaths.map(file => ({ role: 'evidence', path: file })),
  ];
  if (new Set(descriptors.map(file => file.path)).size !== descriptors.length) throw new Error('Review artifact paths must be unique');
  let markdown, sources;
  const files = descriptors.map(descriptor => {
    const file = fileUnderRoot(rootDir, descriptor.path);
    if (descriptor.role === 'digest') markdown = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    if (descriptor.role === 'sources') {
      sources = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
      if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('Review sources must be a JSON object');
    }
    return { ...descriptor, sha256: hash(file.bytes), sizeBytes: file.bytes.length };
  }).sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path));
  const provenance = sources.provenance;
  if (provenance && (Object.hasOwn(provenance, 'evidence') || provenance.transport === 'gos-supported-browser')) {
    if (!Array.isArray(provenance.evidence) || !provenance.evidence.length) throw new Error('Source provenance requires nonempty evidence records');
    const declared = new Set();
    const actualEvidence = new Map(files.filter(file => file.role === 'evidence').map(file => [file.path, file.sha256]));
    for (const evidence of provenance.evidence) {
      if (!evidence || !meaningful(evidence.path) || declared.has(evidence.path)) throw new Error('Source provenance has missing or duplicate evidence paths');
      declared.add(evidence.path);
      if (!actualEvidence.has(evidence.path)) throw new Error('Source provenance evidence omitted from review snapshot');
      if (!/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') || actualEvidence.get(evidence.path) !== evidence.sha256) {
        throw new Error('Source provenance evidence hash does not match the actual file');
      }
    }
  }
  const units = deriveReviewUnits(markdown, renderedMarkdown);
  const bindings = { authorId, files, renderedSha256: hash(renderedMarkdown), units: units.map(({ text, ...unit }) => unit) };
  return { bindings, snapshotSha256: hash(JSON.stringify(bindings)), units };
}

/** Creates pending records only. An independent reviewer must supply findings. */
export function createReviewInput(options) {
  const snapshot = buildReviewSnapshot(options);
  const createdAt = options.now ?? new Date().toISOString();
  instant(createdAt, 'review creation');
  return {
    schemaVersion: 1, kind: KIND, status: 'pending', createdAt,
    authorId: options.authorId, reviewerId: null, reviewedAt: null,
    snapshotSha256: snapshot.snapshotSha256, bindings: snapshot.bindings,
    unresolvedIssues: [],
    units: snapshot.units.map(unit => ({ ...unit, status: 'pending', unresolvedIssues: [],
      comprehension: { status: 'pending', sourceBlind: false, checkedAt: null,
        reconstruction: { problem: null, method: null, result: null, innovation: null }, notes: null },
      fidelity: { status: 'pending', checkedAt: null, sourcePaths: [], notes: null },
    })),
  };
}

/** Throws unless the complete approved record matches the exact current bytes. */
export function validateReview(review, options) {
  if (review?.schemaVersion !== 1 || review?.kind !== KIND || review?.status !== 'approved') throw new Error('Independent approved recovery review is required');
  if (!meaningful(review.authorId) || !meaningful(review.reviewerId) || review.authorId.trim() === review.reviewerId.trim() || review.authorId !== options.authorId) {
    throw new Error('Review requires a distinct independent reviewer and matching author identity');
  }
  const created = instant(review.createdAt, 'review creation');
  const reviewed = instant(review.reviewedAt, 'review completion');
  if (reviewed < created) throw new Error('Review completion precedes creation');
  if (!Array.isArray(review.unresolvedIssues) || review.unresolvedIssues.length) throw new Error('Review has unresolved issues');
  const snapshot = buildReviewSnapshot(options);
  if (review.snapshotSha256 !== snapshot.snapshotSha256 || JSON.stringify(review.bindings) !== JSON.stringify(snapshot.bindings)) {
    throw new Error('Review binding is stale or tampered: digest, render, sources, dispositions, materials, or evidence changed');
  }
  if (!Array.isArray(review.units) || review.units.length !== snapshot.units.length) throw new Error('Review unit coverage is incomplete');
  const permittedSources = new Set(snapshot.bindings.files.filter(file => !['digest', 'dispositions'].includes(file.role)).map(file => file.path));
  for (const [index, expected] of snapshot.units.entries()) {
    const unit = review.units[index];
    if (!unit || ['id', 'kind', 'sha256', 'text'].some(key => unit[key] !== expected[key]) || unit.status !== 'approved') {
      throw new Error(`Review unit ${expected.id} is missing, changed, or not approved`);
    }
    if (!Array.isArray(unit.unresolvedIssues) || unit.unresolvedIssues.length) throw new Error(`Review unit ${expected.id} has unresolved issues`);
    const comprehension = unit.comprehension, fidelity = unit.fidelity;
    if (comprehension?.status !== 'pass' || comprehension.sourceBlind !== true || !meaningful(comprehension.notes) ||
        !['problem', 'method', 'result', 'innovation'].every(key => meaningful(comprehension.reconstruction?.[key]))) {
      throw new Error(`Review unit ${expected.id} lacks independent comprehension reconstruction`);
    }
    if (fidelity?.status !== 'pass' || !meaningful(fidelity.notes) || !Array.isArray(fidelity.sourcePaths) || !fidelity.sourcePaths.length ||
        new Set(fidelity.sourcePaths).size !== fidelity.sourcePaths.length || fidelity.sourcePaths.some(file => !permittedSources.has(file))) {
      throw new Error(`Review unit ${expected.id} lacks source-backed fidelity review`);
    }
    const blindAt = instant(comprehension.checkedAt, 'source-blind comprehension');
    const evidenceAt = instant(fidelity.checkedAt, 'source fidelity');
    if (blindAt < created || evidenceAt <= blindAt || reviewed < evidenceAt) throw new Error(`Review unit ${expected.id} requires source-blind reconstruction before evidence checking`);
  }
  return { ok: true, reviewedUnits: snapshot.units.length, reviewerId: review.reviewerId,
    snapshotSha256: snapshot.snapshotSha256, bindings: snapshot.bindings };
}

export const validateApprovedReview = validateReview;
