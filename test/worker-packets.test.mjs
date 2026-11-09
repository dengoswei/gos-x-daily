import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeWorkerPackets, validateWorkerPackets } from '../worker-packets.mjs';
import { candidateKeys } from '../binding.mjs';
import { main } from '../cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'synthetic-worker-packets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcesFile = path.join(root, 'sources.json');
  const collection = {
    collectionId: 'synthetic-workers', date: '2026-11-01', digestMarker: '<!-- synthetic -->',
    sources: {
      xFollowing: Array.from({ length: 53 }, (_, i) => ({ url: `https://x.com/synthetic/status/${i + 1}`, text: `SYNTHETIC ORIGINAL BODY ${i}`, evidenceId: `synthetic-evidence-${i}`, links: [{ href: 'https://paper.example/1' }] })),
      watchProfiles: [{ handle: 'karpathy', items: [{ url: 'https://x.com/synthetic/status/1', text: 'SYNTHETIC ALTERNATE BODY', truncated: true, publishedAt: '2026-10-31T12:00:00Z' }] }],
      deepArticles: [{ url: 'https://paper.example/1', text: 'SYNTHETIC LARGE ORIGINAL '.repeat(20000), truncated: false, evidenceId: 'deep-proof' }],
      threadContexts: [{ url: 'https://x.com/synthetic/status/1', text: 'SYNTHETIC THREAD ORIGINAL', unresolvedReferences: [{ url: 'https://paper.example/unresolved' }] },
        { url: 'https://x.com/synthetic/status/999', text: 'SYNTHETIC UNMATCHED THREAD', dateStatus: 'unknown' }],
    },
    coverage: { window: { from: '2026-10-30T01:00:00Z', to: '2026-11-01T01:00:00Z' } },
    warnings: ['SYNTHETIC partial capture'],
    provenance: { transport: 'synthetic', evidence: [{ id: 'synthetic-evidence-0', path: 'evidence/synthetic.txt', sha256: hash('SYNTHETIC') }] },
  };
  fs.writeFileSync(sourcesFile, JSON.stringify(collection));
  const outputDir = path.join(root, 'packets');
  const read = relative => JSON.parse(fs.readFileSync(path.join(outputDir, relative), 'utf8'));
  return { root, collection, sourcesFile, outputDir, read };
};

test('coordinator remains body-free while every candidate and original observation is retained', t => {
  const f = fixture(t), before = fs.readFileSync(f.sourcesFile);
  const result = writeWorkerPackets(f);
  const coordinator = f.read('coordinator.json');
  assert.equal(result.candidateCount, 54);
  assert.ok(fs.statSync(result.coordinator).size < 10000);
  assert.ok(!JSON.stringify(coordinator).includes('SYNTHETIC ORIGINAL BODY'));
  const rows = coordinator.indexPages.flatMap(ref => f.read(ref.path).items);
  assert.deepEqual(rows.map(row => row.key), candidateKeys(f.collection));
  assert.ok(coordinator.indexPages.every(ref => f.read(ref.path).items.length <= 24));
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC ORIGINAL BODY'));
  assert.equal(rows.length, 54, 'batch size must not become an item quota');
  const packet = f.read(rows[0].packet.path);
  assert.equal(packet.observations[0].item.evidenceId, 'synthetic-evidence-0');
  assert.deepEqual(packet.evidence, f.collection.provenance.evidence);
  assert.deepEqual(f.read(packet.evidenceIndex.path).provenance, f.collection.provenance);
  assert.equal(packet.observations[1].item.text, 'SYNTHETIC ALTERNATE BODY');
  assert.equal(packet.observations[1].item.truncated, true);
  assert.equal(packet.sourceBinding.sha256, hash(before));
  assert.equal(f.read(rows.at(-1).packet.path).observations[0].item.text, f.collection.sources.deepArticles[0].text);
  assert.deepEqual(fs.readFileSync(f.sourcesFile), before);
  assert.equal(validateWorkerPackets(f.outputDir).candidates, 54);
});

