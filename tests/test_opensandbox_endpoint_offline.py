"""Run with the pinned upstream server on PYTHONPATH and its prepared dependencies.

No Docker client, sockets, HTTP calls or service process is constructed.
"""
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tomllib
import unittest

from opensandbox_server.services.docker import networking
from opensandbox_server.services.constants import SANDBOX_EMBEDDING_PROXY_PORT_LABEL

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("control", ROOT / "scripts/opensandbox-control-plane.py")
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class EndpointTests(unittest.TestCase):
    def test_generated_config_uses_internal_ip_without_published_ports(self):
        self.assertEqual(hashlib.sha256(Path(networking.__file__).read_bytes()).hexdigest(),
                         "ced0f2189c1025111dd7be87e504e85cd467b0638b73188c425814d8e5ade415")
        config = tomllib.loads(control.build_config(Path("/unused-fixture"), "fixture-only", "task-net"))
        class FakeService(networking.DockerNetworkingMixin):
            network_mode = config["docker"]["network_mode"]
            app_config = SimpleNamespace(server=SimpleNamespace(host="127.0.0.1"),
                                         docker=SimpleNamespace(host_ip=None))
            def validate_port(self, port):
                assert port == 44772
            def _get_container_by_sandbox_id(self, sandbox_id):
                assert sandbox_id == "fixture"
                return SimpleNamespace(attrs={
                    "Config": {"Labels": {SANDBOX_EMBEDDING_PROXY_PORT_LABEL: "49001"}},
                    "NetworkSettings": {"IPAddress": "", "Ports": {}, "Networks": {
                        "task-net": {"IPAddress": "192.0.2.2"}}},
                })
        service = FakeService()
        endpoint = service.get_endpoint("fixture", 44772,
            resolve_internal=config["proxy"]["resolve_internal"], use_proxy_host=True)
        self.assertEqual(endpoint.endpoint, "192.0.2.2:44772")
        # Previous config manufactures a host endpoint from labels even though
        # NetworkSettings.Ports is empty. It does not verify a published port.
        previous = service.get_endpoint("fixture", 44772, resolve_internal=False, use_proxy_host=True)
        self.assertEqual(previous.endpoint, "127.0.0.1:49001/proxy/44772")


if __name__ == "__main__":
    unittest.main()
