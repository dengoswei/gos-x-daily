# Current-run collection coverage — controller material template

Template only, not evidence. Replace placeholders with measured values or “未知”
and a reason. Do not copy example claims into an actual report without evidence.
Follow docs/COVERAGE.md. Store the completed file privately and declare it under
publication snapshotInputs.materialsPaths; explicitly read it for writing/review.

## Run and denominator

- Collection/run ID: <actual ID>
- Started / cutoff / completed at (timezone): <actual timestamps>
- Requested 24h / 48h windows: <exact endpoints>
- Known planned source roster origin: <actual configuration/user instruction>
- Configuration gaps and roster changes: <facts; unknown original sources if any>
- Reused evidence: <IDs and original observations; not new reads this run>

## Per-source record (repeat for each planned entry, including failures)

- Source ID and type: <Following / watch account / feed / blog / XHS profile / mail search / Substack>
- Declared bounded check/query/window: <actual scope; not all-platform scope>
- Status: <normal / partial / unavailable / unattempted>
- Attempt time / observation time: <actual or unknown/not attempted>
- Actual pages observed / screenshots / raw item occurrences: <counts or unknown>
- Unique post/note identities: <count, deduplication key and evidence, or unknown>
- Reading progress: <full bodies / known matching messages; notes / known notes;
  meaningful images inspected / known images; unknown denominators explicit>
- Normalized imported count / separately evidenced manual reads: <counts or unknown;
  explain discrepancies and retain original importer warnings>
- Failure, cap, partial text, pagination/date/image limits: <facts>
- Evidence references: <declared files/IDs supporting status, counts and times>

## Reconciled summary

- Known planned source entries P: <count or unknown; breakdown by type>
- Normal N / partial L / unavailable U / unattempted T: <counts; N+L+U+T=P>
- Attempted A/P: <A=N+L+U; fraction and % only if P known and >0>
- Usable S/P: <S=N+L; fraction and % only if P known and >0>
- Optional qualitative label: <only known usable sources; fraction + criterion>
- Current-run pages / screenshots: <counts and counting method or unknown>
- Current-run distinct observed posts/notes: <deduplicated count or unknown>
- Final collection distinct candidate keys K: <candidateKeys output count>
- Validated resolved distinct keys R/K: <included + merged + skipped; counts;
  validation result; pending until actually validated, N/A if K=0>
- Supplemental candidates outside imported keys: <observed and resolved counts,
  separate from R/K; or unknown>
- Gmail: <full bodies actually read / known unique matching messages; query/window;
  search completeness; excerpt/preview/unopened/failed counts or unknown>
- Xiaohongshu: <notes read / known discovered; meaningful images inspected / known;
  unknown totals, OCR-only and partial reading limits>
- 24h: <ledger cutoff; certified UI hours/24; unverified hours; gaps/reasons>
- 48h: <ledger cutoff; certified UI hours/48; unverified hours; gaps/reasons>
- Cumulative ledger statistics (if used): <explicit cumulative label + cutoff>
- True all-post coverage: 未知; unseen eligible-post denominator not established.

## Concise final-render paragraph (fill with verified facts)

本次采集范围：已知计划来源 <A>/<P> 已尝试，<S>/<P> 有可用材料
（正常 <N>、部分 <L>、不可用 <U>、未尝试 <T>）；<important gaps/reasons>。
本轮实际观察 <pages or unknown> 页，<distinct candidate count or unknown> 个候选；
<mail/XHS reading ratios when measured, otherwise important unknowns>。
近24小时 <certified traversal/gaps>，近48小时 <certified traversal/gaps>；
真实全量帖子覆盖率未知。

Place the completed paragraph within the last retained sourced main section,
before 差异补充. No URL-free level-two heading or fabricated citation. Check the
exact render. Keep all automatic cumulative/disposition lines and existing gates.

## Independent verification checklist

- [ ] Every planned source retained; statuses and failed/unattempted split evidenced.
- [ ] Numerators, denominators, time scope and deduplication reconciled.
- [ ] No screenshot extrema, queue completion or source reach called all-post recall.
- [ ] Current-run, reused and rolling cumulative statistics explicitly separate.
- [ ] Mail bodies/notes/images actually read; totals measured or explicitly unknown.
- [ ] Required summary survives render, all material statements independently reviewed.
- [ ] Material and evidence manifest complete; exact final version freshly bound.
