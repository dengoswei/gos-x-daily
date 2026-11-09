import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { composePrompt, larkMarkdown, validateDigest } from '../digest.mjs';

// Synthetic data only; no publication/review approval or external actions.
const collection = {
  collectionId: 'synthetic-coverage-disclosure', date: '2026-10-17',
  digestMarker: '<!-- x-daily-collection: synthetic-coverage-disclosure -->',
  stats: { xFollowing: 1 },
  sources: { xFollowing: [{ url: 'https://x.com/example/status/123', text: 'Synthetic item', links: [] }] },
};
const summary = '本次采集范围：已知计划来源 2/3 已尝试，1/3 有可用材料；本轮 1 个候选；真实全量帖子覆盖率未知。';
const draft = placement => `# X AI 日报 ${collection.date}\n${collection.digestMarker}\n\n## Applications / Products\n- Synthetic item https://x.com/example/status/123\n\n${placement}\n\n## 差异补充\nSynthetic audit only\n`;

test('plain or level-three collection disclosure survives exact render in a sourced section', () => {
  for (const text of [summary, `### 本次采集范围\n${summary}`]) {
    const markdown = draft(text);
    assert.equal(validateDigest(markdown, collection).ok, true);
    const rendered = larkMarkdown(markdown, collection);
    assert.ok(rendered.includes(summary));
    assert.ok(rendered.includes('缺少可验证的覆盖账本'));
    assert.ok(!rendered.includes('Synthetic audit only'));
  }
});

test('audit-only or URL-free level-two disclosure is omitted, so must not be used', () => {
  assert.ok(!larkMarkdown(draft(`## 本次采集范围\n${summary}`), collection).includes(summary));
  assert.ok(!larkMarkdown(`${draft('')}\n${summary}`, collection).includes(summary));
});

test('full and compact composition prompts both require current-run coverage material', () => {
  for (const full of [false, true]) {
    const prompt = composePrompt(collection, { full });
    assert.ok(prompt.includes('collection-coverage.md'));
    assert.ok(prompt.includes('attempted/planned known sources and usable/planned'));
    assert.ok(prompt.includes('Rolling ledger counts are cumulative, not this run.'));
  }
  const contract = fs.readFileSync(new URL('../docs/COVERAGE.md', import.meta.url), 'utf8');
  assert.ok(contract.includes('`unattempted`'));
  assert.ok(contract.includes('zero or unknown denominator gives N/A'));
  assert.ok(contract.includes('80% to less than 100%'));
});
