#!/usr/bin/env python3
"""Opt-in temporary control plane. No sandbox requests; dry-run does no I/O.

Approval references are audit context supplied by the operator, not permission
receipts. This manages its process group only, never Docker sandbox resources.
Use a dedicated idle Docker daemon; the empty inventory check is not a lock.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

UPSTREAM = "c7dc78a4090e5de2b9119e9bd93952cae24f87bd"
RUNTIME = "server/opensandbox_server/services/docker/runtime.py"
PATCHED = "6b2037ccb1be25b0c3fb8e7a1de56d4e84030326250b1d81c208e3675a8142db"
DEADLINE = 900
EXECD_IMAGE = "opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a"
GiB = 1024 ** 3


def disk_guard(paths, preparation=False):
    # 5 GiB reserve + 1 GiB reaction margin; 1 GiB additional startup budget.
    required = (7 if preparation else 6) * GiB
    if any(shutil.disk_usage(path).free < required for path in paths):
        raise RuntimeError("disk reserve reached")


def publish(**fields):
    print(json.dumps(fields), flush=True)


def private_file(path, content):
    """Exclusive temporary file, fsync, atomic rename inside private task root."""
    temporary = path.with_suffix(path.suffix + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_group(child, grace=3):
    """Return evidence of group disappearance, not merely a signal result."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        until = time.monotonic() + grace
        while time.monotonic() < until:
            child.poll()  # Reap our leader before checking the group.
            if not group_exists(child.pid):
                return True
            time.sleep(0.03)
    return False


def supervise(child, parent_fd, deadline, guard=lambda: None):
    """Independent session watches parent pipe EOF and a monotonic deadline."""
    selector = selectors.DefaultSelector()
    selector.register(parent_fd, selectors.EVENT_READ)
    last_check = 0
    try:
        while child.poll() is None:
            if time.monotonic() - last_check >= 0.5:
                guard()
                last_check = time.monotonic()
            if time.monotonic() >= deadline:
                return "deadline"
            if selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                if not os.read(parent_fd, 4096):
                    return "parent-exited"
        return "service-exited"
    finally:
        selector.close()


def public_command(argv, *, cwd=None, env=None):
    # Never echo subprocess stderr (upstream diagnostics may include secrets).
    result = subprocess.run(argv, cwd=cwd, env=env or {"PATH": "/usr/local/bin:/usr/bin:/bin"}, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=20, check=True)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("oversized public command output")
    return result.stdout.decode()


def port_closed(port):
    if port is None:
        return True
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def clean_task(child, task, port=None):
    stopped = child is None or stop_group(child)
    stopped = stopped and port_closed(port)
    if stopped:
        shutil.rmtree(task)
    return stopped


def validate(options):
    source = Path(options.source).resolve(strict=True)
    python = Path(options.python).absolute()
    if not python.is_file() or not (python.parent.parent / "pyvenv.cfg").is_file():
        raise ValueError("preinstalled venv interpreter required")
    if options.execd_image != EXECD_IMAGE:
        raise ValueError("audited execd image required")
    if not options.approval_ref or len(options.approval_ref) > 512:
        raise ValueError("operator approval reference required")
    if not options.dedicated_daemon:
        raise ValueError("dedicated idle daemon confirmation required")
    if public_command(["git", "rev-parse", "HEAD"], cwd=source).strip() != UPSTREAM:
        raise ValueError("upstream revision mismatch")
    if hashlib.sha256((source / RUNTIME).read_bytes()).hexdigest() != PATCHED:
        raise ValueError("runtime patch mismatch")
    changed = public_command(["git", "diff", "HEAD", "--name-only"], cwd=source).splitlines()
    if changed != [RUNTIME] or public_command(["git", "ls-files", "--others"], cwd=source).strip():
        raise ValueError("unexpected source modifications")
    if public_command(["docker", "ps", "-aq"]).strip():
        raise ValueError("existing Docker containers; refuse startup restoration")
    public_command(["docker", "image", "inspect", options.execd_image, "--format", "{{.Id}}"])
    return source, python