test('story routing retains related originals, shared-link leads, published history and unmatched threads', t => {
  const f = fixture(t);
  writeWorkerPackets({ ...f, publishedHistory: [{ date: '2026-10-31', urls: ['https://paper.example/1'] }] });
  const coordinator = f.read('coordinator.json'), row = f.read(coordinator.indexPages[0].path).items[0];
  const story = f.read(row.story.path);
  assert.equal(story.materials.length, 1);
  assert.equal(story.threadContexts.length, 1);
  assert.equal(f.read(story.threadContexts[0].path).original.unresolvedReferences[0].url, 'https://paper.example/unresolved');
  assert.ok(story.sharedLinkLeads.length > 0);
  assert.deepEqual(f.read(story.history.path).publishedRecently, [{ date: '2026-10-31', urls: ['https://paper.example/1'] }]);
  const supplemental = f.read(coordinator.supplementalIndex.path);
  assert.equal(supplemental.threadContexts.length, 2);
  assert.equal(f.read(supplemental.threadContexts[1].packet.path).thread.dateStatus, 'unknown');
});

test('source batches assign each candidate once without copying original bodies', t => {
  const f = fixture(t); writeWorkerPackets(f);
  const coordinator = f.read('coordinator.json'), packets = coordinator.sourcePackets.map(ref => f.read(ref.path));
  const keys = packets.flatMap(packet => packet.items.map(item => item.key));
  assert.equal(keys.length, 54);
  assert.equal(new Set(keys).size, 54);
  assert.ok(packets.every(packet => packet.items.length <= 24));
  assert.ok(!JSON.stringify(packets).includes('SYNTHETIC ORIGINAL BODY'));
});

test('hash verification rejects changed packet bytes and path escapes', t => {
  const f = fixture(t); writeWorkerPackets(f);
  const c = f.read('coordinator.json'), ref = f.read(c.indexPages[0].path).items[0].packet;
  fs.appendFileSync(path.join(f.outputDir, ref.path), ' ');
  assert.throws(() => validateWorkerPackets(f.outputDir), /packet changed/);
  c.inventory.path = '../sources.json';
  fs.writeFileSync(path.join(f.outputDir, 'coordinator.json'), JSON.stringify(c));
  assert.throws(() => validateWorkerPackets(f.outputDir), /safe relative paths/);
});

test('refuses existing outputs and input/output symlinks without overwriting data', t => {
  const f = fixture(t); writeWorkerPackets(f);
  const before = fs.readFileSync(path.join(f.outputDir, 'coordinator.json'));
  assert.throws(() => writeWorkerPackets(f), /must be new/);
  assert.deepEqual(fs.readFileSync(path.join(f.outputDir, 'coordinator.json')), before);
  fs.symlinkSync(f.sourcesFile, path.join(f.root, 'source-alias.json'));
  assert.throws(() => writeWorkerPackets({ ...f, sourcesFile: path.join(f.root, 'source-alias.json'), outputDir: path.join(f.root, 'new') }), /non-symlink/);
  fs.symlinkSync(f.outputDir, path.join(f.root, 'output-alias'));
  assert.throws(() => writeWorkerPackets({ ...f, outputDir: path.join(f.root, 'output-alias') }), /must be new/);
  assert.throws(() => validateWorkerPackets(path.join(f.root, 'output-alias')), /symlink/);
});

test('long discovery titles are bounded only in indexes; packet keeps exact original', t => {
  const f = fixture(t); f.collection.sources.xFollowing[0].title = 'SYNTHETIC TITLE '.repeat(5000);
  fs.writeFileSync(f.sourcesFile, JSON.stringify(f.collection)); writeWorkerPackets(f);
  const c = f.read('coordinator.json'), row = f.read(c.indexPages[0].path).items[0];
  assert.equal(row.title.length, 180); assert.equal(row.titleTruncated, true);
  assert.equal(f.read(row.packet.path).candidate.title, f.collection.sources.xFollowing[0].title);
});

test('CLI writes worker manifest without exposing any original body in stdout result', async t => {
  const f = fixture(t);
  const result = await main(['worker-input', '--sources', f.sourcesFile, '--out', f.outputDir]);
  assert.equal(result.status, 'worker_packets_written');
  assert.equal(result.notApproval, true);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC ORIGINAL'));
  assert.equal(validateWorkerPackets(f.outputDir).candidates, 54);
});
