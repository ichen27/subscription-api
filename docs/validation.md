# Validation — 2026-10-15

Initial release, Node.js 22+ on macOS. Codex CLI 0.159.2 and Claude Code 2.1.273.

## Automated checks

- `npm ci`: passes; no runtime npm dependencies.
- `npm test`: 18 tests pass. Covers authentication, exact forwarded identity, CSRF, both provider routes, model catalog, invalid and oversized input, JSON/SSE success and error responses, client cancellation, subprocess timeout/output bounds, credential isolation, private OAuth-file enforcement, concurrency, and gateway-key persistence.
- `npm run check`: syntax checks pass for source, browser JavaScript, scripts, and tests.
- `git diff --check`: passes.

## Live provider checks

- ChatGPT subscription sign-in verified; a real Codex request returned `SUBSCRIPTION_API_OK`.
- Claude interactive subscription sign-in verified; a real Claude request returned `CLAUDE_SUBSCRIPTION_OK`.
- Background-service testing exposed a difference: the launchd process reported Claude signed out despite the terminal login working. The official `claude setup-token` flow resolved service authentication. An explicitly configured owner-only OAuth file is now used only for Claude.
- Deployed ChatGPT dashboard prompt returned `ChatGPT connection verified.`.
- Deployed Claude HTTP Chat Completions request returned 200 using the automation OAuth credential.
- Both provider sign-in states are connected in the deployed service. This is authentication status, not a guarantee of remaining quota.

## Access and deployment

- Managed launcher service is running on loopback port 8932.
- Public anonymous request to the app returned 302 to the existing Cloudflare Access login.
- Loopback API request without a gateway key returned 401.
- `/health`, authenticated `/api/status`, and authenticated `/v1/models` returned 200.
- The Subscription API card appears in the authenticated launcher and is marked running and favorited.

## Final verification

- Authenticated Chrome dashboard: both providers show Connected. ChatGPT returned `ChatGPT connection verified.`; Claude returned `Claude connection verified.`.
- Copy-key action succeeded without revealing the key in the page. Copy-endpoint action and expandable curl example were verified. The complete dashboard is saved in `docs/dashboard.png`.
- Real launcher restart: the gateway key was unchanged and both providers remained connected.
- After restart, both providers returned HTTP 200 through the SSE Chat Completions route, with content `OK`, a terminal `[DONE]`, and no error event.
- Fresh GitHub branch clone: `npm ci`, all 18 tests, and syntax checks passed. This validated setup from committed source rather than the development working tree.
- GitHub Actions passed on the implementation revision. Final artifact-only changes also run through CI before merge.
- Diff reviewed for auth boundaries, secret isolation, subprocess cleanup, supported-field validation, and provider error handling. Temporary authentication diagnostics were removed.
- GitHub rejected branch-protection access with HTTP 403: this private repository requires a plan upgrade for that feature. Checks are configured and verified manually before merge; protected-branch enforcement is not claimed.

## Known limits

No mobile-device browser test was performed. The CSS includes narrow-screen layouts, but only the desktop browser was visually verified. HTTPS API access requires the existing Cloudflare Access authentication plus the gateway key; clients without Access support can use an SSH tunnel. Remaining subscription quota and provider-side charges were not measured. CLI upgrades and expiring OAuth credentials require maintenance.

## Model selection update — 2026-10-15

- `npm ci`, `npm run check`, and all 21 tests pass. Added coverage for explicit model routing, saved-default authentication/origin checks, concurrent atomic saves, persistence, invalid identifiers, failed-write handling, and concurrency across different models of one provider.
- Authenticated Chrome: selected `chatgpt/gpt-6-luna` and received `MODEL_PICKER_OK`; entered custom `claude/claude-opus-4-8` and received `CLAUDE_MODEL_PICKER_OK`.
- Saved Claude’s custom model, restarted the launcher-managed service, reloaded the dashboard, and observed `Saved default (claude-opus-4-8)`. Restored the original defaults (`gpt-6.1-sol`, `sonnet`) after testing.
- Verified per-request selection updates the displayed curl example without changing the saved default. Updated `docs/dashboard.png` from the deployed page.
- The Bash request block in `examples/github-actions-step.yml` passes `bash -n` and ran successfully against the local gateway with `chatgpt/gpt-6-luna`. This verifies the request step, not GitHub networking.
- Inspected the launcher auth implementation: it requires a signed JWT with the configured owner email. A Cloudflare service token alone is insufficient. Updated the deployment and CI guidance accordingly; no launcher source or Access policy changes were made.
- No target GitHub repository, CI job purpose, machine network credentials, or live GitHub-to-gateway call is configured for this integration. The YAML artifact is explicitly a step fragment with a network prerequisite.

## Review-agent candidate — October 19, 2026

This evidence concerns the unactivated review-agent branch, not the deployed gateway. The historical checks above do not prove the new sandbox passes live acceptance.

- `npm ci`, all **74 tests**, `npm run check` and `git diff --check` pass. Hosted CI passes on sandbox revision `b137e47`. Tests cover private configuration, atomic snapshots, ZIP/archive validation, owner/project authorization, queue isolation, provider exclusion, scoped tool events, bounds, cancellation, cleanup and concurrent stale-lock recovery. Independent reviews found no remaining actionable findings after repairs.
- The owner portal was exercised in a synthetic browser session: edit/save, tabs and 390px mobile layout without horizontal overflow. [Desktop](review-agents/portal-agents.png) and [mobile](review-agents/portal-projects-mobile.png) screenshots contain demonstration data.
- Real Docker offline smoke passed with CLI **2.1.301**, image `sha256:6e5c41d107529e69590a3b0a96dfdd825531c90e5c1c2ac48e37ef1e94fa08d7`. [Machine-readable evidence](review-agents/smoke-offline.json) records mode `offline`; its `completed: true` means the offline checks completed, not inference. Example/GitHub CONNECT denied; inference CONNECT allowed; direct internet, host and arbitrary DNS connections blocked; source write denied; host canary inaccessible; probe container lacks credentials; selected skill listed and repository skill excluded.
- Safe mode did not load the selected skill. Restricted mode with empty settings sources, managed policy and an empty working directory did. The startup tool set was Read/Grep/Glob/Skill plus the schema tool. Built-in vendor plugins remain visible, so selected-skill permissions and event checks are required. Startup visibility alone does not prove invocation or permission enforcement.
- A real inference attempt failed with `subscription_limit`. No successful live result is claimed. Still pending: selected skill invocation, explicit CLI outside-path denial, schema output with tools, live usage/steps, observed inference hosts across a successful run, representative review latency, personal Claude compatibility on this candidate, approved deployment/Cloudflare changes, and hosted reviews from **both** clients.
- The controlled permission smoke bypasses only its deliberate `/etc/passwd` event in the extra observer and requires the CLI's own explicit denial. Production enforcement is unchanged. This test has not yet passed live.

Reproduce from a clean candidate checkout with the commands in [deployment](deployment.md#repository-review-rollout). Do not enable the runner until the pending acceptance evidence has been recorded. No credentials, raw prompts, model replies or private source are included in the evidence artifacts.

The candidate's personal ChatGPT provider subsequently passed a harmless live `COMPATIBILITY_OK` request through `createProviders` with isolated temporary runtime data. No deployed service or provider configuration was changed. Personal Claude and sandbox inference remain pending due to the known subscription limit.
