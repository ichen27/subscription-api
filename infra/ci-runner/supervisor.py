#!/usr/bin/env python3
"""One-at-a-time disposable Lima workers for a single GitHub repository."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid


class Stopping(BaseException):
    pass


def run(args, *, env=None, input=None, timeout=120):
    """Never include argv, stdin, or output in exceptions: these may contain tokens."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env=env,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(input, timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream:
                stream.close()
        raise
    if process.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {process.returncode})")
    return stdout


def valid_config(config):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", config["repository"]):
        raise ValueError("Invalid repository")
    if not re.fullmatch(r"[a-z0-9-]+", config["label"]):
        raise ValueError("Invalid runner label")
    for key in ("state_dir", "lima_home"):
        path = Path(config[key])
        if not path.is_absolute() or path == Path.home() or path == Path("/"):
            raise ValueError(f"{key} must be a dedicated absolute directory")
    if not 60 <= config.get("job_timeout_seconds", 1200) <= 3600:
        raise ValueError("Job timeout must be 60–3600 seconds")
    return config


def matching_jobs(runs, jobs_for_run, label):
    """An Actions run can be in progress while its worker job remains queued."""
    for workflow in reversed(runs):
        if workflow["status"] not in ("queued", "in_progress", "waiting"):
            continue
        for job in jobs_for_run(workflow["id"]):
            if job["status"] == "queued" and label in job.get("labels", []):
                yield job


