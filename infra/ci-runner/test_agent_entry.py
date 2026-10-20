import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("agent_entry", Path(__file__).with_name("agent-entry.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EntryTests(unittest.TestCase):
    def request(self):
        return dict(pr="12", head="a" * 40, github_token="example-github-token",
                    subscription_token="example-subscription-token", run_id="123", run_attempt="1")

    def test_caller_cannot_override_commands_paths_or_environment(self):
        config = {"repository": "owner/repo", "image": "sha256:" + "a" * 64, "controller_digest": "b" * 64}
        env = module.environment(self.request(), config)
        self.assertEqual(env["RUNNER_TEMP"], "/var/lib/pr-agent/jobs")
        self.assertEqual(env["GITHUB_REPOSITORY"], "owner/repo")
        for field in ("PATH", "NODE_OPTIONS", "REVIEW_OUTPUT_DIR", "command", "repository"):
            with self.assertRaises(ValueError):
                module.environment({**self.request(), field: "/tmp/evil"}, config)

    def test_injection_and_invalid_identifiers_are_rejected(self):
        for key, value in [("pr", "1;id"), ("head", "../main"), ("run_id", "0"),
                           ("subscription_token", "token\nextra"), ("github_token", None)]:
            with self.assertRaises(ValueError):
                module.environment({**self.request(), key: value}, {})
