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
import queue
import threading
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
WORKER_IMAGE = "sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed"
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
    network = json.loads(public_command(["docker", "network", "inspect", options.network]))[0]
    validate_internal_network(network, options.network, options.network_owner)
    return source, python


def validate_internal_network(network, name, owner):
    if not owner or network.get("Name") != name or network.get("Driver") != "bridge" or network.get("Internal") is not True:
        raise ValueError("task-owned internal bridge required")
    if network.get("Labels", {}).get("flyrewheel.lifecycle-owner") != owner or network.get("Containers"):
        raise ValueError("network ownership or empty inventory mismatch")
    allowed = {"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"}
    if network.get("Options") != allowed or network.get("EnableIPv6") or network.get("Scope") != "local":
        raise ValueError("unexpected internal network options")


def build_config(task, key, network="bridge"):
    """Pure configuration construction; callers choose real or nonsensitive fixture key."""
    # Internal Docker bridges do not publish host ports. The host-side server
    # must reach execd by container IP; clients still use its HTTPS API proxy.
    return (f'[server]\nhost="127.0.0.1"\napi_key={json.dumps(key)}\n'
                  f'[runtime]\ntype="docker"\nexecd_image={json.dumps(EXECD_IMAGE)}\n'
                  f'[store]\ntype="sqlite"\npath={json.dumps(str(task / "state.db"))}\n'
                  '[proxy]\nresolve_internal=true\n'
                  f'[docker]\nnetwork_mode={json.dumps(network)}\npublish_host="127.0.0.1"\n'
                  'port_range_min=49000\nport_range_max=49100\n'
                  'drop_capabilities=["ALL"]\nno_new_privileges=true\npids_limit=64\n'
                  '[storage]\nallowed_host_paths=["/nonexistent/flyrewheel-denied"]\n'
                  '[log]\nlevel="ERROR"\n')


