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

Further browser, restart, clean-checkout, and GitHub delivery results are recorded below after final verification.
