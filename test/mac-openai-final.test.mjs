import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as cli } from '../cli.mjs';
import { finalizeOpenAI } from '../deployment/mac/openai-final.mjs';
import { prepareDelivery } from '../digest.mjs';
import { makeApiFinalFixture } from './helpers/api-final-fixture.mjs';

const model = 'gpt-6.1-sol';
const fromTag = (text, tag) => JSON.parse(text.split('<' + tag + '>\n')[1].split('\n</' + tag + '>')[0]);
async function setup(t, variant) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-SYNTHETIC-final-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await makeApiFinalFixture(root);
  const { runDir, ledgerDir, markdown, dispositions, evidenceText, coverageText, secret } = fixture;
  const ledgerBefore = fs.readFileSync(path.join(ledgerDir, 'ledger.json'), 'utf8');
  const keyFile = path.join(root, 'SYNTHETIC-key');
  fs.writeFileSync(keyFile, 'CODEX_API_KEY=synthetic-placeholder\n');
  const stages = [];
  let finalText;
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, 'Bearer synthetic-placeholder');
    assert.equal(body.model, model);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.ok(!request.body.includes(secret) && !request.body.includes('mail-body.txt') && !request.body.includes('synthetic-placeholder'));
    const messages = body.messages;
    const all = messages.map(message => message.content).join('\n');
    const last = messages.at(-1).content;
    let stage = messages[0].content.match(/<!-- stage: ([a-z-]+) -->/)[1];
    if (stage === 'final' && last.startsWith('Continue as the same final author')) {
      stage = last.includes('reconstructing your final units') ? 'author-comprehension' : 'author-fidelity';
      assert.equal(messages.find(message => message.role === 'assistant')?.content, finalText);
      assert.ok(all.includes(evidenceText));
    }
    stages.push(stage);
    let answer;
    if (stage === 'final') {
      if (variant === 'repair' && stages.length > 1) assert.ok(last.includes('指出具体问题并进行修订'));
      answer = { markdown, dispositions };
      finalText = JSON.stringify(answer);
    } else {
      const units = fromTag(all, 'review_units');
      const isComprehension = stage.endsWith('comprehension');
      if (stage === 'reader-comprehension') {
        assert.equal(messages.length, 2);
        assert.ok(!all.includes(evidenceText) && !all.includes(coverageText) && !all.includes('verified_evidence') && !all.includes('local_disposition_facts'));
      }
      if (stage === 'reader-fidelity') {
        assert.ok(all.includes('persisted_reader_reconstruction') && all.includes(evidenceText));
        const runOutput = fs.readdirSync(runDir).find(entry => entry.startsWith('api-final-') && !entry.endsWith('.json'));
        const stored = fs.readdirSync(path.join(runDir, runOutput));
        assert.ok(stored.some(entry => entry.endsWith('reader-comprehension.json')));
      }
      const fail = stage === 'reader-fidelity' &&
        (variant === 'reader-fails' || (variant === 'repair' && stages.filter(value => value === 'reader-fidelity').length === 1));
      const covered = [{ id: 'coverage', quote: coverageText }];
      const paper = [{ id: 'paper', quote: evidenceText }, { id: 'paper', quote: fixture.input.excerpts[0].url }];
      const audit = !isComprehension && fromTag(all, 'local_disposition_facts');
      const reviewRows = units.map(unit => ({
        id: unit.id,
        status: fail && unit === units[0] ? 'fail' : 'pass',
        notes: fail ? '指出具体问题并进行修订。' : '复核来源限定，判断表述与给出的材料一致。',
        ...(isComprehension
          ? { reconstruction: { problem: '重复解码造成可以避免的开销。', method: '在两级索引中保存已解码前缀状态。', result: '模拟观察到重复解码减少，未报告生产结果。', innovation: '复用已保存的前缀状态是主要机制。' } }
          : { evidence: unit.kind === 'main' && !unit.text.includes('本次采集范围') ? paper
            : [...covered, ...paper, ...(unit.kind === 'audit' ? [{ id: audit.id, quote: audit.text }] : [])] }),
      }));
      if (variant === 'missing' && stage === 'reader-comprehension') reviewRows.pop();
      if (variant === 'forged' && stage === 'author-fidelity') reviewRows[0].evidence = [{ id: 'paper', quote: 'This passage was never seen in the source.' }];
      if (variant === 'url-only' && stage === 'author-fidelity') reviewRows[0].evidence = [paper[1]];
      if (variant === 'tamper' && stage === 'author-fidelity') fs.appendFileSync(path.join(runDir, 'public-source.txt'), 'modified');
      answer = { units: reviewRows };
    }
    return Response.json({ id: 'synthetic-api-' + stages.length, model, service_tier: 'default',
      choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  return { ...fixture, stages, run: () => finalizeOpenAI({ runsDir: root, runDir, ledgerDir, keyFile, fetchImpl }),
    unchangedLedger: () => {
      assert.deepEqual(fs.readdirSync(ledgerDir), ['ledger.json']);
      assert.equal(fs.readFileSync(path.join(ledgerDir, 'ledger.json'), 'utf8'), ledgerBefore);
    } };
}

test('API final preserves reader isolation, author continuity, exact payload binding and a read-only ledger', async t => {
  const f = await setup(t);
  const result = await f.run();
  assert.equal(result.status, 'api_final_reviewed_not_sent');
  assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'author-comprehension', 'author-fidelity']);
  const checked = await cli(['validate-publication', '--publication', result.publication]);
  const review = JSON.parse(fs.readFileSync(path.join(path.dirname(result.publication), 'review.self.json'), 'utf8'));
  assert.equal(checked.reviewedUnits, result.units);
  assert.ok(review.units.some(unit => unit.kind === 'transport'));
  assert.equal(review.authorId, review.reviewerId);
  assert.match(review.authorId, /:synthetic-api-1$/);
  assert.ok(review.units.every(unit => unit.comprehension.sourceBlind === false));
  assert.ok(review.bindings.files.some(file => file.path === 'mail-body.txt'));
  assert.ok(review.units.some(unit => unit.kind === 'audit' && unit.fidelity.sourcePaths.some(file => file.endsWith('audit-facts.json'))));
  const publication = JSON.parse(fs.readFileSync(result.publication, 'utf8'));
  const collection = JSON.parse(fs.readFileSync(path.join(f.runDir, 'sources.json'), 'utf8'));
  const target = { enabled: true, userId: 'ou_' + 'a'.repeat(32), ledgerDir: f.ledgerDir,
    deploymentId: 'synthetic-api-final', executable: fileURLToPath(new URL('../deployment/mac/mac-sender.mjs', import.meta.url)),
    reviewMode: 'self', transport: 'feishu-post-v1' };
  const plan = prepareDelivery(f.markdown, collection, target, { ...publication, rootDir: f.runDir });
  assert.equal(plan.status, 'prepared_not_sent');
  assert.equal(plan.transport.content, fs.readFileSync(path.join(path.dirname(result.publication), 'post.final.json'), 'utf8'));
  const usage = fs.readFileSync(result.usagePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(usage.map(row => row.stage), f.stages);
  assert.ok(usage.every(row => row.inputTokens === 100 && row.outputTokens === 20));
  await assert.rejects(f.run(), /already completed/);
  fs.appendFileSync(path.join(path.dirname(result.publication), 'digest.md'), '\n');
  await assert.rejects(cli(['validate-publication', '--publication', result.publication]), /stale or tampered/);
  f.unchangedLedger();
});

