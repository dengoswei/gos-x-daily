import fs from 'node:fs';
import path from 'node:path';
import { candidateKeys } from '../../binding.mjs';
import { publicationGates } from '../../digest.mjs';
import { initializeDeliveryLedger } from '../../delivery-ledger.mjs';
import { makeSyntheticRun } from '../../prototype/make-synthetic-run.mjs';

export async function makeApiFinalFixture(runsDir) {
  const runDir = path.join(runsDir, '2026-11-08-SYNTHETIC');
  const ledgerDir = path.join(runsDir, 'SYNTHETIC-ledger');
  const write = (file, text) => fs.writeFileSync(path.join(runDir, file), text, { mode: 0o600 });
  const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
  await makeSyntheticRun({ outDir: runDir });
  initializeDeliveryLedger(ledgerDir, { notBeforeDate: '2026-11-08', createdBy: 'synthetic-fixture' });
  const collection = JSON.parse(fs.readFileSync(path.join(runDir, 'sources.json'), 'utf8'));
  const url = collection.sources.deepArticles[0].url;
  const evidenceText = 'SYNTHETIC public article published November 7: the fictional runtime caches decoded states for repeated prefixes in a two-level index. The second pass reuses the saved states rather than decoding the same prefix again. The article reports a simulated reduction in repeat-prefix decoding and gives no production benchmark.';
  const coverageText = 'SYNTHETIC: 本次从 X Following 和 Karpathy 抽样，未验证近 24 小时与近 48 小时的完整遍历，未看到的帖子数未知。没有采集其他平台。';
  const secret = 'SYNTHETIC-PRIVATE-MAIL-MUST-STAY-LOCAL';
  json('run.json', { date: collection.date });
  json('canonical-materials.json', [{ url, file: 'public-source.txt' }]);
  write('public-source.txt', url + '\n' + evidenceText + '\n');
  write('collection-coverage.md', coverageText + '\n' + secret);
  write('mail-body.txt', secret);
  const input = { schemaVersion: 1, collectionId: collection.collectionId,
    materialsPaths: ['canonical-materials.json', 'collection-coverage.md'],
    evidencePaths: ['public-source.txt', 'mail-body.txt'],
    excerpts: [{ id: 'paper', kind: 'public', path: 'public-source.txt', url, text: evidenceText },
      { id: 'coverage', kind: 'coverage', path: 'collection-coverage.md', text: coverageText }],
  };
  json('api-final-input.json', input);
  const section = '研究与工程';
  const markdown = [
    '# X AI 日报 ' + collection.date, '<!-- x-daily-collection: ' + collection.collectionId + ' -->',
    '## ' + section, '', '- **相同的前缀可以复用解码状态**：这篇虚构文章把前缀对应的解码状态存进两级索引。第二次遇到相同的前缀时可以直接读取状态，少做一遍解码；收益来自模拟，尚无生产数据。 [原文](' + url + ')',
    '', '本次采集范围：抽样看了 X Following 和 Karpathy，近 24 小时和近 48 小时均未验证完整遍历。', '',
    '## 差异补充', '未验证两个窗口的完整性；未观察到的帖子数未知。', '',
  ].join('\n');
  const dispositions = { schemaVersion: 1, collectionId: collection.collectionId,
    items: candidateKeys(collection).map(key => key === 'deep:' + url
      ? { key, disposition: 'included', section, url }
      : { key, disposition: 'skipped', reason: 'low_signal' }),
  };
  fs.mkdirSync(path.join(runDir, 'api-draft'));
  write('api-draft/digest.md', markdown);
  json('api-draft/dispositions.json', dispositions);
  const { validation } = publicationGates(runDir, {
    dispositionsPath: 'api-draft/dispositions.json',
    materialsPaths: input.materialsPaths, evidencePaths: input.evidencePaths,
  }, markdown, collection);
  json('api-draft/report.json', { validation: { ...validation, passed: true } });
  return { runsDir, runDir, ledgerDir, input, markdown, dispositions, evidenceText, coverageText, secret };
}
