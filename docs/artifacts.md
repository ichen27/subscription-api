# Artifact index

| Artifact | Purpose | Format / how to use |
| --- | --- | --- |
| [Dashboard](dashboard.png) | Verified deployed UI with model selection | PNG; open in any image viewer |
| [Validation](validation.md) | Automated and live verification results | Markdown |
| [CI guide](github-actions.md) and [request step](../examples/github-actions-step.yml) | CI setup requirements and copyable request step; network setup pending | Markdown / YAML |
| [Request](../examples/request.json) | Harmless example input | JSON; send to `/v1/chat/completions` |
| [Response](../examples/response.json) | Representative output schema | JSON; sample, not a promised model response |
| [Review API/runbook](review-agents.md) | Project keys, job contract, limits and pending acceptance | Markdown |
| [Review request](../examples/review-request.json) | Public fixture request with schema; requires a matching configured project | JSON |
| [Agents portal](review-agents/portal-agents.png) and [mobile projects](review-agents/portal-projects-mobile.png) | Synthetic portal demonstrations | PNG |
| [Offline sandbox evidence](review-agents/smoke-offline.json) | Docker isolation and CLI startup checks; no completed inference | JSON; check `mode` before interpreting `completed` |
| [Sandbox sources](../sandbox/) and [smoke script](../scripts/sandbox-smoke.mjs) | Editable image/policy and acceptance probes | Dockerfile / JSON / JavaScript |
| [Source](../src/) and [UI](../public/) | Editable implementation | JavaScript, HTML, CSS; Node 22+ |
| [Launcher manifest](../launcher.json) | Native service deployment | JSON; adapt paths using deployment guide |

Excluded intentionally: subscription credentials, gateway keys, runtime work directories, private request contents, account identifiers, and dependency/cache directories. CI uses fake providers and does not require accounts. Screenshots exclude keys and account identifiers.
