# Source provenance

This is a portable source-only extraction of the owner's existing X Daily code,
including subsequent browser-artifact, independent-review and delivery-ledger
work. It is not a restoration of private source evidence or deployment history.
The legacy collector was originally derived from the owner's macOS workflow and
ported to Node.js/Linux without copying browser profiles or credentials.

Excluded deliberately: production config/state, credentials and runtime logs,
private email, screenshots, source evidence, prior digests, private orchestration
reports, host-specific recovery scripts, original machine paths, installed
third-party code/binaries and source archives. User-owned editorial prompts and
synthetic tests are included.

Feed items carry `evidenceId` pointing at a `provenance.evidence` entry of kind
`fetched_document`: the feed document as downloaded by `tools/fetch-feeds.mjs`,
with its requested URL, fetch time, run-relative path and SHA-256. The hash proves
which bytes were imported, not that the publisher's entries are accurate.

No third-party license/ownership claim is invented. Dependencies or source acquired
in future must retain their actual notices and be reviewed before addition.
