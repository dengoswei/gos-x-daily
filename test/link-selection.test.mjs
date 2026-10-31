import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDeepLinks, rankDeepLinks, scanWindow, itemKey, mergeItems, readFeedDom } from '../feed.mjs';

// Synthetic observations only. None of these fixtures fetch their URLs.
const window = { start: '2026-10-16T01:00:00Z', end: '2026-10-17T01:00:00Z' };
const post = (id = '1', publishedAt = '2026-10-16T12:00:00Z') => ({ id, text: `Synthetic post ${id}`, publishedAt });
const linked = (text, href, label) => ({ text, links: [{ href, text: label }] });

test('root-hosted Goodfire article and technical microsites survive selection', () => {
  const links = rankDeepLinks([
    linked('Nick Cammarata shares Goodfire’s new mechanistic interpretability article', 'https://goodfire.ai/'),
    linked('An interactive explanation of superposition', 'https://synthetic-microsite.example/'),
    linked('New work on neuron behavior', 'https://synthetic-neuron.example/'),
  ]);
  assert.equal(links.length, 3);
  assert.ok(links.every(link => link.selected && link.eligible && link.status === 'selected'));
  assert.ok(links.every(link => link.reason === 'ranked_for_deep_read'));
});

test('interpretability topic names independently qualify non-primary article URLs', () => {
  for (const topic of ['mechanistic interpretability', 'mechanistic-interpretability', 'neurons', 'neuron',
    'superposition', 'Goodfire', 'Nick Cammarata', '@nickcammarata', 'sparse autoencoders', 'SAEs',
    'monosemanticity', 'polysemanticity', 'feature visualization', '可解释性', '神经元']) {
    const ranked = rankDeepLinks([linked(topic, 'https://synthetic.example/article')]);
    assert.equal(ranked.length, 1, topic);
    assert.equal(ranked[0].selected, true, topic);
    assert.equal(ranked[0].eligibilityReason, 'technical_context', topic);
  }
});

test('unrelated roots and navigation stay filtered with explicit audit reasons', () => {
  const audit = auditDeepLinks([
    linked('Our summer trip', 'https://synthetic-holiday.example/'),
    linked('Our summer trip', 'https://synthetic-holiday.ai/'),
    linked('Our summer trip', 'https://synthetic-holiday.example/photos'),
    linked('AI training notes', 'https://github.com/'),
    linked('Goodfire research', 'https://synthetic.example/', 'Homepage'),
    linked('AI training notes', 'https://substack.com/home'),
    linked('AI training notes', 'https://x.com/synthetic/status/1'),
    linked('AI training notes', 'https://synthetic.example/analytics/'),
    linked('AI training notes', 'mailto:synthetic@example.org'),
    linked('AI training notes', 'not a URL'),
  ]);
  assert.equal(audit.length, 10);
  assert.ok(audit.every(link => !link.eligible && !link.selected && link.status === 'filtered'));
  assert.deepEqual(audit.map(link => link.reason), [
    'homepage_without_technical_signal', 'homepage_without_technical_signal', 'no_technical_signal',
    'homepage_navigation', 'homepage_navigation', 'substack_navigation', 'social_link', 'analytics_link',
    'unsupported_protocol', 'invalid_url',
  ]);
  assert.deepEqual(rankDeepLinks([linked('Summer trip', 'https://synthetic.example/')]), []);
});

test('primary and essay host matching does not trust lookalike domains', () => {
  const audit = auditDeepLinks([
    linked('Interesting document', 'https://arxiv.org/abs/synthetic'),
    linked('Interesting document', 'https://author.substack.com/p/synthetic'),
    linked('Interesting document', 'https://substack.com.evil.example/p/synthetic'),
    linked('Interesting document', 'https://notlatent.space/p/synthetic'),
  ]);
  assert.equal(audit.filter(link => link.eligible).length, 2);
  assert.equal(audit.filter(link => link.reason === 'no_technical_signal').length, 2);
});

