import json

import pytest

from scripts.attachment_parser_metadata import read_metadata


def _write(tmp_path, **overrides):
    value = {
        "name": "attachment-parser",
        "version": "0.2.0",
        "protocolVersion": 2,
        "description": "fixture parser",
        "state": "ephemeral",
        **overrides,
    }
    path = tmp_path / "addon.json"
    path.write_text(json.dumps(value))
    return path


def test_reads_contract_fields(tmp_path):
    assert read_metadata(_write(tmp_path)) == ("attachment-parser", "0.2.0", 2, "ephemeral")


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"protocolVersion": 1}, "protocolVersion"),
        ({"state": "persistent"}, "state"),
        ({"version": "foo"}, "version"),
        ({"version": "0_2_0"}, "version"),
        ({"version": "1.2.3-"}, "version"),
        ({"description": ""}, "description"),
        ({"description": "x" * 257}, "description"),
        ({"extra": True}, "exactly"),
    ],
)
def test_rejects_metadata_outside_build_contract(tmp_path, overrides, message):
    with pytest.raises(ValueError, match=message):
        read_metadata(_write(tmp_path, **overrides))


def test_accepts_semver_prerelease_and_build_metadata(tmp_path):
    assert read_metadata(_write(tmp_path, version="1.2.3-rc.1+build.7"))[1] == "1.2.3-rc.1+build.7"


def test_rejects_versions_over_64_characters(tmp_path):
    with pytest.raises(ValueError, match="64"):
        read_metadata(_write(tmp_path, version="1.2.3+" + "a" * 60))
