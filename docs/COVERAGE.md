# Coverage semantics

The independent ledger retains a rolling 48-hour horizon of observations, attempted
intervals, gaps and pending deep reads. It does not import another deployment's
history or promise exhaustive X recall.

- Plan eight initial adjacent six-hour windows, newest first. Coarse unattempted
  windows precede repeated splitting; capped/stalled windows split into adjacent
  halves with limits. Failures stay explicit rather than silently disappearing.
- Defaults: 200 pages / five minutes per slice; 50 minutes total; requested
  concurrency at most two. Current CUA/unverified CDP paths execute serially.
  Budgets are starting configuration, not measured live throughput claims.
- Locks and atomic persistence prevent concurrent ledger overwrites. Never clear
  live locks or reset state merely to make a run start.
- Browser artifact imports retain bounded screenshot coverage as incomplete; they
  cannot certify whole intervals from oldest/newest sampled posts.
- Keep 24-hour and 48-hour unscanned hours separate from known queue counts.
  Unseen-post count remains unknown. Do not sum overlapping thread/feed counts.
- The rendered coverage line for a supported-browser capture whose 24h and 48h
  windows are both entirely unscanned says so plainly: `本期为浏览器截图抽样（M 张截图），
  未做区间遍历，近24小时与近48小时覆盖均未验证`. M counts screenshot evidence entries
  in the current collection. The following `滚动覆盖账本累计观察 N 条帖子、链接 L 个`
  and filter/deep-read counts come from `knownCandidates`, which can retain prior
  observations in the rolling horizon; they are not this capture's item counts.
  Any other case reports unscanned hours per window and likewise labels the
  link/filter/deep-read counts as cumulative rolling-ledger observations. Under
  `renderStyle: "concise"`, fully unscanned `gos-supported-browser` runs render
  `采集范围说明：X 时间线为浏览器有界抽样（近24小时与近48小时均未做全量区间遍历验证，未看到的帖子数未知）。`
  while preserving the detailed coverage ledger in `collection-coverage.md` and `## 差异补充`.
- Preserve partial results and exact failure reasons, actual timestamps, source
  dates and quote context. No missing receipt or history implies novelty.

- An interval is certified only by `explicit_empty`, an opted-in
  `ordered_timestamp_boundary`, or `observed_end`. The DOM reader reports
  scroll position (`atEnd`), never exhaustion, so scroll geometry alone stays a
  stall. The bounded follows-search adapter opts in (`allowExhausted`) to
  `observed_end` with `boundaryEvidence: "stable_scroll_end"` only when the
  bottom stayed settled (no loading indicator, no new post) for three reads
  before a completed recovery nudge and three reads after it, with no undated
  item. Any new post or non-bottom read voids the streak; the Following feed
  never opts in. This is still `best_effort_ui` evidence, not platform recall;
  the search time-filter check can still revoke it. Search windows are bounded
  by `since_time`, so an older post means the filter failed, not a boundary.
- Candidate/item keys: X posts are `x:<status id>`. Other URLs key on the
  canonical link (tracking parameters such as `utm_*`/`fbclid` and ordinary
  `#anchors` dropped; hash routes and identifying queries such as `?p=101`,
  `?v=…`, `?id=…` kept). Earlier versions dropped every query, so two such
  posts overwrote each other. Compatibility: the rolling state stores items,
  not keys, and published history and the deep-link audit key on URLs, so they
  re-key on load without error. Previously collapsed items cannot be restored.
  A `dispositions.json` or review written for a collection under the old keys
  no longer matches its query-bearing candidates and is rejected (fail closed,
  never a silent "new item"); rebuild the dispositions for that collection.
- Deep-read queue and collector page fetches accept only public HTTPS hosts.
  Plain HTTP (`insecure_protocol`), IP literals (`ip_literal_host`) and
  loopback/`.local`/`.internal`/`.localhost`/single-label names
  (`non_public_host`) are audited as filtered, never queued. Fetches re-check
  every redirect hop, browser deep reads discard text when the final page is
  refused, and bodies are size-bounded. This is a name check, not DNS-rebinding
  protection.
- A failed or unattempted source is unknown, not zero: compose lists it under
  `unavailableSources`, separate from `zeroYieldSources`.

```sh
node cli.mjs coverage-plan --config config/runtime.local.json
node cli.mjs coverage-report --config config/runtime.local.json
```

These commands are offline. They do not capture a browser or close gaps themselves.

## Required per-run collection disclosure

For every future controller run, keep `collection-coverage.md` in the private run
directory using `examples/collection-coverage.template.md`. This is a controller
material, not a new importer field or a machine-validated coverage schema. Do not
add unsupported fields to browser bundles or infer measurements from defaults.
The controller and independent reviewer own its factual validation. List this
file in publication `snapshotInputs.materialsPaths`, and list every supporting
capture/log/body actually used in the existing materials/evidence manifest.
The writer and reviewer must explicitly read it; `compose-input` does not load it.

Freeze a named source roster at collection start, with one row per actual planned
entry (Following, each watch profile, each configured blog/feed/profile, relevant
received-mail search, optional Substack). Record the roster's origin and known
configuration gaps. Public examples are not restored personalized subscriptions.
Do not drop failed/unattempted sources from the denominator or add each article
as a new source. Keep source types and within-type counts visible: a feed, an
account and a mailbox query are different units. Log any justified roster change.
If a complete roster cannot be established, use “已知计划来源” and state the gap;
do not invent a denominator for all subscriptions.