test('dedup chooses strongest context and audits every duplicate without spending its budget', () => {
  const items = [
    { id: 'weak', ...linked('A link', 'https://synthetic.example/') },
    { id: 'strong', ...linked('Goodfire superposition', 'https://synthetic.example/?utm_source=feed#part') },
    { id: 'duplicate', ...linked('Goodfire superposition', 'https://synthetic.example/') },
    linked('RL optimizer research', 'https://arxiv.org/abs/synthetic'),
    linked('Inference kernel', 'https://other.example/article'),
  ];
  const ranked = rankDeepLinks(items, 2);
  assert.equal(ranked.length, 3);
  assert.equal(ranked.filter(link => link.selected).length, 2);
  const root = ranked.find(link => link.href === 'https://synthetic.example/');
  assert.equal(root.sourceId, 'strong');
  assert.equal(root.originalHref, 'https://synthetic.example/?utm_source=feed#part');
  const audit = auditDeepLinks(items, 2);
  assert.equal(audit.length, 5);
  assert.equal(audit.filter(link => link.reason === 'duplicate_url').length, 2);
  assert.equal(audit.filter(link => link.eligible && !link.selected).length, 1);
  assert.ok(audit.filter(link => link.reason === 'duplicate_url').every(link => !link.eligible && !link.selected));
  assert.deepEqual(audit.filter(link => link.eligible && !link.selected).map(link => [link.status, link.reason]),
    [['eligible_backlog', 'deep_read_budget']]);
});

test('deep-read budget supports zero, is deterministic, and preserves meaningful queries', () => {
  const items = [linked('Neuron behavior', 'https://synthetic.example/article?id=1'),
    linked('Neuron behavior', 'https://synthetic.example/article?id=2')];
  assert.equal(rankDeepLinks(items, 0).filter(link => link.selected).length, 0);
  assert.equal(rankDeepLinks(items, 0).filter(link => link.status === 'eligible_backlog').length, 2);
  assert.equal(rankDeepLinks(items, 1)[0].href, items[0].links[0].href);
  for (const limit of [-1, 1.5, NaN, Infinity]) assert.throws(() => rankDeepLinks(items, limit), /budget/);
  const routed = rankDeepLinks([linked('Neuron behavior', 'https://synthetic.example/#/article/one'),
    linked('Neuron behavior', 'https://synthetic.example/#/article/two')]);
  assert.equal(routed.length, 2);
  assert.equal(routed[0].href, 'https://synthetic.example/#/article/one');
});

test('default stall limit is eight unchanged reads and scroll-bottom is incomplete', async () => {
  let reads = 0;
  const result = await scanWindow({ window, allowExhausted: true,
    read: async () => { reads++; return { items: [post()], atEnd: true }; }, scroll: async () => {} });
  assert.equal(reads, 9); // One new page, followed by eight unchanged pages.
  assert.equal(result.coverage.reason, 'stalled');
  assert.equal(result.coverage.stallCause, 'unchanged_feed');
  assert.equal(result.coverage.scanned, false);
  assert.equal(result.coverage.recovery.attempts, 0);
});

test('delayed loading receives one bounded recovery then remains incomplete on continued stall', async () => {
  let recoveries = 0;
  const result = await scanWindow({ window, stallLimit: 2, maxRecoveryMs: 100,
    read: async () => ({ items: [post()], loading: true, atEnd: true }), scroll: async () => {},
    recover: async args => {
      recoveries++;
      assert.equal(args.cause, 'delayed_loading');
      assert.equal(args.stagnant, 2);
      assert.equal(args.pages, 3);
      assert.ok(args.remainingMs <= 100 && args.remainingMs > 0);
      assert.equal(args.signal.aborted, false);
    },
  });
  assert.equal(recoveries, 1);
  assert.equal(result.coverage.pages, 5);
  assert.equal(result.coverage.reason, 'stalled');
  assert.equal(result.coverage.stallCause, 'delayed_loading');
  assert.equal(result.coverage.scanned, false);
  assert.equal(result.coverage.recovery.status, 'completed');
});

