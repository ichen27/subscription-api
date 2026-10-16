# Deployment

## Portable setup

Run as a user who has already signed into both official CLIs. Set an absolute persistent `APP_DATA_DIR`, absolute CLI executable paths, `PORT`, and `PUBLIC_ORIGIN`. Keep the listener on loopback. The process exits its child requests on cancellation/shutdown, so use a service manager with a shutdown grace period of at least three seconds.

Use an SSH tunnel for API clients that cannot supply Cloudflare Access credentials. The HTTPS endpoint behind Access and the launcher requires an authenticated owner session **in addition to** the gateway key. The launcher currently requires an owner-email JWT; simply adding a Cloudflare service token is insufficient. Machine access requires a deliberately scoped route or a private SSH tunnel. The initial deployment does not create a new Cloudflare service token or widen the existing owner-only policy.

## Personal launcher integration

`launcher.json` records this installation's manifest. Adapt its `cwd`, executable path, free port, and environment-file path when using it elsewhere. The launcher supplies `HOST`, `PORT`, and `APP_DATA_DIR`, then manages launchd, health checks, DNS, logs, and restart controls. No change to launcher source code is needed.

Before deployment, read the launcher's deployment guide and check both its app registry and live listeners for a port collision. Prepare the environment file outside Git with:

```dotenv
PUBLIC_ORIGIN=https://app-subscription-api.YOUR_DOMAIN
LAUNCHER_OWNER_EMAIL=YOUR_EXACT_OWNER_EMAIL
CODEX_BIN=/absolute/path/to/codex
CLAUDE_BIN=/absolute/path/to/claude
CHATGPT_MODEL=gpt-6.1-sol
CLAUDE_MODEL=sonnet
```

Only enable `LAUNCHER_OWNER_EMAIL` when using the existing trusted launcher gateway: it must independently validate the signed Access JWT and overwrite the forwarded identity headers. The gateway must reach this service over loopback, forward the exact public Host, set `x-forwarded-host` to that host and `x-forwarded-proto` to `https`, and set `cf-access-authenticated-user-email` to the authenticated owner. All dashboard mutations require the exact Origin. Local processes running as the same machine user remain trusted; this is not a multi-user security boundary.

Deploy with the launcher's CLI using this project's absolute manifest path. Confirm:

1. Launcher reports the app running and `/health` responds successfully.
2. Anonymous public requests redirect to Cloudflare Access; unsigned requests directly to the launcher are rejected.
3. Authenticated browser status recognizes both providers and a harmless prompt completes for each.
4. `/v1/models` and `/v1/chat/completions` require the gateway key, even for an authenticated browser.
5. The same gateway key remains valid after a real launcher restart.

## Recovery

### Claude background-service authentication

On the initial host, Claude's interactive sign-in worked in the terminal but `claude auth status` under launchd reported signed out. Merely restarting the app did not fix it. The service therefore uses the official `claude setup-token` automation flow, which authorizes an inference-only subscription OAuth credential.

Run `claude setup-token` interactively as the service user. Save the resulting token in a file outside the repository, owned by that user with mode `0600`, and configure `CLAUDE_OAUTH_TOKEN_FILE` with its absolute path in the service environment file. Keep the token out of terminal history, logs, screenshots, and the dashboard. The gateway passes it only to Claude; Codex never receives it. It is distinct from an Anthropic API key and does not enable a paid API fallback.

The credential has a provider-controlled lifetime. When it expires or is revoked, repeat the official flow and securely replace the file. The gateway rereads it for each operation. Do not rely on interactive keychain token refresh to renew an explicitly configured automation credential.

### Routine recovery

- Authentication expires: run `codex login`, or renew the configured Claude automation credential (otherwise run `claude auth login --claudeai`) as the service user on its host. Refresh the dashboard after five seconds. Do not paste OAuth codes into chat or a repository.
- Provider rate limit: select the other provider or wait for reset. There is no automatic provider switch or separately billed API fallback.
- Key rotation: stop the service, securely replace/delete `gateway.key` in `APP_DATA_DIR`, restart, then update clients with the new key. The file is generated on startup only when absent.
- Rollback: stop the app, check out the prior reviewed commit, redeploy its manifest, and verify health. Persistent data and provider logins are separate from source. Merely changing the Git branch does not roll back an already-running process.
- Shutdown leaves stale work directories after an abrupt host crash: after confirming the service is stopped and has no active provider children, remove only its empty `work/request-*` directories.

This app neither starts nor changes the historical llm-router or claude-router messaging services.

## Saved model defaults

The dashboard saves defaults in `APP_DATA_DIR/models.json` (owner-only, atomic replacement). These saved values take precedence over `CHATGPT_MODEL` and `CLAUDE_MODEL`, which seed a fresh installation. Changing a default affects later alias requests; explicit `provider/model-id` requests and already-started requests keep their selection. Back up this small settings file with the gateway key. Invalid settings fail startup instead of silently choosing another model.
