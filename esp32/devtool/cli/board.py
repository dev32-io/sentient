"""Board manifest loader + USB auto-detect."""
from __future__ import annotations

import glob as glob_mod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yaml

from cli.errors import BoardNotFound


# Repo-relative boards dir, resolved once at import time. Every command module
# used to recompute this from its own `__file__`; centralizing keeps the path
# in one place and shaves a Path() walk per invocation.
BOARDS_DIR = (Path(__file__).resolve().parent.parent / "boards").resolve()


@dataclass
class Capability:
    transport: str
    require: list[str] = field(default_factory=list)
    format: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)


@dataclass
class UsbCfg:
    vid: int | None = None
    pid: int | None = None
    port_glob: str | None = None


@dataclass
class HttpCfg:
    enabled: bool = False
    port: int = 8081
    discover_via: str = "usb-info"
    static_host: str | None = None


@dataclass
class LogRelayCfg:
    enabled: bool = False
    port: int = 9000
    format: str = "json"


@dataclass
class Extension:
    cmd: str
    exec: str
    args_passthrough: bool = True
    transient: bool = False
    help: str = ""


@dataclass
class BoardManifest:
    name: str
    display_name: str
    chip: str
    build_profiles: list[str]
    firmware_path: str | None
    usb: UsbCfg
    http: HttpCfg
    capabilities: dict[str, Capability]
    log_relay: LogRelayCfg
    verbs: list[str]
    extensions: list[Extension]
    source_path: Path


def load_manifest(path: Path) -> BoardManifest:
    raw = yaml.safe_load(path.read_text())
    if "name" not in raw:
        raise ValueError(f"{path}: missing required field 'name'")
    if "chip" not in raw:
        raise ValueError(f"{path}: missing required field 'chip'")
    if "build_profiles" not in raw:
        raise ValueError(f"{path}: missing required field 'build_profiles'")

    usb_raw = raw.get("usb") or {}
    http_raw = raw.get("http") or {}
    relay_raw = raw.get("log_relay") or {}

    caps: dict[str, Capability] = {}
    for verb, body in (raw.get("capabilities") or {}).items():
        caps[verb] = Capability(
            transport=body["transport"],
            require=body.get("require") or [],
            format=body.get("format") or [],
            sources=body.get("sources") or [],
        )

    exts = [
        Extension(
            cmd=e["cmd"],
            exec=e["exec"],
            args_passthrough=e.get("args_passthrough", True),
            transient=e.get("transient", False),
            help=e.get("help", ""),
        )
        for e in (raw.get("extensions") or [])
    ]

    return BoardManifest(
        name=raw["name"],
        display_name=raw.get("display_name", raw["name"]),
        chip=raw["chip"],
        build_profiles=list(raw["build_profiles"]),
        firmware_path=raw.get("firmware_path"),
        usb=UsbCfg(
            vid=usb_raw.get("vid"),
            pid=usb_raw.get("pid"),
            port_glob=usb_raw.get("port_glob"),
        ),
        http=HttpCfg(
            enabled=bool(http_raw.get("enabled", False)),
            port=int(http_raw.get("port", 8081)),
            discover_via=http_raw.get("discover_via", "usb-info"),
            static_host=http_raw.get("static_host"),
        ),
        capabilities=caps,
        log_relay=LogRelayCfg(
            enabled=bool(relay_raw.get("enabled", False)),
            port=int(relay_raw.get("port", 9000)),
            format=relay_raw.get("format", "json"),
        ),
        verbs=list(raw.get("verbs") or []),
        extensions=exts,
        source_path=path,
    )


def list_manifests(boards_dir: Path) -> list[BoardManifest]:
    out = []
    for p in sorted(boards_dir.glob("*.yaml")):
        if p.name.startswith("_"):
            continue
        out.append(load_manifest(p))
    return out


def _default_scan_ports(glob_pat: str) -> list[str]:
    return sorted(glob_mod.glob(glob_pat))


def resolve_usb_port(manifest: BoardManifest, override: str | None = None) -> str | None:
    """Resolve the cube USB port: override → manifest glob → None.

    Returns the first matching device path, or None if no port detected.
    Callers raise typed ``DevtoolError`` if None matters at their layer.
    """
    if override:
        return override
    pattern = (manifest.usb.port_glob if manifest.usb else None) or "/dev/cu.usbmodem*"
    matches = sorted(glob_mod.glob(pattern))
    return matches[0] if matches else None


def detect_board(
    *,
    boards_dir: Path,
    override_name: str | None,
    scan_ports: Callable[[str], list[str]] = _default_scan_ports,
) -> BoardManifest:
    # Fast path: the very common ``--board <name>`` (and
    # ``_try_register_extensions``'s force-load) just loads one YAML by
    # filename, skipping the full ``list_manifests`` scan that ran on every
    # CLI invocation before.
    if override_name is not None:
        candidate = boards_dir / f"{override_name}.yaml"
        if candidate.exists():
            return load_manifest(candidate)
        # Fall through so the existing error path can list available names.

    manifests = list_manifests(boards_dir)
    by_name = {m.name: m for m in manifests}

    if override_name is not None:
        if override_name not in by_name:
            raise BoardNotFound(
                f"manifest '{override_name}' not found in {boards_dir}",
                next_step=f"available: {sorted(by_name)}",
            )
        return by_name[override_name]

    candidates: list[tuple[BoardManifest, str]] = []
    for m in manifests:
        glob_pat = m.usb.port_glob
        if not glob_pat:
            continue
        ports = scan_ports(glob_pat)
        for p in ports:
            candidates.append((m, p))

    if not candidates:
        raise BoardNotFound(
            "no board connected on USB",
            next_step="pass --board <name> explicitly, or check the cable",
        )
    if len({m.name for m, _ in candidates}) > 1:
        names = sorted({m.name for m, _ in candidates})
        raise BoardNotFound(
            f"multiple boards match: {names}",
            next_step="disambiguate with --board=<name> --port=<path>",
        )
    return candidates[0][0]