test('recovery may reveal more posts; only genuine old-page evidence completes coverage', async () => {
  let recovered = false, index = 0;
  const after = [[post('2')], [post('3', '2026-10-14Z'), post('4', '2026-10-14Z')],
    [post('5', '2026-10-13Z'), post('6', '2026-10-13Z')]];
  const result = await scanWindow({ window, stallLimit: 2, orderedTimestamps: true,
    read: async () => ({ items: recovered ? after[index] : [post()] }),
    scroll: async () => { if (recovered) index++; },
    recover: async () => { recovered = true; },
  });
  assert.deepEqual(result.items.map(item => item.id), ['1', '2']);
  assert.equal(result.coverage.reason, 'time_boundary');
  assert.equal(result.coverage.boundaryEvidence, 'ordered_timestamp_boundary');
  assert.equal(result.coverage.scanned, true);
  assert.equal(result.coverage.stallCause, null);
  assert.equal(result.coverage.recovery.attempts, 1);
});

test('explicit exhaustion needs opt-in and loading prevents exhaustion claims', async () => {
  const run = options => scanWindow({ window, stallLimit: 1, maxPages: 3, read: async () => ({ items: [post()], exhausted: true }), scroll: async () => {}, ...options });
  assert.equal((await run({})).coverage.scanned, false);
  assert.equal((await run({ allowExhausted: true })).coverage.scanned, true);
  assert.equal((await run({ allowExhausted: true })).coverage.boundaryEvidence, 'explicit_exhaustion');
  const loading = await run({ allowExhausted: true, read: async () => ({ items: [post()], exhausted: true, loading: true }) });
  assert.equal(loading.coverage.scanned, false);
  assert.equal(loading.coverage.reason, 'stalled');
});

test('unordered old repost pages do not stop the scan or prove coverage', async () => {
  const pages = [[post('1')], [post('2', '2026-10-14Z'), post('3', '2026-10-14Z')],
    [post('4', '2026-10-13Z'), post('5', '2026-10-13Z')], [post('6')]];
  let index = 0;
  const result = await scanWindow({ window, maxPages: pages.length,
    read: async () => ({ items: pages[index] }), scroll: async () => { index++; } });
  assert.deepEqual(result.items.map(item => item.id), ['1', '6']);
  assert.equal(result.coverage.reason, 'page_budget');
  assert.equal(result.coverage.scanned, false);
  assert.equal(result.coverage.boundaryEvidence, null);
  const empty = await scanWindow({ window, read: async () => ({ empty: true, items: [] }), scroll: async () => {} });
  assert.equal(empty.coverage.scanned, true);
  assert.equal(empty.coverage.boundaryEvidence, 'explicit_exhaustion');
  index = 0;
  const loading = await scanWindow({ window, maxPages: 3, orderedTimestamps: true,
    read: async () => ({ items: pages[index], loading: true }), scroll: async () => { index++; } });
  assert.equal(loading.coverage.scanned, false);
  assert.equal(loading.coverage.boundaryEvidence, null);
});

test('canonical X status identity wins over adapter ids and merges dates/provenance', () => {
  const first = { id: 'adapter-one', url: 'https://twitter.com/synthetic/status/123?s=20', publishedAt: '2026-10-16T12:00:00Z',
    text: 'Longer observed text', evidenceId: 'first', discoveries: [{ source: 'following', at: 'one' }], links: [{ href: 'https://first.example/' }] };
  const second = { id: 'adapter-two', url: 'https://x.com/synthetic/status/123', publishedAt: null,
    text: 'Short', evidenceId: 'second', evidenceIds: ['second', 'third'],
    discoveries: [{ at: 'one', source: 'following' }, { source: 'search', at: 'two' }], links: [{ href: 'https://second.example/' }] };
  assert.equal(itemKey(first), 'x:123');
  assert.equal(itemKey(second), 'x:123');
  const merged = mergeItems([first], [second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].publishedAt, first.publishedAt);
  assert.equal(merged[0].text, first.text);
  assert.deepEqual(merged[0].evidenceIds, ['first', 'second', 'third']);
  assert.equal(merged[0].discoveries.length, 2);
  assert.equal(merged[0].links.length, 2);
  assert.equal(itemKey({ id: 'unrelated', url: 'https://unrelated.example/status/123' }), 'unrelated');
});

