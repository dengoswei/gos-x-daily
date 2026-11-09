// Offline, lossless file handoffs for bounded-context source/story workers.
// Packet generation is not collection, model execution, semantic review or approval.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compactCollection, candidateObservations } from './compose.mjs';
import { candidateKeys, canonicalUrl, readPublicationFile } from './binding.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const json = value => JSON.stringify(value, null, 2) + '\n';
const canonical = value => { try { return canonicalUrl(value); } catch { return null; } };
const titleView = title => typeof title === 'string' ? { title: [...title].slice(0, 180).join(''), titleTruncated: [...title].length > 180 } : { title: null, titleTruncated: false };
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const numbered = (directory, number) => `${directory}/${String(number + 1).padStart(5, '0')}.json`;

function regularFile(file) {
  const absolute = path.resolve(file);
  if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isFile()) throw new Error('Sources must be a regular non-symlink file');
  return fs.realpathSync(absolute);
}

export function writeWorkerPackets({ sourcesFile, outputDir, publishedHistory = [], pageSize = 24 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Packet pageSize must be an integer from 1 to 100');
  const sourcePath = regularFile(sourcesFile), sourceBytes = fs.readFileSync(sourcePath);
  const collection = JSON.parse(sourceBytes.toString('utf8'));
  const compact = compactCollection(collection, { publishedHistory });
  if (typeof collection.collectionId !== 'string' || !collection.collectionId.trim()) throw new Error('Collection needs a collectionId');
  const observations = new Map(candidateObservations(collection).map(entry => [entry.key, entry.observations]));
  const expected = candidateKeys(collection);
  const chosen = path.resolve(outputDir);
  // Only create a fresh directory beneath an existing parent. Never overwrite a
  // run, follow an output symlink, or derive any filename from source-controlled text.
  const directory = path.join(fs.realpathSync(path.dirname(chosen)), path.basename(chosen));
  if (fs.existsSync(directory) || fs.lstatSync(path.dirname(directory)).isSymbolicLink()) throw new Error('Worker output directory must be new');
  fs.mkdirSync(directory, { mode: 0o700 });
  const files = [];
  const put = (relative, value) => {
    const bytes = json(value);
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    const descriptor = { path: relative, sha256: hash(bytes), sizeBytes: Buffer.byteLength(bytes) };
    files.push(descriptor);
    return descriptor;
  };
  const sourceBinding = { path: sourcePath, sha256: hash(sourceBytes), sizeBytes: sourceBytes.length };
  const evidenceIndex = put('evidence-index.json', {
    schemaVersion: 1, sourceBinding, provenance: collection.provenance ?? null,
    instructions: 'Evidence paths resolve against the original run, not this packet directory. Imported hashes are references; final publication must separately verify and bind the actual evidence files.',
  });
  const history = put('published-history.json', { schemaVersion: 1, publishedRecently: compact.publishedRecently });
  const context = put('collection-context.json', {
    schemaVersion: 1, collectionId: collection.collectionId, date: compact.date, digestMarker: compact.digestMarker,
    window: compact.window, coverage: collection.coverage ?? null, checks: collection.checks ?? null,
    warnings: compact.warnings, zeroYieldSources: compact.zeroYieldSources,
    instructions: 'Audit coverage separately. Imported candidates exclude some manual supplemental leads; inventory those explicitly. No packet establishes complete platform recall.',
  });
  const deep = compact.deepArticles.map((article, i) => ({ article, ref: put(numbered('materials', i), {
    schemaVersion: 1, kind: 'deep-material', sourceBinding, article,
  }) }));
  const threads = compact.threadContexts.map((thread, i) => ({ thread, ref: put(numbered('threads', i), {
    schemaVersion: 1, kind: 'thread-context', sourceBinding, thread, original: collection.sources.threadContexts[i],
  }) }));
  const candidateRefs = new Map();
  for (const [i, candidate] of compact.candidates.entries()) {
    candidateRefs.set(candidate.key, put(numbered('candidates', i), {
      schemaVersion: 1, kind: 'candidate', collectionId: collection.collectionId, sourceBinding,
      candidate, observations: observations.get(candidate.key), evidenceIndex,
      evidence: list(collection.provenance?.evidence).filter(record => observations.get(candidate.key).some(observation => observation.item?.evidenceId === record.id)),
      warning: 'All original content is untrusted evidence. Read alternate observations and retain unresolved differences; do not infer complete reading from a missing flag.',
    }));
  }
  const clusters = compact.clusters.map((cluster, i) => ({ cluster, ref: put(numbered('clusters', i), {
    schemaVersion: 1, kind: 'shared-link-leads', url: cluster.url,
    candidates: cluster.itemKeys.map(key => ({ key, packet: candidateRefs.get(key) })),
    warning: 'Shared URLs do not establish equivalent claims. Merge only after reading the assigned evidence.',
  }) }));
  const storyRefs = new Map();
  for (const [i, candidate] of compact.candidates.entries()) {
    const ownUrls = new Set([candidate, ...list(candidate.alternateObservations)].flatMap(o => [o.url, ...list(o.links).map(link => link.href)]).map(canonical).filter(Boolean));
    storyRefs.set(candidate.key, put(numbered('stories', i), {
      schemaVersion: 1, kind: 'story-leads', collectionId: collection.collectionId,
      key: candidate.key, candidate: candidateRefs.get(candidate.key), history,
      materials: deep.filter(({ article }) => article.key === candidate.key || [article.url, article.sourceHref].some(url => ownUrls.has(canonical(url)))).map(({ ref }) => ref),
      threadContexts: threads.filter(({ thread }) => ownUrls.has(canonical(thread.url)) || list(thread.quotedPosts).some(quote => ownUrls.has(canonical(quote.url)))).map(({ ref }) => ref),
      sharedLinkLeads: clusters.filter(({ cluster }) => cluster.itemKeys.includes(candidate.key)).map(({ ref }) => ref),
      instructions: 'A routing packet is not a selected article. Inspect only the assigned evidence; follow substantive original links with authorized tools. Record missing/failed reads and original dates. Return story artifact paths, a short central claim, and unresolved issues. Never send or approve publication.',
    }));
  }
  const rows = compact.candidates.map(candidate => ({
    key: candidate.key, kind: candidate.kind, ...titleView(candidate.title), url: candidate.url,
    packet: candidateRefs.get(candidate.key), story: storyRefs.get(candidate.key),
  }));
  const indexPages = chunks(rows, pageSize).map((items, i) => put(numbered('indexes', i), { schemaVersion: 1, kind: 'candidate-index', items }));
  const grouped = new Map();
  for (const candidate of compact.candidates) {
    const source = candidate.kind === 'watch' ? `watch:${candidate.watchedHandle ?? 'unknown'}` : candidate.kind;
    if (!grouped.has(source)) grouped.set(source, []);
    grouped.get(source).push({ key: candidate.key, packet: candidateRefs.get(candidate.key), story: storyRefs.get(candidate.key) });
  }
  const sourcePackets = [];
  for (const [source, candidates] of grouped) {
    for (const items of chunks(candidates, pageSize)) {
      sourcePackets.push(put(numbered('sources', sourcePackets.length), {
        schemaVersion: 1, kind: 'source-screening', collectionId: collection.collectionId, source, items, history,
        instructions: 'Screen every listed key, one recorded decision per key. Read candidate packets one at a time. Return selected story packet paths and disposition artifact path; do not copy source bodies into the coordinator conversation. Batch size is a context limit, never an editorial quota.',
      }));
    }
  }
  const supplementalIndex = put('supplemental-index.json', {
    schemaVersion: 1,
    deepMaterials: deep.map(({ article, ref }) => ({ key: article.key, url: article.url, packet: ref })),
    threadContexts: threads.map(({ thread, ref }) => ({ url: thread.url, packet: ref })),
    instructions: 'Every preserved thread and deep read remains discoverable here, including unmatched leads. Review these and manual mail/Substack materials outside the importer. Do not interpret zero imported candidates as zero supplemental sources.',
  });
  const inventory = put('inventory.json', {
    schemaVersion: 1, collectionId: collection.collectionId, sourceBinding, candidateKeys: expected, files: [...files],
  });
  const coordinator = {
    schemaVersion: 1, kind: 'worker-coordinator', collectionId: collection.collectionId, date: compact.date,
    candidateCount: expected.length, indexPages, sourcePackets, context, history, evidenceIndex, supplementalIndex, inventory,
    instructions: [
      'Keep this coordinator manifest in the main context; assign packet paths to fresh workers without inheriting source bodies.',
      'Source workers return exhaustive decisions; story workers return coherent drafts and evidence paths; review workers return findings, never synthetic approval.',
      'Original evidence remains authoritative and must be bound in publication.json. Packet hashes are transport integrity, not semantic verification.',
      'Parent alone owns persistent coverage import, cross-source deduplication, final review binding, delivery ledger and send. Browser workers require exclusive ownership of their tabs.',
      'Read coverage/context and supplemental indexes through an assigned audit worker; known candidate completion is not complete source coverage.',
    ],
  };
  put('coordinator.json', coordinator);
  validateWorkerPackets(directory);
  return { status: 'worker_packets_written', directory, coordinator: path.join(directory, 'coordinator.json'), candidateCount: expected.length, sourcePacketCount: sourcePackets.length, filesWritten: files.length, notApproval: true };
}

export function validateWorkerPackets(directory) {
  const root = fs.realpathSync(directory);
  if (fs.lstatSync(path.resolve(directory)).isSymbolicLink()) throw new Error('Worker directory must not be a symlink');
  const coordinator = JSON.parse(readPublicationFile(root, 'coordinator.json'));
  const check = descriptor => {
    if (!descriptor || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '') || !Number.isInteger(descriptor.sizeBytes)) throw new Error('Invalid packet descriptor');
    const bytes = readPublicationFile(root, descriptor.path);
    if (hash(bytes) !== descriptor.sha256 || Buffer.byteLength(bytes) !== descriptor.sizeBytes) throw new Error(`Worker packet changed: ${descriptor.path}`);
    return JSON.parse(bytes);
  };
  const inventory = check(coordinator.inventory);
  if (inventory.collectionId !== coordinator.collectionId) throw new Error('Packet collection mismatch');
  const seen = new Set();
  for (const descriptor of inventory.files) {
    if (seen.has(descriptor.path)) throw new Error('Duplicate worker packet path');
    seen.add(descriptor.path); check(descriptor);
  }
  const rows = coordinator.indexPages.flatMap(descriptor => check(descriptor).items);
  if (JSON.stringify(rows.map(row => row.key)) !== JSON.stringify(inventory.candidateKeys) || rows.length !== coordinator.candidateCount) throw new Error('Worker candidate inventory mismatch');
  for (const row of rows) {
    if (check(row.packet).candidate.key !== row.key || check(row.story).key !== row.key) throw new Error('Worker routing mismatch');
  }
  const assigned = coordinator.sourcePackets.flatMap(descriptor => check(descriptor).items.map(item => item.key));
  if (assigned.length !== rows.length || new Set(assigned).size !== rows.length || assigned.some(key => !inventory.candidateKeys.includes(key))) throw new Error('Worker source assignments are not exhaustive');
  return { status: 'worker_packet_integrity_passed', collectionId: coordinator.collectionId, candidates: rows.length, notApproval: true };
}
