import importlib.util
from pathlib import Path
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
