#!/usr/bin/env python3
"""Install reviewed source into a clean base VM, inaccessible for modification by ci."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

from supervisor import valid_config


def bundle(project, repository, image):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("An immutable image digest is required")
    files = {}
    paths = list((project / "src").glob("*.mjs")) + [project / "scripts/pr-agent.mjs"]
    for path in sorted(paths):
        if path.is_symlink():
            raise ValueError("Runtime source must not contain symlinks")
        files["runtime/" + str(path.relative_to(project))] = path.read_bytes()
    files["agent-entry.py"] = (project / "infra/ci-runner/agent-entry.py").read_bytes()
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    files["manifest.json"] = json.dumps(manifest, indent=2).encode()
    files["config.json"] = json.dumps({"repository": repository, "image": image, "controller_digest": digest}).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o444, 0
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue(), digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    config = valid_config(json.loads(Path(args.config).read_text()))
    if json.loads((Path(config["lima_home"]) / "ci-owner.json").read_text()) != {"repository": config["repository"]}:
        raise ValueError("Lima ownership does not match")
    env = dict(os.environ, LIMA_HOME=config["lima_home"])
    project = Path(__file__).resolve().parents[2]
    payload, digest = bundle(project, config["repository"], args.image)
    def shell(*command, input=None):
        return subprocess.run(["limactl", "--tty=false", "shell", "--workdir=/", "base",
                               "sudo", *command], input=input, env=env, check=True, timeout=120)
    shell("bash", "-c",
          "test -f /opt/ci-base-ready && test ! -e /home/ci/runner/.credentials && "
          "test ! -e /home/ci/runner/_work && test -z \"$(docker ps -q)\" && "
          "test \"$(/usr/local/bin/node --version)\" = v22.22.0 && "
          "install -d -m 0755 /opt/pr-agent /var/lib/pr-agent")
    shell("docker", "image", "inspect", args.image, "--format", "{{.Id}}")
    shell("tar", "-xz", "--no-same-owner", "-C", "/opt/pr-agent", input=payload)
    shell("bash", "-c",
          "chown -R root:root /opt/pr-agent && chmod -R go-w /opt/pr-agent && "
          "install -o root -g root -m 0755 /opt/pr-agent/agent-entry.py /usr/local/bin/pr-agent && "
          "printf '%s\\n' 'ci ALL=(root) NOPASSWD: /usr/local/bin/pr-agent \"\"' "
          "> /etc/sudoers.d/pr-agent && chmod 0440 /etc/sudoers.d/pr-agent && "
          "visudo -cf /etc/sudoers.d/pr-agent && "
          "! id -nG ci | tr ' ' '\\n' | grep -qx docker")
    print(json.dumps({"controller_digest": digest, "repository": config["repository"], "image": args.image}))


if __name__ == "__main__":
    main()
