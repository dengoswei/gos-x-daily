import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { larkPostJson, larkPostVisibleText } from '../lark-post.mjs';
import { nativeSenderArgs, expectedReadback, normalizedReadback } from '../deployment/mac/transport.mjs';

test('readback accepts same-domain autolinking but rejects changed destinations or text', () => {
  const original = 'A report from [Institute / ModelLab.ai · Memory] follows.';
  assert.equal(normalizedReadback(original), normalizedReadback('A report from [Institute / [ModelLab.ai](ModelLab.ai) · Memory] follows.'));
  assert.notEqual(normalizedReadback(original), normalizedReadback('A report from [Institute / [ModelLab.ai](different.ai) · Memory] follows.'));
  assert.notEqual(normalizedReadback(original), normalizedReadback('A report from [Institute / [ModelLab.ai](ModelLab.ai) · Changed] follows.'));
  assert.notEqual(normalizedReadback('[label](label)'), normalizedReadback('label'));
});

const markdown = '# Test digest\n## Section\n- **Finding.** Explanation. [Original](https://example.invalid/a) · [Code](https://example.invalid/b)\n';
function plan() {
  const content = larkPostJson(markdown);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { args: ['im', '+messages-send', '--as', 'bot', '--user-id', `ou_${'a'.repeat(32)}`, '--markdown', markdown, '--idempotency-key', 'xdaily-gos-daily-2026-11-09'],
    transport: { kind: 'feishu-post-v1', content, sha256 }, validation: { review: { bindings: { transport: { kind: 'feishu-post-v1', sha256 } } } } };
}
test('native adapter preserves bot, target and date key, using exact reviewed content', () => {
  const p = plan();
  const args = nativeSenderArgs(p);
  assert.deepEqual(args.slice(0, 6), p.args.slice(0, 6));
  assert.deepEqual(args.slice(-2), p.args.slice(-2));
  assert.deepEqual(args.slice(6, 10), ['--msg-type', 'post', '--content', p.transport.content]);
  assert.equal(expectedReadback(p), larkPostVisibleText(markdown));
});
test('native adapter fails closed on altered content, review, Markdown or missing transport', () => {
  for (const mutate of [p => p.transport.content += ' ', p => p.transport.sha256 = 'a'.repeat(64),
    p => p.validation.review.bindings.transport.sha256 = 'b'.repeat(64), p => p.args[7] += 'new text', p => delete p.transport]) {
    const p = plan(); mutate(p);
    assert.throws(() => nativeSenderArgs(p), /does not match/);
  }
});
test('legacy receipt reconciliation retains original projection without permitting legacy send', () => {
  const p = plan(); delete p.transport;
  assert.equal(expectedReadback(p), markdown);
  assert.throws(() => nativeSenderArgs(p));
  assert.equal(normalizedReadback('# Title\n**text**'), 'Titletext');
  assert.notEqual(normalizedReadback(expectedReadback(plan())), normalizedReadback(markdown));
});
