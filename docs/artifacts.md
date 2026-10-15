# Artifact index

| Artifact | Purpose | Format / how to use |
| --- | --- | --- |
| [Dashboard](dashboard.png) | Verified deployed UI, initial release | PNG; open in any image viewer |
| [Validation](validation.md) | Automated and live verification results | Markdown |
| [Request](../examples/request.json) | Harmless example input | JSON; send to `/v1/chat/completions` |
| [Response](../examples/response.json) | Representative output schema | JSON; sample, not a promised model response |
| [Source](../src/) and [UI](../public/) | Editable implementation | JavaScript, HTML, CSS; Node 22+ |
| [Launcher manifest](../launcher.json) | Native service deployment | JSON; adapt paths using deployment guide |

Excluded intentionally: subscription credentials, gateway keys, runtime work directories, private request contents, account identifiers, and dependency/cache directories. CI uses fake providers and does not require accounts. Screenshots exclude keys and account identifiers.
