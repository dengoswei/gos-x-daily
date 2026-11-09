# Mac source consolidation, 2026-11-09

The previous Mac installation contained an imported Git snapshot with no remote.
Its two local commits were `fa52f67` and `ec261f1`; the November 8 Mac self-review
and local-controller changes were still uncommitted. Neither a local Git directory
nor a passing installed manifest established synchronization with GitHub.

This branch starts from the actual GitHub `main` history. It incorporates the
source-only installed snapshot, including the previously local coverage/recovery
changes, then adds the Mac deployment modules and new editorial/worker/native-post
work. The old installation remains a preserved historical snapshot, not another
canonical source checkout. Runtime configuration, credentials, source evidence,
attempts, receipts and published URLs are excluded.

## Problems and changes

1. The pinned CLI's Markdown converter splits inline citations and separators
   into separate `md` elements. Native `text`/`a` elements preserve one paragraph
   row. The exact native JSON is separately reviewed and hash-bound; the sender
   checks it again. Historic Markdown receipts remain reconcilable.
2. The editorial preference for two or three sentences encouraged compression
   before the mechanism was understandable. Items now require a coherent central
   idea and explicit reasoning, with length determined by the explanation.
3. Full captures/articles entered one model context. The new worker CLI emits
   body-free indexes and lossless per-candidate files. Real host subagents consume
   assigned source/story packets; the CLI itself never pretends to run models.
4. The source runtime rejected an entire named personal workspace, preventing a
   legitimate portable clone from running offline tests there. That obsolete
   path substring rule was removed. Existing collection authorization, disabled
   defaults and dedicated-browser checks remain.
5. macOS temporary-path aliases made synthetic tests fail realpath guards.
   The test runner canonicalizes the temporary root; production path validation
   stays strict.

## Verification boundary

Offline tests cover inline citation grouping, changed-payload rejection,
legacy-receipt projection, exact review binding, worker inventory completeness
and file integrity. CLI dry-run can verify serialization without sending.
Neither proves the final Feishu client's visual layout. Record the next actual
production readback and visual observation separately. Do not send a test digest
or resend an already receipted day to demonstrate the change.
