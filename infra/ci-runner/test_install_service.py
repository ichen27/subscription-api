import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

import install_service


class InstallerTests(unittest.TestCase):
    def test_reinstall_reuses_identical_read_only_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.json"
            config.write_text(json.dumps({
                "repository": "owner/repo", "label": "test-ci",
                "state_dir": str(home / "state"), "lima_home": str(home / "lima")
            }))
            with patch.object(Path, "home", return_value=home), \
                 patch.object(install_service.sys, "argv", ["installer", "--config", str(config)]), \
                 patch.object(install_service.subprocess, "run") as launch:
                install_service.main()
                plist = home / "Library/LaunchAgents/com.ichen27.ci.test-ci.plist"
                definition = plistlib.loads(plist.read_bytes())
                runtime = Path(definition["ProgramArguments"][2])
                self.assertTrue(runtime.is_file())
                self.assertEqual(runtime.stat().st_mode & 0o777, 0o500)
                self.assertTrue(definition["StandardOutPath"].startswith(str(home / "Library/Logs")))
                with self.assertRaises(SystemExit):
                    install_service.main()
                plist.unlink()  # Model a stopped, archived previous service.
                install_service.main()
                self.assertEqual(launch.call_count, 2)
                self.assertEqual(len(list((home / "state/runtime").iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