def run_supervisor(options):
    if not stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode):
        raise ValueError("supervisor requires parent-owned pipe")
    os.umask(0o077)
    started = time.monotonic()
    source, python = validate(options)
    disk_guard((source, tempfile.gettempdir(), "/"), preparation=True)
    task = Path(tempfile.mkdtemp(prefix="flyrewheel-control-"))
    child = None
    listener = None
    stopped = True
    port = None
    spawning = False
    signal_pending = False
    def interrupt(_sig, _frame):
        nonlocal signal_pending
        if spawning:
            signal_pending = True
            return
        raise InterruptedError()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(task),
               "TMPDIR": str(task), "PYTHONPATH": str(source / "server"),
               "PYTHONDONTWRITEBYTECODE": "1", "SANDBOX_CONFIG_PATH": str(task / "config.toml")}
        key = secrets.token_urlsafe(32)
        private_file(task / "api-key", key.encode())
        config = (f'[server]\nhost="127.0.0.1"\napi_key={json.dumps(key)}\n'
                  f'[runtime]\ntype="docker"\nexecd_image={json.dumps(options.execd_image)}\n'
                  f'[store]\ntype="sqlite"\npath={json.dumps(str(task / "state.db"))}\n'
                  '[proxy]\nresolve_internal=false\n'
                  '[docker]\nnetwork_mode="bridge"\npublish_host="127.0.0.1"\n'
                  'port_range_min=49000\nport_range_max=49009\n'
                  'drop_capabilities=["ALL"]\nno_new_privileges=true\npids_limit=64\n'
                  '[storage]\nallowed_host_paths=["/nonexistent/flyrewheel-denied"]\n'
                  '[log]\nlevel="ERROR"\n')
        private_file(task / "config.toml", config.encode())
        public_command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(task / "tls.key.new"), "-out", str(task / "tls.crt.new"),
                        "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], env=env)
        for name in ("tls.key", "tls.crt"):
            os.replace(task / (name + ".new"), task / name)
            os.chmod(task / name, 0o600)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(32)
        port = listener.getsockname()[1]
        argv = [str(python), "-m", "uvicorn", "opensandbox_server.main:app", "--fd", str(listener.fileno()),
                "--ssl-keyfile", str(task / "tls.key"), "--ssl-certfile", str(task / "tls.crt"),
                "--no-access-log", "--log-level", "critical"]
        # Do not lose ownership if a termination signal arrives inside Popen.
        spawning = True
        try:
            child = subprocess.Popen(argv, cwd=task, env=env, pass_fds=(listener.fileno(),),
                                     start_new_session=True, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        finally:
            spawning = False
        if signal_pending:
            raise InterruptedError()
        listener.close()
        listener = None
        private_file(task / "public.json", json.dumps({"pid": child.pid, "pgid": child.pid, "port": port,
                     "upstream": UPSTREAM, "runtimeSha256": PATCHED,
                     "operatorApprovalReference": options.approval_ref,
                     "permissionReceipt": False}).encode())
        publish(status="process-started-readiness-unverified", pid=child.pid, pgid=child.pid,
                port=port, task=str(task), deadlineSeconds=DEADLINE,
                scope="control-plane-process-only-no-sandbox-requests")
        reason = supervise(child, sys.stdin.fileno(), started + DEADLINE,
                           lambda: disk_guard((source, task, "/")))
        publish(status="stopping", reason=reason)
        if reason == "service-exited" and child.returncode != 0:
            raise RuntimeError("service exited unsuccessfully")
    finally:
        if listener:
            listener.close()
        # Further signals cannot interrupt the bounded cleanup sequence.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        stopped = clean_task(child, task, port)
        publish(status="stopped-secrets-removed" if stopped else "cleanup-unverified-secrets-retained",
                task=str(task), sandboxCleanup="not-managed-no-api-requests-issued")
        if not stopped:
            raise RuntimeError("control plane stop unverified")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--approval-ref")
    parser.add_argument("--source")
    parser.add_argument("--python")
    parser.add_argument("--execd-image")
    parser.add_argument("--dedicated-daemon", action="store_true")
    parser.add_argument("--supervisor", action="store_true", help=argparse.SUPPRESS)
    options = parser.parse_args(argv)
    if not options.execute:
        publish(status="dry-run", upstream=UPSTREAM, runtimeSha256=PATCHED, deadlineSeconds=DEADLINE,
                execdImage=EXECD_IMAGE, startupFreeBytes=7 * GiB, stopFreeBytes=6 * GiB,
                required=["explicit execute", "parent approval reference", "preinstalled venv", "pinned patched source",
                          "preloaded execd image digest", "dedicated idle Docker daemon"],
                scope="control-plane-process-only", permissionReceipt=False)
        return 0
    if not all((options.approval_ref, options.source, options.python, options.execd_image, options.dedicated_daemon)):
        parser.error("execute requires all explicit preparation and approval inputs")
    if options.supervisor:
        run_supervisor(options)
        return 0
    command = [sys.executable, str(Path(__file__).resolve()), *(argv if argv is not None else sys.argv[1:]), "--supervisor"]
    supervisor = subprocess.Popen(command, stdin=subprocess.PIPE, start_new_session=True,
                                  env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
    # The detached supervisor observes EOF even on parent SIGKILL. Never wait on
    # a service directly; all descendants are managed by the independent process.
    try:
        return supervisor.wait()
    finally:
        supervisor.stdin.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        publish(status="failed", detail="operation failed; raw diagnostics suppressed")
        sys.exit(1)