Each row records source ID/type, actual scope/query/time bounds, status, attempt
and observation timestamps, current-run counts, supporting evidence references,
and limitations. Use these reporting statuses (not importer status enums):

- `normal` / 正常: the declared bounded check finished with usable evidence,
  including an explicitly verified empty result. It does not mean exhaustive recall.
- `partial` / 部分: some usable evidence, but a declared check/read is incomplete,
  capped, interrupted, excerpt-only or has unresolved date/image limits.
- `unavailable` / 不可用: an actual attempt yielded no usable evidence; give the reason.
- `unattempted` / 未尝试: no actual attempt; give the reason. Do not relabel unavailable.
  A blog index that was opened and yielded no article link is `empty`, with the
  cause recorded in `collection-limitations.json`, not `unattempted`.

Reconcile actual capture/read evidence with normalized importer counts. A source
with `stats.blogs: 0`, an absent normalized entry or an importer “未采集” warning
may still have genuine manually read supplemental material. Record both the
normalized count and separately evidenced manual reads; explain the discrepancy.
Do not label the site unavailable merely because its material was not imported,
or treat a saved file/screenshot as proof of a full read without a reading record.
A successful index read and a partial article read have different scopes. Preserve
original importer warnings rather than rewriting them as if import had occurred.

Report the following distinct quantities, using unknown / 未知 when unmeasured:

1. **Source reach:** attempted/planned known source entries; attempted means an
   evidenced access attempt, including unavailable outcomes. Separately report
   usable/planned (`normal` + `partial`) and the four status counts. A failed
   attempt improves attempt coverage, never usable coverage. Always show raw
   fractions with percentages; a zero or unknown denominator gives N/A, not 0%.
2. **Current-run observation:** scanned pages (actual recorded page observations,
   not configured budget; repeated views are not new unique pages), screenshots,
   raw item occurrences, and distinct observed post/note IDs or canonical URLs
   when measured. Distinguish those from `candidateKeys(finalCollection).length`,
   the distinct candidate-key count: one underlying article can have multiple
   candidate kinds. Do not sum overlapping Following/watch/thread counts as
   unique posts. Label reused evidence separately with its original time, never
   count it as a new page/read this run.
3. **Time-window traversal:** for each of 24h and 48h separately, report the
   accounting cutoff and verified UI-scanned hours / window hours, unverified
   hours and actual gaps/reasons. Only existing coverage-ledger certified intervals
   count; union overlapping intervals. This is time coverage, not post coverage.
   For screenshot-only capture with no certified traversal, say “区间遍历未验证”;
   0 certified hours does not mean no posts were observed. Missing ledger is unknown.
4. **Reading progress:** relevant Gmail full bodies actually read / known matching
   messages within the stated query/window; distinguish unique message IDs from
   threads, previews, excerpts, unopened matches and failed reads. Truncated search
   or unknown pagination means the total is unknown, not the visible first page.
   For Xiaohongshu, record notes read / known discovered notes and meaningful
   images inspected / known images separately, with partial/excerpt/OCR-only
   limits. Report these ratios only when both numerator and denominator were
   actually measured; metadata retrieval is not reading.
5. **Candidate resolution:** distinct keys with validated included/merged/skipped
   dispositions / distinct keys in the final collection, plus each disposition
   count. Resolve grouped `keys` individually. Before validation this is pending,
   not approved. This measures disposition completion over observed candidates,
   not the proportion of all posts found or full texts read. Track supplemental
   mail/manual candidates separately if they are outside the imported key set.

Do not use rolling `coverage.accounting.knownCandidates` as this-run counts.
If shown, label them “滚动覆盖账本累计” with their accounting cutoff. A metric whose
population or time basis is unknown stays unknown, even when another count exists.
The platform's unseen eligible-post total is normally unknown: **真实全量帖子覆盖率
未知**. Neither source reach, time coverage nor 100% candidate disposition proves it.

Prefer exact counts to “大部分覆盖 / 小部分覆盖”. If a qualitative label is useful,
restrict it explicitly to known planned **usable sources**: all = 100%; most =
80% to less than 100%; partial = 50% to less than 80%; small part = greater than
0% to less than 50%; none = 0%; unknown when denominator is unknown/zero.
Print the fraction and this criterion with the label. These are reporting
conventions, not estimates of all-post recall. Never label bare “完整覆盖”.

### Final message and review placement

Include a short “本次采集范围” paragraph before `## 差异补充`, at the end of a
retained main section that already has a real sourced item. Use a plain paragraph
(or a `### 本次采集范围` subheading), not a URL-free `##` section or an unsourced
bullet. Do not invent a source URL merely to preserve this text. The renderer
omits the audit section and URL-free main sections. Keep full per-source details
in the declared material and audit, but retain reach/status, important failures,
this-run counts, 24h/48h limitations and unknown true recall in the exact send text.
Default rendering appends cumulative coverage and disposition lines. The explicit concise Mac render retains the unverified-hour and unknown-recall statement while keeping detailed cumulative and candidate counts in the bound audit.
If mandatory collection fails, do not create/send a partial digest; use the same
metrics in the controller's failure explanation instead, with unknowns intact.

Before genuine independent review, inspect the exact rendered message to ensure
this paragraph survives. Review numerator, denominator, deduplication, cutoff,
status evidence, configuration gaps, and every qualitative claim. Missing or
unverified coverage material requires correction or explicit unknowns, never
fabricated zeroes. Any later edit requires a new bound review as usual. These
controller requirements do not replace or weaken existing executable gates.
