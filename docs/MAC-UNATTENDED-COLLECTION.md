# Unattended Mac Collection Architecture

Gos X Daily runs on macOS using a foreground-safe scripted browser collector (`deployment/mac/mac-collect.mjs`) paired with `node $DEPLOYMENT_HOME/run.mjs local auto` (or `local collect` + `local deliver`). This replaces interactive `codex` app-session collection in scheduled automation.

## Why scheduled Codex browser sessions were replaced

Observed failure modes in unattended `codex` scheduled automation runs fell into four structural classes:

1. **Interactive browser bridge stalls (`codex_apps`)**: Playwright/Codex app page-open calls can block for minutes and return null page handles during session contention.
2. **Non-interactive policy blocks (`guardian_review` / approvals)**: Scheduled unattended turns lack an interactive terminal user to approve navigation or shell actions.
3. **Sub-step timeouts**: Driving the full page-by-page scroll, OCR/link extraction, and prose drafting inside a single agentic loop hits per-turn timeout ceilings.
4. **Reader-fidelity coupling**: Delegating source extraction and digest composition to one unscripted session breaks schema/evidence isolation; composition and final review now run exclusively through the deterministic `run-daily.mjs` pipeline (`deployment/mac/daily.mjs`).

## Foreground-safe Dia background window (`--backend apple-events`)

The default `apple-events` driver automates a live signed-in browser (`Dia` by default) **without stealing foreground focus, moving the cursor, or disrupting existing windows**:

