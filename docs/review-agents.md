# Review agents

Implementation is staged. The owner portal at `/reviews` manages configuration; the new CI route and container runner are not yet activated. Existing personal and CI text routes are unchanged.

The private store lives under `APP_DATA_DIR/review/`. `config.json` contains versioned agents, projects and skill references. Project keys are generated once and only their SHA-256 hashes are retained. Public configuration views omit hashes and secret references. `secrets.json` contains versioned GitHub tokens with mode 0600. Tokens are never returned by the portal. Changing a project's repository clears its token unless a replacement is explicitly supplied.

Writes are serialized and files are replaced atomically. Secret versions are written before the config commit point; interrupted saves can leave an unreferenced secret version, never a committed reference to a missing token. Obsolete versions are removed on later mutations. Skill revisions are immutable and content-addressed, so queued job snapshots retain their original instructions, settings and skill contents. Runtime data is private and must not be committed.

Invalid persisted data disables the review store with `review_config_invalid`, rather than overwriting it. The HTTP integration isolates that failure from the existing personal API. Skills accept bounded text files and a standard `SKILL.md` with simple name/description frontmatter; path traversal, symlinks, binary content and missing metadata are rejected. Multiline YAML metadata is currently unsupported and reports validation failure.

The portal, project-scoped async jobs and candidate container runner are implemented. Live acceptance, deployment and client migrations for both Slice and CuseSublets remain pending. The legacy `/ci/slice/review` endpoint, including Cuse's `full-context-v1` mode, must remain available until both clients have migrated successfully. A review job must pin both source revisions when base-side evidence is needed. Tool access does not replace independent citation or completion checks.

Validation: `npm ci`, `npm test`, `npm run check`. No live configuration or gateway restart is required to exercise the isolated store tests.

## Owner portal

Open **Manage review agents** from the dashboard through the authenticated owner launcher. Ordinary gateway keys and project keys cannot access management APIs. All mutations require the exact browser Origin. Skills accept pasted SKILL.md or bounded ZIP files; encrypted entries, links, traversal, invalid UTF-8, binary content and over-limit expansion are rejected before storage.

Create skills, then agents, then projects. Choose allowed agents per project, and use a fine-grained GitHub token with Contents: read on that repository for private source. Leave the token blank during edits to retain it, or select Remove saved token. Changing repositories clears the token unless a replacement is supplied. Project creation and rotation return a key once; copy it into CI secrets before dismissing it. Rotation immediately revokes the old key.

Desktop and mobile demo screenshots use synthetic project data: [agents](review-agents/portal-agents.png), [projects on mobile](review-agents/portal-projects-mobile.png). Browser validation exercised agent editing/saving, tab switching, and a 390px layout without horizontal overflow. HTTP tests cover access boundaries, reference deletion, rotation and secret redaction.

## Project job API

`POST /ci/review` requires a project Bearer key, no Origin header, and `Prefer: respond-async`. Send `agent`, exact `repository`, full 40-hex `commit`, optional full `base`, 1–100 text `messages` ending in a nonempty user message, and optional OpenAI-style `response_format` JSON schema. Limits are 400,000 message characters and 640 KB body. Agent settings choose the model; request-level model or stream fields are rejected.

The 202 response includes `id`, `agent`, queue status and a `Location` for polling. `GET /ci/review?agents` lists only that project's allowed agents, without instructions. `GET /ci/review?job=<id>` returns queued/running/completed/failed state, with a chat-completion `result` and safe usage metadata only on completion. Poll more often than every two minutes; abandoned work is cancelled. Legacy and new asynchronous reviews share one queue with four waiting slots.

Jobs belong to the submitting credential generation. Rotation or deleting/recreating a project prevents access to previous jobs, even with a reused project name; rotate outside active runs. Unauthorized polling cannot extend a job's lifetime. Queued requests retain a snapshot of instructions, skill contents, source revisions and selected model. A failed, aborted or unfinished execution never becomes a successful job. Clients still need to validate review completeness and findings independently.

Until a verified sandbox runner is configured, submissions return `503 sandbox_unavailable`. Listing and management work independently. There is no host-tool or text-only fallback for the new route.

## Sandbox candidate — validation pending

The sandbox implementation is available behind an explicit `REVIEW_IMAGE_DIGEST` setting, unset by default. **Do not enable it yet:** live subscription inference hit `subscription_limit` on October 19, 2026. The complete skill invocation, outside-read denial, structured completion and representative review acceptance checks remain pending. Personal Claude live compatibility remains pending; the candidate ChatGPT provider passed a harmless live request, and deterministic compatibility tests pass.

