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
