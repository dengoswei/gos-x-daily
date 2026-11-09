# Explicit immutable-artifact reissue transport

This separately reviewed adapter adds **only** the explicit October 31 historical
refresh resend requested on November 1. It is not a bypass for new daily reports.
The original daily `cli.mjs`, `digest.mjs`, source-review gate and ledger primitives
remain unchanged. New reports still require full original daily review/source gates.
The reissue body and prefix remain exactly those covered by the independent
artifact-equivalence review; no new collection or factual re-review is implied.

## Controller-owned evidence and authorization

An execution binding lives outside source control. Its externally supplied SHA-256
pins the reviewed reissue plan, contract, independent review, exact payload, verified
runtime configuration and a manifest of **the actually executing** four core modules.
The runtime pins the wrapper and every wrapper dependency/native executable, the
exact historical recipient/deployment, app identity and current nonsecret identity
verification evidence. Verification must be within 24 hours, not future-dated.
`recipientVerified` means identity correspondence to the exact prior private-chat
recipient, not proven reachability, successful delivery or read status. A current
app-owner ID matching the historical recipient can establish this correspondence;
no test message or broader contact permission is required.

Root owns the authenticity of all external evidence, genuine review independence,
current ledger state and actual user authority. JSON booleans and hashes are not
proof of those facts. Workers never enable or invoke a live send merely because
local preparation passes. Credentials stay in the separately authorized CLI store;
this adapter never reads them and never puts them in its runtime JSON or arguments.

## Commands

All paths and expected hashes below must be the actual reviewed private values.
A plan is persisted with exclusive creation plus file and directory fsync.

```text
node reissue-cli.mjs check --binding ABS_BINDING --binding-sha EXACT_BINDING_SHA
node reissue-cli.mjs prepare --binding ABS_BINDING --binding-sha EXACT_BINDING_SHA --out NEW_ABS_PLAN
```

The root controller alone may execute the following under the user's authority,
after checking current bot/app and exact recipient correspondence:

```text
X_DAILY_ALLOW_REISSUE_SEND=1 node reissue-cli.mjs send --binding ABS_BINDING --binding-sha EXACT_BINDING_SHA --plan ABS_PLAN --plan-sha EXACT_PLAN_SHA --allow-send
```

There is deliberately no default send, retry, alternate key, ledger initialization,
new boundary or automatic schedule. The fixed key is
`xdaily-gos-refresh-2026-10-31-request-20261101`. It stays fixed even when restoration
or sending happens on a later day. The ledger remains the same preserved ledger
with its original history and boundary. New ledger activity invalidates a plan's
snapshot; re-preparation/review is required, never rollback or deletion of records.

## Exact transport and durable stop

Sending re-reads every pinned input and rederives the entire plan. It invokes the
verified absolute wrapper without a shell, using only these fixed arguments:

```text
im +messages-send --as bot --user-id EXACT_HISTORICAL_RECIPIENT --markdown EXACT_REVIEWED_PAYLOAD --idempotency-key FIXED_REISSUE_KEY
```

The subprocess receives only the explicit safe runtime environment, never ambient
credential/identity overrides, shell startup hooks or Node injection variables.
The wrapper isolates its own config/data/log/profile and verifies its native binary.
A durable exclusive attempt is written and fsynced **before** invoking the sender.
The attempt binds the transport-plan hash plus executable/app/target metadata.
Every timeout, exception, signal, nonzero exit, malformed/missing confirmation,
returned recipient mismatch or receipt-persistence failure stops as uncertain,
retains the attempt, and tries to persist an uncertain marker. A process crash also
leaves the attempt blocking every retry. No raw CLI stdout/stderr is printed.

Acceptance requires boolean `ok: true` and nonempty `data.message_id`; an optional
`data.receive_id` must match. API acceptance is not recipient read confirmation.
A successful reissue does not append synthetic new-coverage URL history. If any
attempt/receipt/uncertain file already exists, reconcile externally; never change
the key, reset the ledger or run the wrapper directly to bypass the guard.

## Verification

Run `npm test`, `npm run check`, and `npm run test:synthetic`. Transport tests use
only synthetic temporary ledgers and mocked subprocesses, not the real wrapper.
They cover exact arguments, durable-before-invoke ordering, unchanged historical
records, body/prefix/target/key/hash/runtime tampering, both authorization gates,
current identity evidence, source-module pinning, isolated environment, duplicate
states, process/receipt uncertainty, and mutual rejection of generic daily and
reissue plans. Passing tests does not authorize sending or prove current login.
