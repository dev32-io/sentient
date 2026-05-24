from __future__ import annotations

import pytest
from pathlib import Path

from cli.board import (
    BoardManifest,
    load_manifest,
    list_manifests,
    detect_board,
)
from cli.errors import BoardNotFound


FIXTURES = Path(__file__).parent / "fixtures"
BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def test_load_manifest_parses_cube():
    m = load_manifest(BOARDS_DIR / "cube.yaml")
    assert m.name == "cube"
    assert m.chip == "esp32-s3"
    assert m.http.enabled is True
    assert m.http.port == 8081
    assert "screenshot" in m.capabilities
    assert m.capabilities["screenshot"].transport == "http"
    assert m.log_relay.enabled is True
    # Net_logger ships ESP_LOGx to SENTIENT_GATEWAY_LOG_PORT=5514. The
    # manifest mirrors that. Future Task 27+ migration to the devtool-side
    # log_relay component will keep the same port.
    assert m.log_relay.port == 5514
    assert "sentient.status" in m.verbs


def test_list_manifests_returns_both_boards():
    names = {m.name for m in list_manifests(BOARDS_DIR)}
    assert "cube" in names
    assert "generic-s3-devkit" in names


def test_detect_board_explicit_override_wins():
    m = detect_board(boards_dir=BOARDS_DIR, override_name="cube",
                     scan_ports=lambda glob: [])
    assert m.name == "cube"


def test_detect_board_no_ports_raises():
    with pytest.raises(BoardNotFound):
        detect_board(boards_dir=BOARDS_DIR, override_name=None,
                     scan_ports=lambda glob: [])


def test_detect_board_single_match_uses_it(tmp_path):
    # cube + generic-s3-devkit both glob /dev/cu.usbmodem* — would be ambiguous
    # against the real boards dir. Use a fresh dir with only cube.yaml.
    (tmp_path / "cube.yaml").write_text((BOARDS_DIR / "cube.yaml").read_text())
    m = detect_board(boards_dir=tmp_path, override_name=None,
                     scan_ports=lambda glob: ["/dev/cu.usbmodem101"])
    assert m.name == "cube"


def test_detect_board_ambiguous_raises(tmp_path):
    # Synthesize two manifests with the same port_glob — the real boards dir
    # intentionally avoids this (only cube has a glob; generic-s3-devkit ships
    # without one so it never auto-detects).
    (tmp_path / "cube.yaml").write_text((BOARDS_DIR / "cube.yaml").read_text())
    (tmp_path / "multi_match.yaml").write_text(
        (FIXTURES / "multi_match.yaml").read_text()
    )
    with pytest.raises(BoardNotFound, match="multiple boards"):
        detect_board(boards_dir=tmp_path, override_name=None,
                     scan_ports=lambda glob: ["/dev/cu.usbmodem101"])


def test_load_manifest_missing_required_field_raises(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("chip: esp32-s3\nbuild_profiles: [debug]\n")
    with pytest.raises(ValueError, match="name"):
        load_manifest(bad)
