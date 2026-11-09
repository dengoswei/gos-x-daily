# Bounded approved-artifact reissue preparation

The core described below remains offline-only. This deployment also contains the
separately gated `reissue-transport.mjs` / `reissue-cli.mjs` described in
[REISSUE-TRANSPORT.md](REISSUE-TRANSPORT.md). Only root may activate that transport
using current verified runtime bindings and explicit send authorization; the
original daily gate remains unchanged.


Offline-only, isolated preparation for the explicit November 1 request to resend the
October 31 same-source refresh. This is **not** a new daily publication gateway,
source re-review, factual certification, transport implementation or authorization.
The preparation module never reads credentials, spawns a sender, accesses the
network, deploys or changes the original daily pipeline. The real artifact, user transcript, recipient,
ledger paths and review records belong outside this source directory.

## Trust and scope

The controller provides an externally verified SHA-256 of a private contract. The
contract pins the exact Library ID/version, body filename/size/hash, request evidence
hash/reference, existing historical recipient/deployment, allowed prefix and fixed
new reissue key. The adapter is bounded to report date 2026-10-31, original cutoff
2026-10-31T03:02:15Z and request date 2026-11-01. The historical body is never edited
or rerendered: payload bytes are **literal allowed prefix + two LF bytes + original
artifact bytes**, including every original preview status phrase and trailing byte.

The prefix is the controller-approved historical status label, not new substantive
news. The unchanged reader may still contain “not resent” or preview language;
the prefix explicitly explains that it describes the state at generation time.

Hashes establish identity, not facts. A real independently assigned reviewer must
read the final payload and compare artifact/request/target/prefix bindings. This is
fresh **payload-equivalence review only**, not original source-fidelity review.
No previous approval is reconstructed or inferred from missing source files.
The controller must establish the authenticity of the user request and Library
identity, reviewer independence, ledger currentness, bot identity, recipient,
runtime, and authority outside JSON. Passing a JSON record or changing its reviewer
name is not proof of any of these. Historical target receipts do not verify a
currently authenticated app. No test-only approval helper may review real work.

## Offline APIs

`prepareReissuePlan(inputs, {expectedContractSha256, reviewPath?})` reads only three
explicit local inputs (`contractPath`, `artifactPath`, `requestPath`), the pinned
existing ledger and optional review. Without a real approved review it creates a
pending, non-sendable plan. `pendingReissueReview` creates empty review fields only.
`validateReissuePlan` rederives every bound byte and can also compare an on-disk
`payloadPath`. Changed body, prefix, request, target, key, review or ledger fails.
Plans have a distinct kind and schema 1, not the generic daily sender's schema 2.
No executable or command arguments are included.

## Durable lifecycle — never call against a real ledger during preparation

`reserveReissueAttempt` is a dormant offline lifecycle primitive, not a sender.
Before any later authorized integration uses it, the root controller must approve
that integration and implement a real synchronous `verifyExternalAuthorization`
callback checking external authority/identity and the exact payload/plan/target.
A fabricated `() => true` callback would not establish real authority. A JSON or
boolean authorization argument is rejected. The adapter revalidates after this
callback and calls the original `recordDeliveryAttempt` exclusive/fsynced race gate.
Any prior attempt, receipt or uncertain marker blocks all new attempts; the key is
fixed and cannot be changed to retry. Never initialize a replacement ledger.

Only after the durable attempt exists may a separately authorized future transport
send the exact bound payload to the bound target under the bound key. That transport
must be reviewed separately; the preparation module does not implement it. The separately gated transport now
implements that integration; merely importing or testing it does not enable sends.
When using the dormant reservation API, every caught exception, timeout, nonzero
exit, malformed/absent confirmation or uncertain outcome must call
`recordReissueOutcome(reservation, null)`. The separately gated transport instead
uses the equivalent durable ledger primitives directly, including an uncertain
marker on every unconfirmed result.
`recordReissueOutcome` requires boolean API `ok: true` plus a nonempty message ID,
rejects a returned mismatched recipient, and stores either the original durable
receipt or an uncertainty marker. Acceptance is never read confirmation. If the
process dies, the attempt alone still blocks retry; restarted or forged handles
cannot finalize receipts through this adapter. Reconciliation is external, not an
automatic retry, ledger reset or new key.

No published-URL row is synthesized or modified for this historical resend: it is
not today's new coverage or a replacement for the old publication history. Future
integration may add a separate explicit reissue audit under separate authority.

## Preservation and checks

`delivery-ledger.mjs` is an exact unchanged copy of the recovered 2026-11-01 source
baseline. Existing generic publication code is not edited, imported or weakened.
Restoration alone does not authorize a live attempt. Original readers, backups, ledgers,
attempt keys and receipts remain untouched. Test-only ledger initialization and
approval helpers run only under temporary synthetic directories.

Run `npm test` and `npm run check`. Also rerun the untouched baseline's `npm test`,
`npm run check` and `npm run test:synthetic`, and verify it rejects a reissue plan.
These offline checks do not establish auth, a live send, source fact accuracy,
original review recoverability or durable environment persistence.
