# Disposable CI workers

The `Checks / test` job runs in an Ubuntu ARM64 VM on a Mac host. GitHub Actions
still schedules jobs, stores job logs, and reports PR checks. A Python supervisor
starts one fresh VM when a matching job is queued and destroys it after one job.
The application service and provider logins are independent of this worker.

## Requirements

- Apple Silicon macOS host, Lima 2.2.1+, Python 3.10+, and authenticated GitHub CLI.
- Repository administration access to register runners. The authentication
  remains on the host; workers receive only short-lived registration credentials.
- SSD space for a 12 GiB virtual disk and temporary clones; initially 2 vCPUs and
  2 GiB RAM per worker. The supervisor admits one VM at a time.
- Outbound network access to Ubuntu packages, GitHub and Node downloads.

Install Lima from Homebrew with `brew install lima`. Choose dedicated absolute
paths for `LIMA_HOME` and the supervisor state directory; never reuse another
project's Lima namespace. On macOS Lima's download cache is fixed at
`~/Library/Caches/lima`; relocate it to suitable storage with a verified copy and
symlink if necessary. `LIMA_CACHE_HOME` is not a supported override.

## Prepare the base

Set `LIMA_HOME` to the chosen dedicated directory and run:

```sh
limactl start --tty=false --name=base infra/ci-runner/worker.yaml
limactl shell --workdir=/ base sudo test -f /opt/ci-base-ready
limactl stop base
```

The template pins the Ubuntu image and runner archive with SHA-256 digests. It
installs Git and runtime libraries and creates the unprivileged `ci` user.
Plain mode disables host mounts, dynamic forwarding and container engines.
The guest firewall rejects private, link-local, Tailscale and non-loopback IPv6
destinations for the `ci` account. Loopback is needed by the Node HTTP tests;
Lima's DNS gateway is allowed only on DNS ports. Guest root controls this firewall:
it does not defend against a guest-kernel exploit. Do not give jobs sudo.

The base must remain stopped, clean and unregistered. Rebuild it periodically to
apply OS patches. Runner auto-update is enabled. To change provisioning, build
and verify a new base; the provisioning marker deliberately prevents repeatedly
mutating an existing base on every boot.

Copy `infra/ci-runner/config.example.json` to your private state directory, fill
the repository and paths, and create `LIMA_HOME/ci-owner.json` containing exactly:

```json
{"repository":"OWNER/REPOSITORY"}
```

This ownership marker is required before recovery may delete `job-*` VMs.
Keep all state outside Git. Test runner permissions, private-network blocking,
and absence of host mounts before enabling automatic execution.

## Start the supervisor

```sh
python3 infra/ci-runner/supervisor.py --config /absolute/path/config.json --once
python3 infra/ci-runner/supervisor.py --config /absolute/path/config.json
```

With no matching queued job it creates no VM. It checks GitHub every 30 seconds.
Matching is by the configured repository and runner label. A lock prevents two
supervisors sharing the state directory. The persisted active record allows
cleanup after an interrupted host process; cleanup failure stops the service
instead of creating more workers.
After three provisioning/runtime errors for one queued job, the supervisor stops
retrying that job and records `retry_limit`. Repair the worker, then cancel and
rerun the GitHub run to obtain a new job ID. Test failures themselves do not
trigger provisioning retries.

The VM runtime has an external 20-minute deadline, in addition to the workflow's
15-minute job timeout. A stalled boot has its own deadline. Registration tokens
are delivered through stdin and are never recorded in supervisor logs.
Runner diagnostics are retained as untrusted text, capped at 1 MiB per VM and
the latest 50 VMs. Actions retains the ordinary test output.

Once the foreground trial succeeds, stop it and install the reviewed revision:

```sh
python3 infra/ci-runner/install_service.py --config /absolute/path/config.json
```

The installer copies the supervisor into an immutable-by-convention versioned
runtime directory and creates a per-user LaunchAgent. It refuses to replace an
existing service. This starts at user login, not before login after a reboot.
Events and VM diagnostics live in the configured state directory. Small service
bootstrap logs use `~/Library/Logs/com.ichen27.ci.LABEL/`: launchd can fail opening
log files on removable volumes before the user process starts. The host's
existing GitHub CLI authorization must remain available under launchd.

To stop, use `launchctl bootout gui/$(id -u) /path/to/the/printed.plist`.
Confirm there are no running `job-*` VMs. If shutdown was interrupted, run the
supervisor once to reconcile its recovery state. Do not delete the state record
to bypass failed cleanup.

## Workflow and verification

The workflow keeps its `Checks` name and `test` job ID, runs for PR updates and
pushes to main, and supports manual dispatch. Superseded PR runs are canceled.
Feature branches without PRs require manual dispatch. No path filters are used
that would leave a required check pending. The checkout token is read-only and
is not persisted in Git configuration. Unit tests use deterministic fake model
providers, so no provider credentials belong in these VMs.

Before rollout, verify passing and deliberately failing jobs, cancellation on a
new revision, clean VM replacement, and cleanup after controller termination.
Switching from hosted x64 to ARM64 must be validated using the real test suite.
Required-check enforcement depends on the repository plan and rules: retaining
check names does not enable branch protection.

```sh
python3 -m unittest discover -s infra/ci-runner -p 'test_*.py'
npm ci
npm run check
npm test
python3 infra/ci-runner/report.py --repository OWNER/REPOSITORY --since YYYY-MM-DD
```

The report separates hosted and self-hosted execution, retaining source run
links. It measures observed runtime, not invoices or actual cash savings.
Included allowance, storage charges, runtime differences and previous run
attempts prevent equating these minutes with billed savings.

## Recovery and future agent workers

Restore the previous `runs-on` label in a PR to return execution to hosted
workers. That still requires hosted allowance/payment access. Do not silently
fall back to paid hosted compute when the local worker is unavailable.

This worker handles CI only. Tool-enabled agents need a separate worker pool,
credential boundary, runtime and usage budgets. Start those jobs manually;
changes made by an agent must receive fresh checks. Do not enable tools on the
existing text-only subscription gateway as a shortcut to agent execution.
