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
        self.assertFalse(config["proxy"]["resolve_internal"])
        with self.assertRaises(ValueError):
            schema.DockerConfig.model_validate({**config["docker"], "port_range_max": 49009})

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


if __name__ == "__main__":
    unittest.main()