test('API final revises a material finding and rechecks the new exact publication', async t => {
  const f = await setup(t, 'repair');
  const result = await f.run();
  assert.equal(result.attempt, 2);
  assert.equal(f.stages.filter(stage => stage === 'reader-comprehension').length, 2);
  assert.equal(f.stages.filter(stage => stage === 'author-comprehension').length, 1);
  assert.ok(!fs.existsSync(path.join(result.outDir, 'attempt-1', 'publication.json')));
  f.unchangedLedger();
});

test('API final refuses unresolved findings, missing units, forged evidence and changed source bytes', async t => {
  for (const [variant, error] of [
    ['reader-fails', /two attempts/], ['missing', /incomplete unit coverage/],
    ['forged', /unsupported evidence excerpt/], ['url-only', /without source text/], ['tamper', /evidence changed/],
  ]) {
    await t.test(variant, async sub => {
      const f = await setup(sub, variant);
      await assert.rejects(f.run(), error);
      assert.ok(!fs.existsSync(path.join(f.runDir, 'api-final-result.json')));
      assert.ok(!fs.readdirSync(f.runDir, { recursive: true }).some(file => file.endsWith('publication.json')));
      f.unchangedLedger();
    });
  }
});

test('API final rejects attempts to select local mail or to supply a non-verbatim excerpt before calling the API', async t => {
  const f = await setup(t);
  const manifest = path.join(f.runDir, 'api-final-input.json');
  const original = f.input.excerpts[0];
  for (const [excerpt, error] of [
    [{ ...original, path: 'mail-body.txt', text: f.secret }, /disallowed backing file/],
    [{ ...original, text: 'This text does not exist in the captured source.' }, /not verbatim/],
  ]) {
    fs.writeFileSync(manifest, JSON.stringify({ ...f.input, excerpts: [excerpt, f.input.excerpts[1]] }));
    await assert.rejects(f.run(), error);
  }
  assert.deepEqual(f.stages, []);
  f.unchangedLedger();
});
