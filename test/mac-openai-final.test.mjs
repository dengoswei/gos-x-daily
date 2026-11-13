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
  if (variant === 'delta') {
    fs.writeFileSync(path.join(runDir, 'api-final-input.json'), JSON.stringify({
      ...fixture.input, editorialFocus: [fixture.input.excerpts[0].id],
    }));
  }
  const included = dispositions.items.find(row => row.disposition === 'included');
  const notice = ['citation-empty', 'citation-missing', 'citation-empty-persistent'].includes(variant)
    ? '本期版本说明：依据 X Following 和 Karpathy 抽样。' : undefined;
  const quickSection = '## Quick Hits / 快讯速览\n- **版本更新。** 新增本地导出命令。 [发布说明](https://example.com/synthetic-quick-release)\n\n';
  const quickExcerpt = { id: 'quick', kind: 'public', path: 'public-source.txt',
    url: 'https://example.com/synthetic-quick-release', text: 'SYNTHETIC release: version 1.2 adds a local export command.' };
  const essayHeading = '## Long-form / Essays';
  let essayDigest;
  if (variant === 'quick-first') {
    fs.appendFileSync(path.join(runDir, quickExcerpt.path), quickExcerpt.url + '\n' + quickExcerpt.text + '\n');
    fs.writeFileSync(path.join(runDir, 'api-final-input.json'), JSON.stringify({
      ...fixture.input, excerpts: [...fixture.input.excerpts, quickExcerpt],
    }));
    essayDigest = markdown.replace('## ' + included.section, essayHeading);
    included.section = essayHeading.slice(3);
  }
  if (variant === 'citation-typo') {
    const skippedIndex = dispositions.items.findIndex(row => row.disposition === 'skipped');
    dispositions.items[skippedIndex] = { key: dispositions.items[skippedIndex].key, disposition: 'merged', mergedInto: included.key };
    const secondSkipped = dispositions.items.findIndex(row => row.disposition === 'skipped');
    dispositions.items[secondSkipped] = { ...included, key: dispositions.items[secondSkipped].key };
  }
  const ledgerBefore = fs.readFileSync(path.join(ledgerDir, 'ledger.json'), 'utf8');
  const keyFile = path.join(root, 'SYNTHETIC-key');
  fs.writeFileSync(keyFile, 'CODEX_API_KEY=synthetic-placeholder\n');
  const stages = [];
  let finalText;
  let interrupted = false;
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
    const repairingCitations = last.includes('<citation_errors>');
    if (repairingCitations) {
      stage = stage === 'final' ? 'author-fidelity' : stage;
      assert.ok(messages.at(-2).role === 'assistant');
      if (stage === 'author-fidelity') {
        assert.equal(messages.find(message => message.role === 'assistant')?.content, finalText);
      }
    }
    stages.push(stage);
    if (variant === 'resume-coverage' && repairingCitations && !interrupted) {
      interrupted = true;
      throw new TypeError('synthetic interruption');
    }
    let answer;
    if (stage === 'final') {
      if (variant === 'delta') {
        assert.deepEqual(fromTag(all, 'verified_evidence').editorialFocus, [fixture.input.excerpts[0].id]);
        assert.match(last, /preserve the material conditions, exceptions and benchmark scope/);
      }
      if (['repair', 'citation-then-material-fail'].includes(variant) && stages.length > 1) {
        assert.ok(last.includes('指出具体问题并进行修订'));
      }
      answer = variant === 'delta' ? {
        markdown: markdown.replace('](' + fixture.input.excerpts[0].url + ')', '](' + fixture.input.excerpts[0].url + '/)'),
        dispositionChanges: dispositions.items.filter(row => row.disposition === 'included'),
      } :
        { markdown, dispositions };
      if (notice) answer.markdown = markdown.replace('## ' + included.section, notice + '\n\n## ' + included.section);
      if (variant === 'quick-first') {
        if (stages.length > 1) assert.match(last, /before every other main section/);
        answer.markdown = stages.length === 1
          ? essayDigest.replace('本次采集范围', quickSection + '本次采集范围')
          : essayDigest.replace(essayHeading, quickSection + essayHeading);
      }
      finalText = JSON.stringify(answer);
    } else {
      const originalUnits = fromTag(all, 'review_units');
      const units = repairingCitations ? fromTag(last, 'repair_units') : originalUnits;
      if (repairingCitations) {
        assert.deepEqual(units.map(unit => unit.id), fromTag(last, 'citation_errors').map(issue => issue.unitId));
        assert.ok(units.length < originalUnits.length);
        if (notice) {
          assert.deepEqual(units.map(unit => unit.text), [notice]);
          assert.deepEqual(fromTag(last, 'citation_errors'), [
            { unitId: units[0].id, excerptIds: [], reason: 'pass_without_evidence' },
          ]);
        }
        if (['citation-unknown-id', 'citation-unknown-id-persistent'].includes(variant)) {
          assert.deepEqual(units.map(unit => unit.kind), ['render', 'transport']);
          assert.deepEqual(fromTag(last, 'citation_errors').map(issue => issue.excerptIds), [[units[0].id], ['paper']]);
          assert.deepEqual(new Set(fromTag(last, 'valid_evidence_ids')),
            new Set(['paper', 'coverage', 'local-coverage-accounting', 'local-disposition-counts']));
          assert.match(last, /Review unit IDs .* must never be cited as source evidence/);
        }
      }
      const isComprehension = stage.endsWith('comprehension');
      if (!isComprehension) {
        assert.match(repairingCitations ? last : all,
          /Every pass verdict requires at least one valid source citation, including for titles, dates and notices/);
      }
      if (stage.endsWith('fidelity') && !repairingCitations) {
        assert.match(all, /A link_only record can establish discovery of a companion link/);
        assert.match(all, /Fail any material claim about the destination content unless supported by separate content evidence/);
      }
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
      const materialAfterRepair = variant === 'citation-then-material-fail' && stage === 'reader-fidelity' &&
        stages.filter(value => value === 'final').length === 1;
      const fail = stage === 'reader-fidelity' &&
        (variant === 'reader-fails' || (variant === 'repair' && stages.filter(value => value === 'reader-fidelity').length === 1) ||
          (materialAfterRepair && repairingCitations));
      const covered = [{ id: 'coverage', quote: coverageText }];
      const paper = [{ id: 'paper', quote: evidenceText }, { id: 'paper', quote: fixture.input.excerpts[0].url }];
      if (variant === 'quick-first') paper.push({ id: quickExcerpt.id, quote: quickExcerpt.text });
      const audit = !isComprehension && fromTag(all, 'local_disposition_facts');
      if (audit) {
        const facts = JSON.parse(audit.text);
        assert.equal(facts.mainBullets, variant === 'quick-first' ? 2 : 1);
        assert.deepEqual(Object.values(facts.publicUrlDispositions),
          [variant === 'citation-typo' ? { includedKeys: 2, mergedKeys: 1 } : { includedKeys: 1, mergedKeys: 0 }]);
        assert.ok(!audit.text.includes(included.key));
      }
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
      if (variant === 'resume-coverage' && stage === 'reader-fidelity' && !repairingCitations) {
        const index = units.findIndex(unit => unit.kind === 'render');
        reviewRows[index].evidence = reviewRows[index].evidence.filter(ref => ref.id !== 'coverage');
      }
      if (['uncited-link-repair', 'uncited-link-persists'].includes(variant) && stage === 'reader-fidelity' &&
          (!repairingCitations || variant === 'uncited-link-persists')) {
        const index = units.findIndex(unit => unit.kind === 'render');
        reviewRows[index].evidence = covered;
      }
      if (!repairingCitations && ((variant === 'citation-typo' && stage.endsWith('fidelity')) || materialAfterRepair)) {
        for (const [index, unit] of units.entries()) {
          if (unit === units[0] || unit.kind === 'render') {
            reviewRows[index].evidence = [{ id: 'paper', quote: 'This passage was never seen in the source.' }];
          }
        }
      }
      if (stage === 'reader-fidelity' && (variant === 'citation-unknown-id-persistent' ||
          (variant === 'citation-unknown-id' && !repairingCitations))) {
        const render = units.findIndex(unit => unit.kind === 'render');
        const transport = units.findIndex(unit => unit.kind === 'transport');
        reviewRows[render].evidence.push({ id: units[render].id, quote: evidenceText });
        reviewRows[transport].evidence.push({ id: 'paper', quote: evidenceText.slice(0, 7) });
      }
      if (notice && !isComprehension) {
        const row = reviewRows[units.findIndex(unit => unit.text === notice)];
        row.evidence = covered;
        if (stage === 'reader-fidelity' && (!repairingCitations || variant === 'citation-empty-persistent')) {
          if (variant === 'citation-missing') delete row.evidence;
          else row.evidence = [];
        }
      }
      if (materialAfterRepair && repairingCitations) reviewRows[0].evidence = [];
      if (variant === 'forged' && stage === 'author-fidelity') reviewRows[0].evidence = [{ id: 'paper', quote: 'This passage was never seen in the source.' }];
      if (variant === 'url-only' && stage === 'author-fidelity') reviewRows[0].evidence = [paper[1]];
      if (variant === 'tamper' && stage === 'author-fidelity') fs.appendFileSync(path.join(runDir, 'public-source.txt'), 'modified');
      answer = { units: reviewRows };
    }
    return Response.json({ id: 'synthetic-api-' + stages.length, model, service_tier: 'default',
      choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  return { ...fixture, stages, run: resume => finalizeOpenAI({ runsDir: root, runDir, ledgerDir, keyFile, fetchImpl, resume }),
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
  assert.deepEqual(usage.filter(row => row.event === 'started').map(row => row.stage), f.stages);
  assert.deepEqual(usage.filter(row => row.event === 'response').map(row => row.stage), f.stages);
  assert.ok(usage.filter(row => row.event === 'response').every(row => row.inputTokens === 100 && row.outputTokens === 20));
  await assert.rejects(f.run(), /already completed/);
  fs.appendFileSync(path.join(path.dirname(result.publication), 'digest.md'), '\n');
  await assert.rejects(cli(['validate-publication', '--publication', result.publication]), /stale or tampered/);
  f.unchangedLedger();
});

test('Mac final rejects Quick Hits below essays and reviews the corrected order', async t => {
  const f = await setup(t, 'quick-first');
  const result = await f.run();
  assert.equal(result.attempt, 2);
  assert.deepEqual(f.stages.slice(0, 3), ['final', 'final', 'reader-comprehension']);
  const report = fs.readFileSync(path.join(path.dirname(result.publication), 'report.final.md'), 'utf8');
  assert.deepEqual(report.match(/^## .+$/gm), ['## Quick Hits / 快讯速览', '## Long-form / Essays']);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
  f.unchangedLedger();
});

test('API final resumes bound responses and repairs only the unit missing a coverage citation', async t => {
  const f = await setup(t, 'resume-coverage');
  await assert.rejects(f.run(), /reader-fidelity-citation-repair failed/);
  const prior = fs.readdirSync(f.runDir).find(name => /^api-final-[A-Za-z0-9]{6}$/.test(name));
  const result = await f.run(prior);
  assert.equal(result.attempt, 1);
  assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity', 'reader-fidelity', 'author-comprehension', 'author-fidelity']);
  const usage = fs.readFileSync(result.usagePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(usage.filter(row => row.reusedFrom === prior).map(row => row.stage), ['final', 'reader-comprehension', 'reader-fidelity']);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
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

test('API final repairs only units with invalid quotes before approving the same report', async t => {
  const f = await setup(t, 'citation-typo');
  const result = await f.run();
  assert.equal(result.attempt, 1);
  assert.deepEqual(f.stages, [
    'final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity',
    'author-comprehension', 'author-fidelity', 'author-fidelity',
  ]);
  const usage = fs.readFileSync(result.usagePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(usage.filter(row => row.event === 'response' && row.stage.endsWith('citation-repair')).map(row => row.stage),
    ['reader-fidelity-citation-repair', 'author-fidelity-citation-repair']);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
  f.unchangedLedger();
});

test('API final repairs a review unit citation and a short source quote in one retry', async t => {
  const f = await setup(t, 'citation-unknown-id');
  const result = await f.run();
  assert.equal(result.attempt, 1);
  assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity',
    'author-comprehension', 'author-fidelity']);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
  f.unchangedLedger();
});

test('API final refuses a review unit citation that survives the only citation retry', async t => {
  const f = await setup(t, 'citation-unknown-id-persistent');
  await assert.rejects(f.run(), /unsupported evidence excerpt/);
  assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity']);
  assert.ok(!fs.readdirSync(f.runDir, { recursive: true }).some(file => file.endsWith('publication.json')));
  f.unchangedLedger();
});

test('API final repairs only the passing notice with missing or empty evidence', async t => {
  for (const variant of ['citation-empty', 'citation-missing']) {
    await t.test(variant, async sub => {
      const f = await setup(sub, variant);
      const result = await f.run();
      assert.equal(result.attempt, 1);
      assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity',
        'author-comprehension', 'author-fidelity']);
      assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
      f.unchangedLedger();
    });
  }
});

test('API final blocks an uncited pass after the only citation retry', async t => {
  const f = await setup(t, 'citation-empty-persistent');
  await assert.rejects(f.run(), /lacks fidelity evidence/);
  assert.deepEqual(f.stages, ['final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity']);
  assert.ok(!fs.readdirSync(f.runDir, { recursive: true }).some(file => file.endsWith('publication.json')));
  f.unchangedLedger();
});

test('API final keeps unchanged dispositions and reviews the exact observed spelling of links', async t => {
  const f = await setup(t, 'delta');
  const result = await f.run();
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
  const finalDigest = fs.readFileSync(path.join(path.dirname(result.publication), 'digest.md'), 'utf8');
  assert.equal(finalDigest, f.markdown);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(result.outDir, '1-final.json'), 'utf8')).markdown, finalDigest);
  f.unchangedLedger();
});