class Supervisor:
    def __init__(self, config):
        self.config = valid_config(config)
        self.root = Path(config["state_dir"])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.env = dict(os.environ, LIMA_HOME=config["lima_home"])
        self.repo = config["repository"]
        self.state = self.root / "active.json"
        self.failures_path = self.root / "provisioning-failures.json"
        self.failures = (json.loads(self.failures_path.read_text())
                         if self.failures_path.exists() else {})

    def event(self, event, **data):
        row = dict(at=dt.datetime.now(dt.timezone.utc).isoformat(), event=event, **data)
        with (self.root / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(row) + "\n")
        print(json.dumps(row), flush=True)

    def gh(self, suffix, method="GET"):
        result = run(["gh", "api", "--method", method,
                      f"/repos/{self.repo}/{suffix}"], env=self.env)
        return json.loads(result) if result.strip() else None

    def lima(self, *args, input=None, timeout=300):
        return run(["limactl", "--tty=false", *args], env=self.env,
                   input=input, timeout=timeout)

    def instances(self):
        return [json.loads(line) for line in self.lima("list", "--json").splitlines()
                if line.strip()]

    def persist(self, state):
        temporary = self.state.with_suffix(".tmp")
        temporary.write_text(json.dumps(state))
        temporary.chmod(0o600)
        temporary.replace(self.state)

    def runners(self):
        return self.gh("actions/runners?per_page=100")["runners"]

    def cleanup(self, state):
        name = state["name"]
        if not re.fullmatch(r"job-[a-f0-9]{12}", name):
            raise ValueError("Refusing cleanup of an unowned VM name")
        # Stop code execution before removing registration or clearing recovery state.
        existing = {item["name"]: item for item in self.instances()}
        if name in existing:
            if existing[name]["status"] != "Stopped":
                self.lima("stop", "--force", name)
            self.lima("delete", "--force", name)
        if name in {item["name"] for item in self.instances()}:
            raise RuntimeError("Worker cleanup not confirmed")
        for runner in self.runners():
            if runner["name"] == name:
                self.gh(f"actions/runners/{runner['id']}", "DELETE")
        self.state.unlink(missing_ok=True)
        self.event("cleaned", worker=name)

    def recover(self):
        if self.state.exists():
            self.event("recovering")
            self.cleanup(json.loads(self.state.read_text()))
        # Dedicated LIMA_HOME only. Never touch another project's Lima namespace.
        for instance in self.instances():
            if re.fullmatch(r"job-[a-f0-9]{12}", instance["name"]):
                self.cleanup({"name": instance["name"]})

    def pending(self):
        runs = self.gh("actions/runs?per_page=100")["workflow_runs"]
        candidates = matching_jobs(
            runs, lambda run_id: self.gh(f"actions/runs/{run_id}/jobs?per_page=100")["jobs"],
            self.config["label"])
        return next((job for job in candidates
                     if self.failures.get(str(job["id"]), 0) < 3), None)

    def collect_diagnostics(self, name):
        # Preserve as opaque text, never execute or extract guest-controlled paths.
        # Only the final 1 MiB is retained per worker to bound host disk use.
        output = self.lima(
            "shell", "--workdir=/", name, "sudo", "bash", "-c",
            "find /home/ci/runner/_diag -maxdepth 1 -type f -name '*.log' "
            "-exec tail -c 262144 -- {} + | tail -c 1048576", timeout=30)
        destination = self.root / "diagnostics"
        destination.mkdir(exist_ok=True, mode=0o700)
        (destination / f"{name}.log").write_text(output)
        files = sorted(destination.glob("job-*.log"), key=lambda p: p.stat().st_mtime)
        for path in files[:-50]:
            path.unlink()

    def execute(self, job):
        name = "job-" + uuid.uuid4().hex[:12]
        state = {"name": name, "requested_job_id": job["id"],
                 "started": dt.datetime.now(dt.timezone.utc).isoformat()}
        self.persist(state)  # Persist before creating anything, for crash recovery.
        self.event("starting", **state)
        failed = False
        try:
            self.lima("clone", "base", name)
            self.lima("start", "--timeout=5m", name, timeout=330)
            # Refuse a dirty image or missing isolation before registering it.
            self.lima("shell", "--workdir=/", name, "sudo", "bash", "-c",
                      "test -f /opt/ci-base-ready && "
                      "test ! -e /home/ci/runner/.credentials && "
                      "test ! -e /home/ci/runner/_work && "
                      "nft list table inet ci_boundary >/dev/null && "
                      "! sudo -u ci sudo -n true 2>/dev/null")
            token = self.gh("actions/runners/registration-token", "POST")["token"]
            command = (
                "cd /home/ci/runner; IFS= read -r registration_token; "
                "./config.sh --unattended "
                f"--url https://github.com/{self.repo} "
                '--token "$registration_token" --ephemeral '
                f"--name {name} --labels {self.config['label']} --work _work")
            self.lima("shell", "--workdir=/", name, "sudo", "-u", "ci", "env", "-i",
                      "HOME=/home/ci", "USER=ci", "PATH=/usr/local/bin:/usr/bin:/bin",
                      "bash", "-c", command, input=token + "\n")
            del token
            self.event("registered", worker=name)
            self.lima("shell", "--workdir=/", name, "sudo", "-u", "ci", "env", "-i",
                      "HOME=/home/ci", "USER=ci", "PATH=/usr/local/bin:/usr/bin:/bin",
                      "bash", "-c", "cd /home/ci/runner && exec ./run.sh",
                      timeout=self.config.get("job_timeout_seconds", 1200))
            self.event("runner_exited", worker=name)
        except subprocess.TimeoutExpired:
            failed = True
            self.event("timeout", worker=name)
        except Exception as error:
            failed = True
            self.event("worker_error", worker=name, error=str(error))
        finally:
            try:
                self.collect_diagnostics(name)
            except (Exception, Stopping):
                self.event("diagnostics_unavailable", worker=name)
            self.cleanup(state)
        if failed:
            key = str(job["id"])
            self.failures[key] = self.failures.get(key, 0) + 1
            temporary = self.failures_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.failures))
            temporary.replace(self.failures_path)
            if self.failures[key] >= 3:
                self.event("retry_limit", job_id=job["id"],
                           action="Repair worker, then cancel and rerun the GitHub job")
        # Query the requested job for evidence; a runner may have received another
        # matching queued job, so this is not asserted to be the executed job.
        result = self.gh(f"actions/jobs/{job['id']}")
        self.event("job_observed", job_id=job["id"], status=result["status"],
                   conclusion=result.get("conclusion"), runner=result.get("runner_name"),
                   started_at=result.get("started_at"), completed_at=result.get("completed_at"))

    def serve(self, once=False):
        with (self.root / "supervisor.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            ownership = Path(self.config["lima_home"]) / "ci-owner.json"
            if json.loads(ownership.read_text()) != {"repository": self.repo}:
                raise ValueError("Lima namespace ownership does not match repository")
            self.recover()
            self.event("ready", repository=self.repo)
            while True:
                job = self.pending()
                if job:
                    self.execute(job)
                if once:
                    return
                time.sleep(30)


def stop(signum, frame):
    raise Stopping()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    supervisor = Supervisor(json.loads(Path(args.config).read_text()))
    try:
        supervisor.serve(args.once)
    except Stopping:
        supervisor.event("stopped")
    except Exception as error:
        supervisor.event("fatal", error=str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