def run_supervisor(options):
    if not stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode):
        raise ValueError("supervisor requires parent-owned pipe")
    os.umask(0o077)
    started = time.monotonic()
    expires = getattr(options, "expires_unix_ms", None)
    remaining = DEADLINE if expires is None else (expires / 1000 - time.time())
    if not 0 < remaining <= DEADLINE:
        raise ValueError("expired or excessive absolute deadline")
    source, python = validate(options)
    disk_guard((source, tempfile.gettempdir(), "/"), preparation=True)
    if time.monotonic() >= started + remaining:
        raise ValueError("absolute deadline before resource preparation")
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
        if time.monotonic() >= started + remaining:
            raise ValueError("absolute deadline before secret preparation")
        key = secrets.token_urlsafe(32)
        private_file(task / "api-key", key.encode())
        config = build_config(task, key, options.network)
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
        if time.monotonic() >= started + remaining:
            raise ValueError("absolute deadline before service spawn")
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
        if getattr(options, "trial_state", None):
            private_file(Path(options.trial_state) / "control.json", json.dumps({
                "pid": os.getpid(), "processIdentity": process_identity(os.getpid()),
                "task": str(task), "deadlineUnixMs": expires}).encode())
        private_file(task / "public.json", json.dumps({"pid": child.pid, "pgid": child.pid, "port": port,
                     "upstream": UPSTREAM, "runtimeSha256": PATCHED,
                     "operatorApprovalReference": options.approval_ref,
                     "permissionReceipt": False}).encode())
        publish(status="process-started-readiness-unverified", pid=child.pid, pgid=child.pid,
                port=port, task=str(task), deadlineSeconds=DEADLINE,
                scope="control-plane-process-only-no-sandbox-requests")
        reason = supervise(child, sys.stdin.fileno(), started + remaining,
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
        if getattr(options, "trial_state", None):
            private_file(Path(options.trial_state) / "control-stopped.json", json.dumps({
                "stopped": stopped, "task": str(task), "deadlineUnixMs": expires}).encode())
        if not stopped:
            raise RuntimeError("control plane stop unverified")



def process_identity(pid):
    # PID reuse is never sufficient authority to signal a resumed supervisor.
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return {"bootId": boot, "startTicks": fields[19]}


def exclusive_json(path, value):
    """Durable one-shot claims. A partial file is a consumed claim, never retried."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def trial_admission(options, now_ms=None):
    now = int(time.time() * 1000) if now_ms is None else now_ms
    state = Path(options.trial_state).absolute()
    expected = dict(schema=1, owner=options.network_owner,
                    approvalReference=options.approval_ref, network=options.network,
                    execdImage=EXECD_IMAGE, workerImage=WORKER_IMAGE)
    try:
        state.mkdir(mode=0o700)
    except FileExistsError:
        pass
    if state.is_symlink() or not state.is_dir() or state.stat().st_mode & 0o077 or state.stat().st_uid != os.getuid():
        raise ValueError("private owned trial directory required")
    admission_path = state / "admission.json"
    if not admission_path.exists():
        expires = options.expires_unix_ms
        if expires is None or not now < expires <= now + DEADLINE * 1000:
            raise ValueError("explicit absolute trial deadline within 900 seconds required")
        exclusive_json(admission_path, dict(expected, startedUnixMs=now, deadlineUnixMs=expires))
    if admission_path.is_symlink():
        raise ValueError("admission symlink refused")
    fd = os.open(admission_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600 or info.st_size > 4096:
            raise ValueError("private bounded admission file required")
        data = stream.read(4097)
        if len(data) > 4096:
            raise ValueError("admission size bound")
        admission = json.loads(data)
    if any(admission.get(key) != value for key, value in expected.items()):
        raise ValueError("immutable admission identity mismatch")
    began, end = admission.get("startedUnixMs"), admission.get("deadlineUnixMs")
    if type(began) is not int or type(end) is not int or not 0 < end - began <= DEADLINE * 1000 or began > now:
        raise ValueError("invalid immutable deadline")
    if options.expires_unix_ms is not None and options.expires_unix_ms != end:
        raise ValueError("immutable deadline mismatch")
    return state, admission


def trial_cleanup(stages, receipt):
    """Run every independent cleanup stage; any unknown or failure is non-success."""
    results = receipt.setdefault("cleanup", {})
    for name, operation in stages:
        try:
            results[name] = operation() is True
        except Exception as error:
            results[name] = False
            receipt.setdefault("cleanupErrors", {})[name] = type(error).__name__
    if not all(results.values()):
        receipt["status"] = "cleanup-unverified"


def trial_scan(owner):
    """After server stop, delete only exact owned workers. Unknown helpers fail closed.

    Helper names/image alone cannot prove task ownership. The pinned helper has
    no owner label, so a surviving helper is retained and reported as unknown.
    """
    ids = public_command(["docker", "ps", "-aq"]).split()
    unknown = False
    for identity in ids:
        try:
            obj = json.loads(public_command(["docker", "inspect", identity]))[0]
            if (obj.get("Config", {}).get("Labels") or {}).get("flyrewheel.lifecycle-owner") != owner:
                unknown = True
                continue
            public_command(["docker", "rm", "-f", identity])
        except Exception:
            # One inaccessible or failed container must not skip other owned IDs.
            unknown = True
    remaining = public_command(["docker", "ps", "-aq"]).split()
    return not unknown and not remaining



def trial_quiescent_scan(owner):
    verified = True
    for attempt in range(3):
        try:
            verified = trial_scan(owner) and verified
        except Exception:
            verified = False
        if attempt < 2:
            time.sleep(0.25)
    return verified


def trial_node(options):
    node = Path(options.node_executable)
    if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError("explicit executable Node path required")
    return str(node.resolve())


def run_trial(options):
    node = trial_node(options)
    state, admission = trial_admission(options)
    receipt = dict(schema=1, owner=admission["owner"], deadlineUnixMs=admission["deadlineUnixMs"],
                   status="failed", cleanup={}, nodeExecutable=node, imagePolicy="retain-preexisting-no-image-removal")
    child = driver = None
    task = None
    messages = queue.Queue()
    thread = None
    network_id = None
    control_stopped = False
    launched = False
    old_signals = {}
    spawning = False
    signal_pending = False
    parent_selector = None
    if getattr(options, "trial_supervisor", False):
        if not stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode):
            raise ValueError("trial supervisor requires parent pipe")
        parent_selector = selectors.DefaultSelector()
        parent_selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    def parent_alive():
        if parent_selector and parent_selector.select(0):
            if not os.read(sys.stdin.fileno(), 4096):
                raise RuntimeError("trial parent exited")
    def interrupted(_sig, _frame):
        nonlocal signal_pending
        if spawning:
            signal_pending = True
            return
        raise InterruptedError()
    def spawn_owned(role, *args, **kwargs):
        nonlocal spawning, child, driver
        spawning = True
        try:
            if role == "control":
                child = subprocess.Popen(*args, **kwargs)
            elif role == "driver":
                driver = subprocess.Popen(*args, **kwargs)
            else:
                raise ValueError("unknown owned process role")
        finally:
            spawning = False
    def check_spawn():
        if signal_pending:
            raise InterruptedError()
    for sig in (signal.SIGINT, signal.SIGTERM):
        old_signals[sig] = signal.signal(sig, interrupted)

    def remaining():
        return min((admission["deadlineUnixMs"] / 1000) - time.time(), DEADLINE)

    def read_messages():
        try:
            while True:
                line = child.stdout.readline(65537)
                if not line:
                    break
                if len(line) > 65536:
                    raise ValueError("output bound")
                messages.put(json.loads(line))
        except Exception:
            messages.put({"status": "output-unverified"})

    def drain():
        nonlocal task
        while not messages.empty():
            message = messages.get_nowait()
            receipt.setdefault("controlEvents", []).append(message)
            if message.get("status") == "process-started-readiness-unverified":
                task = Path(message["task"])

    def stop_driver():
        if driver is not None:
            if driver.poll() is None:
                receipt["allocationOutcomeAmbiguous"] = True
            return stop_group(driver)
        if not receipt.get("resumeCleanupOnly", False):
            return True
        record = json.loads((state / "driver.json").read_text())
        if record["deadlineUnixMs"] != admission["deadlineUnixMs"]:
            return False
        pid = record["pid"]
        try:
            identity = process_identity(pid)
        except FileNotFoundError:
            return not group_exists(pid)
        if identity != record["processIdentity"] or os.getpgid(pid) != pid:
            return False
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except ProcessLookupError:
                return True
            until = time.monotonic() + 3
            while time.monotonic() < until:
                if not group_exists(pid):
                    return True
                time.sleep(0.05)
        return False

    def stop_control():
        nonlocal control_stopped, task
        if child is None:
            if not receipt.get("resumeCleanupOnly", False):
                control_stopped = True
                return True
            record = json.loads((state / "control.json").read_text())
            if record["deadlineUnixMs"] != admission["deadlineUnixMs"]:
                return False
            task = Path(record["task"])
            done_path = state / "control-stopped.json"
            if not done_path.exists():
                pid = record["pid"]
                if process_identity(pid) != record["processIdentity"]:
                    return False
                os.kill(pid, signal.SIGTERM)
                until = time.monotonic() + 15
                while not done_path.exists() and time.monotonic() < until:
                    time.sleep(0.05)
            done = json.loads(done_path.read_text())
            control_stopped = (done.get("stopped") is True and done.get("task") == str(task)
                               and done.get("deadlineUnixMs") == admission["deadlineUnixMs"] and not task.exists())
            return control_stopped
        child.stdin.close()  # independent supervisor stops service on EOF
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # Do not SIGKILL supervisor: it owns a separately grouped service.
            return False
        if thread:
            thread.join(timeout=2)
        drain()
        control_stopped = any(m.get("status") == "stopped-secrets-removed"
                              for m in receipt.get("controlEvents", []))
        return control_stopped

    def secrets_absent():
        if not launched and not receipt.get("resumeCleanupOnly", False):
            return True
        return task is not None and not task.exists() and control_stopped

    def containers_absent():
        if not control_stopped:
            return False  # no race with a late in-flight create
        return trial_quiescent_scan(admission["owner"])

    def remove_network():
        nonlocal network_id
        if not control_stopped or not receipt["cleanup"].get("containersAbsent"):
            return False
        if network_id is None:
            provenance = json.loads((state / "provenance.json").read_text())
            network_id = provenance["networkId"]
        if network_id not in public_command(["docker", "network", "ls", "--no-trunc", "-q"]).split():
            return True
        obj = json.loads(public_command(["docker", "network", "inspect", network_id]))[0]
        validate_internal_network(obj, options.network, options.network_owner)
        if obj["Id"] != network_id:
            return False
        public_command(["docker", "network", "rm", network_id])
        return network_id not in public_command(["docker", "network", "ls", "--no-trunc", "-q"]).split()

    try:
        parent_alive()
        try:
            exclusive_json(state / "outer.claim", {"deadlineUnixMs": admission["deadlineUnixMs"]})
        except FileExistsError:
            receipt["resumeCleanupOnly"] = True
            raise ValueError("one-shot outer claim already consumed; no second driver")
        if remaining() <= 0 or (state / "allocation.claim").exists():
            raise ValueError("expired or previously allocated trial")
        validate(options)
        obj = json.loads(public_command(["docker", "network", "inspect", options.network]))[0]
        network_id = obj["Id"]
        receipt["networkId"] = network_id
        receipt["preexistingImageId"] = public_command(["docker", "image", "inspect", EXECD_IMAGE, "--format", "{{.Id}}"]).strip()
        public_command(["docker", "image", "inspect", WORKER_IMAGE, "--format", "{{.Id}}"])
        exclusive_json(state / "provenance.json", {"networkId": network_id, "execdImageId": receipt["preexistingImageId"]})
        if remaining() <= 0:
            raise ValueError("trial deadline")
        args = [sys.executable, str(Path(__file__).resolve()), "--execute", "--supervisor",
                "--approval-ref", options.approval_ref, "--source", options.source,
                "--python", options.python, "--execd-image", options.execd_image,
                "--dedicated-daemon", "--network", options.network, "--network-owner", options.network_owner,
                "--expires-unix-ms", str(admission["deadlineUnixMs"]), "--trial-state", str(state)]
        parent_alive()
        spawn_owned("control", args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 text=True, start_new_session=True, env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
        launched = True
        check_spawn()
        thread = threading.Thread(target=read_messages, daemon=True)
        thread.start()
        ready_until = min(time.monotonic() + 45, time.monotonic() + remaining())
        while task is None:
            parent_alive()
            drain()
            if child.poll() is not None or time.monotonic() >= ready_until:
                raise RuntimeError("control startup failed")
            time.sleep(0.05)
        repo = Path(__file__).resolve().parents[1]
        parent_alive()
        if remaining() <= 0:
            raise RuntimeError("absolute deadline before driver")
        spawn_owned("driver", [node, "--import", "tsx", str(repo / "scripts/run-opensandbox-local-smoke.ts"),
                                   str(task), options.network_owner, options.network, str(state / "lifecycle.json"), str(state)],
                                  cwd=repo, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  start_new_session=True, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "OPENSANDBOX_DISABLE_METRICS": "1"})
        check_spawn()
        private_file(state / "driver.json", json.dumps({"pid": driver.pid,
            "processIdentity": process_identity(driver.pid), "deadlineUnixMs": admission["deadlineUnixMs"]}).encode())
        while driver.poll() is None:
            parent_alive()
            if remaining() <= 0:
                raise RuntimeError("absolute trial deadline")
            disk_guard((state, "/"))
            time.sleep(0.1)
        receipt["driverExitCode"] = driver.returncode
        receipt["status"] = "succeeded" if driver.returncode == 0 else "failed"
    except Exception as error:
        receipt["errorClass"] = type(error).__name__
    finally:
        for sig in old_signals:
            signal.signal(sig, signal.SIG_IGN)
        try:
            trial_cleanup([("driverStopped", stop_driver), ("controlStopped", stop_control),
                           ("secretsAbsent", secrets_absent), ("containersAbsent", containers_absent),
                           ("networkAbsent", remove_network),
                           ("finalContainersAbsent", containers_absent)], receipt)
            lifecycle_path = state / "lifecycle.json"
            if lifecycle_path.is_file():
                try:
                    lifecycle = json.loads(lifecycle_path.read_text())
                    allocation = [r for r in lifecycle.get("requests", [])
                                  if r.get("category") == "sandboxes" and r.get("method") == "POST"]
                    if lifecycle.get("allocationDispatches", 0) and not any(isinstance(r.get("status"), int) for r in allocation):
                        receipt["allocationOutcomeAmbiguous"] = True
                except Exception:
                    receipt["allocationOutcomeAmbiguous"] = True
            if receipt.get("allocationOutcomeAmbiguous") or ((launched or (state / "allocation.claim").exists()) and not lifecycle_path.is_file()):
                receipt["allocationOutcomeAmbiguous"] = True
                receipt["status"] = "cleanup-unverified"
        finally:
            try:
                private_file(state / "receipt.json", (json.dumps(receipt, indent=2) + "\n").encode())
            finally:
                if parent_selector:
                    parent_selector.close()
                for sig, handler in old_signals.items():
                    signal.signal(sig, handler)
    return 0 if receipt["status"] == "succeeded" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--trial-supervisor", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--node-executable", help="absolute installed Node binary for the isolated trial driver")
    parser.add_argument("--trial-state", help="private persistent one-shot outer trial directory")
    parser.add_argument("--expires-unix-ms", type=int, help="absolute UTC deadline; never extended on resume")
    parser.add_argument("--approval-ref")
    parser.add_argument("--source")
    parser.add_argument("--python")
    parser.add_argument("--execd-image")
    parser.add_argument("--dedicated-daemon", action="store_true")
    parser.add_argument("--network")
    parser.add_argument("--network-owner")
    parser.add_argument("--supervisor", action="store_true", help=argparse.SUPPRESS)
    options = parser.parse_args(argv)
    if not options.execute:
        publish(status="dry-run", upstream=UPSTREAM, runtimeSha256=PATCHED, deadlineSeconds=DEADLINE,
                execdImage=EXECD_IMAGE, startupFreeBytes=7 * GiB, stopFreeBytes=6 * GiB,
                required=["explicit execute", "parent approval reference", "preinstalled venv", "pinned patched source",
                          "preloaded execd image digest", "dedicated idle Docker daemon", "empty task-owned internal bridge"],
                scope="control-plane-process-only", permissionReceipt=False)
        return 0
    if not all((options.approval_ref, options.source, options.python, options.execd_image, options.dedicated_daemon, options.network, options.network_owner)):
        parser.error("execute requires all explicit preparation and approval inputs")
    if options.trial_supervisor and (not options.trial_state or options.supervisor):
        parser.error("trial supervisor requires outer trial mode")
    if options.trial_state and not options.supervisor:
        if not options.node_executable:
            parser.error("trial mode requires --node-executable")
        if options.trial_supervisor:
            return run_trial(options)
        command = [sys.executable, str(Path(__file__).resolve()),
                   *(argv if argv is not None else sys.argv[1:]), "--trial-supervisor"]
        trial = subprocess.Popen(command, stdin=subprocess.PIPE, start_new_session=True,
                                 env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
        try:
            return trial.wait()
        finally:
            trial.stdin.close()
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