test('API final treats an uncited material fail in a repaired verdict as a revision finding', async t => {
  const f = await setup(t, 'citation-then-material-fail');
  const result = await f.run();
  assert.equal(result.attempt, 2);
  assert.ok(!fs.existsSync(path.join(result.outDir, 'attempt-1', 'publication.json')));
  assert.equal(f.stages.filter(stage => stage === 'author-comprehension').length, 1);
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
  fs.writeFileSync(manifest, JSON.stringify({ ...f.input, editorialFocus: ['coverage'] }));
  await assert.rejects(f.run(), /editorial focus must reference distinct public evidence IDs/);
  f.unchangedLedger();
});

test('API final repairs a passing render unit that omitted one cited link excerpt instead of aborting', async t => {
  const f = await setup(t, 'uncited-link-repair');
  const result = await f.run();
  assert.equal(result.attempt, 1);
  assert.deepEqual(f.stages, [
    'final', 'reader-comprehension', 'reader-fidelity', 'reader-fidelity',
    'author-comprehension', 'author-fidelity',
  ]);
  assert.equal((await cli(['validate-publication', '--publication', result.publication])).reviewedUnits, result.units);
  f.unchangedLedger();
});

test('API final rejects a link still missing after citation repair', async t => {
  const f = await setup(t, 'uncited-link-persists');
  await assert.rejects(f.run(), /account for every cited link/);
  assert.equal(f.stages.filter(stage => stage === 'reader-fidelity').length, 2);
  f.unchangedLedger();
});
