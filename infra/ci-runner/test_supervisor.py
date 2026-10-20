import importlib.util
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).with_name("supervisor.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SupervisorTests(unittest.TestCase):
    def config(self, root):
        return {"repository": "owner/repo", "label": "subscription-api-ci",
                "state_dir": str(root), "lima_home": str(root / "lima"),
                "lima_cache": str(root / "cache")}

    def test_in_progress_run_can_have_queued_matching_job(self):
        runs = [{"id": 2, "status": "completed"}, {"id": 1, "status": "in_progress"}]
        jobs = [{"id": 5, "status": "queued", "labels": ["other"]},
                {"id": 6, "status": "queued", "labels": ["subscription-api-ci"]}]
        self.assertEqual([j["id"] for j in module.matching_jobs(
            runs, lambda _: jobs, "subscription-api-ci")], [6])

    def test_config_rejects_shell_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(Path(directory))
            config["label"] = "ci; touch /tmp/bad"
            with self.assertRaises(ValueError):
                module.valid_config(config)

    def test_cleanup_refuses_unowned_vm(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            with self.assertRaises(ValueError):
                controller.cleanup({"name": "base"})

    def test_cleanup_stops_vm_before_deleting_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            calls = []
            name = "job-123456abcdef"
            controller.persist({"name": name})
            with patch.object(controller, "instances", side_effect=[
                [{"name": name, "status": "Running"}], []]), \
                 patch.object(controller, "lima", side_effect=lambda *a: calls.append(a)), \
                 patch.object(controller, "runners", return_value=[
                     {"name": name, "id": 7}, {"name": "someone-else", "id": 8}]), \
                 patch.object(controller, "gh", side_effect=lambda *a: calls.append(a)):
                controller.cleanup({"name": name})
            self.assertEqual(calls, [("stop", "--force", name), ("delete", "--force", name),
                                     ("actions/runners/7", "DELETE")])
            self.assertFalse(controller.state.exists())

    def test_failed_vm_cleanup_preserves_recovery_record(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            name = "job-123456abcdef"
            controller.persist({"name": name})
            with patch.object(controller, "instances", return_value=[
                {"name": name, "status": "Running"}]), \
                 patch.object(controller, "lima", side_effect=RuntimeError("stop failed")), \
                 patch.object(controller, "gh") as gh:
                with self.assertRaises(RuntimeError):
                    controller.cleanup({"name": name})
                gh.assert_not_called()
            self.assertTrue(controller.state.exists())

    def test_failed_creation_still_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            with patch.object(controller, "lima", side_effect=RuntimeError("clone failed")), \
                 patch.object(controller, "cleanup") as cleanup, \
                 patch.object(controller, "gh", return_value={"status": "queued"}):
                controller.execute({"id": 42})
            cleanup.assert_called_once()

    def test_interruption_during_boot_still_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            with patch.object(controller, "lima", side_effect=[None, module.Stopping()]), \
                 patch.object(controller, "collect_diagnostics"), \
                 patch.object(controller, "cleanup") as cleanup:
                with self.assertRaises(module.Stopping):
                    controller.execute({"id": 42})
            cleanup.assert_called_once()

    def test_recovery_cleans_record_before_scanning_orphans(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            state = {"name": "job-123456abcdef"}
            controller.persist(state)
            with patch.object(controller, "cleanup") as cleanup, \
                 patch.object(controller, "instances", return_value=[]):
                controller.recover()
            cleanup.assert_called_once_with(state)

    def test_repeated_provisioning_failures_are_not_requeued(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = module.Supervisor(self.config(Path(directory)))
            controller.failures["42"] = 3
            with patch.object(controller, "gh", side_effect=[
                {"workflow_runs": [{"id": 1, "status": "queued"}]},
                {"jobs": [{"id": 42, "status": "queued", "labels": ["subscription-api-ci"]},
                          {"id": 43, "status": "queued", "labels": ["subscription-api-ci"]}]}]):
                self.assertEqual(controller.pending()["id"], 43)

    def test_external_deadline_terminates_a_stalled_process(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            module.run([sys.executable, "-c", "import time; time.sleep(60)"], timeout=0.1)

    def test_command_errors_do_not_disclose_output(self):
        with self.assertRaisesRegex(RuntimeError, "failed") as caught:
            module.run([sys.executable, "-c", "print('private-sentinel'); exit(1)"])
        self.assertNotIn("private-sentinel", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
