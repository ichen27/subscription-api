#!/usr/bin/env python3
"""Report observed Actions execution time; never equate runtime with an invoice."""
import argparse
import datetime as dt
import json
import math
import subprocess


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--since", required=True, help="YYYY-MM-DD")
    args = parser.parse_args()
    dt.date.fromisoformat(args.since)
    rows = []
    page = 1
    while True:
        runs = api(f"/repos/{args.repository}/actions/runs?created=%3E%3D{args.since}"
                   f"&per_page=100&page={page}")["workflow_runs"]
        for run in runs:
            job_page = 1
            while True:
                jobs = api(f"/repos/{args.repository}/actions/runs/{run['id']}/jobs"
                           f"?per_page=100&page={job_page}")["jobs"]
                for job in jobs:
                    seconds = None
                    if job.get("started_at") and job.get("completed_at") and job.get("runner_name"):
                        seconds = max(0, (timestamp(job["completed_at"]) -
                                          timestamp(job["started_at"])).total_seconds())
                    rows.append({
                        "run_id": run["id"], "attempt": run["run_attempt"],
                        "job_id": job["id"], "workflow": run["name"],
                        "event": run["event"], "sha": run["head_sha"],
                        "runner": job.get("runner_name"), "labels": job["labels"],
                        "conclusion": job["conclusion"], "seconds": seconds,
                        "rounded_runtime_minutes": math.ceil(seconds / 60) if seconds is not None else None,
                        "url": job["html_url"],
                    })
                if len(jobs) < 100:
                    break
                job_page += 1
        if len(runs) < 100:
            break
        page += 1
    hosted = [r for r in rows if r["runner"] and "self-hosted" not in r["labels"]]
    own = [r for r in rows if "self-hosted" in r["labels"]]
    print(json.dumps({
        "repository": args.repository, "since": args.since,
        "scope": "Latest attempt of each returned workflow run; observed runtime, not billing",
        "hosted_rounded_runtime_minutes": sum(r["rounded_runtime_minutes"] or 0 for r in hosted),
        "self_hosted_rounded_runtime_minutes": sum(r["rounded_runtime_minutes"] or 0 for r in own),
        "jobs": rows,
        "limitations": [
            "Failed-to-start jobs have no measured execution duration.",
            "Allowances, storage, runner pricing, retries and invoices are not measured.",
            "Self-hosted runtime does not establish the runtime on hosted hardware."
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
