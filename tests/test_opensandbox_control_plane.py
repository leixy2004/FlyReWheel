"""Only fake processes and temporary non-secret fixtures; no Docker/API calls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/opensandbox-control-plane.py"
spec = importlib.util.spec_from_file_location("control", SCRIPT)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ControlPlaneTests(unittest.TestCase):
    def test_generated_toml_with_pinned_official_docker_config(self):
        import tomllib
        fixture = Path(__file__).parent / "fixtures/opensandbox_docker_config.py"
        schema_spec = importlib.util.spec_from_file_location("official_docker_config", fixture)
        schema = importlib.util.module_from_spec(schema_spec)
        schema_spec.loader.exec_module(schema)
        schema.DockerConfig.model_rebuild(_types_namespace=vars(schema))
        config = tomllib.loads(control.build_config(Path("/tmp/non-sensitive-fixture"), "fixture-only-not-an-api-key"))
        validated = schema.DockerConfig.model_validate(config["docker"])
        self.assertEqual(validated.port_range_max - validated.port_range_min, 100)
        self.assertEqual(validated.publish_host, "127.0.0.1")
        self.assertEqual(validated.drop_capabilities, ["ALL"])
        self.assertTrue(config["proxy"]["resolve_internal"])
        with self.assertRaises(ValueError):
            schema.DockerConfig.model_validate({**config["docker"], "port_range_max": 49009})

    def test_network_admission_requires_owned_internal_bridge(self):
        network = {"Name": "task-net", "Driver": "bridge", "Internal": True,
                   "Labels": {"flyrewheel.lifecycle-owner": "owner"}, "Containers": {},
                   "Options": {"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"},
                   "EnableIPv6": False, "Scope": "local"}
        control.validate_internal_network(network, "task-net", "owner")
        for change in ({"Internal": False}, {"Driver": "host"}, {"Labels": {}},
                       {"Containers": {"other": {}}}, {"Options": {}}, {"EnableIPv6": True}):
            with self.assertRaises(ValueError):
                control.validate_internal_network({**network, **change}, "task-net", "owner")

    def test_default_dry_run_has_no_resource_effects(self):
        output = io.StringIO()
        with patch.object(control, "validate", side_effect=AssertionError("validation I/O")), \
             patch.object(control.subprocess, "Popen", side_effect=AssertionError("spawn")), \
             patch.object(control.tempfile, "mkdtemp", side_effect=AssertionError("mkdir")), \
             contextlib.redirect_stdout(output):
            self.assertEqual(control.main([]), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "dry-run")
        self.assertFalse(result["permissionReceipt"])

    def test_execute_requires_explicit_inputs_before_spawn(self):
        with patch.object(control.subprocess, "Popen", side_effect=AssertionError("spawn")), \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            control.main(["--execute"])

    def test_private_atomic_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "fixture"
            control.private_file(target, b"non-sensitive-fixture")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.read_bytes(), b"non-sensitive-fixture")
            self.assertFalse(target.with_suffix(".new").exists())

    def test_cleanup_failure_retains_task(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(control, "stop_group", return_value=False), \
                 patch.object(control.shutil, "rmtree") as remove:
                self.assertFalse(control.clean_task(object(), Path(directory)))
                remove.assert_not_called()

    def test_open_listener_prevents_secret_removal(self):
        with tempfile.TemporaryDirectory() as directory, control.socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with patch.object(control.shutil, "rmtree") as remove:
                self.assertFalse(control.clean_task(None, Path(directory), listener.getsockname()[1]))
                remove.assert_not_called()

    def test_disk_guard_refuses_low_space(self):
        from types import SimpleNamespace
        with patch.object(control.shutil, "disk_usage", return_value=SimpleNamespace(free=6 * control.GiB - 1)):
            with self.assertRaises(RuntimeError):
                control.disk_guard(["unused"])

    def test_independent_supervisor_deadline_and_parent_eof(self):
        # Detached supervisor runs real supervision on an inert sleeping child.
        # Pipe EOF simulates parent death without touching platform processes.
        program = """
