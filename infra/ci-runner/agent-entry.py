#!/usr/bin/python3
"""Root-owned entry point in the disposable agent VM; accepts data, never commands."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

FIELDS = {"pr", "head", "github_token", "subscription_token", "run_id", "run_attempt"}


def environment(request, config):
    if not isinstance(request, dict) or set(request) != FIELDS:
        raise ValueError("Invalid request fields")
    if any(not isinstance(value, str) for value in request.values()):
        raise ValueError("Request values must be strings")
    for key in ("pr", "run_id", "run_attempt"):
        if not re.fullmatch(r"[1-9][0-9]{0,19}", request[key]):
            raise ValueError("Invalid numeric identifier")
    if request["head"] and not re.fullmatch(r"[a-f0-9]{40}", request["head"]):
        raise ValueError("Invalid head SHA")
    for key in ("github_token", "subscription_token"):
        if not 10 <= len(request[key]) <= 8192 or any(c.isspace() for c in request[key]):
            raise ValueError("Invalid credential format")
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
        "GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": config["repository"],
        "GITHUB_RUN_ID": request["run_id"], "GITHUB_RUN_ATTEMPT": request["run_attempt"],
        "GITHUB_TOKEN": request["github_token"],
        "CLAUDE_CODE_OAUTH_TOKEN": request["subscription_token"],
        "REVIEW_PR": request["pr"], "REVIEW_HEAD": request["head"],
        "REVIEW_IMAGE_DIGEST": config["image"],
        "REVIEW_CONTROLLER_DIGEST": config["controller_digest"],
        "RUNNER_TEMP": "/var/lib/pr-agent/jobs",
        "REVIEW_OUTPUT_DIR": "/var/lib/pr-agent/output",
    }


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(65_537)
    if len(raw) > 65_536:
        raise ValueError("Request too large")
    config = json.loads(Path("/opt/pr-agent/config.json").read_text())
    env = environment(json.loads(raw), config)
    # ci cannot modify these root-owned directories or redirect output via symlinks.
    root = Path("/var/lib/pr-agent")
    root.mkdir(exist_ok=True, mode=0o755)
    root.chmod(0o755)
    (root / "jobs").mkdir(exist_ok=True, mode=0o700)
    output = root / "output"
    output.mkdir(exist_ok=True, mode=0o755)
    output.chmod(0o755)
    with (root / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = subprocess.run(
            ["/usr/local/bin/node", "/opt/pr-agent/runtime/scripts/pr-agent.mjs"],
            env=env, cwd="/opt/pr-agent/runtime", timeout=660, check=False)
        for filename in ("review.json", "review.md"):
            file = output / filename
            if file.exists():
                file.chmod(0o644)
        return result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # No request data, credentials or child environment in error output.
        print("Agent controller failed; no successful review is implied.", file=sys.stderr)
        sys.exit(1)
