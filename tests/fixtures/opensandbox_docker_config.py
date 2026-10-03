# Copyright 2025 The OpenSandbox Authors
# Licensed under the Apache License, Version 2.0; https://www.apache.org/licenses/LICENSE-2.0
# Unmodified DockerConfig class excerpt; no server startup code.
# Source: https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/config.py
# Full original file SHA256: 9ddfbaf1e745581ca40716a97eb5fb6fad914a22a1b178e904a23b3d6f9b7a4d
from __future__ import annotations
import ipaddress
from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator

class DockerConfig(BaseModel):
    network_mode: str = Field(
        default="host",
        description="Docker network mode for sandbox containers (host, bridge, or a custom user-defined network name).",
    )
    api_timeout: Optional[int] = Field(
        default=None,
        ge=1,
        description="Docker API timeout in seconds. If unset, default is 180.",
    )
    host_ip: Optional[str] = Field(
        default=None,
        description=(
            "Docker host IP or hostname for bridge-mode endpoint URLs when the server runs in a container."
        ),
    )
    drop_capabilities: list[str] = Field(
        default_factory=lambda: [
            "AUDIT_WRITE",
            "MKNOD",
            "NET_ADMIN",
            "NET_RAW",
            "SYS_ADMIN",
            "SYS_MODULE",
            "SYS_PTRACE",
            "SYS_TIME",
            "SYS_TTY_CONFIG",
        ],
        description=(
            "Linux capabilities to drop from sandbox containers. Defaults to a conservative set to reduce host impact."
        ),
    )
    apparmor_profile: Optional[str] = Field(
        default=None,
        description=(
            "Optional AppArmor profile name applied to sandbox containers. Leave unset to let Docker choose the default."
        ),
    )
    no_new_privileges: bool = Field(
        default=True,
        description="Enable the kernel no_new_privileges flag to block privilege escalation inside the container.",
    )
    seccomp_profile: Optional[str] = Field(
        default=None,
        description=(
            "Optional seccomp profile name or path applied to sandbox containers. Leave unset to use Docker's default profile."
        ),
    )
    port_range_min: int = Field(
        default=40000,
        ge=1024,
        le=65535,
        description=(
            "Lower bound of the host port range for bridge-mode sandbox port allocation. "
            "Must be less than port_range_max. Narrow the range to match your firewall policy."
        ),
    )
    port_range_max: int = Field(
        default=60000,
        ge=1024,
        le=65535,
        description=(
            "Upper bound of the host port range for bridge-mode sandbox port allocation. "
            "Range must span at least 100 ports for reliable allocation. "
            "Each sandbox needs 2–3 host ports (2 without egress, 3 with egress sidecar)."
        ),
    )
    publish_host: str = Field(
        default="0.0.0.0",
        description=(
            "Host address Docker publishes bridge-mode sandbox ports on (the HostIp of every port "
            "binding, the egress sidecar's included). The default 0.0.0.0 publishes on every host "
            "interface. Set an IP address to keep sandbox ports off public interfaces: 127.0.0.1 "
            "when the server runs on the host, or the Docker bridge gateway (e.g. 172.17.0.1) when "
            "the server runs in a container and reaches sandboxes through host-published ports. "
            "Must be an IPv4 address (Docker does not resolve names in port bindings, and the port "
            "probe is IPv4-only)."
        ),
    )
    pids_limit: Optional[int] = Field(
        default=4096,
        ge=1,
        description="Maximum number of processes allowed per sandbox container. Set to null to disable the limit.",
    )
    sandbox_env: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Environment variables injected into every sandbox container. Keys from a sandbox "
            "creation request override same-named keys. Docker-runtime counterpart of the "
            "Kubernetes pod template: useful for fleet-wide settings such as trusting a private "
            "CA (e.g. NODE_EXTRA_CA_CERTS) together with sandbox_binds."
        ),
    )
    sandbox_binds: list[str] = Field(
        default_factory=list,
        description=(
            "Host bind mounts applied to every sandbox container, in Docker -v syntax "
            "(host_path:container_path[:mode]). Prepended to the binds derived from a request's "
            "volumes. Useful for mounting a private CA certificate into all sandboxes."
        ),
    )

    @field_validator("publish_host")
    @classmethod
    def validate_publish_host(cls, value: str) -> str:
        host = (value or "").strip()
        if not host:
            return "0.0.0.0"
        try:
            parsed = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError(
                f"docker.publish_host must be an IP address (got {value!r}): Docker publishes ports "
                "on addresses, not names."
            ) from exc
        if not isinstance(parsed, ipaddress.IPv4Address):
            # The port allocator probes with an AF_INET socket: an IPv6 literal would pass here and
            # then fail every probe (gaierror, not EADDRNOTAVAIL), so say so at config load.
            raise ValueError(
                f"docker.publish_host must be an IPv4 address (got {value!r}): the port allocator "
                "probes with an IPv4 socket."
            )
        return host

    @model_validator(mode="after")
    def validate_port_range(self) -> "DockerConfig":
        if self.port_range_min >= self.port_range_max:
            raise ValueError(
                f"docker.port_range_min ({self.port_range_min}) must be less than "
                f"docker.port_range_max ({self.port_range_max})."
            )
        if self.port_range_max - self.port_range_min < 100:
            raise ValueError(
                f"Port range ({self.port_range_min}-{self.port_range_max}) is too narrow. "
                f"Need at least 100 ports for reliable allocation."
            )
        return self
