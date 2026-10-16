# Slice CI reviewer connection

Target repository: `sliceconsultingsu/slice-launcher`. The requester is its protected-base advisory review job on GitHub-hosted runners. No repository build or model tool executes on the Mac mini.

## Narrow machine endpoint

`POST /ci/slice/review` is disabled unless `CI_REVIEW_KEY_FILE` names an owner-only, regular, non-symlink file containing `slice_ci_` followed by 64 lowercase hexadecimal characters. Generate a new random key; do not reuse `gateway.key`. The key is loaded on startup and cannot authenticate to any personal API/dashboard endpoint.

Requests use the usual text `model`/`messages`/optional `stream` shape, but the model must be exactly `claude/claude-opus-5-5` and streaming must be off. Browser Origin headers are rejected. The provider requests High reasoning and disables automatic model switching on flagged requests; arbitrary request fields and model changes are rejected before execution. The authenticated review route accepts at most 200,000 conversation characters within the existing 256,000-byte JSON body limit. The personal API retains its 100,000-character cap. One concurrent call per provider, cancellation and tool isolation remain in force. The echoed model field is not upstream version attestation; usage/cost and output-token caps remain unsupported.

## Production access

Public URL: `https://app-subscription-api.chenagent.com/ci/slice/review`.

Create a separate Cloudflare Access application for that exact path, with a reusable **Service Auth** policy allowing only a dedicated Slice CI service token. Preserve the owner-only application for the dashboard and general API. Set a finite token expiry and rotate before it expires.

Add an ingress rule before the wildcard launcher route:

```yaml
- hostname: app-subscription-api.chenagent.com
  path: ^/ci/slice/review$
  service: http://127.0.0.1:8932
  originRequest:
    access:
      required: true
      teamName: snowy-voice-36a1
      audTag:
        - REPLACE_WITH_DEDICATED_ACCESS_APPLICATION_AUDIENCE
```

Keep the server bound to loopback. Cloudflared validates the signed audience before forwarding; the endpoint separately checks the review key. Never route the entire hostname directly to the API or weaken the launcher's owner check. Back up and validate the existing tunnel configuration; preserve all unrelated entries. See [Cloudflare's origin Access validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).

GitHub's protected `ai-review` environment receives only `SUBSCRIPTION_REVIEW_KEY`, `SUBSCRIPTION_ACCESS_CLIENT_ID` and `SUBSCRIPTION_ACCESS_CLIENT_SECRET`. Keep the general gateway key and provider OAuth credentials on this host. Only protected-base code may use these credentials; contributor source enters as untrusted data, never executed code. Gateway subscription allowance is consumed by reviews, so repeated PR events affect personal quota.

## Validation and rollout status

Implementation tests cover endpoint disabled state, wrong/general keys, alternate model/stream/tool rejection, browser-origin rejection, inability to access personal endpoints with the review key, fixed effort and private-key file validation. A live synthetic Claude Opus 5.5 review at High effort returned a valid finding through a temporary loopback candidate server. The existing ChatGPT route also returned its expected harmless reply. The initial Opus 5.5 probe failed because Claude Code 2.1.273 was too old: the provider required 2.1.280 or newer. Updating to 2.1.301 resolved it; there is no downgrade or provider fallback. These are local checks, not a hosted GitHub-to-Cloudflare test.

Activated with the maintainer’s approval on October 15, 2026. The one-year Cloudflare service token expires October 15, 2027. The dedicated Service Auth application, signed-audience tunnel validation, production review key, and protected GitHub environment are configured. Public checks rejected unsigned requests and either credential alone; the pair reached request validation. Requests to the personal API and dashboard still required owner sign-in.

[Slice’s hosted PR #30 review](https://github.com/sliceconsultingsu/slice-launcher/actions/runs/38836195196) completed against base `02fbb89` and head `5f1512d` through the production connection. The requested Opus 5.5 route returned a finding in about 28 seconds, and Slice’s exact-source evidence validator accepted it. The report disclosed a screenshot requiring human review. This verifies the machine reviewer connection, not consultants’ separate MCP/OAuth rollout. Future commits require fresh reviews; model identity/usage limitations above still apply.

To revoke: remove the dedicated service token from its policy and remove the GitHub secrets. To disable the endpoint, unset `CI_REVIEW_KEY_FILE` and restart the service. Remove only its dedicated tunnel rule and application when decommissioning. The personal gateway, saved model defaults and provider logins are independent.
