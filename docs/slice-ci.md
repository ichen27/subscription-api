# Slice CI reviewer connection

Target repository: `sliceconsultingsu/slice-launcher`. The requester is its protected-base advisory review job on GitHub-hosted runners. No repository build or model tool executes on the Mac mini.

## Narrow machine endpoint

`POST /ci/slice/review` is disabled unless `CI_REVIEW_KEY_FILE` names an owner-only, regular, non-symlink file containing `slice_ci_` followed by 64 lowercase hexadecimal characters. Generate a new random key; do not reuse `gateway.key`. The key is loaded on startup and cannot authenticate to any personal API/dashboard endpoint.

Requests use the usual text `model`/`messages`/optional `stream` shape, but the model must be exactly `chatgpt/gpt-6-astra` and streaming must be off. Browser Origin headers are rejected. The provider requests High reasoning; arbitrary request fields and model changes are rejected before execution. Existing limits, one concurrent call per provider, cancellation and tool isolation apply. The echoed model field is not upstream version attestation; usage/cost and output-token caps remain unsupported.

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

Implementation tests cover endpoint disabled state, wrong/general keys, alternate model/stream/tool rejection, browser-origin rejection, inability to access personal endpoints with the review key, fixed effort and private-key file validation. A live synthetic GPT-6 Astra review at High effort returned a valid finding through a temporary loopback candidate server. The existing Claude Opus 4.8 route also returned its expected harmless reply. A separate Opus 5.5 availability probe failed; this integration does not select or fall back to Claude. These are local checks, not a hosted GitHub-to-Cloudflare test.

Cloudflare policy, production configuration and GitHub secrets still require provisioning. After release, verify unsigned requests fail, either credential alone fails, the pair succeeds only at the exact review path, and the owner dashboard remains protected. Then dispatch a small Slice PR and verify its current-commit comment. Record the actual hosted result before marking activation complete.

To revoke: remove the dedicated service token from its policy and remove the GitHub secrets. To disable the endpoint, unset `CI_REVIEW_KEY_FILE` and restart the service. Remove only its dedicated tunnel rule and application when decommissioning. The personal gateway, saved model defaults and provider logins are independent.