1. **Dedicated isolated window**: Calls `make new window` **without** AppleScript `activate` or `focus` (in Dia's scripting dictionary, `focus` brings a window forward).
2. **Window-ID binding**: Navigates a unique data-URL probe `<title>gos-xdaily-bg-<hex></title>`, closes the initial blank tab so our dedicated window holds **exactly one tab** at all times, and matches `CGWindowListCopyWindowInfo` (`kCGWindowName` containing the probe title) to obtain the exact `CGWindowID`. There is no fallback window: if the marker is not found, at start or when a capture must re-bind through a fresh marker, collection fails instead of capturing another browser window.
3. **Zero-focus tab replacement & capture**: Every `openUrl` opens a new tab inside that owned `window id` and closes the previous tab, keeping the controlled page active inside its background window without raising it. Evidence screenshots and dynamic CUA viewport images use `/usr/sbin/screencapture -x -o -t jpg -l <cgWindowId>`.
4. **Guaranteed teardown**: `close()` closes only the dedicated `window id` opened for the run, leaving all user windows and tabs untouched.

Because `Dia` shares its existing signed-in cookie jar across windows in the same profile, authenticated X (`x.com/home`, search, watch accounts), Substack, and Xiaohongshu views work directly once signed in inside Dia.

## One collection flow, interchangeable browser drivers (`--backend`)

Collection logic is the same on every machine; only the browser driver differs. A driver implements seven methods (`init`, `openUrl`, `evalJson`, `screenshot`, `captureViewBase64`, `close`, `getEvidence`) and every source, limit, Gmail check and CUA rule above and below applies to all of them.

| Backend | Default on | Reaches the signed-in browser through |
| --- | --- | --- |
| `apple-events` | macOS | AppleScript + `screencapture` on a dedicated Dia/Chromium window |
| `cdp` | every other OS | A loopback DevTools endpoint (`--cdp-endpoint`, default `http://127.0.0.1:9222`) of an already running, already signed-in Chromium (`deployment/mac/cdp-browser-driver.mjs`) |
| `codex-exec` | never (explicit) | `codex exec` |

The `cdp` backend opens one window of its own (`Target.createTarget` with `newWindow`), works only in that target and closes only that target; it never navigates, focuses or closes other tabs and never quits the browser. The endpoint and the browser socket it advertises must both be loopback. Because the repository keeps CDP collection off by default, this backend additionally requires `collectionEnabled: true` in the run's runtime configuration **and** `X_DAILY_ALLOW_COLLECTION=1` in the environment:

```sh
X_DAILY_ALLOW_COLLECTION=1 node "$DEPLOYMENT_HOME/run.mjs" local auto
```

## OpenAI `gpt-6.1-terra` Responses API assist (dynamic blog indexes)

Configured `blogs[]` entries first use deterministic DOM anchor extraction (`extractBlogLinksFromDom`). Only when static anchors yield **0 articles** and the page is **not** gated by a CAPTCHA/anti-bot interstitial (`Verify you are human`, Cloudflare Turnstile, etc.), `collectBlogs` invokes `assistBlogIndexWithTerra`:

- **Endpoint & contract**: Stateless `POST https://api.openai.com/v1/responses` (`store: false`), `model: "gpt-6.1-terra"`, `include: ["reasoning.encrypted_content"]`, `reasoning: { effort: "low" }` (without `temperature`, `top_p`, or `logprobs`), plus strict `inspect_blog_index` tool schema.
- **Inputs**: Initial DOM candidate summary + background window JPEG from `captureViewBase64()` (temp JPEG deleted immediately in `finally`), up to 3 bounded scroll/click turns, echoing returned reasoning items verbatim.
- **Safety & scoping**: Every candidate URL returned by the model is re-validated through `normalizeAndFilterBlogUrls` against `blog.articleBaseUrl` (`https:`, exact origin, subpath, slug sanity) and `blog.articlePattern`.
- **Key resolution**: Uses `--api-key-file`, else `deployment.local.json` `model.apiDraft.keyFile` (`CODEX_API_KEY`), else `OPENAI_API_KEY` / `CODEX_API_KEY`. A key file must hold exactly one `CODEX_API_KEY=...` line. When an empty index needs the assist and no key resolves, the reason is recorded in `collection-limitations.json`. Disable explicitly with `--no-cua` or override model with `--cua-model`.
- **Origin lock**: Before every request, the page must still be on the origin of `blog.indexUrl` or `blog.articleBaseUrl`; if a redirect or a model-requested click left it, the assist stops and neither the DOM snapshot nor the window image of that page is sent.

### Why `gpt-6.1-terra` Responses API over alternatives

| Option | Fit for unattended personal Mac (`Dia`) | Decision |
| --- | --- | --- |
| **OpenAI `gpt-6.1-terra` (`POST /v1/responses`)** | Reuses `deployment.model.apiDraft.keyFile`, stateless bounded fallback only when DOM extraction returns 0, zero desktop focus hijack | **Chosen** |
| **Google Gemini Computer Use (`gemini-2.5-computer-use-preview`)** | Viable alternative API, requires separate billing/key plumbing | Deferred |
| **Desktop harnesses (`trycua/cua`, OS mouse/keyboard replay)** | Controls OS pointer/VM rather than a single background browser window | Rejected (disrupts foreground user) |
| **Playwright / Stagehand via dedicated Chromium profile** | Clean DOM automation, but does not share native `Dia` login cookies without launching a debug port | Rejected (extra auth maintenance) |

## Strict fail-closed Gmail newsletter isolation (`sources.gmail`)

Gmail newsletter URL discovery never falls back to `/mail/u/0/` or whichever Google account happens to be index `0`:

- **Disabled by default**: If `sources.gmail` is omitted or `{ "enabled": false }` (or `--no-gmail` is passed), `mail.google.com` is never opened and Gmail CLI is never invoked.
- **Explicit account required**: Enabled configs must specify `"account": "<user>@gmail.com"` in private `sources.local.json` (never committed to Git). Invalid configs throw immediately via `validateGmailConfig`.
- **Modes (`auto` | `gmail-cli` | `browser`)**:
  - `gmail-cli`: Runs `gmail readonly sendas --json` + `gmail readonly read --max <N> --json -- <query>` with `AGY_ACCOUNT=<account>` (fails closed if `AGY_ACCOUNT` is unauthenticated, or if `sendAs` is empty, unparseable or does not list the account). Note that Antigravity's plugin wrapper only injects credentials inside Antigravity agent sessions; standalone `launchd` jobs without standalone `gmail` auth should use `mode: "browser"` or `mode: "auto"`.
  - `browser`: Opens `https://mail.google.com/mail/u/?authuser=<account>#search/<query>`, extracts account emails outside `[role="main"]` (and the Gmail title account slot), and **aborts before clicking any `tr.zA` row** if the active mailbox does not exclusively match `sources.gmail.account`.
  - `auto` (default when `sources.gmail` is configured): Tries `gmail-cli` first, then falls back cleanly to verified `?authuser=` browser extraction.
- **Alternative (zero mailbox access)**: Forward desired technical newsletters to a dedicated RSS inbox service (e.g., Kill the Newsletter or self-hosted RSS bridge) and configure it as an ordinary `feeds[]` entry in `sources.local.json`.

## Unattended `launchd` scheduling notes

Keep Mac Automation (`System Events` / `Dia`) and Screen Recording permissions granted to the launch shell/Terminal running `launchd`, keep Dia open (can stay in the background) and signed into X/Gmail (for `browser`/`auto` mode), and ensure the Mac wakes via `pmset schedule` before the job:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.example.gos-x-daily</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>exec node "$HOME/Documents/GosXDaily/run.mjs" local auto</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key><integer>9</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
  </dict>
</plist>
```

For manual collection only (without delivery), run:

```bash
node "$DEPLOYMENT_HOME/run.mjs" local collect --run "$DEPLOYMENT_HOME/runs/<RUN_DIR>"
```
