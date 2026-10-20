#!/usr/bin/env python3
"""Install this reviewed supervisor revision as a per-user macOS launch agent."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

from supervisor import valid_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config_path = Path(args.config).resolve()
    config = valid_config(json.loads(config_path.read_text()))
    root = Path(config["state_dir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = Path(__file__).with_name("supervisor.py")
    revision = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    runtime = root / "runtime" / revision
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    installed = runtime / source.name
    if installed.exists():
        if installed.read_bytes() != source.read_bytes():
            raise SystemExit("Existing versioned runtime differs from source")
    else:
        shutil.copy2(source, installed)
        installed.chmod(0o500)
    label = f"com.ichen27.ci.{config['label']}"
    # launchd opens stdout/stderr before the user process starts. Removable-volume
    # paths can fail at that stage; keep these small bootstrap logs in Library.
    logs = Path.home() / "Library" / "Logs" / label
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    if plist_path.exists():
        raise SystemExit(f"Service already exists: stop and archive {plist_path} before replacement")
    definition = {
        "Label": label,
        "ProgramArguments": [str(Path(sys.executable).resolve()), "-u",
                             str(runtime / source.name), "--config", str(config_path)],
        "WorkingDirectory": str(root),
        "EnvironmentVariables": {
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONUNBUFFERED": "1",
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Interactive",
        "SessionCreate": True,
        "ThrottleInterval": 60,
        "ExitTimeOut": 90,
        "StandardOutPath": str(logs / "stdout.log"),
        "StandardErrorPath": str(logs / "stderr.log"),
    }
    with plist_path.open("xb") as stream:
        plistlib.dump(definition, stream)
    target = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootstrap", target, str(plist_path)], check=True)
    print(json.dumps({"service": label, "plist": str(plist_path),
                      "runtime_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
