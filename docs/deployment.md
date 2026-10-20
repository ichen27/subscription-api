# Deployment

## Portable setup

Run as a user who has already signed into both official CLIs. Set an absolute persistent `APP_DATA_DIR`, absolute CLI executable paths, `PORT`, and `PUBLIC_ORIGIN`. Keep the listener on loopback. The process exits its child requests on cancellation/shutdown, so use a service manager with a shutdown grace period of at least 30 seconds.

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

## Repository-review rollout

This section covers the shared HTTP gateway and its Slice/Cuse clients. The standalone [queued PR worker](queued-pr-agent.md) does not require these gateway deployment or Cloudflare steps; it uses a separate protected workflow environment and disposable VM.

**Current state:** implementation, offline isolation and live sandbox acceptance are verified. The existing service and legacy client routes have not been changed. Gateway activation and both client migrations remain separate deployment work. Keep `REVIEW_IMAGE_DIGEST` unset in the live gateway until its deployment is performed and verified. `/health` confirms the HTTP process, not sandbox readiness.

1. On an isolated checkout, run `npm ci`, `npm test`, `npm run check`, then `npm run sandbox:build`. The service user needs a running Docker daemon and permission to create containers and isolated bridge networks. Use the digest printed by the build; the runtime requires a local `sha256:` image ID, not a mutable tag. The image has a pinned CLI and base images. No registry push is required.
2. Run `npm run sandbox:smoke -- --offline`. Then supply the private `CLAUDE_OAUTH_TOKEN_FILE` and run `npm run sandbox:smoke`. Keep full CLI output private. Save only the sanitized final evidence. The live script must pass explicit skill invocation, head/base reads, CLI path denial, structured output, warnings and usage. Also verify harmless personal requests through each available provider and a representative repository review. A rate-limit failure leaves acceptance pending.
3. Back up private `APP_DATA_DIR/review/` and the service environment with owner-only permissions. Configure `DOCKER_BIN` if needed and the verified `REVIEW_IMAGE_DIGEST`. The OAuth file stays outside Git. GitHub read tokens are set per project in the owner portal; they never enter the review container. One Claude busy guard covers personal, legacy and sandbox requests. A review can occupy it for up to the configured 600 seconds plus setup/cleanup.
4. Merge the reviewed PR stack in order only after its current checks and reviews pass; then perform the separately approved service deployment/restart. Give shutdown at least 30 seconds. Validate personal and legacy routes, project isolation, new-job success and cleanup. No host-tool fallback is available if Docker or startup cleanup fails.
5. **Maintainer Cloudflare step:** mirror the existing dedicated Service Auth application and exact-path origin audience validation described in [the legacy CI guide](slice-ci.md#production-access). Extend that application to `/ci/review` and insert an anchored `^/ci/review$` tunnel rule for the exact gateway hostname before the wildcard, pointing to the loopback origin. Keep Access validation required with the correct audience. Preserve the old rule, owner launcher and unrelated routes. Verify no credentials, either credential alone, and both together; only the pair should reach the new API. Management remains behind the owner launcher.
6. Through the owner portal, create separate Slice and CuseSublets projects with exact repository names, approved agents/skills and repository-scoped Contents: read tokens where needed. Put each one-time project key into that repository's protected CI environment. Use separate keys; do not expose provider OAuth, general gateway keys or GitHub download tokens to CI.
7. Activate one client at a time. Pin base/head, retain source validation and unsuccessful incomplete reports, show safe warnings, and run an end-to-end hosted review through collection, submission, validation and publication. Keep the legacy defaults available for rollback. Retire `/ci/slice/review` and `CI_REVIEW_KEY_FILE` only in a separate reviewed PR after **both Slice and CuseSublets** have migrated successfully.

### Sandbox networking and recovery

Each job creates an isolated internal Docker bridge and a proxy container with an additional external network. The review container has no external network or host ports. The proxy permits only inference CONNECT to `api.anthropic.com:443`. The Docker host must support `com.docker.network.bridge.gateway_mode_ipv4=isolated`; the real smoke is the compatibility check. Never substitute a plain internal bridge and assume it blocks host access. The Docker daemon and local service account remain trusted.

Startup removes orphaned containers/networks bearing this runtime's owner label and only its temporary review directories. A PID lock prevents concurrent runtime owners; a separate recovery guard serializes stale-lock recovery. If startup reports unavailable, inspect privately after stopping the service. Never delete a lock/guard while a runtime or recovery process is active. A stale recovery guard requires manual removal only after confirming that no owner/recovery is running. A shutdown-deadline error requires verifying container/network cleanup before restart. Do not indiscriminately prune Docker or delete other projects' data.

Rollback the new route by restoring clients to their legacy configuration, unsetting `REVIEW_IMAGE_DIGEST`, and restarting through the service manager. Preserve the review store for recovery and leave legacy Access/key configuration intact. Queued/running jobs are not durable across restart; clients must report those runs unsuccessful. For a full source rollback, restore the prior reviewed commit and matching private configuration backup without publishing secrets.
