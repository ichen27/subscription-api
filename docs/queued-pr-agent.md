# Queued PR reviews

The **Agent review** workflow runs a bounded read-only review of an open
same-repository PR. GitHub Actions queues the work; a separate disposable ARM64
VM executes it on the Mac host. Ordinary test jobs use their existing worker pool.
No gateway deployment or public endpoint is required.

## Run a review

Open Actions → Agent review → Run workflow, select `main`, and enter the PR number.
Optionally supply the full expected head SHA to reject a stale request.

```sh
gh workflow run agent-review.yml --ref main -f pr=123
```

The workflow publishes an **Agent review** check on the reviewed head commit,
a job summary, and `review.json` / `review.md` artifacts retained for seven days.
The report identifies the head, merge base, base-branch tip, image, controller
digest, model selection, skill digest, tool count and duration. Requested model
metadata is not independent attestation of the upstream model.

Findings are advisory and produce a neutral check; a completed review without
findings produces success. An incomplete review fails. Main's required test
check remains independent. Reviews cannot push code, merge PRs, or replace tests.
The pilot starts manually to bound subscription usage. It does not automatically
review every PR update.

Limits: one agent VM at a time, 4 GiB memory / 2 vCPUs, five-minute inference,
60 tool calls, 30 changed files and 80,000 patch characters. Missing, binary or
truncated patches fail before inference. The job checks that all changed files
are covered and every finding cites an actual changed line with matching source
text. This validates citations, not the truth of every model claim. A changed
head or base tip makes the result stale and unsuccessful.

## Execution and credentials

The workflow is manual-dispatch-only on `main`, and its `agent-review`
environment must allow deployment from the `main` branch only. Its OAuth secret
must never be stored as a general repository secret. Use the existing
subscription automation credential as an environment secret named
`CLAUDE_CODE_OAUTH_TOKEN`; rotating that credential requires updating this secret
as well as any existing gateway token file. There is no paid API fallback.

The Actions user has no arbitrary sudo or Docker access. A narrow sudo rule
allows only `/usr/local/bin/pr-agent` with no arguments. That root-owned entry
point accepts bounded JSON data, rebuilds a fixed environment, and runs reviewed
source installed in the VM base. It never executes a PR checkout or a caller-
supplied command. Even an unrelated job routed to this worker cannot use Docker
directly. Only the fixed review controller can start its containers.

The controller validates the active GitHub workflow identity, downloads the exact
source archives and keeps its GitHub token outside the model container. The
container receives the inference credential, read-only source and selected skill,
with no shell, host mounts, Docker socket or GitHub credential. Its restricted
proxy permits inference only. See [sandbox acceptance](review-agents.md).
The reviewed image and controller are trusted components; this does not promise
resistance to a guest-kernel or hypervisor exploit.

## Provision the worker

Use the [ordinary worker setup](isolated-ci.md) for prerequisites and supervisor
installation, but choose a separate Lima namespace and private state directory,
label `subscription-api-agent`, and the `agent-worker.yaml` template. Do not
replace the CI worker's config or base.

```sh
limactl start --tty=false --name=base infra/ci-runner/agent-worker.yaml
```

The template installs Docker but leaves `ci` out of the Docker group. Docker is
restarted after nftables provisioning so the firewall flush cannot erase Docker's
network rules. The base must remain unregistered and have no runner `_work` tree.

Build the pinned review image on an ARM64 Docker host using `npm run sandbox:build`,
run both sandbox acceptance modes, and save its content digest. Transfer that
image to the base without a shared host mount:

```sh
docker save subscription-review:2.1.301 -o /private/state/review-image.tar
limactl shell --workdir=/ base sudo docker load < /private/state/review-image.tar
```

Install the official Node 22.22.0 Linux ARM64 archive into `/usr/local` in the base.
Its `node-v22.22.0-linux-arm64.tar.xz` SHA-256 is
`1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f`.
Download it from `https://nodejs.org/dist/v22.22.0/`, verify the digest, copy it
with `limactl cp`, and extract with `--strip-components=1`. Keep third-party
license files from the archive.

Create the private config and `ci-owner.json` as described in the ordinary
worker guide, then install the reviewed controller:

```sh
python3 infra/ci-runner/install_agent_runtime.py \
  --config /private/state/config.json --image sha256:VERIFIED_IMAGE_DIGEST
```

The installer copies only runtime source and records file hashes. It installs
the fixed entry point and narrow sudo policy. Verify the image's offline
network checks inside the actual VM, not only Docker on the host. Confirm
`sudo -u ci sudo -n true` and `sudo -u ci docker info` both fail, and that
`sudo -u ci sudo -n /usr/local/bin/pr-agent extra` is rejected. Then stop the base:

```sh
limactl stop base
python3 infra/ci-runner/install_service.py --config /private/state/config.json
```

Configure the GitHub environment's branch policy before storing its secret.
Dispatch one small PR, verify the check and artifact contents, and confirm
VM/runner removal. Rebuild and verify a clean base when updating the image,
Node or controller. Changing the repository checkout alone does not update the
installed controller. Record the new controller digest.

## Validation and rollback

```sh
npm test
npm run check
python3 -m unittest discover -s infra/ci-runner -p 'test_*.py'
actionlint
```

Disable the Agent review workflow to stop new dispatches, cancel active runs,
and stop its LaunchAgent. Confirm no `job-*` VM remains in the agent namespace.
Remove or rotate the protected environment secret if retiring this worker.
The test worker and live application service are separate.
