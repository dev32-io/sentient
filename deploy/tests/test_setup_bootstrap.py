from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "bootstrap_setup_prod", Path(__file__).parents[1] / "setup-prod.py"
)
assert SPEC is not None and SPEC.loader is not None
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def _release_fixture(tmp_path: Path) -> None:
    version = "1.2.3"
    payload = tmp_path / "dist" / "gateway" / version / "addons" / "attachment-parser"
    payload.mkdir(parents=True)
    (tmp_path / "gateway").mkdir()
    (tmp_path / "gateway" / "package.json").write_text(json.dumps({"version": version}))
    (payload / "addon.json").write_text(json.dumps({
        "name": "attachment-parser",
        "version": "0.2.0",
        "protocolVersion": 2,
        "description": "fixture parser",
        "state": "ephemeral",
    }))
    (payload / "identity.json").write_text(json.dumps({
        "addon": {
            "name": "attachment-parser",
            "version": "0.2.0",
            "protocolVersion": 2,
        },
        "image": {"revision": "fresh-revision"},
    }))
    archive = tmp_path / "dist" / "gateway" / f"{version}.tar.gz"
    archive.write_bytes(b"release")
    archive.with_suffix(archive.suffix + ".sha256").write_text("digest")


def _prepare(monkeypatch, tmp_path: Path, validator_output: str):
    _release_fixture(tmp_path)
    monkeypatch.setattr(bootstrap, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(bootstrap, "_ensure_build_tool", lambda *_: None)
    monkeypatch.setattr(bootstrap, "_wheel_payload_complete", lambda: True)
    monkeypatch.setattr(bootstrap, "_command", lambda name: name)
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        if "attachment_parser_metadata.py" in " ".join(map(str, argv)):
            return subprocess.CompletedProcess(argv, 0, validator_output, "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)
    return calls


def test_bootstrap_builds_only_siblings_with_fresh_parser_metadata(monkeypatch, tmp_path):
    calls = _prepare(monkeypatch, tmp_path, "attachment-parser\t0.2.0\t2\tephemeral\n")
    monkeypatch.setenv("ATTACHMENT_PARSER_NAME", "stale")
    monkeypatch.setenv("ATTACHMENT_PARSER_VERSION", "stale")
    monkeypatch.setenv("ATTACHMENT_PARSER_PROTOCOL_VERSION", "99")
    monkeypatch.setenv("ATTACHMENT_PARSER_REVISION", "stale")

    archive = bootstrap.prepare_native_release()

    compose = next(kwargs for argv, kwargs in calls if argv[0:2] == ["docker", "compose"])
    compose_argv = next(argv for argv, _kwargs in calls if argv[0:2] == ["docker", "compose"])
    assert compose_argv[-3:] == ["outbound-worker", "ingress-proxy", "inbound-proxy"]
    assert "attachment-parser" not in compose_argv
    assert compose["env"] == {
        **bootstrap.os.environ,
        "ATTACHMENT_PARSER_NAME": "attachment-parser",
        "ATTACHMENT_PARSER_VERSION": "0.2.0",
        "ATTACHMENT_PARSER_PROTOCOL_VERSION": "2",
        "ATTACHMENT_PARSER_REVISION": "fresh-revision",
    }
    assert archive.name == "1.2.3.tar.gz"
    assert sum("build-gateway.sh" in " ".join(map(str, argv)) for argv, _ in calls) == 1
    assert all("java" not in " ".join(map(str, argv)) for argv, _ in calls)
    assert all("stack.sh" not in " ".join(map(str, argv)) for argv, _ in calls)
    assert all("scripts/env.sh" not in " ".join(map(str, argv)) for argv, _ in calls)


def test_invalid_parser_metadata_stops_compose(monkeypatch, tmp_path):
    calls = _prepare(monkeypatch, tmp_path, "")

    def fail_validator(argv, **kwargs):
        calls.append((argv, kwargs))
        if "attachment_parser_metadata.py" in " ".join(map(str, argv)):
            raise subprocess.CalledProcessError(1, argv, stderr="invalid metadata")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(bootstrap.subprocess, "run", fail_validator)

    with pytest.raises(subprocess.CalledProcessError):
        bootstrap.prepare_native_release()

    assert not any(argv[0:2] == ["docker", "compose"] for argv, _ in calls)
