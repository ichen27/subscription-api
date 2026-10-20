# Disposable CI pilot validation

Verified October 20, 2026. The pilot moves only `subscription-api` test execution;
GitHub Actions remains the scheduler and check publisher.

| Scenario | Evidence | Result |
| --- | --- | --- |
| Previous hosted execution | [Run 39428855136](https://github.com/ichen27/subscription-api/actions/runs/39428855136) | No test steps started; GitHub reported account payment/spending-limit failure |
| First disposable ARM64 worker | [Run 39436412823](https://github.com/ichen27/subscription-api/actions/runs/39436412823) | Passed; 12 seconds of job execution, followed by VM and runner cleanup |
| Intentional failing test | [Run 39437153368](https://github.com/ichen27/subscription-api/actions/runs/39437153368) | Failed with the expected deliberate test error; VM cleaned |
| Superseded slow revision | [Run 39437298558](https://github.com/ichen27/subscription-api/actions/runs/39437298558) | Canceled after a newer revision; VM cleaned |
| Supervisor interruption | Startup for [run 39437509335](https://github.com/ichen27/subscription-api/actions/runs/39437509335) | Supervisor killed while its VM was running; the next supervisor removed the orphan before creating another worker |
| Background service | [Run 39438288183](https://github.com/ichen27/subscription-api/actions/runs/39438288183) | Passed all 59 application tests and 12 worker tests under the installed LaunchAgent |
| Recovery and fresh execution | [Run 39437509335](https://github.com/ichen27/subscription-api/actions/runs/39437509335) | Passed on a replacement VM; 14 seconds of job execution |

The deliberately failing and slow test files were removed. The permanent
workflow checks the CI user identity, lack of sudo and shared filesystem mounts,
and absence of a marker left by a previous job. Every worker writes that marker;
successful subsequent runs therefore also check fresh-machine behavior.

Manual guest checks confirmed public GitHub connectivity, a firewall rejection
for the host gateway's private address, no host filesystem mounts, and denied
sudo for the `ci` account. This is isolation for the configured unprivileged
workflow, not a claim of resistance to guest-kernel or hypervisor exploits.

The live application test suite passes all 59 tests on Linux ARM64. Supervisor
tests exercise cleanup ordering, failure recovery records, interruption,
retry limits, external deadlines, and redaction of command errors.

## Usage interpretation

The initial October 1–20 snapshot contained 55 latest-attempt jobs: 52 rounded
minutes of observed hosted execution and one rounded minute on the first
self-hosted worker. Failed-to-start jobs have no measured execution duration.
The prior inspection found 21 commit SHAs with both push and PR runs.

These are operational metrics, not billed totals. The account's included
allowance, historical reruns, storage and invoices were not accessible in this
inspection. Self-hosted duration does not prove what the same job would cost or
how long it would take on hosted hardware.

During the rollout the repository became public through a separate user-requested
change. [Standard hosted runners are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
so this repository now validates worker infrastructure rather than demonstrating
cash savings. Apply the measured approach to a private workload with billed
minutes before claiming savings; local power and maintenance still have costs.

## Limits and repository controls

- After the visibility change, main protection was enabled: PRs and an up-to-date
  passing `test` check from GitHub Actions are required, including for admins.
  No separate approving reviewer is required for this solo-maintainer pilot.
- All external fork contributors require workflow approval before execution.
  Review their changes before approving access to the isolated worker.
- No provider credentials or live provider requests are used by this CI.
- Tool-enabled coding agents are not enabled by this pilot.
- The LaunchAgent starts after the host user logs in. If the mini is unavailable,
  jobs queue; there is no automatic paid-compute fallback.
