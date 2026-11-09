// SYNTHETIC ONLY: this test does not collect sources, review real text, or send.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../cli.mjs';
import { larkMarkdown } from '../digest.mjs';
import { initializeDeliveryLedger } from '../delivery-ledger.mjs';
import { approveSyntheticReview } from './helpers/review-fixture.mjs';

test('complete forward run: synthetic browser import, prompt, supplemental material, review and plan without send', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-SYNTHETIC-forward-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeJson = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'evidence'));
  const fakeScreenshot = Buffer.from('SYNTHETIC NOT AN ACTUAL SCREENSHOT OR SOURCE');
  const sha256 = createHash('sha256').update(fakeScreenshot).digest('hex');
  const evidence = ['following', 'karpathy', 'thread'].map((id, index) => {
    const relative = `evidence/${id}.txt`; fs.writeFileSync(path.join(root, relative), fakeScreenshot);
    return { id, kind: 'screenshot', path: relative, sha256, capturedAt: `2026-10-31T03:0${index + 1}:00.000Z`,
      url: id === 'following' ? 'https://x.com/home?filter=following' : id === 'karpathy' ? 'https://x.com/karpathy' : 'https://x.com/writer/status/12345' };
  });
  const bundle = { schemaVersion: 1, transport: 'gos-supported-browser', startedAt: '2026-10-31T03:00:00Z', capturedAt: '2026-10-31T03:05:00Z', evidence,
    feeds: {
      xFollowing: { status: 'ok', view: 'following', pages: [{ evidenceId: 'following', items: [{ url: 'https://x.com/writer/status/12345', text: 'SYNTHETIC Goodfire mechanism discussion', publishedAt: '2026-10-30T12:00:00Z', links: [] }] }] },
      karpathy: { status: 'page_error', pages: [{ evidenceId: 'karpathy', items: [] }] },
    },
    threadDiscovery: { schemaVersion: 1, pages: [{ evidenceId: 'thread', items: [{ url: 'https://x.com/other/status/12346', text: 'SYNTHETIC cross-author Goodfire interpretability explanation', publishedAt: '2026-10-30T13:00:00Z', links: [],
      quotedPosts: [{ url: 'https://x.com/original/status/12347', text: 'SYNTHETIC older Goodfire mechanism hypothesis', publishedAt: '2026-10-15T12:00:00Z', links: [{ href: 'https://goodfire.ai/' }] }] }] }] },
  };
  writeJson('browser-capture.json', bundle);
  const target = { enabled: true, userId: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deploymentId: 'gos-SYNTHETIC-test', executable: '/SYNTHETIC/never-executed' };
  writeJson('runtime.json', { dataDir: path.join(root, 'data'), lookbackHours: 48, collectionEnabled: false, lark: target });
  const priorFetch = globalThis.fetch, priorWs = globalThis.WebSocket;
  globalThis.fetch = () => { throw new Error('No network in synthetic integration'); };
  globalThis.WebSocket = class { constructor() { throw new Error('No browser in synthetic integration'); } };
  t.after(() => { globalThis.fetch = priorFetch; globalThis.WebSocket = priorWs; });
  const imported = await main(['import-browser', '--artifacts', path.join(root, 'browser-capture.json'), '--out', path.join(root, 'sources.json'), '--config', path.join(root, 'runtime.json')]);
  assert.equal(imported.status, 'browser_artifacts_imported');
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json')));
  assert.equal(sources.date, '2026-10-31');
  assert.equal(sources.coverage.accounting.windows['48h'].unscannedHours, 48);
  await main(['compose-input', '--sources', path.join(root, 'sources.json'), '--out', path.join(root, 'prompt.md')]);
  const prompt = fs.readFileSync(path.join(root, 'prompt.md'), 'utf8');
  assert.match(prompt, /cross-author/); assert.match(prompt, /2026-10-15/); assert.match(prompt, /goodfire\.ai/);
  const markdown = `# X AI 日报 ${sources.date}\n${sources.digestMarker}\n\n## Frameworks / Infra\n- SYNTHETIC mechanism only. https://goodfire.ai/\n\n## Breakthrough Research\nNo synthetic item.\n\n## Applications / Products\n- SYNTHETIC received newsletter item. https://newsletter.example.invalid/p/issue-1?utm_source=mail\n\n## 差异补充\nSYNTHETIC Following sample only; Karpathy page error; unknown missed posts.\n`;
  fs.writeFileSync(path.join(root, 'digest.md'), markdown);
  fs.writeFileSync(path.join(root, 'mail-body.txt'), 'SYNTHETIC received email only, not fetched or complete subscription coverage.\n');
  writeJson('materials.json', { kind: 'SYNTHETIC', sourceFiles: ['mail-body.txt'], originalQuoteDate: '2026-10-15' });
  // A saved mail body rarely contains its own URL, so the canonical materials carry it.
  writeJson('canonical-materials.json', { kind: 'SYNTHETIC', items: [{ source: 'gmail', url: 'https://newsletter.example.invalid/p/issue-1', file: 'mail-body.txt' }] });
  writeJson('dispositions.json', { schemaVersion: 1, collectionId: sources.collectionId,
    items: [{ key: 'x:12345', disposition: 'included', section: 'Frameworks / Infra', url: 'https://goodfire.ai/' }] });
  const prompted = fs.readFileSync(path.join(root, 'prompt.md'), 'utf8');
  assert.match(prompted, /<candidate_keys>\nx:12345\n<\/candidate_keys>/);
  const ledgerDir = path.join(root, 'delivery-ledger');
  initializeDeliveryLedger(ledgerDir, { notBeforeDate: '2026-10-31', createdBy: 'SYNTHETIC-test' });
  const snapshotInputs = { digestPath: 'digest.md', sourcesPath: 'sources.json', dispositionsPath: 'dispositions.json', materialsPaths: ['materials.json', 'canonical-materials.json', 'mail-body.txt'], evidencePaths: evidence.map(e => e.path), authorId: 'SYNTHETIC-writer' };
  const publication = { rootDir: root, snapshotInputs, reviewPath: 'review.approved.json', ledgerDir };
  writeJson('publication.json', publication);
  await main(['review-input', '--publication', path.join(root, 'publication.json'), '--out', path.join(root, 'review.pending.json')]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'review.pending.json'))).status, 'pending');
  // The only auto-filled approval is a clearly labelled test fixture, never a production API.
  writeJson('review.approved.json', approveSyntheticReview({ ...snapshotInputs, rootDir: root, renderedMarkdown: larkMarkdown(markdown, sources, { dispositions: JSON.parse(fs.readFileSync(path.join(root, 'dispositions.json'))) }) }));
  const approved = await main(['validate-publication', '--publication', path.join(root, 'publication.json')]);
  assert.equal(approved.ok, true);
  const prepared = await main(['prepare-delivery', '--publication', path.join(root, 'publication.json'), '--sources', path.join(root, 'sources.json'), '--digest', path.join(root, 'digest.md'), '--config', path.join(root, 'runtime.json'), '--out', path.join(root, 'delivery.json')]);
  assert.equal(prepared.status, 'prepared_not_sent');
  assert.deepEqual(prepared.validation.urlBinding, { checked: 2, matchedCollection: 1, matchedMaterials: 1 });
  assert.deepEqual(prepared.validation.dispositions.supplementUrls, ['https://newsletter.example.invalid/p/issue-1']);
  const rendered = JSON.parse(fs.readFileSync(path.join(root, 'delivery.json'))).args[7];
  assert.ok(!rendered.includes('Breakthrough Research') && !rendered.includes('No synthetic item.'));
  const known = sources.coverage.accounting.knownCandidates;
  assert.ok(rendered.endsWith(`\n\n采集完整性：本期为浏览器截图抽样（3 张截图），未做区间遍历，近24小时与近48小时覆盖均未验证；滚动覆盖账本累计观察 ${known.observedPosts} 条帖子、链接 ${known.observedLinks} 个，规则过滤 ${known.filterDrops} 个，待深读 ${known.deepReadBacklog} 个（其中失败 ${known.deepReadFailures} 个）。未看到的帖子数未知。\n候选处置：共 1 条候选，收录 1 条，合并 0 条，跳过 0 条。\n`), rendered);
  assert.deepEqual(prepared.validation.repeatedUrls, []);
  // Exercise the real CLI under the explicit author-self-review deployment contract.
  snapshotInputs.reviewMode = 'self';
  snapshotInputs.renderStyle = 'concise';
  writeJson('publication.json', publication);
  const concise = larkMarkdown(markdown, sources, { renderStyle: 'concise' });
  assert.ok(concise.includes('近24小时仍有 24 小时'));
  assert.ok(!concise.includes('候选处置') && !concise.includes('滚动覆盖账本累计'));
  const selfReview = approveSyntheticReview({ ...snapshotInputs, rootDir: root, renderedMarkdown: concise });
  selfReview.reviewerId = snapshotInputs.authorId;
  for (const unit of selfReview.units) unit.comprehension.sourceBlind = false;
  writeJson('review.approved.json', selfReview);
  const prepareArgs = ['prepare-delivery', '--publication', path.join(root, 'publication.json'), '--sources', path.join(root, 'sources.json'), '--digest', path.join(root, 'digest.md'), '--config', path.join(root, 'runtime.json'), '--out', path.join(root, 'self-delivery.json')];
  await assert.rejects(main(prepareArgs), /review mode must match/);
  target.reviewMode = 'self';
  writeJson('runtime.json', { dataDir: path.join(root, 'data'), lookbackHours: 48, collectionEnabled: false, lark: target });
  const selfPrepared = await main(prepareArgs);
  assert.equal(selfPrepared.status, 'prepared_not_sent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'self-delivery.json'))).args[7], concise);
  assert.deepEqual(fs.readdirSync(ledgerDir), ['ledger.json']);
});