Build with `npm run sandbox:build`. `npm run sandbox:smoke -- --offline` validates real Docker network isolation, read-only mounts, host canary isolation, selected skill loading and repository skill exclusion using a dummy OAuth value; it makes no inference request. Its checked [result](review-agents/smoke-offline.json) is not a completed live review. `npm run sandbox:smoke` additionally requires `CLAUDE_OAUTH_TOKEN_FILE` and fails unless skill invocation, head/base reads, explicit outside-read denial, schema output, usage and warnings all pass. The smoke fixture supplements a pinned tiny public repository with synthetic test files.

The runtime uses a pinned CLI image, a per-job isolated internal bridge and a dual-network proxy container that permits only `api.anthropic.com:443`. Direct external and host connections are blocked in the offline probe. This replaces the design's host-bound proxy because the Docker daemon is inside the macOS VM; an internal bridge alone still allows host-gateway access. Review containers have no shells/package managers, no Docker socket, read-only source/skills mounts, dropped capabilities, non-root UID, bounded memory/CPU/processes and temporary home/storage. GitHub tokens stay in the host downloader. Both head and optional base archives are fetched by exact SHA; links and unsafe archive entries fail explicitly.

CLI safe mode suppressed the selected plugin skill in the startup probe. The candidate instead uses restricted mode, empty settings sources, an empty working directory, immutable managed policy disabling repository customizations/hooks/MCP, and only the selected plugin directory. Built-in vendor skills/plugins remain visible in this CLI version; only selected skill names are preapproved and unexpected skill calls fail the job. Full live permission enforcement remains an acceptance gate. The synthetic `StructuredOutput` tool is expected only with a response schema. Streaming tool-use events are counted independently of `num_turns`; exceeding the configured tool bound fails the job.

Startup cleanup is scoped to a label derived from the runtime work directory, protected by a process lock. Job cleanup removes its containers, network and temporary source. A cleanup failure remains unsuccessful. The sandbox shares Claude's busy guard with personal and legacy text requests. Logs contain only job/project/agent identifiers, duration and fixed outcome codes; prompts and model output are not logged. A bounded source/message injection heuristic adds a warning; it is not a security boundary or proof of coverage.

The candidate now limits preapproved reads to absolute source/skill paths, explicitly denies runtime and credential paths in managed policy, and rejects unexpected path or skill events. These are layered checks; the runtime event observer is not a substitute for the pending live CLI permission test. Shutdown waits for job cleanup, with container removals in parallel and a 28-second final failure deadline; an exceeded deadline logs failure and requires host verification. Stale runtime recovery is serialized by a separate private guard file. A crash during that short recovery window leaves the guard in place and requires manual repair after confirming no runtime is active; it never guesses that a concurrent recovery is safe to delete. Archive decompression and extraction honor cancellation.

The live smoke independently tests the CLI permission policy for a deliberate `/etc/passwd` read. Its harness withholds only that known container-path tool event from the additional production observer, then requires the CLI's explicit permission-denial record. Every other event retains production checks. Production never bypasses the observer. This test remains pending; a model statement that access was denied does not satisfy it.

## Client request example

[review-request.json](../examples/review-request.json) uses a pinned public fixture and a small output schema. After acceptance and provisioning, submit it with the project key (never the general gateway key):

```sh
curl --fail-with-body "$REVIEW_ORIGIN/ci/review" \
  -H "Authorization: Bearer $PROJECT_REVIEW_KEY" \
  -H "CF-Access-Client-Id: $REVIEW_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $REVIEW_ACCESS_CLIENT_SECRET" \
  -H 'Prefer: respond-async' -H 'Content-Type: application/json' \
  --data-binary @examples/review-request.json
```

Use a fixture project whose repository and allowed agent match the example. Poll the returned job ID at the same trusted origin/path every ten seconds with the same credentials; never forward them to an arbitrary `Location` host. Stop on failed state. Completed transport alone is not a completed review: parse and validate the result, require the client's completion contract, then validate every citation against the pinned diff. Preserve valid partial findings while keeping unresolved/incomplete reports unsuccessful. The job response also includes provenance (configuration revision, source SHAs, selected model, skill digests, image and CLI version); requested model metadata does not attest the upstream model actually used.

Agents allow 60–600 seconds and 10–100 tool steps. Client wait and workflow limits must allow queueing, execution, cleanup and any one output-only repair under a shared deadline. A 600-second agent plus a retry can exceed a 20-minute client deadline even without queueing; use a lower agent limit or explicitly raise both client and workflow limits. Transport failures must not be blindly resubmitted. The gateway does not automatically retry jobs or switch providers.
