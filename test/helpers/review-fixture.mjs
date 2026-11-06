// TEST-ONLY SYNTHETIC FIXTURES. Never import this module in production, a CLI,
// or a real publication controller. These invented reviews approve no real text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewInput } from '../../review.mjs';
import { larkMarkdown } from '../../digest.mjs';
import { candidateKeys, digestUrls } from '../../binding.mjs';
import { initializeDeliveryLedger } from '../../delivery-ledger.mjs';

export function approveSyntheticReview(options) {
  const review = createReviewInput(options);
  review.status = 'approved';
  review.reviewerId = 'SYNTHETIC-independent-reviewer';
  const start = Date.parse(review.createdAt);
  review.reviewedAt = new Date(start + 3000).toISOString();
  for (const unit of review.units) {
    unit.status = 'approved';
    unit.comprehension = {
      status: 'pass', sourceBlind: true, checkedAt: new Date(start + 1000).toISOString(),
      reconstruction: {
        problem: 'SYNTHETIC baseline problem, not a real source assessment.',
        method: 'SYNTHETIC concrete method reconstructed only for a structural test.',
        result: 'SYNTHETIC result; no real benchmark, gain, or deployment is claimed.',
        innovation: 'SYNTHETIC mechanism explanation, not an invented numeric improvement.',
      },
      notes: 'SYNTHETIC source-blind comprehension record for an offline test only.',
    };
    unit.fidelity = {
      status: 'pass', checkedAt: new Date(start + 2000).toISOString(),
      sourcePaths: [options.sourcesPath, ...options.materialsPaths, ...options.evidencePaths],
      notes: 'SYNTHETIC source-fidelity record. No real source was reviewed.',
    };
  }
  return review;
}

// SYNTHETIC ledger: the first candidate is included under the first section with the
// first cited URL; every other candidate is skipped. Other cited URLs become supplements.
export function syntheticDispositions(collection, markdown) {
  const [first, ...rest] = candidateKeys(collection), [url, ...supplements] = digestUrls(markdown);
  const section = markdown.split('\n').find(line => /^## /.test(line)).slice(3).trim();
  const items = [{ key: first, disposition: 'included', section, url }];
  if (rest.length) items.push({ keys: rest, disposition: 'skipped', reason: 'low_signal' });
  return { dispositions: { schemaVersion: 1, collectionId: collection.collectionId, items }, supplements };
}

export function createSyntheticReviewedFixture(t, overrides = {}) {
  if (typeof t?.after !== 'function') throw new Error('Synthetic helper requires node:test cleanup context');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-SYNTHETIC-publication-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const collection = overrides.collection ?? {
    collectionId: 'SYNTHETIC-recovery', digestMarker: '<!-- x-daily-collection: SYNTHETIC-recovery -->', date: '2026-10-30',
    stats: { xFollowing: 1 }, sources: { xFollowing: [{ url: 'https://example.invalid/SYNTHETIC', text: 'SYNTHETIC source, not live evidence' }] },
  };
  const markdown = overrides.markdown ?? `# X AI 日报 ${collection.date}\n${collection.digestMarker}\n\n## Frameworks / Infra\n- SYNTHETIC method and result, not real evidence. https://example.invalid/SYNTHETIC\n\n## Breakthrough Research\nNo synthetic item.\n\n## Applications / Products\nNo synthetic item.\n\n## 差异补充\nSYNTHETIC incomplete source audit.\n`;
  const generated = syntheticDispositions(collection, markdown);
  const dispositions = overrides.dispositions ?? generated.dispositions;
  const snapshotInputs = {
    digestPath: 'digest.md', sourcesPath: 'sources.json', dispositionsPath: 'dispositions.json', materialsPaths: ['materials.json'],
    evidencePaths: ['evidence/source.txt'], authorId: 'SYNTHETIC-author',
  };
  fs.mkdirSync(path.join(rootDir, 'evidence'));
  fs.writeFileSync(path.join(rootDir, snapshotInputs.digestPath), markdown);
  fs.writeFileSync(path.join(rootDir, snapshotInputs.sourcesPath), JSON.stringify(collection, null, 2) + '\n');
  fs.writeFileSync(path.join(rootDir, 'dispositions.json'), JSON.stringify(dispositions, null, 2) + '\n');
  fs.writeFileSync(path.join(rootDir, 'materials.json'), JSON.stringify({ kind: 'SYNTHETIC-TEST-NOT-EVIDENCE', items: generated.supplements.map(url => ({ url })) }) + '\n');
  fs.writeFileSync(path.join(rootDir, 'evidence/source.txt'), 'SYNTHETIC preserved bytes for offline structural tests. Not live evidence.\n');
  const options = { ...snapshotInputs, rootDir, renderedMarkdown: overrides.renderedMarkdown ?? larkMarkdown(markdown, collection, { dispositions }),
    now: '2026-10-30T01:00:00.000Z' };
  const review = approveSyntheticReview(options);
  const reviewPath = 'review.approved.json';
  fs.writeFileSync(path.join(rootDir, reviewPath), JSON.stringify(review, null, 2) + '\n');
  const ledgerDir = path.join(rootDir, 'ledger');
  initializeDeliveryLedger(ledgerDir, { notBeforeDate: overrides.notBeforeDate ?? collection.date, createdBy: 'SYNTHETIC-test-controller' });
  const target = overrides.target ?? {
    enabled: true, userId: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deploymentId: 'gos-SYNTHETIC-test', executable: '/SYNTHETIC/not-a-real-lark-wrapper',
  };
  const publication = { rootDir, snapshotInputs, reviewPath, ledgerDir };
  return { rootDir, collection, markdown, dispositions, snapshotInputs, options, review, reviewPath, ledgerDir, target, publication };
}
