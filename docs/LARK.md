# Optional Lark delivery integration

The core is dependency-free; live delivery additionally needs a separately
installed and authorized Lark CLI or compatible wrapper. No binaries, third-party
package archives, app IDs, recipient IDs or credential files are bundled.

The adapter invokes a command directly (no shell expansion):

```text
EXECUTABLE im +messages-send --as bot --user-id VERIFIED_OPEN_ID --markdown EXACT_RENDERED_TEXT --idempotency-key xdaily-DEPLOYMENT-DATE
```

`config.lark.executable` must be an explicit, verified absolute local executable
or wrapper path; a bare command on PATH is deliberately rejected. The example
path is a placeholder and must be replaced before enabling delivery.
A wrapper is recommended to pin the selected CLI version/binary, isolate its
profile/config/data/log directories, reject unexpected credential-environment
identity overrides, and restrict the allowed recipient and idempotency namespace.
Use a platform-appropriate installation from the official project:
https://github.com/larksuite/cli . The prior adapter contract was checked against
v1.0.98; this is not a claim that another installed version behaves identically.
Verify installed help and response schema before enabling live delivery.

The rendered `--markdown` text is the digest main body (title onward, collection
marker and `## 差异补充` audit removed), minus any `##` main section without a line
containing a URL, then the coverage line (`采集完整性：…`) and the candidate line
(`候选处置：…`). `review-input` and `prepare-delivery` produce the identical render,
and the review binds it.

## Compact native post transport

The optional `snapshotInputs.transport: "feishu-post-v1"` requires the same
`transport` on the verified deployment target and a compatible sender wrapper.
It keeps the reviewed Markdown in the plan's existing argument positions for
historical reconciliation. The plan additionally carries `transport.kind`, the
exact serialized `transport.content`, and its `transport.sha256`.

`lark-post.mjs` deterministically converts the reviewed Markdown into native
Feishu `text` and `a` elements. Each story and its citations share one content
row; blank Markdown lines do not produce empty post rows. This avoids the
installed CLI's `--markdown` conversion, which splits inline links/separators
into separate `md` elements that clients can display as separate blocks.

Before sending, the wrapper must verify the plan's exact Markdown, rederive the
post JSON, and compare its hash and bytes with both plan and review bindings.
Only then may it call the pinned CLI using:

```text
EXECUTABLE im +messages-send --as bot --user-id VERIFIED_OPEN_ID --msg-type post --content EXACT_BOUND_POST_JSON --idempotency-key EXISTING_CANONICAL_KEY
```

Enabling this transport invalidates earlier review approval: `review-input`
adds a mandatory `transport` unit for the exact JSON. Review the paragraph/row
boundaries, heading and bold styles, link order, visible text and coverage
paragraph, in addition to source fidelity. A text/link count or hash match alone
does not establish a good client layout. Existing accepted deliveries retain
their old plans and reconciliation path; never resend them to change format.

Supported authoring syntax is deliberately narrow: a plain `#` title, headings,
paragraphs, bullets, `**bold**`, inline code (displayed literally), and explicit
`[label](http[s]://...)` links. Images, fenced code, tables and unremoved collection
markers fail closed instead of triggering network fetches or dropping content.
Malformed links and unclosed bold/code spans also fail. No image or URL is fetched
by the renderer. Use ordinary punctuation rather than unsupported Markdown.

Readback compatibility was checked against the installed CLI v1.0.36 and its
[upstream post converter](https://github.com/larksuite/cli/blob/v1.0.36/shortcuts/im/convert_lib/text.go):
it concatenates native elements within each row, emits literal text (including
the bullet), represents links as `[label](href)`, and joins rows after the title.
`larkPostVisibleText` follows that projection. A synthetic host-context `--dry-run`
confirmed that `--content --msg-type post` preserves the exact post JSON; this is
an offline request-construction check, not evidence of a delivered client layout.

Successful subprocess output must provide a JSON object with **boolean** `ok: true`
and a nonempty `data.message_id`. CLI exit zero alone is insufficient. The exact
schema accepted is implemented and tested in digest.mjs. A failure after the durable
attempt record is written blocks automatic retry even if no receipt exists.

Credentials stay on the new deployment through that CLI's supported interactive
or secret-store mechanism. Never transfer credentials via Git/chat/command-line
arguments. Do not reuse a different app/profile by accident. Verify the bot and
recipient through read-only identity/API checks before setting `enabled: true`.
Credential storage may persist before a probe fails; inspect status safely instead
of blindly repeating setup or deleting state. No test message is required by setup.

This README is not a complete credential bootstrapper. The installing human or
agent must use the target machine's approved secret handling and authority. Code
setup, authentication, semantic approval, send authorization and API acceptance
remain distinct steps. The real publication gate must not be bypassed by invoking
the native CLI directly.
