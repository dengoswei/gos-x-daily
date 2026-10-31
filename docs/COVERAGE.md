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
  windows are both entirely unscanned says so plainly: `本期为浏览器截图抽样（观察 N
  条帖子、M 张截图），未做区间遍历，近24小时与近48小时覆盖均未验证`, followed by the
  link/filter/deep-read counts. N is `knownCandidates.observedPosts` and M the number
  of screenshot evidence entries. Any other case reports unscanned hours per window.
- Preserve partial results and exact failure reasons, actual timestamps, source
  dates and quote context. No missing receipt or history implies novelty.

```sh
node cli.mjs coverage-plan --config config/runtime.local.json
node cli.mjs coverage-report --config config/runtime.local.json
```

These commands are offline. They do not capture a browser or close gaps themselves.
