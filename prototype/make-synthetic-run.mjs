#!/usr/bin/env node
// SYNTHETIC ONLY: builds a clearly fictional captured run (invented handles,
// `example.invalid`/`.invalid` domains, 'SYNTH:' texts) so the prototype
// orchestrator can be exercised offline. This collects nothing and sends nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { main as cliMain } from '../cli.mjs';

const SHARED_LINK = 'https://synth.example.invalid/papers/synth-mechanism';
const DEEP_URL = 'https://synth.example.invalid/papers/synth-mechanism-full';
const PLACEHOLDER = 'SYNTHETIC PLACEHOLDER: not an actual screenshot or source capture.\n';

const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const minutes = count => count * 60000;
const hours = count => count * 3600000;

function evidenceEntry(runDir, { id, url, capturedAt }) {
  const relative = `evidence/${id}.txt`;
  const bytes = Buffer.from(`${PLACEHOLDER}${id}\n`);
  fs.writeFileSync(path.join(runDir, relative), bytes, { flag: 'wx', mode: 0o600 });
  return { id, kind: 'screenshot', url, capturedAt, path: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function bundle(runDir, now) {
  const startedAt = shift(now, -hours(1));
  const published = shift(now, -hours(15));
  const evidence = [
    evidenceEntry(runDir, { id: 'following', url: 'https://x.com/home', capturedAt: shift(now, -minutes(50)) }),
    evidenceEntry(runDir, { id: 'karpathy', url: 'https://x.com/karpathy', capturedAt: shift(now, -minutes(45)) }),
    evidenceEntry(runDir, { id: 'thread', url: 'https://x.com/synththread/status/1005', capturedAt: shift(now, -minutes(40)) }),
    evidenceEntry(runDir, { id: 'deep', url: DEEP_URL, capturedAt: shift(now, -minutes(35)) }),
  ];
  const paper = { href: SHARED_LINK, text: 'SYNTH 合成论文链接' };
  return {
    schemaVersion: 1, transport: 'gos-supported-browser', startedAt, capturedAt: now, evidence,
    feeds: {
      xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'following', items: [
        { url: 'https://x.com/synthwriter/status/1001', publishedAt: published, links: [paper],
          text: 'SYNTH: 合成测试帖，描述一个虚构的推理缓存机制如何降低重复解码开销。' },
        { url: 'https://x.com/synthreader/status/1002', publishedAt: shift(published, minutes(30)), links: [paper],
          text: 'SYNTH: 合成测试帖，转述同一个虚构推理缓存机制并给出自己的实现顾虑。' },
        { url: 'https://x.com/synthpromo/status/1003', publishedAt: shift(published, minutes(60)), links: [],
          text: 'SYNTH: PROMO 合成广告帖，限时报名一个虚构的付费课程，立刻私信领取优惠。' },
        { url: 'https://x.com/synthquoter/status/1004', publishedAt: shift(published, minutes(90)),
          links: [{ href: 'https://x.com/synththread/status/1005', text: 'SYNTH 合成讨论线程' }],
          text: 'SYNTH: 合成测试帖，讨论一条更早的虚构帖子为何在今天重新被提起。' },
      ] }] },
      karpathy: { status: 'ok', pages: [{ evidenceId: 'karpathy', items: [
        { url: 'https://x.com/karpathy/status/1006', publishedAt: shift(published, minutes(120)), links: [],
          text: 'SYNTH: 合成观察账号帖，讨论一个虚构的训练数据配比实验结果。' },
      ] }] },
    },
    deepArticles: [{ url: DEEP_URL, sourceHref: SHARED_LINK, evidenceId: 'deep', title: 'SYNTH 合成机制全文',
      publishedAt: shift(published, -hours(1)),
      text: 'SYNTH: 合成长文正文。虚构机制把重复前缀的解码结果缓存到一个分层索引里，并用一个虚构的命中率指标说明收益。' }],
    threadDiscovery: { schemaVersion: 1, pages: [{ evidenceId: 'thread', items: [{
      url: 'https://x.com/synththread/status/1005', publishedAt: shift(published, minutes(45)), links: [],
      text: 'SYNTH: 合成线程观察文本，转发并评论一条更早的虚构帖子。',
      quotedPosts: [{ url: 'https://x.com/synthorigin/status/900', publishedAt: shift(now, -hours(19 * 24)),
        links: [], text: 'SYNTH: 更早的合成帖子，提出这个虚构机制的最初假设。' }],
      unresolvedReferences: [],
    }] }] },
  };
}

/** Creates outDir (must not exist) with a synthetic bundle, then runs the real offline CLI stages. */
export async function makeSyntheticRun({ outDir, now = '2026-11-08T03:00:00.000Z' }) {
  const runDir = path.resolve(outDir);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.mkdirSync(path.join(runDir, 'evidence'), { mode: 0o700 });
  const artifacts = path.join(runDir, 'browser-capture.json');
  fs.writeFileSync(artifacts, JSON.stringify(bundle(runDir, now), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const configFile = path.join(runDir, 'runtime.json');
  fs.writeFileSync(configFile, JSON.stringify({ collectionEnabled: false, lookbackHours: 48,
    dataDir: path.join(runDir, 'state'), lark: { enabled: false, userId: null, deploymentId: 'SYNTH-prototype', executable: '/SYNTHETIC/never-executed' },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const sourcesFile = path.join(runDir, 'sources.json');
  const promptFile = path.join(runDir, 'prompt.md');
  const packetsDir = path.join(runDir, 'packets');
  const imported = await cliMain(['import-browser', '--artifacts', artifacts, '--out', sourcesFile, '--config', configFile]);
  await cliMain(['compose-input', '--sources', sourcesFile, '--out', promptFile]);
  const packets = await cliMain(['worker-input', '--sources', sourcesFile, '--out', packetsDir]);
  const collection = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  return { status: 'synthetic_run_written', runDir, artifacts, configFile, sourcesFile, promptFile, packetsDir,
    collectionId: collection.collectionId, date: collection.date, candidateCount: packets.candidateCount,
    sourcePacketCount: packets.sourcePacketCount, stats: imported.stats, synthetic: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const out = value('--out');
  if (!out) { console.error('Usage: make-synthetic-run.mjs --out NEW_DIRECTORY [--now ISO]'); process.exit(1); }
  console.log(JSON.stringify(await makeSyntheticRun({ outDir: out, ...(value('--now') ? { now: value('--now') } : {}) }), null, 2));
}
