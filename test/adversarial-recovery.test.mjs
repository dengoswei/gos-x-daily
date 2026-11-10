// Independent recovery audit: synthetic local fixtures and mocked subprocesses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSyntheticReviewedFixture } from './helpers/review-fixture.mjs';
import { coverageStatusLine, larkMarkdown, prepareDelivery, sendDelivery } from '../digest.mjs';
import { main } from '../cli.mjs';

const accounting = () => ({
  windows: { '24h': { unscannedHours: 12 }, '48h': { unscannedHours: 30 } },
  knownCandidates: { observedLinks: 10, filterDrops: 2, deepReadBacklog: 4, deepReadFailures: 1 },
});
const collection = data => ({ coverage: { accounting: data } });
const auth = target => ({ authorized: true, env: { X_DAILY_ALLOW_SEND: '1' }, target });

test('independent audit: absent coverage cannot silently remove the rendered uncertainty disclosure', () => {
  const line = coverageStatusLine({});
  assert.ok(line.length > 0, 'Missing accounting needs explicit unknown disclosure, not an empty string');
  assert.match(line, /未知|unknown|未验证/i);
  assert.match(larkMarkdown('# SYNTHETIC\n## 差异补充\nAudit hidden by renderer.\n', {}), /未知|unknown|未验证/i);
});

test('independent audit: impossible or nonnumeric reported coverage is rejected', () => {
  const cases = [
    a => { a.windows['24h'].unscannedHours = -1; },
    a => { a.windows['24h'].unscannedHours = -Number.EPSILON; },
    a => { a.windows['24h'].unscannedHours = 25; },
    a => { a.windows['24h'].unscannedHours = 24 + 1 / 3600000; },
    a => { a.windows['48h'].unscannedHours = 49; },
    a => { a.windows['48h'].unscannedHours = 48.00000000000001; },
    a => { a.windows['48h'].unscannedHours = 48 + 1 / 3600000; },
    a => { a.windows['48h'].unscannedHours = 2; },
    a => { a.windows['48h'].unscannedHours = 12 - 1 / 3600000; },
    a => { a.windows['24h'].unscannedHours = '12'; },
    a => { a.knownCandidates.observedLinks = -1; },
    a => { a.knownCandidates.filterDrops = 'all'; },
    a => { a.knownCandidates.deepReadBacklog = 0.5; },
    a => { a.knownCandidates.deepReadFailures = NaN; },
    a => { a.knownCandidates.deepReadFailures = 5; },
    a => { a.knownCandidates.filterDrops = 11; },
  ];
  for (const change of cases) {
    const value = accounting(); change(value);
    assert.throws(() => coverageStatusLine(collection(value)), 'Reject impossible coverage/accounting values');
  }
});

test('independent audit: finite partial coverage is disclosed without turning backlog into unseen posts', () => {
  const line = coverageStatusLine(collection(accounting()));
  assert.match(line, /12\.00/); assert.match(line, /30\.00/);
  assert.match(line, /待深读 4/); assert.match(line, /未看到的帖子数未知/);
});

test('browser sampling wording applies only to a fully unscanned supported-browser capture', () => {
  const sampled = (transport, recent, full) => ({ provenance: { transport, evidence: [{ kind: 'screenshot' }, { kind: 'screenshot' }, { kind: 'fetched_document' }] },
    coverage: { accounting: { windows: { '24h': { unscannedHours: recent }, '48h': { unscannedHours: full } },
      knownCandidates: { observedPosts: 7, observedLinks: 10, filterDrops: 2, deepReadBacklog: 4, deepReadFailures: 1 } } } });
  assert.equal(coverageStatusLine(sampled('gos-supported-browser', 24, 48)),
    '采集完整性：本期为浏览器截图抽样（2 张截图），未做区间遍历，近24小时与近48小时覆盖均未验证；滚动覆盖账本累计观察 7 条帖子、链接 10 个，规则过滤 2 个，待深读 4 个（其中失败 1 个）。未看到的帖子数未知。');
  for (const [transport, recent, full] of [['gos-supported-browser', 23, 48], ['gos-supported-browser', 24, 47], ['cdp', 24, 48], [undefined, 24, 48]]) {
    assert.match(coverageStatusLine(sampled(transport, recent, full)), /小时未验证扫描/);
  }
  const broken = sampled('gos-supported-browser', 24, 48); broken.coverage.accounting.knownCandidates.observedPosts = -1;
  assert.throws(() => coverageStatusLine(broken), /observed post/);
  broken.coverage.accounting.knownCandidates.filterDrops = 11;
  assert.throws(() => coverageStatusLine(broken), /Inconsistent/);
});

test('independent audit: only boolean true can establish a successful CLI acknowledgment', t => {
  for (const ok of ['false', 'true', 1, {}, []]) {
    const f = createSyntheticReviewedFixture(t);
    const plan = prepareDelivery(f.markdown, f.collection, f.target, f.publication);
    let calls = 0;
    const mock = () => {
      calls++;
      return { status: 0, stdout: JSON.stringify({ ok, data: { message_id: 'SYNTHETIC-invalid-success-type' } }) };
    };
    assert.throws(() => sendDelivery(plan, { ...auth(f.target), spawnSyncImpl: mock }), /uncertain/);
    assert.equal(calls, 1);
    assert.equal(fs.readdirSync(f.ledgerDir).filter(name => name.endsWith('.receipt.json')).length, 0);
    assert.equal(fs.readdirSync(f.ledgerDir).filter(name => name.endsWith('.attempt.json')).length, 1);
    assert.throws(() => sendDelivery(plan, { ...auth(f.target), spawnSyncImpl: mock }), /Prior delivery/);
    assert.equal(calls, 1);
  }
});

test('independent audit: CLI omission of publication/review cannot write a legacy plan', async t => {
  const f = createSyntheticReviewedFixture(t);
  const configPath = path.join(f.rootDir, 'synthetic-config.json');
  const output = path.join(f.rootDir, 'forbidden-legacy-plan.json');
  fs.writeFileSync(configPath, JSON.stringify({ lark: f.target }));
  await assert.rejects(main(['prepare-delivery', '--sources', path.join(f.rootDir, 'sources.json'),
    '--digest', path.join(f.rootDir, 'digest.md'), '--config', configPath, '--out', output]), /publication/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(f.ledgerDir), ['ledger.json']);
});

test('independent audit: changed ledger route cannot reuse a previously prepared plan', t => {
  const f = createSyntheticReviewedFixture(t);
  const g = createSyntheticReviewedFixture(t);
  const plan = prepareDelivery(f.markdown, f.collection, f.target, f.publication);
  plan.publication.ledgerDir = g.ledgerDir;
  let calls = 0;
  // The send-time target's pinned ledger now refuses the rerouted plan before plan comparison.
  assert.throws(() => sendDelivery(plan, { ...auth(f.target), spawnSyncImpl: () => { calls++; } }), /modified|configured delivery ledger/);
  assert.equal(calls, 0);
});