import importlib.util, subprocess, sys, time, json
s=importlib.util.spec_from_file_location('control', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],start_new_session=True)
reason=m.supervise(p,sys.stdin.fileno(),time.monotonic()+float(sys.argv[2]))
print(json.dumps({'reason':reason,'stopped':m.stop_group(p),'pid':p.pid}),flush=True)
"""
        for seconds, close_parent, expected in ((0.2, False, "deadline"), (10, True, "parent-exited")):
            process = subprocess.Popen([sys.executable, "-B", "-c", program, str(SCRIPT), str(seconds)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True)
            try:
                if close_parent:
                    process.stdin.close()
                process.wait(timeout=5)
                result = json.loads(process.stdout.read())
                self.assertEqual(result["reason"], expected)
                self.assertTrue(result["stopped"])
                self.assertFalse(control.group_exists(result["pid"]))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    if not stream.closed:
                        stream.close()


class TrialPrerequisiteTests(unittest.TestCase):
    def options(self, directory):
        from types import SimpleNamespace
        now = int(time.time() * 1000)
        return SimpleNamespace(trial_state=str(Path(directory) / "trial"),
            network_owner="fixture-owner", approval_ref="fixture-approval", network="fixture-network",
            expires_unix_ms=now + 600000, source="unused", python="unused",
            execd_image=control.EXECD_IMAGE, dedicated_daemon=True)

    def test_immutable_admission_and_durable_exclusive_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            state, first = control.trial_admission(options)
            original = (state / "admission.json").read_bytes()
            _, second = control.trial_admission(options)
            self.assertEqual(first, second)
            self.assertEqual(original, (state / "admission.json").read_bytes())
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            control.exclusive_json(state / "allocation.claim", {"fixture": True})
            with self.assertRaises(FileExistsError):
                control.exclusive_json(state / "allocation.claim", {})
            options.expires_unix_ms += 1
            with self.assertRaises(ValueError):
                control.trial_admission(options)
            self.assertEqual(original, (state / "admission.json").read_bytes())

    def test_admission_rejects_extended_window_and_identity_change(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            options.expires_unix_ms = int(time.time() * 1000) + 901000
            with self.assertRaises(ValueError):
                control.trial_admission(options)
            options.expires_unix_ms = int(time.time() * 1000) + 500000
            control.trial_admission(options)
            options.network_owner = "different"
            with self.assertRaises(ValueError):
                control.trial_admission(options)

    def test_expired_admission_is_readable_for_cleanup_without_deadline_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            options.expires_unix_ms = 2000
            _, first = control.trial_admission(options, now_ms=1000)
            _, expired = control.trial_admission(options, now_ms=3000)
            self.assertEqual(first, expired)

    def test_cleanup_continues_after_each_failure_and_downgrades_success(self):
        receipt = {"status": "succeeded"}
        calls = []
        def fail():
            calls.append("failed")
            raise RuntimeError("fixture")
        def last():
            calls.append("last")
            return True
        control.trial_cleanup([("first", fail), ("unknown", lambda: None), ("last", last)], receipt)
        self.assertEqual(calls, ["failed", "last"])
        self.assertEqual(receipt["status"], "cleanup-unverified")
        self.assertEqual(receipt["cleanup"], {"first": False, "unknown": False, "last": True})

    def test_late_worker_is_scanned_after_control_stop_and_unknown_helper_retained(self):
        containers = {}
        calls = []
        def fake_command(argv):
            calls.append(argv)
            if argv[1:3] == ["ps", "-aq"]:
                return " ".join(containers)
            if argv[1] == "inspect":
                return json.dumps([containers[argv[2]]])
            if argv[1:3] == ["rm", "-f"]:
                del containers[argv[3]]
                return ""
            raise AssertionError(argv)
        def stop_control():
            containers["late-worker"] = {"Config": {"Labels": {"flyrewheel.lifecycle-owner": "fixture-owner"}}}
            return True
        receipt = {"status": "failed"}
        with patch.object(control, "public_command", side_effect=fake_command):
            control.trial_cleanup([("controlStopped", stop_control),
                ("containersAbsent", lambda: control.trial_scan("fixture-owner"))], receipt)
            self.assertTrue(receipt["cleanup"]["containersAbsent"])
            self.assertIn(["docker", "rm", "-f", "late-worker"], calls)
            containers["unknown-helper"] = {"Config": {"Labels": {}, "Image": control.EXECD_IMAGE}}
            self.assertFalse(control.trial_scan("fixture-owner"))
            self.assertIn("unknown-helper", containers)

    def test_partial_claim_unknown_task_never_launches_again_and_writes_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            state, admission = control.trial_admission(options)
            (state / "outer.claim").write_text("")
            with patch.object(control.subprocess, "Popen", side_effect=AssertionError("no spawn")), \
                 patch.object(control, "public_command", side_effect=AssertionError("no Docker")):
                self.assertEqual(control.run_trial(options), 1)
            receipt = json.loads((state / "receipt.json").read_text())
            self.assertTrue(receipt["resumeCleanupOnly"])
            self.assertFalse(receipt["cleanup"]["controlStopped"])
            self.assertFalse(receipt["cleanup"]["secretsAbsent"])
            self.assertEqual(receipt["status"], "cleanup-unverified")
            self.assertEqual(json.loads((state / "admission.json").read_text()), admission)

    def test_preparation_failure_writes_receipt_and_consumes_outer_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            with patch.object(control, "validate", side_effect=RuntimeError("fixture failure")), \
                 patch.object(control, "public_command", side_effect=RuntimeError("offline fixture")), \
                 patch.object(control.subprocess, "Popen", side_effect=AssertionError("no spawn")):
                self.assertEqual(control.run_trial(options), 1)
            state = Path(options.trial_state)
            receipt = json.loads((state / "receipt.json").read_text())
            self.assertEqual(receipt["errorClass"], "RuntimeError")
            self.assertTrue((state / "outer.claim").exists())
            self.assertTrue((state / "receipt.json").exists())

    def test_failed_container_removal_does_not_skip_remaining_owned(self):
        deleted = []
        def fake(argv):
            if argv[1:3] == ["ps", "-aq"]:
                return "bad good" if not deleted else "bad"
            if argv[1] == "inspect":
                return json.dumps([{"Config": {"Labels": {"flyrewheel.lifecycle-owner": "owner"}}}])
            if argv[1:3] == ["rm", "-f"]:
                if argv[3] == "bad":
                    raise RuntimeError("fake rm failure")
                deleted.append(argv[3])
                return ""
            raise AssertionError(argv)
        with patch.object(control, "public_command", side_effect=fake):
            self.assertFalse(control.trial_scan("owner"))
        self.assertEqual(deleted, ["good"])

    def test_quiescent_scan_rechecks_late_appearance(self):
        calls = []
        def scan(owner):
            calls.append(owner)
            # A queued Docker create can materialize after the first empty scan.
            return len(calls) != 2
        with patch.object(control, "trial_scan", side_effect=scan), patch.object(control.time, "sleep"):
            self.assertFalse(control.trial_quiescent_scan("owner"))
        self.assertEqual(len(calls), 3)

    def test_parent_eof_enters_outer_finally_without_spawn(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            options.trial_supervisor = True
            selector = MagicMock()
            selector.select.return_value = [(object(), 1)]
            real_fstat = os.fstat
            with patch.object(control.sys, "stdin", SimpleNamespace(fileno=lambda: 98765)), \
                 patch.object(control.os, "fstat", side_effect=lambda fd: SimpleNamespace(st_mode=0o010000) if fd == 98765 else real_fstat(fd)), \
                 patch.object(control.os, "read", return_value=b""), \
                 patch.object(control.selectors, "DefaultSelector", return_value=selector), \
                 patch.object(control, "trial_quiescent_scan", return_value=True), \
                 patch.object(control.subprocess, "Popen", side_effect=AssertionError("must not spawn")):
                self.assertEqual(control.run_trial(options), 1)
            receipt = json.loads((Path(options.trial_state) / "receipt.json").read_text())
            self.assertEqual(receipt["errorClass"], "RuntimeError")
            self.assertIn("finalContainersAbsent", receipt["cleanup"])
            selector.close.assert_called_once()

    def test_admission_rejects_nonprivate_file(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            state, _ = control.trial_admission(options)
            (state / "admission.json").chmod(0o644)
            with self.assertRaises(ValueError):
                control.trial_admission(options)

    def test_signal_inside_control_spawn_keeps_child_owned_for_cleanup(self):
        from unittest.mock import MagicMock
        import signal
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            child = MagicMock()
            child.stdin = io.StringIO()
            child.stdout = io.StringIO("")
            def spawn(*args, **kwargs):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                return child
            def command(argv):
                if argv[1:3] == ["network", "inspect"]:
                    return json.dumps([{"Id": "fixture-network-id"}])
                return "fixture-image-id"
            with patch.object(control, "validate"), \
                 patch.object(control, "public_command", side_effect=command), \
                 patch.object(control.subprocess, "Popen", side_effect=spawn) as creation:
                self.assertEqual(control.run_trial(options), 1)
            creation.assert_called_once()
            child.wait.assert_called_once_with(timeout=15)
            self.assertTrue(child.stdin.closed)
            receipt = json.loads((Path(options.trial_state) / "receipt.json").read_text())
            self.assertEqual(receipt["errorClass"], "InterruptedError")
            self.assertEqual(receipt["status"], "cleanup-unverified")

    def test_resume_missing_leader_does_not_claim_live_group_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            state, admission = control.trial_admission(options)
            control.exclusive_json(state / "outer.claim", {})
            control.exclusive_json(state / "driver.json", {"pid": 12345,
                "processIdentity": {}, "deadlineUnixMs": admission["deadlineUnixMs"]})
            with patch.object(control, "process_identity", side_effect=FileNotFoundError()), \
                 patch.object(control, "group_exists", return_value=True), \
                 patch.object(control.os, "killpg", side_effect=AssertionError("unknown group must not be signalled")), \
                 patch.object(control.subprocess, "Popen", side_effect=AssertionError("no spawn")):
                self.assertEqual(control.run_trial(options), 1)
            receipt = json.loads((state / "receipt.json").read_text())
            self.assertFalse(receipt["cleanup"]["driverStopped"])
            self.assertEqual(receipt["status"], "cleanup-unverified")

    def test_active_driver_parent_eof_stops_driver_then_control_before_scan(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory:
            options = self.options(directory)
            options.trial_supervisor = True
            task = Path(directory) / "already-cleaned-task"
            calls = []
            spawned = []
            child = MagicMock()
            child.poll.return_value = None
            child.stdin = io.StringIO()
            child.stdout = io.StringIO(json.dumps({"status": "process-started-readiness-unverified", "task": str(task)}) + "\n" +
                                       json.dumps({"status": "stopped-secrets-removed"}) + "\n")
            child.wait.side_effect = lambda **kwargs: calls.append("stop-control")
            driver = MagicMock()
            driver.pid = 12345
            driver.poll.return_value = None
            def spawn(*args, **kwargs):
                result = child if not spawned else driver
                spawned.append(result)
                return result
            class ImmediateThread:
                def __init__(self, target, **kwargs): self.target = target
                def start(self): self.target()
                def join(self, **kwargs): pass
            selector = MagicMock()
            selector.select.side_effect = lambda timeout: [(object(), 1)] if len(spawned) == 2 else []
            def command(argv):
                if argv[1:3] == ["network", "inspect"]:
                    return json.dumps([{"Id": "fixture-network-id"}])
                if argv[1:3] == ["network", "ls"]:
                    return ""  # fake network already absent
                return "fixture-image-id"
            def stop_group(process):
                self.assertIs(process, driver)
                calls.append("stop-driver")
                return True
            def scan(owner):
                calls.append("scan")
                return True
            real_fstat = os.fstat
            with patch.object(control.sys, "stdin", SimpleNamespace(fileno=lambda: 98765)), \
                 patch.object(control.os, "fstat", side_effect=lambda fd: SimpleNamespace(st_mode=0o010000) if fd == 98765 else real_fstat(fd)), \
                 patch.object(control.os, "read", return_value=b""), \
                 patch.object(control.selectors, "DefaultSelector", return_value=selector), \
                 patch.object(control.threading, "Thread", ImmediateThread), \
                 patch.object(control, "validate"), \
                 patch.object(control, "public_command", side_effect=command), \
                 patch.object(control, "process_identity", return_value={"fixture": True}), \
                 patch.object(control, "stop_group", side_effect=stop_group), \
                 patch.object(control, "trial_quiescent_scan", side_effect=scan), \
                 patch.object(control.subprocess, "Popen", side_effect=spawn):
                self.assertEqual(control.run_trial(options), 1)
            self.assertEqual(len(spawned), 2)
            self.assertEqual(calls, ["stop-driver", "stop-control", "scan", "scan"])
            receipt = json.loads((Path(options.trial_state) / "receipt.json").read_text())
            self.assertTrue(receipt["cleanup"]["driverStopped"])
            self.assertTrue(receipt["cleanup"]["controlStopped"])
            self.assertTrue(receipt["allocationOutcomeAmbiguous"])
            self.assertEqual(receipt["status"], "cleanup-unverified")


if __name__ == "__main__":
    unittest.main()