test('later undated observations cannot erase a known date or re-mark it unknown', async () => {
  let index = 0;
  const pages = [{ items: [post()] }, { items: [{ ...post(), publishedAt: null }], exhausted: true }];
  const result = await scanWindow({ window, allowExhausted: true,
    read: async () => pages[index], scroll: async () => { index++; } });
  assert.equal(result.items[0].publishedAt, post().publishedAt);
  assert.equal(result.coverage.undatedItems, 0);
  assert.equal(result.coverage.scanned, true);
  const unknown = await scanWindow({ window, allowExhausted: true,
    read: async () => ({ items: [{ ...post(), publishedAt: null }], exhausted: true }), scroll: async () => {} });
  assert.equal(unknown.coverage.undatedItems, 1);
  assert.equal(unknown.coverage.scanned, false);
});

test('DOM ad filtering uses promoted markers, not ordinary words in post text', t => {
  const original = new Map(['document', 'location', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const node = (id, text, promoted) => ({ innerText: text,
    querySelectorAll: selector => selector === 'a[href]' ? [{ innerText: 'Post', href: `https://x.com/synthetic/status/${id}` }] : [],
    querySelector: selector => selector === 'time' ? {
      getAttribute: name => name === 'datetime' ? '2026-10-16T12:00:00Z' : null,
      closest: () => ({ href: `https://x.com/synthetic/status/${id}` }),
    } : selector.includes('promotedIndicator') && promoted ? {} : null,
    closest: () => null,
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelectorAll: () => [node('1', 'Promoted checkpoints into production. Sponsored research is discussed here.\nAd\nA quotation.', false),
      node('2', 'Buy a synthetic advertised item', true)],
    querySelector: () => null, body: { innerText: 'Synthetic feed' }, documentElement: { scrollHeight: 2000 },
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/home' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scrollY: 0, innerHeight: 800 } });
  const result = readFeedDom('x');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://x.com/synthetic/status/1');
  assert.ok(result.items[0].text.includes('Promoted checkpoints'));
});

test('failed or timed-out recovery is bounded and cannot create complete coverage', async () => {
  const base = { window, stallLimit: 1, maxRecoveryMs: 10, read: async () => ({ items: [post()] }), scroll: async () => {} };
  const failed = await scanWindow({ ...base, recover: async () => { throw new Error('Synthetic failure'); } });
  assert.equal(failed.coverage.reason, 'recovery_error');
  assert.equal(failed.coverage.scanned, false);
  assert.equal(failed.coverage.recovery.status, 'failed');
  assert.equal(failed.coverage.recovery.error, 'Synthetic failure');
  let signal;
  const timedOut = await scanWindow({ ...base, recover: async args => { signal = args.signal; await new Promise(() => {}); } });
  assert.equal(timedOut.coverage.recovery.status, 'timed_out');
  assert.equal(timedOut.coverage.recovery.attempts, 1);
  assert.equal(timedOut.coverage.scanned, false);
  assert.equal(signal.aborted, true);
});

test('read exceptions preserve all prior observations with explicit incomplete failure', async () => {
  let reads = 0;
  const result = await scanWindow({ window, read: async () => {
    if (reads++ === 0) return { items: [post('1'), { ...post('2'), publishedAt: null }] };
    throw new Error('Synthetic browser read failed');
  }, scroll: async () => {} });
  assert.deepEqual(result.items.map(item => item.id), ['1', '2']);
  assert.equal(result.coverage.reason, 'read_error');
  assert.equal(result.coverage.scanned, false);
  assert.equal(result.coverage.boundaryEvidence, null);
  assert.equal(result.coverage.pages, 1);
  assert.equal(result.coverage.readAttempts, 2);
  assert.equal(result.coverage.undatedItems, 1);
  assert.deepEqual(result.coverage.failure, { phase: 'read', name: 'Error', code: null, message: 'Synthetic browser read failed' });
});

test('scroll errors retain collected posts and first-read errors return a failed report', async () => {
  const scrolled = await scanWindow({ window, read: async () => ({ items: [post()] }),
    scroll: async () => { throw new Error('Synthetic scroll failed'); } });
  assert.equal(scrolled.items.length, 1);
  assert.equal(scrolled.coverage.reason, 'scroll_error');
  assert.equal(scrolled.coverage.scanned, false);
  assert.equal(scrolled.coverage.failure.phase, 'scroll');
  const firstRead = await scanWindow({ window,
    read: async () => { throw new Error('Synthetic initial failure'); }, scroll: async () => assert.fail('Must not scroll after a failed read') });
  assert.deepEqual(firstRead.items, []);
  assert.equal(firstRead.coverage.reason, 'read_error');
  assert.equal(firstRead.coverage.pages, 0);
  assert.equal(firstRead.coverage.readAttempts, 1);
  assert.equal(firstRead.coverage.scanned, false);
  assert.equal(firstRead.coverage.boundaryEvidence, null);
});

test('global deadline and abort failures preserve partial posts as interrupted', async () => {
  for (const phase of ['read', 'scroll']) {
    for (const error of [Object.assign(new Error('Global collection time budget exhausted'), { code: 'RUN_BUDGET' }),
      Object.assign(new Error('Synthetic abort'), { name: 'AbortError' }),
      Object.assign(new Error('Synthetic timeout'), { name: 'TimeoutError' })]) {
      let now = 0, reads = 0;
      const result = await scanWindow({ window, maxMs: 5, clock: () => now,
        read: async () => {
          if (phase === 'read' && reads++ > 0) { now = 6; throw error; }
          return { items: [post()] };
        },
        scroll: async () => { if (phase === 'scroll') { now = 6; throw error; } },
      });
      assert.equal(result.items.length, 1, `${phase}: ${error.name}`);
      assert.equal(result.coverage.reason, 'interrupted', `${phase}: ${error.name}`);
      assert.equal(result.coverage.scanned, false);
      assert.equal(result.coverage.failure.phase, phase);
      assert.equal(result.coverage.failure.message, error.message);
    }
  }
});

test('slow blocked reads retain source-terminal reasons instead of becoming time_budget', async () => {
  for (const blocked of ['login_required', 'rate_limited', 'page_error']) {
    let now = 0, reads = 0;
    const result = await scanWindow({ window, maxMs: 5, clock: () => now,
      read: async () => {
        if (reads++ === 0) return { items: [post()] };
        now = 10;
        return { blocked, items: [] };
      }, scroll: async () => {} });
    assert.equal(result.coverage.reason, blocked);
    assert.equal(result.coverage.scanned, false);
    assert.equal(result.coverage.boundaryEvidence, null);
    assert.equal(result.items.length, 1);
    assert.equal(result.coverage.pages, 2);
  }
});

test('malformed read responses are incomplete read errors without losing earlier posts', async () => {
  for (const malformed of [null, undefined, { items: 'not an array' }]) {
    let reads = 0;
    const result = await scanWindow({ window, read: async () => reads++ ? malformed : { items: [post()] }, scroll: async () => {} });
    assert.equal(result.items.length, 1);
    assert.equal(result.coverage.reason, 'read_error');
    assert.equal(result.coverage.scanned, false);
  }
});

test('recovery cannot evade page/time limits or reset the traversal budget', async () => {
  let attempts = 0;
  const capped = await scanWindow({ window, stallLimit: 1, maxPages: 2,
    read: async () => ({ items: [post()] }), scroll: async () => {}, recover: async () => { attempts++; } });
  assert.equal(attempts, 0);
  assert.equal(capped.coverage.scanned, false);
  let now = 0;
  const timed = await scanWindow({ window, stallLimit: 1, maxMs: 5, clock: () => now,
    read: async () => ({ items: [post()] }), scroll: async () => { now += 1; },
    recover: async () => { attempts++; now += 5; } });
  assert.equal(attempts, 1);
  assert.equal(timed.coverage.reason, 'time_budget');
  assert.equal(timed.coverage.scanned, false);
  for (const stallLimit of [0, -1, 1.5, Infinity]) {
    await assert.rejects(scanWindow({ window, stallLimit, read: async () => ({}), scroll: async () => {} }), /budget/);
  }
});

test('singular collector discovery labels also survive merged provenance', () => {
  const items = mergeItems([{ url: 'https://x.com/example/status/12345', text: 'A', discovery: 'following_timeline' }],
    [{ url: 'https://x.com/example/status/12345', text: 'B', discovery: 'gos_48h_follows_search' }]);
  assert.deepEqual(items[0].discoveries, ['following_timeline', 'gos_48h_follows_search']);
});
