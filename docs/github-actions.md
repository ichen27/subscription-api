# GitHub Actions integration

Yes: a CI job can call `POST /v1/chat/completions` with a selected `provider/model-id`. It can summarize a diff, explain a failed test, or evaluate generated text. It cannot ask this text-only gateway to execute repository commands, run tests, edit files, or perform tool calls. Run normal builds/tests in GitHub Actions and provide only the relevant text to the model.

## Recommended connection for this installation

Use an ephemeral GitHub-hosted runner with a narrowly scoped private network connection to the service host, then an SSH local forward to `127.0.0.1:8932`. The existing Mac mini is already reached over Tailscale. Provision CI identity/network access for only the chosen repository and only the required host/port. Use a dedicated forwarding-only SSH identity, a verified/pinned SSH host key, and the gateway key in GitHub Actions secrets. Do not reuse a personal administrator SSH key. Network access alone does not expose the gateway: it binds only to loopback, so the SSH forward is still required.

```text
GitHub-hosted runner → private network → restricted SSH tunnel
  → Mac mini loopback:8932 → selected subscription model
```

GitHub documents [private networking for hosted runners](https://docs.github.com/en/actions/concepts/runners/private-networking). The exact network action, trust policy, SSH configuration, secret names, and event trigger must be configured and tested for the target repository before enabling an AI job.

The existing public app URL is protected twice: Cloudflare Access and the launcher’s signed owner-email check. An API key alone does not pass either. A Cloudflare service token alone also fails the launcher’s owner-email check. A separate machine-authenticated route could be built, but has not been provisioned. Do not weaken the owner dashboard policy to make CI work.

Avoid placing a general-purpose self-hosted runner on the personal Mac mini just to reach the endpoint: it executes repository workflow code on that machine. GitHub-hosted execution with restricted forwarding keeps build execution separate from the subscription host.

## Add the request step

After the trusted network/tunnel step works, copy [the example step](../examples/github-actions-step.yml) under a job’s `steps`. Set:

- `SUBSCRIPTION_API_BASE_URL` repository variable: `http://127.0.0.1:8932/v1` for the runner’s local SSH-forwarded port.
- `SUBSCRIPTION_API_MODEL` repository variable: an explicit route such as `chatgpt/gpt-6-luna` or `claude/sonnet`; aliases are allowed but change with the dashboard default.
- `SUBSCRIPTION_API_KEY` repository secret: the gateway key. Keep provider OAuth credentials on the service host.

The example makes one small test call, checks the HTTP and response shape, and records only success in the job summary. It deliberately does not log arbitrary model output or execute it. It is a step fragment, not a complete provisioned workflow. Start with a manual `workflow_dispatch` job on a trusted branch. Do not expose gateway/network credentials to fork PR code or execute model-generated commands. See [GitHub’s secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).

For useful review/test analysis, build the JSON from input files with `jq --rawfile` rather than interpolating untrusted PR content into shell code. Keep the combined conversation under 100,000 characters and the HTTP body under 256 KB. Treat generated advice as advisory; deterministic tests should decide whether builds pass.

## Reliability and usage

The Mac mini, private network, CLIs, and subscription sign-ins must remain available. The endpoint permits one in-flight request per provider and times out inference after 90 seconds. Use a workflow/job timeout and avoid parallel requests to the same provider. Requests can fail with 429 (busy/limit), 503 (login), or 502 (provider/model error). Do not blindly retry timeouts: a request may already have consumed allowance. Choose whether an AI-step outage should block the build; normal build/test jobs should remain independent unless AI evaluation is explicitly a release requirement.

Usage follows subscription/model/credit rules; this is not unlimited CI capacity. [Claude documents subscription access for noninteractive calls](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), while model access and billing can vary by account. No live GitHub-to-gateway request has been verified yet: a target repository and CI task are still needed.
