"""Installer state-machine tests.

Scope is deliberately narrow: the install/rollback FSM, the checksum gate and
the TLS trust decision. Those are the paths where a defect takes the mini down
or weakens a security boundary. The thin I/O shells (RealFs, RealLaunchd) are
exercised through the FSM against a real temp filesystem rather than mocked.
"""

from __future__ import annotations

import hashlib
import io
import json
import ssl
import os
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest
import setup_prod
from setup_prod import (
    CERT_RELATIVE,
    DockerCommandTimeout,
    DockerCli,
    DockerImageIdentity,
    INSTALL_VENV_SCRIPT,
    OPERATOR_PLACEHOLDER,
    PARSER_RETAINED_IMAGE_PREFIX,
    PARSER_RUNTIME_IMAGE,
    PLIST_SOURCE,
    RELEASE_ROOT_PLACEHOLDER,
    RELEASES_SUBDIR,
    SERVICE_SOURCES,
    RELEASE_INSTALL_VENV,
    RELEASE_NATIVE_SOURCES_DIR,
    RELEASE_REQUIREMENTS_DIR,
    RELEASE_WHEELS_DIR,
    STATE_DIRS,
    STATE_ROOT,
    HealthProbe,
    InstallError,
    Installer,
    InstallerLock,
    RealFs,
    RealLaunchd,
    build_tls_context,
    ensure_state_dirs,
    prepare_attachment_parser,
    prepare_legacy_attachment_parser,
    prepare_legacy_candidate_attachment_parser,
    preflight_attachment_parser_install,
    read_attachment_parser_artifact,
    read_optional_attachment_parser_artifact,
    read_legacy_parser_receipt,
    write_legacy_parser_receipt,
    read_inbound_proxy_cert_dir,
    read_release_version,
    resolve_operator,
    resolve_outward_cert,
    stage_native_services,
    verify_tarball_checksum,
)


class _FakeResponse:
    """Minimal stand-in for the urlopen context manager."""

    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeFs:
    def __init__(self):
        self.current = None
        self.installed = []

    def unpack(self, version, tarball):
        self.installed.append(version)

    def point_current_at(self, version):
        self.current = version

    def harden_release(self, version):
        pass

    def has_version(self, version):
        return version in self.installed


class FakeLaunchd:
    def __init__(self):
        self.kicks = 0

    def kickstart(self):
        self.kicks += 1


def _parser_release(tmp_path, version="0.2.0", revision="rev"):
    release = tmp_path / "release"
    root = release / "addons/attachment-parser"
    root.mkdir(parents=True)
    image_id = "sha256:" + "1" * 64
    image_ref = f"sentient/attachment-parser:release-{version.replace('+', '_')}-{revision}"
    archive_path = root / "image.tar"
    manifest = json.dumps([{"Config": "config.json", "RepoTags": [image_ref], "Layers": []}]).encode()
    with tarfile.open(archive_path, "w") as archive:
        member = tarfile.TarInfo("manifest.json")
        member.size = len(manifest)
        archive.addfile(member, io.BytesIO(manifest))
    metadata = {
        "name": "attachment-parser",
        "version": version,
        "protocolVersion": 2,
        "description": "fixture parser",
        "state": "ephemeral",
    }
    (root / "addon.json").write_text(json.dumps(metadata))
    (root / "identity.json").write_text(
        json.dumps(
            {
                "addon": {
                    "name": metadata["name"],
                    "version": metadata["version"],
                    "protocolVersion": metadata["protocolVersion"],
                },
                "image": {
                    "ref": image_ref,
                    "imageId": image_id,
                    "revision": revision,
                    "runtimeImage": PARSER_RUNTIME_IMAGE,
                    "archive": "image.tar",
                    "archiveSha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
                },
            }
        )
    )
    return release, image_ref, image_id


class FakeParserDocker:
    def __init__(self, image_ref, image_id, include_previous=True, version="0.2.0", revision="rev"):
        self.images = {
            image_ref: DockerImageIdentity(
                image_id, version, revision, "attachment-parser", 2
            ),
        }
        if include_previous:
            self.images[PARSER_RUNTIME_IMAGE] = DockerImageIdentity(
                "sha256:" + "2" * 64, "legacy", "legacy-rev"
            )
        self.loaded = []
        self.tags = []
        self.removed = []

    def inspect(self, image, missing_ok=False):
        value = self.images.get(image)
        if value is None and not missing_ok:
            raise AssertionError(f"unexpected missing image {image}")
        return value

    def load(self, archive):
        self.loaded.append(archive)

    def tag(self, image_id, image):
        if not any(identity.image_id == image_id for identity in self.images.values()):
            raise AssertionError(f"image {image_id} is no longer available")
        self.tags.append((image_id, image))
        self.images[image] = DockerImageIdentity(image_id, "tagged", "tagged")

    def remove(self, image):
        self.removed.append(image)
        self.images.pop(image, None)


def test_legacy_parser_directory_absence_skips_payload_but_partial_payload_fails_closed(tmp_path):
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    assert read_optional_attachment_parser_artifact(legacy) is None

    partial = tmp_path / "partial"
    (partial / "addons/attachment-parser").mkdir(parents=True)
    (partial / "addons/attachment-parser/addon.json").write_text("{}")
    with pytest.raises(InstallError, match="missing attachment-parser identity"):
        read_optional_attachment_parser_artifact(partial)


def test_parser_artifact_checksum_is_checked_before_docker_load(tmp_path):
    release, _image_ref, _image_id = _parser_release(tmp_path)

    artifact = read_attachment_parser_artifact(release)
    assert artifact.version == "0.2.0"
    assert artifact.protocol_version == 2

    artifact.archive.write_bytes(b"damaged")
    with pytest.raises(InstallError, match="archive checksum mismatch"):
        read_attachment_parser_artifact(release)


def test_parser_archive_cannot_carry_the_active_alias(tmp_path):
    release, image_ref, _image_id = _parser_release(tmp_path)
    archive_path = release / "addons/attachment-parser/image.tar"
    manifest = json.dumps(
        [{"Config": "config.json", "RepoTags": [image_ref, PARSER_RUNTIME_IMAGE], "Layers": []}]
    ).encode()
    with tarfile.open(archive_path, "w") as archive:
        member = tarfile.TarInfo("manifest.json")
        member.size = len(manifest)
        archive.addfile(member, io.BytesIO(manifest))
    identity_path = release / "addons/attachment-parser/identity.json"
    identity = json.loads(identity_path.read_text())
    identity["image"]["archiveSha256"] = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    identity_path.write_text(json.dumps(identity))

    with pytest.raises(InstallError, match="active runtime tag"):
        read_attachment_parser_artifact(release)


def test_parser_prepare_checks_image_identity_and_does_not_replace_active_alias(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    docker = FakeParserDocker(image_ref, image_id)
    previous_id = docker.images[PARSER_RUNTIME_IMAGE].image_id
    retained_ref = f"{PARSER_RETAINED_IMAGE_PREFIX}{previous_id[len('sha256:'):]}"

    pairing = prepare_attachment_parser(release, "1.12.0", docker)

    assert docker.loaded == [release / "addons/attachment-parser/image.tar"]
    assert docker.images[retained_ref].image_id == previous_id
    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == previous_id
    pairing.activate()
    assert docker.tags[-1] == (image_id, PARSER_RUNTIME_IMAGE)
    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == image_id
    docker.images[image_ref] = DockerImageIdentity("sha256:" + "3" * 64, "replaced", "replaced")
    pairing.restore()
    assert docker.tags[-1] == (previous_id, PARSER_RUNTIME_IMAGE)
    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == previous_id


def test_parser_prepare_rejects_loaded_image_id_mismatch(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    docker = FakeParserDocker(image_ref, image_id)
    docker.images[image_ref] = DockerImageIdentity(
        "sha256:" + "3" * 64, "0.2.0", "rev"
    )

    with pytest.raises(InstallError, match="image ID mismatch"):
        prepare_attachment_parser(release, "1.12.0", docker)

    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == "sha256:" + "2" * 64


def test_parser_prepare_refuses_legacy_rollback_without_previous_image(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    docker = FakeParserDocker(image_ref, image_id, include_previous=False)

    with pytest.raises(InstallError, match="rollback cannot restore"):
        prepare_attachment_parser(release, "1.12.0", docker)

    assert docker.loaded == [], "must refuse before loading a release with no rollback pairing"


def test_installer_parser_manifest_uses_same_exact_contract(tmp_path):
    release, _image_ref, _image_id = _parser_release(tmp_path)
    metadata_path = release / "addons/attachment-parser/addon.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["extra"] = True
    metadata_path.write_text(json.dumps(metadata))

    with pytest.raises(InstallError, match="exactly"):
        read_attachment_parser_artifact(release)


def test_parser_manifest_accepts_build_metadata_but_docker_tag_uses_underscore(tmp_path):
    release, image_ref, _image_id = _parser_release(tmp_path, version="1.2.3-rc.1+build.7")

    artifact = read_attachment_parser_artifact(release)

    assert artifact.version == "1.2.3-rc.1+build.7"
    assert image_ref == "sentient/attachment-parser:release-1.2.3-rc.1_build.7-rev"
    assert artifact.image_ref == image_ref


def test_same_version_first_repair_can_recover_missing_alias_explicitly(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    docker = FakeParserDocker(image_ref, image_id, include_previous=False)

    pairing = prepare_attachment_parser(release, "1.13.0", docker, allow_missing_previous=True)
    assert pairing.previous_image_id is None
    pairing.activate()
    assert docker.tags[-1] == (image_id, PARSER_RUNTIME_IMAGE)
    pairing.restore()
    assert docker.removed == [PARSER_RUNTIME_IMAGE]


def test_timed_out_staging_reconciles_immutable_image_before_failing(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)

    class TimeoutLoadDocker(FakeParserDocker):
        def load(self, archive):
            self.loaded.append(archive)
            raise DockerCommandTimeout("load state unknown")

    docker = TimeoutLoadDocker(image_ref, image_id)
    pairing = prepare_attachment_parser(release, "1.12.0", docker)

    assert pairing.artifact.image_id == image_id
    assert docker.loaded == [release / "addons/attachment-parser/image.tar"]


def test_timed_out_activation_reconciles_alias_before_rollback(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)

    class TimeoutAfterTag(FakeParserDocker):
        def __init__(self):
            super().__init__(image_ref, image_id)
            self.timed_out = True

        def tag(self, image_id, image):
            super().tag(image_id, image)
            if self.timed_out:
                self.timed_out = False
                raise DockerCommandTimeout("tag state unknown")

    docker = TimeoutAfterTag()
    pairing = prepare_attachment_parser(release, "1.12.0", docker)

    pairing.activate()

    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == image_id


def test_docker_health_requires_running_expected_image_and_live_manifest(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    artifact = read_attachment_parser_artifact(release)
    calls = []

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        if argv[1:3] == ["image", "inspect"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"Id": image_id, "Config": {"Labels": {}}}]), "")
        if argv[1:3] == ["container", "inspect"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"Image": image_id, "State": {"Running": True}}]), "")
        if argv[1] == "exec":
            return subprocess.CompletedProcess(argv, 0, json.dumps(artifact.metadata), "")
        raise AssertionError(argv)

    DockerCli(runner).parser_health("sentient-attachment-parser", artifact)

    assert calls[-1][0] == [
        "docker", "exec", "sentient-attachment-parser", "python3", "/app/exec_client.py", "--health"
    ]
    assert all(call[1]["timeout"] == setup_prod.DOCKER_CLI_TIMEOUT_SECONDS for call in calls)


def test_docker_health_rejects_nonzero_health_command(tmp_path):
    release, _image_ref, image_id = _parser_release(tmp_path)
    artifact = read_attachment_parser_artifact(release)

    def runner(argv, **kwargs):
        if argv[1:3] == ["image", "inspect"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"Id": image_id, "Config": {"Labels": {}}}]), "")
        if argv[1:3] == ["container", "inspect"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"Image": image_id, "State": {"Running": True}}]), "")
        raise subprocess.CalledProcessError(1, argv)

    with pytest.raises(InstallError, match="exec attachment-parser health"):
        DockerCli(runner).parser_health("sentient-attachment-parser", artifact)


def test_docker_cli_bounds_and_classifies_all_calls_on_timeout():
    calls = []

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    docker = DockerCli(runner)
    operations = (
        lambda: docker.inspect(PARSER_RUNTIME_IMAGE, missing_ok=True),
        lambda: docker.load(Path("image.tar")),
        lambda: docker.tag("sha256:" + "1" * 64, PARSER_RUNTIME_IMAGE),
        lambda: docker.remove(PARSER_RUNTIME_IMAGE),
    )
    for operation in operations:
        with pytest.raises(DockerCommandTimeout):
            operation()

    assert len(calls) == 4
    assert calls[0][1]["timeout"] == setup_prod.DOCKER_CLI_TIMEOUT_SECONDS
    assert calls[1][1]["timeout"] == setup_prod.DOCKER_LOAD_TIMEOUT_SECONDS
    assert calls[2][1]["timeout"] == setup_prod.DOCKER_CLI_TIMEOUT_SECONDS
    assert calls[3][1]["timeout"] == setup_prod.DOCKER_CLI_TIMEOUT_SECONDS


def test_previous_paired_alias_mismatch_refuses_before_load_or_tag(tmp_path):
    release, image_ref, image_id = _parser_release(tmp_path)
    docker = FakeParserDocker(image_ref, image_id)
    expected_previous = "sha256:" + "4" * 64

    with pytest.raises(InstallError, match="paired with"):
        prepare_attachment_parser(
            release,
            "1.12.0",
            docker,
            expected_previous_image_id=expected_previous,
        )

    assert docker.loaded == []
    assert docker.tags == []


def test_legacy_candidate_does_not_lookup_candidate_receipt_and_restores_previous_pair(tmp_path):
    paired_release, _image_ref, _image_id = _parser_release(tmp_path)
    previous_artifact = read_attachment_parser_artifact(paired_release)
    docker = FakeParserDocker("sentient/attachment-parser:release-new-rev", "sha256:" + "3" * 64)
    docker.images[PARSER_RUNTIME_IMAGE] = DockerImageIdentity(
        previous_artifact.image_id,
        previous_artifact.version,
        previous_artifact.revision,
        previous_artifact.metadata["name"],
        previous_artifact.protocol_version,
    )
    previous_id = docker.images[PARSER_RUNTIME_IMAGE].image_id

    pairing = prepare_legacy_candidate_attachment_parser(
        "1.12.0", previous_artifact, docker
    )
    pairing.activate()
    docker.images[PARSER_RUNTIME_IMAGE] = DockerImageIdentity(
        "sha256:" + "3" * 64, "candidate", "candidate"
    )
    pairing.restore()

    assert docker.loaded == []
    assert docker.tags[-1] == (previous_id, PARSER_RUNTIME_IMAGE)


def test_preflight_missing_parser_config_fails_before_install_side_effects(tmp_path):
    release, _image_ref, _image_id = _parser_release(tmp_path)
    archive_path = tmp_path / "1.13.0.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(release, arcname="1.13.0")

    config = tmp_path / "operator-config.yaml"
    config.write_text("managed_services:\n  egress-proxy:\n    template: egress-proxy.yaml\n")
    template = tmp_path / "template.yaml"
    template.write_text("managed_services:\n  attachment-parser:\n    template: attachment-parser.yaml\n")

    with pytest.raises(InstallError, match="managed_services\\.attachment-parser"):
        preflight_attachment_parser_install(archive_path, "1.13.0", config, template)

    fs, ld = FakeFs(), FakeLaunchd()
    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: True,
        verify_checksum=lambda _path: True,
        preflight=lambda version, tarball: preflight_attachment_parser_install(
            tarball, version, config, template
        ),
        prepare=lambda _version: pytest.fail("prepare must not run after preflight refusal"),
    )
    with pytest.raises(InstallError, match="managed_services\\.attachment-parser"):
        inst.install("1.13.0", archive_path)

    assert fs.installed == []
    assert ld.kicks == 0


def test_legacy_receipt_restores_recorded_image_not_current_image(tmp_path):
    old_image = "sha256:" + "4" * 64
    write_legacy_parser_receipt(tmp_path, "1.12.0", old_image)
    assert read_legacy_parser_receipt(tmp_path, "1.12.0") == old_image
    docker = FakeParserDocker("sentient/attachment-parser:release-new-rev", "sha256:" + "3" * 64)
    docker.images[old_image] = DockerImageIdentity(old_image, "legacy", "legacy-rev")
    previous_id = docker.images[PARSER_RUNTIME_IMAGE].image_id
    retained_ref = f"{PARSER_RETAINED_IMAGE_PREFIX}{previous_id[len('sha256:'):]}"

    pairing = prepare_legacy_attachment_parser(tmp_path, "1.12.0", "1.13.0", docker)

    assert docker.images[retained_ref].image_id == previous_id
    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == previous_id
    pairing.activate()

    assert docker.tags[-1] == (old_image, PARSER_RUNTIME_IMAGE)
    assert docker.tags[-1][0] != "sha256:" + "3" * 64
    pairing.restore()
    assert docker.tags[-1][0] == previous_id
    assert docker.images[PARSER_RUNTIME_IMAGE].image_id == previous_id


def test_legacy_receipt_refuses_pruned_image_without_guessing(tmp_path):
    old_image = "sha256:" + "4" * 64
    write_legacy_parser_receipt(tmp_path, "1.12.0", old_image)
    docker = FakeParserDocker("sentient/attachment-parser:release-new-rev", "sha256:" + "3" * 64)

    with pytest.raises(InstallError, match="prune.*current image"):
        prepare_legacy_attachment_parser(tmp_path, "1.12.0", "1.13.0", docker)


def test_installer_lock_refuses_concurrent_transition(tmp_path):
    path = tmp_path / ".setup-prod.lock"
    first = InstallerLock(path)
    second = InstallerLock(path)
    first.acquire()
    try:
        with pytest.raises(InstallError, match="concurrent transition"):
            second.acquire()
    finally:
        first.release()
    second.acquire()
    second.release()


def test_failed_parser_readiness_rolls_back_pairing_before_restart():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    events = []
    health = iter([(False, "attachment-parser not ready: container exited"), (True, None)])

    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: next(health),
        verify_checksum=lambda _path: True,
        prepare=lambda _version: events.append("prepare") or object(),
        activate=lambda _prepared: events.append("activate"),
        restore=lambda _prepared: events.append("restore"),
    )

    with pytest.raises(InstallError, match="attachment-parser not ready"):
        inst.install("1.13.0", "release.tar.gz")

    assert events == ["prepare", "activate", "restore"]
    assert fs.current == "1.12.0"
    assert ld.kicks == 2


def test_failed_health_restores_parser_pairing_before_restart(tmp_path):
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    events = []
    health = iter([False, True])

    def prepare(_version):
        events.append("prepare")
        return object()

    def activate(_prepared):
        events.append("activate")

    def restore(_prepared):
        events.append("restore")

    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: next(health),
        verify_checksum=lambda _path: True,
        prepare=prepare,
        activate=activate,
        restore=restore,
    )

    with pytest.raises(InstallError, match="rolled back to 1.12.0"):
        inst.install("1.13.0", "release.tar.gz")

    assert events == ["prepare", "activate", "restore"]
    assert fs.current == "1.12.0"
    assert ld.kicks == 2


def test_idempotent_healthy_reinstall_does_not_prepare_or_activate():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    events = []
    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: True,
        verify_checksum=lambda _path: True,
        prepare=lambda _version: events.append("prepare"),
        activate=lambda _prepared: events.append("activate"),
    )

    inst.install("1.13.0", "release.tar.gz")

    assert events == []
    assert ld.kicks == 0


def test_healthy_same_version_legacy_reinstall_is_noop(tmp_path):
    legacy = tmp_path / "releases/1.13.0"
    legacy.mkdir(parents=True)
    assert read_optional_attachment_parser_artifact(legacy) is None

    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: True,
        verify_checksum=lambda _path: True,
        repair=lambda _version: pytest.fail("healthy legacy reinstall must not repair"),
        prepare=lambda _version: pytest.fail("healthy legacy reinstall must not unpack"),
    )

    inst.install("1.13.0", "release.tar.gz")

    assert ld.kicks == 0


def test_same_version_pairing_repair_does_not_unpack_supplied_tarball():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    health = iter([False, True])
    events = []
    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: next(health),
        verify_checksum=lambda _path: True,
        repair=lambda version: events.append(f"repair:{version}") or object(),
        activate=lambda _prepared: events.append("activate"),
    )

    inst.install("1.13.0", "different-code-same-version.tar.gz")

    assert fs.installed == ["1.13.0"]
    assert events == ["repair:1.13.0", "activate"]
    assert ld.kicks == 1


def test_same_version_repair_failure_has_explicit_no_rollback_state():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    inst = Installer(
        fs=fs,
        launchd=ld,
        health=lambda: False,
        verify_checksum=lambda _path: True,
        repair=lambda _version: object(),
        activate=lambda _prepared: None,
    )

    with pytest.raises(InstallError, match="no distinct rollback target"):
        inst.install("1.13.0", "repair.tar.gz")

    assert fs.current == "1.13.0"
    assert ld.kicks == 1


def test_health_failure_rolls_back_to_previous_version():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    # health fails for the new version, succeeds once rolled back
    health = iter([False, True])
    inst = Installer(fs=fs, launchd=ld, health=lambda: next(health), verify_checksum=lambda p: True)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.current == "1.12.0", "must roll back to the previous version"
    assert ld.kicks == 2, "must restart once for the install and once for the rollback"


def test_rollback_verifies_health_after_reverting():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    # both the new version AND the rollback fail health
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")
    assert "rollback" in str(e.value).lower(), "a failed rollback must say so explicitly"


def test_bad_checksum_refuses_before_touching_anything():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: False)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.installed == [], "must not unpack an unverified tarball"
    assert fs.current == "1.12.0"
    assert ld.kicks == 0


def test_an_unverifiable_tarball_is_refused_even_when_it_matches_the_running_version():
    """The idempotency shortcut must not be reachable before the checksum gate.

    Found by the end-to-end harness: re-installing the CURRENT version from a
    tarball with a corrupt `.sha256` exited 0 and reported "live and healthy",
    because `previous == version and health()` returned before verification ran.
    Nothing malicious gets extracted on that path, but the operator handed us an
    artifact we could not verify and we reported success — so a corrupted release
    being re-deployed to repair a host looks like a good deploy.

    The invariant is the simple one: never report success on an artifact whose
    provenance we did not check.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True,
                     verify_checksum=lambda p: False)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="tampered.tar.gz")

    assert "checksum" in str(e.value).lower()
    assert ld.kicks == 0, "still must not bounce the service"


def test_reinstalling_the_running_version_is_a_noop():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: True)

    inst.install("1.13.0", tarball="x.tar.gz")

    assert ld.kicks == 0, "idempotent: a healthy identical install must not restart the service"


def test_a_release_that_fails_to_prepare_never_becomes_current():
    """Unpacking is not the whole release: the native services' venvs are built
    afterwards, from vendored wheels, and that can fail (a missing wheel, a
    wrong interpreter minor).

    If it does, `current` must still point at the working version. Flipping first
    and preparing second would hand launchd a release with no interpreter and
    turn a recoverable packaging error into an outage.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")

    def prepare(_version):
        raise InstallError("local-tts: vendored wheel missing")

    inst = Installer(fs=fs, launchd=ld, health=lambda: True,
                     verify_checksum=lambda p: True, prepare=prepare)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    assert "wheel" in str(e.value)
    assert fs.current == "1.12.0", "the working version must stay live"
    assert ld.kicks == 0, "must not restart into a half-built release"


def test_first_ever_install_failure_says_there_is_nothing_to_roll_back_to():
    fs, ld = FakeFs(), FakeLaunchd()  # no `current` — fresh mini
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    assert "no previous version" in str(e.value).lower()
    assert ld.kicks == 1, "must not kickstart a rollback that cannot happen"


def test_repairing_the_running_version_never_claims_a_rollback():
    """Re-installing the CURRENT version when it is already unhealthy.

    There is no distinct rollback target here — flipping `current` back to the
    same version would restart into the same broken build while reporting a
    successful rollback. The failure must name that instead.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    message = str(e.value).lower()
    assert "rolled back" not in message, "must not claim a rollback to itself"
    assert ld.kicks == 1, "one restart for the reinstall, no pointless rollback kick"


def test_rollback_target_missing_on_disk_is_reported_not_attempted():
    """`current` points at a version whose directory has been pruned away.

    Flipping the symlink at a directory that is not there leaves launchd with a
    dangling ProgramArguments path — a worse state than the failed install. The
    installer must refuse and say so.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")  # never added to fs.installed => not on disk
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    message = str(e.value).lower()
    assert "1.12.0" in message and "not on disk" in message
    assert fs.current == "1.13.0", "must not point `current` at a missing directory"
    assert ld.kicks == 1


def test_a_health_probe_that_raises_still_rolls_back():
    """A health check that BLOWS UP is "not verified", not "skip the rollback".

    The probe touches the filesystem (its TLS anchor) and the network, so it can
    raise. Before this was guarded, an absent anchor on a fresh host raised out
    of `install()` with `current` already flipped to the new version and zero
    rollback restarts — the exception took the rollback path with it.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    outcomes = iter([InstallError("TLS trust anchor /x/cert.pem not found"), True])

    def health():
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    inst = Installer(fs=fs, launchd=ld, health=health, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.current == "1.12.0", "an unverified release must not be left current"
    assert ld.kicks == 2, "must restart once for the install and once for the rollback"
    message = str(e.value)
    assert "rolled back to 1.12.0" in message
    assert "cert.pem" in message, "the operator must still see what broke the health check"


# --- checksum gate (supply-chain boundary) -----------------------------------
#
# `scripts/build-gateway.sh` writes the sidecar with
#   shasum -a 256 dist/gateway/<v>.tar.gz > dist/gateway/<v>.tar.gz.sha256
# which records the BUILD HOST's absolute path alongside the digest. `shasum -c`
# on the mini therefore checks a path that does not exist there. The digest is
# the only field that travels.


def _release(tmp_path, body=b"gateway release bytes"):
    tarball = tmp_path / "1.13.0.tar.gz"
    tarball.write_bytes(body)
    return tarball


def test_checksum_matches_despite_a_foreign_path_in_the_sidecar(tmp_path):
    tarball = _release(tmp_path)
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text(f"{digest}  /Users/builder/sentient/dist/gateway/1.13.0.tar.gz\n")

    assert verify_tarball_checksum(tarball, sidecar) is True


def test_checksum_mismatch_is_refused(tmp_path):
    tarball = _release(tmp_path)
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text(f"{'0' * 64}  1.13.0.tar.gz\n")

    assert verify_tarball_checksum(tarball, sidecar) is False


def test_missing_sidecar_fails_closed(tmp_path):
    """No sidecar means no provenance. It must never mean 'assume fine'."""
    tarball = _release(tmp_path)

    assert verify_tarball_checksum(tarball, tmp_path / "absent.sha256") is False


def test_malformed_sidecar_fails_closed(tmp_path):
    tarball = _release(tmp_path)
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text("not-a-digest\n")

    assert verify_tarball_checksum(tarball, sidecar) is False


# --- TLS health gate (security boundary) --------------------------------------
#
# The gateway serves HTTPS with a self-signed cert it mints into
# ~/.sentient/certs/cert.pem (CN=sentient, CA:TRUE, SAN localhost + 127.0.0.1 —
# verified on the live host). The probe pins THAT file as its trust anchor.
# `verify=False` is never an option: an installer is exactly the kind of script
# that gets copied to a target that is not loopback.


def _self_signed(tmp_path, san="DNS:localhost,IP:127.0.0.1"):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-keyout", str(key), "-out", str(cert), "-subj", "/CN=sentient",
         "-addext", f"subjectAltName={san}"],
        check=True, capture_output=True,
    )
    return cert


def test_health_probe_context_requires_verification_and_hostname_match(tmp_path):
    ctx = build_tls_context(_self_signed(tmp_path))

    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True


def test_health_probe_without_a_ca_bundle_fails_closed(tmp_path):
    """No trust anchor must mean 'refuse', never 'skip verification'."""
    with pytest.raises(InstallError) as e:
        build_tls_context(tmp_path / "absent.pem")

    assert "absent.pem" in str(e.value)


def test_tls_trust_failure_is_reported_not_retried(tmp_path):
    """A cert the probe cannot trust is a permanent condition.

    Burning the whole retry budget on it hides the cause behind a timeout, and
    the tempting "fix" for a timeout is to disable verification. Fail fast with
    the real reason instead.
    """
    calls = []

    def opener(request, timeout, context):
        calls.append(request)
        raise ssl.SSLCertVerificationError("certificate verify failed: self-signed certificate")

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=10,
        interval_seconds=0,
    )

    assert probe.wait() is False
    assert len(calls) == 1, "a trust failure must not be retried"
    assert "tls" in probe.last_reason.lower()


def test_health_probe_retries_while_the_gateway_is_still_booting(tmp_path):
    """launchd returns before the process is listening; the gate must wait."""
    attempts = iter([ConnectionRefusedError(), ConnectionRefusedError(), None])

    def opener(request, timeout, context):
        outcome = next(attempts)
        if outcome is not None:
            raise outcome
        return _FakeResponse(200)

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=5,
        interval_seconds=0,
    )

    assert probe.wait() is True


def test_health_probe_gives_up_within_its_budget(tmp_path):
    calls = []

    def opener(request, timeout, context):
        calls.append(request)
        raise ConnectionRefusedError()

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=4,
        interval_seconds=0,
    )

    assert probe.wait() is False
    assert len(calls) == 4, "bounded retry budget — never an unbounded wait"


def test_health_probe_waits_for_a_certificate_the_gateway_has_not_minted_yet(
    tmp_path, monkeypatch
):
    """The fresh-install race: the anchor does not exist when probing starts.

    `~/.sentient/certs/cert.pem` is minted by the gateway this installer just
    kickstarted, so on a genuinely fresh mini the FIRST probe of virtually every
    install finds no anchor. That is "not up yet", identical to a refused
    connection — not a misconfiguration to abort on.
    """
    anchor = tmp_path / "certs" / "cert.pem"
    minted = _self_signed(tmp_path)

    def mint_while_waiting(_seconds):
        anchor.parent.mkdir(parents=True, exist_ok=True)
        anchor.write_bytes(minted.read_bytes())

    monkeypatch.setattr(setup_prod.time, "sleep", mint_while_waiting)

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=anchor,
        opener=lambda request, timeout, context: _FakeResponse(200),
        attempts=5,
        interval_seconds=0,
    )

    assert probe.wait() is True, "must retry until the gateway mints its certificate"


def test_a_certificate_that_never_appears_fails_closed_within_the_budget(tmp_path):
    """Retrying a missing anchor must never become "give up and skip verification".

    The budget bounds the wait, `wait()` reports False, and the endpoint is never
    contacted without a trust context.
    """
    calls = []

    def opener(request, timeout, context):
        calls.append(request)
        return _FakeResponse(200)

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=tmp_path / "never-minted.pem",
        opener=opener,
        attempts=3,
        interval_seconds=0,
    )

    assert probe.wait() is False
    assert calls == [], "no request may be made without a verified trust anchor"
    assert "never-minted.pem" in probe.last_reason, "the reason must name the missing anchor"


# --- edge (443) probe generalization (HealthProbe reuse, not a second style) --
#
# HealthProbe now backs BOTH the 8888 probe (exact-200, hostname checked) and
# the edge probe (2xx/3xx, hostname check off — see build_tls_context's
# docstring for why a deliberate localhost-vs-DNS-name mismatch is not a
# verification weakening). These pin that generalization did not change the
# 8888 probe's original behavior and does give the edge probe what it needs.


def test_build_tls_context_can_disable_the_hostname_check_while_requiring_verification(tmp_path):
    """The edge probe dials `localhost` against a cert that may legitimately
    name a different DNS host (the mini's real acme.sh cert names
    sentient.dev32.io). check_hostname=False must never weaken CERT_REQUIRED —
    only the name check, never the chain check.
    """
    ctx = build_tls_context(_self_signed(tmp_path), check_hostname=False)

    assert ctx.verify_mode == ssl.CERT_REQUIRED, "chain verification must stay mandatory"
    assert ctx.check_hostname is False


def test_default_is_success_still_requires_exact_200(tmp_path):
    """Generalizing HealthProbe for the edge probe must not loosen the
    long-standing 8888 probe's exact-200 requirement to any 2xx/3xx."""
    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=lambda request, timeout, context: _FakeResponse(302),
        attempts=1,
        interval_seconds=0,
    )

    assert probe.wait() is False, "the 8888 probe must still reject a redirect"


def test_is_success_lets_the_edge_probe_accept_a_redirect(tmp_path):
    """The edge target's root path may legitimately redirect to a login route;
    a redirect through nginx already proves the proxy, the cert and the
    reverse-proxy hop all work."""
    probe = HealthProbe(
        url="https://localhost/",
        ca_bundle=_self_signed(tmp_path),
        opener=lambda request, timeout, context: _FakeResponse(302),
        attempts=1,
        interval_seconds=0,
        is_success=lambda status: 200 <= status < 400,
    )

    assert probe.wait() is True


# --- outward (443) cert resolution (mirrors phase-orchestrator.ts) -----------
#
# gateway/src/bootstrap/phase-orchestrator.ts:261-276 and
# gateway/src/config/startup-config.ts:190-200 pick the outward cert the exact
# same way: the operator's `inbound_proxy.cert_dir` wins when that path exists,
# else the gateway's own self-signed material. These pin the Python mirror
# against drifting from that TS logic — this file already carries one
# documented incident (CERT_RELATIVE's own comment) where a stale path silently
# failed the gate on every otherwise-healthy release.


def test_read_inbound_proxy_cert_dir_returns_none_when_unset(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("inbound_proxy:\n  cert_dir: null\n")

    assert read_inbound_proxy_cert_dir(config) is None


def test_read_inbound_proxy_cert_dir_returns_none_for_a_missing_file(tmp_path):
    assert read_inbound_proxy_cert_dir(tmp_path / "absent.yaml") is None


def test_read_inbound_proxy_cert_dir_reads_the_configured_path(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("inbound_proxy:\n  cert_dir: /some/acme/dir\n")

    assert read_inbound_proxy_cert_dir(config) == Path("/some/acme/dir")


def test_read_inbound_proxy_cert_dir_ignores_a_same_named_key_outside_the_section(tmp_path):
    """Only `inbound_proxy.cert_dir` counts. A de-indent to a new top-level key
    must reset section tracking, not leak a same-named key from elsewhere."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "tls:\n"
        "  cert_dir: /wrong/section\n"
        "inbound_proxy:\n"
        "  cert_dir: /right/section\n"
    )

    assert read_inbound_proxy_cert_dir(config) == Path("/right/section")


def test_resolve_outward_cert_falls_back_to_the_gateways_own_material_when_unset(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("inbound_proxy:\n  cert_dir: null\n")
    home = tmp_path / "home"

    cert, _reason, is_fallback = resolve_outward_cert(home, config)

    assert cert == home / STATE_ROOT / CERT_RELATIVE
    assert is_fallback is False, "an unset cert_dir is the ordinary default, not a misconfiguration"


def test_resolve_outward_cert_warns_and_falls_back_when_the_configured_dir_is_missing(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("inbound_proxy:\n  cert_dir: /does/not/exist\n")
    home = tmp_path / "home"

    cert, reason, is_fallback = resolve_outward_cert(home, config)

    assert cert == home / STATE_ROOT / CERT_RELATIVE
    assert is_fallback is True, "an explicitly configured but absent path is a real misconfiguration"
    assert "/does/not/exist" in reason


def test_resolve_outward_cert_pins_the_configured_dir_when_it_exists(tmp_path):
    real_dir = tmp_path / "acme"
    real_dir.mkdir()
    config = tmp_path / "config.yaml"
    config.write_text(f"inbound_proxy:\n  cert_dir: {real_dir}\n")
    home = tmp_path / "home"

    cert, _reason, is_fallback = resolve_outward_cert(home, config)

    assert cert == real_dir / "cert.pem"
    assert is_fallback is False


# --- user-owned state (data-loss + privilege boundary) ------------------------


def test_operator_config_is_never_clobbered(tmp_path):
    """The operator hand-edits config.yaml. Re-running the installer must not
    revert those edits — this has bitten before."""
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator:\n  model: template-default\n")
    cfg = home / ".sentient/gateway/config/config.yaml"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("orchestrator:\n  model: operator-tuned\n")

    ensure_state_dirs(home, template)
    ensure_state_dirs(home, template)  # idempotent: twice must be identical

    assert cfg.read_text() == "orchestrator:\n  model: operator-tuned\n"


def test_config_is_seeded_from_the_template_on_a_fresh_host(tmp_path):
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator:\n  model: template-default\n")

    ensure_state_dirs(home, template)

    assert (home / ".sentient/gateway/config/config.yaml").read_text() == template.read_text()


def test_secrets_are_not_readable_by_group_or_world(tmp_path):
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator: {}\n")
    ensure_state_dirs(home, template)
    keys = home / ".sentient/secrets/keys.yaml"
    keys.write_text("paseto: redacted\n")
    keys.chmod(0o644)

    ensure_state_dirs(home, template)

    assert stat.S_IMODE((home / ".sentient/secrets").stat().st_mode) == 0o700
    assert stat.S_IMODE(keys.stat().st_mode) == 0o600


def test_state_created_under_sudo_is_handed_back_to_the_operator(tmp_path):
    """The installer runs as root; the gateway runs as the operator.

    Anything root creates under ~/.sentient and forgets to chown is a directory
    the gateway cannot write at next boot — a failure that shows up hours later
    as a permission error, not here.
    """
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator: {}\n")
    chowned = []

    ensure_state_dirs(home, template, chown=chowned.append)

    created = {p for p in chowned}
    assert home / ".sentient" in created
    assert home / ".sentient/secrets" in created
    # The INTERMEDIATE level, not just the leaf. `mkdir(parents=True)` used to
    # create this one as an unreported side effect, leaving it root:wheel while
    # the daemon runs as the operator — and the gateway writes
    # internal-secrets.json, users.json and auth-secret.key straight into it,
    # so first boot died on EACCES and KeepAlive made it a crash loop.
    assert home / ".sentient/gateway" in created, "the intermediate level too"
    assert home / ".sentient/gateway/config" in created
    assert home / ".sentient/gateway/config/config.yaml" in created, "the seeded config too"


# --- release archive -> disk (untrusted-archive boundary + layout invariant) ---
#
# `scripts/build-gateway.sh` packs `tar -czf <v>.tar.gz -C dist/gateway <v>`, so
# the archive's single top-level directory IS the version. The filename is just
# a label an operator can rename or mistype; the archive is the fact.


def _release_tarball(tmp_path, version, members=()):
    """A tarball shaped exactly like `scripts/build-gateway.sh` emits."""
    staging = tmp_path / "staging"
    release = staging / version
    (release / "bin").mkdir(parents=True, exist_ok=True)
    (release / "bin/sentient-gateway").write_text("#!/bin/sh\nexit 0\n")
    (release / "share").mkdir(exist_ok=True)
    for name in members:
        member = release / name
        member.parent.mkdir(parents=True, exist_ok=True)
        member.write_text("x")
    tarball = tmp_path / f"{version}.tar.gz"
    # COPYFILE_DISABLE mirrors the real `dist/gateway/<v>.tar.gz`, which has zero
    # AppleDouble members (verified). Without it macOS tar emits a `._<name>`
    # sidecar for every xattr-bearing file, which is a DIFFERENT archive shape —
    # covered explicitly by test_applesingle_sidecars_do_not_hide_the_version.
    subprocess.run(
        ["tar", "-czf", str(tarball), "-C", str(staging), version],
        check=True, capture_output=True, env={**os.environ, "COPYFILE_DISABLE": "1"},
    )
    return tarball


def _rootless_runner(recorded):
    """Run `tar` for real; record the privileged calls instead of running them.

    The hardening commands need root. Recording them keeps the extraction path
    genuinely exercised while letting the layout invariants be verified without
    sudo — and lets the tests assert that hardening was actually requested.
    """
    def runner(argv, **kwargs):
        recorded.append(list(argv))
        if argv[0] == "tar":
            return subprocess.run(argv, **kwargs)
        return subprocess.CompletedProcess(argv, 0)
    return runner


def test_release_version_comes_from_the_archive_not_the_filename(tmp_path):
    tarball = _release_tarball(tmp_path, "1.13.0")
    renamed = tmp_path / "9.9.9.tar.gz"
    tarball.rename(renamed)

    assert read_release_version(renamed) == "1.13.0"


def test_applesingle_sidecars_do_not_hide_the_version(tmp_path):
    """A build host whose files carry xattrs makes macOS tar emit a `._<name>`
    AppleDouble sidecar beside every member.

    Today's `dist/gateway/<v>.tar.gz` happens to have none, but treating those
    sidecars as a second top-level directory would reject EVERY genuine release
    the day a build host starts adding xattrs — the same shape of bug as
    trusting the absolute path in the `.sha256` sidecar.
    """
    tarball = tmp_path / "1.13.0.tar.gz"
    payload = tmp_path / "sentient-gateway"
    payload.write_text("#!/bin/sh\nexit 0\n")
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(payload, arcname="1.13.0/bin/sentient-gateway")
        archive.add(payload, arcname="._1.13.0")
        archive.add(payload, arcname="1.13.0/bin/._sentient-gateway")

    assert read_release_version(tarball) == "1.13.0"


def test_a_tarball_disagreeing_with_the_requested_version_is_refused(tmp_path):
    """The failure this prevents: unpacking `1.13.0/` but pointing `current` at
    `9.9.9/`, leaving launchd exec'ing a path that does not exist."""
    tarball = _release_tarball(tmp_path, "1.13.0")
    fs = RealFs(tmp_path / "opt", runner=_rootless_runner([]))

    with pytest.raises(InstallError) as e:
        fs.unpack("9.9.9", tarball)

    assert "1.13.0" in str(e.value) and "9.9.9" in str(e.value)


def test_an_archive_escaping_the_release_root_is_refused(tmp_path):
    """A member outside `<version>/` writes over arbitrary paths as root."""
    payload = tmp_path / "evil"
    payload.write_text("pwned")
    tarball = tmp_path / "1.13.0.tar.gz"
    # Written with tarfile, not `tar`: bsdtar normalises `../` out of member
    # names, so shelling out would silently build a BENIGN archive and the
    # test would pass without ever exercising the guard.
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(payload, arcname="../../etc/evil")

    with pytest.raises(InstallError) as e:
        read_release_version(tarball)

    assert "escape" in str(e.value).lower() or "outside" in str(e.value).lower()


def test_unpack_lays_down_a_runnable_release_then_harden_release_locks_it(tmp_path):
    """CODE IS ROOT-OWNED: unpack extracts writable, then harden_release makes
    it read-only AFTER staging — staging writes into the release dir, so
    hardening must come last, not at unpack time."""
    tarball = _release_tarball(tmp_path, "1.13.0")
    opt = tmp_path / "opt"
    recorded = []
    fs = RealFs(opt, runner=_rootless_runner(recorded))

    fs.unpack("1.13.0", tarball)

    assert (opt / "releases" / "1.13.0" / "bin" / "sentient-gateway").is_file()
    assert fs.has_version("1.13.0") is True
    # unpack does NOT harden — release is still writable
    assert not [argv for argv in recorded if argv[0] in ("chown", "chmod")], \
        "unpack must not harden (staging writes after unpack)"

    fs.harden_release("1.13.0")
    hardening = [argv for argv in recorded if argv[0] == "chown"]
    assert hardening, "harden_release must chown the release"
    assert "root:wheel" in hardening[0]


def test_current_survives_a_tmp_symlink_left_by_a_crashed_run(tmp_path):
    """`current` must never be absent, and a half-finished previous run must not
    wedge the installer — that would turn a retry into an outage."""
    opt = tmp_path / "opt"
    releases = opt / "releases"
    releases.mkdir(parents=True)
    (releases / "1.12.0").mkdir(parents=True)
    (releases / "1.13.0").mkdir(parents=True)
    fs = RealFs(opt, runner=_rootless_runner([]))
    fs.point_current_at("1.12.0")
    (opt / ".current.tmp").symlink_to(releases / "1.12.0")  # crashed mid-swap

    fs.point_current_at("1.13.0")

    assert fs.current == "1.13.0"
    assert (opt / "current").is_symlink()


# --- launchd (privilege boundary + fresh-install ordering) ---------------------
#
# The real plist is `deploy/mac-prod/io.sentient.gateway.plist`, owned by the
# native-cutover task. These tests use a synthetic plist of the same shape so
# the substitution and load ordering are pinned independently of that file.

SYNTHETIC_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>io.sentient.gateway</string>
<key>UserName</key><string>OPERATOR</string>
<key>GATEWAY_CONFIG_PATH</key><string>/Users/OPERATOR/.sentient/gateway/config/config.yaml</string>
<key>StandardOutPath</key><string>/Users/OPERATOR/.sentient/gateway/logs/stdout.log</string>
</dict></plist>
"""


def _recording_runner(recorded, fails=()):
    """Capture argv; fail the subcommands named in `fails`."""
    def runner(argv, **kwargs):
        recorded.append(list(argv))
        if len(argv) > 1 and argv[1] in fails:
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)
    return runner


def test_the_daemon_user_is_never_root():
    """The plist's UserName comes from here.

    If it resolved to `root` the gateway would run privileged and could rewrite
    its own binary under /opt — which is the exact invariant the root-owned code
    tree exists to enforce. Guessing an operator is worse than refusing.
    """
    assert resolve_operator({"SUDO_USER": "kevinye"}) == "kevinye"

    for hostile in ({}, {"SUDO_USER": ""}, {"SUDO_USER": "root"}):
        with pytest.raises(InstallError) as e:
            resolve_operator(hostile)
        assert "operator" in str(e.value).lower()


def test_installing_the_plist_leaves_no_operator_placeholder(tmp_path):
    """A surviving `OPERATOR` is not a cosmetic defect: UserName would name a
    user that does not exist, and GATEWAY_CONFIG_PATH would point at
    /Users/OPERATOR/... so the gateway would boot against no config."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded))

    ld.install_plist()

    installed = (daemons / "io.sentient.gateway.plist").read_text()
    assert "OPERATOR" not in installed
    assert installed.count("kevinye") == 3, "UserName and both /Users paths"
    assert ["chown", "root:wheel", str(daemons / "io.sentient.gateway.plist")] in recorded
    assert stat.S_IMODE((daemons / "io.sentient.gateway.plist").stat().st_mode) == 0o644


def test_kickstart_bootstraps_an_unloaded_job_before_restarting_it(tmp_path):
    """On a fresh mini the job is not in the system domain yet, and
    `launchctl kickstart` on an unloaded label FAILS — so the very first install
    would die here if it did not bootstrap first."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded, fails=("print",)))

    ld.kickstart()

    subcommands = [argv[1] for argv in recorded if argv[0] == "launchctl"]
    assert subcommands == ["print", "bootstrap"], "bootstrap replaces the kickstart"


def test_kickstart_restarts_an_already_loaded_job(tmp_path):
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded))

    ld.kickstart()

    launchctl = [argv for argv in recorded if argv[0] == "launchctl"]
    assert [argv[1] for argv in launchctl] == ["print", "kickstart"]
    assert "-k" in launchctl[-1], "must restart, not no-op on an already-running job"


# --- native python services (cross-process layout contract) --------------------
#
# `gateway/config.yaml` spawns these directly:
#   exec:  ["${SENTIENT_CODE}/whisper-stt/venv/bin/python", "-m", "whisper_stt"]
#   env:   PYTHONPATH: "${SENTIENT_CODE}/whisper-stt/src"
# with SENTIENT_CODE=<release_root>/current. The installer is the only thing that
# puts those paths on disk, and `scripts/build-gateway.sh` stages ONLY bin/ and
# share/ — so if these two sides drift, both native services fail at every boot
# with ModuleNotFoundError or a missing interpreter.

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_release_layout_matches_the_native_exec_contract():
    """Bind the installer's layout to the config that consumes it."""
    config = (REPO_ROOT / "gateway/config.yaml").read_text()

    for service, spec in SERVICE_SOURCES.items():
        assert f"${{SENTIENT_CODE}}/{service}/venv/bin/python" in config, service
        assert f"${{SENTIENT_CODE}}/{service}/src" in config, service
        assert f'"-m", "{spec["module"]}"' in config, service


def test_the_health_anchor_is_where_the_gateway_actually_mints_its_cert():
    """Bind the pinned trust anchor to the daemon definition that places it.

    The gateway resolves its certs dir as `GATEWAY_CERTS_DIR ?? ~/.sentient/
    gateway/certs` (gateway/src/config/startup-config.ts) and the plist sets
    that variable explicitly, so the plist IS the deployed location. When this
    constant still named the container-era `~/.sentient/certs`, every install
    of a perfectly healthy release burned the full 90 s health budget on an
    anchor nothing would ever write, then failed with no rollback target.
    """
    certs_dir = Path(CERT_RELATIVE).parent.as_posix()
    plist = (REPO_ROOT / PLIST_SOURCE).read_text()

    assert f"/Users/{OPERATOR_PLACEHOLDER}/{STATE_ROOT}/{certs_dir}<" in plist
    assert certs_dir in STATE_DIRS, "ensure_state_dirs must create the anchor's parent"


def test_the_staged_src_tree_actually_contains_the_module_it_runs(tmp_path):
    """PYTHONPATH points at `<release>/<svc>/src`, and the service is started with
    `-m <module>`. Copying one directory level too high (the service root instead
    of its `src/`) leaves PYTHONPATH valid but the module unimportable — a boot
    failure that looks nothing like a packaging mistake."""
    repo = tmp_path / "repo"
    for spec in SERVICE_SOURCES.values():
        module = repo / spec["src"] / spec["module"]
        module.mkdir(parents=True)
        (module / "__init__.py").write_text("")
        (module / "__pycache__").mkdir()
        (module / "__pycache__/stale.pyc").write_text("stale")
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")
    release = tmp_path / "opt/1.13.0"
    recorded = []

    stage_native_services(repo, release, wheels_root=repo / "dist/wheels",
                          runner=_recording_runner(recorded))

    for service, spec in SERVICE_SOURCES.items():
        staged = release / service / "src"
        assert (staged / spec["module"] / "__init__.py").is_file(), service
        assert not (staged / spec["module"] / "__pycache__").exists(), "no stale bytecode"


def test_staging_installs_each_venv_from_vendored_wheels(tmp_path):
    """The venv must come from the offline helper with a per-service wheels dir —
    nothing may fetch at deploy time."""
    repo = tmp_path / "repo"
    for spec in SERVICE_SOURCES.values():
        (repo / spec["src"] / spec["module"]).mkdir(parents=True)
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")
    release = tmp_path / "opt/1.13.0"
    wheels = repo / "dist/wheels"
    recorded = []

    stage_native_services(repo, release, wheels_root=wheels,
                          runner=_recording_runner(recorded))

    for service in SERVICE_SOURCES:
        assert [
            str(installer), service,
            str(release / service / "venv"), str(wheels / service),
        ] in recorded, service


def test_staging_prefers_the_self_contained_release_payload(tmp_path):
    """A release archive must be sufficient to install: no second wheel/source
    transfer from the build checkout is allowed."""
    repo = tmp_path / "repo"
    # Deliberately do not create repo service sources or its install helper.
    release = tmp_path / "release"
    release.mkdir()
    helper = release / RELEASE_INSTALL_VENV
    helper.write_text("#!/bin/sh\nexit 0\n")
    recorded = []

    for service, spec in SERVICE_SOURCES.items():
        module = release / RELEASE_NATIVE_SOURCES_DIR / service / spec["module"]
        module.mkdir(parents=True)
        (module / "__init__.py").write_text("")
        (release / RELEASE_WHEELS_DIR / service).mkdir(parents=True)
        requirements = release / RELEASE_REQUIREMENTS_DIR
        requirements.mkdir(exist_ok=True)
        (requirements / f"{service}.lock").write_text("# pinned\n")

    stage_native_services(
        repo, release, wheels_root=release / RELEASE_WHEELS_DIR,
        runner=_recording_runner(recorded),
    )

    for service, spec in SERVICE_SOURCES.items():
        assert (release / service / "src" / spec["module"] / "__init__.py").is_file()
        assert [
            str(helper), service,
            str(release / service / "venv"), str(release / RELEASE_WHEELS_DIR / service),
        ] in recorded, service


def test_staging_rejects_a_self_contained_payload_without_pinned_locks(tmp_path):
    repo = tmp_path / "repo"
    release = tmp_path / "release"
    release.mkdir()
    (release / RELEASE_INSTALL_VENV).write_text("#!/bin/sh\nexit 0\n")
    for service, spec in SERVICE_SOURCES.items():
        (release / RELEASE_NATIVE_SOURCES_DIR / service / spec["module"]).mkdir(parents=True)
        (release / RELEASE_WHEELS_DIR / service).mkdir(parents=True)

    with pytest.raises(InstallError, match="requirements/whisper-stt.lock"):
        stage_native_services(
            repo, release, wheels_root=release / RELEASE_WHEELS_DIR,
            runner=_recording_runner([]),
        )


def test_staging_refuses_a_release_missing_its_service_source(tmp_path):
    """Fail here, loudly, rather than producing a release whose native services
    cannot start."""
    repo = tmp_path / "repo"
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")

    with pytest.raises(InstallError) as e:
        stage_native_services(repo, tmp_path / "opt/1.13.0",
                              wheels_root=repo / "dist/wheels",
                              runner=_recording_runner([]))

    assert "whisper-stt" in str(e.value) or "local-tts" in str(e.value)


# --- pruning (must never delete what rollback depends on) ----------------------


def _releases(opt, *versions):
    """Create release dirs with strictly increasing mtimes (install order)."""
    opt.mkdir(parents=True, exist_ok=True)
    releases_dir = opt / "releases"
    releases_dir.mkdir(exist_ok=True)
    for index, version in enumerate(versions):
        release = releases_dir / version
        release.mkdir()
        (release / "bin").mkdir()
        os.utime(release, (index + 1, index + 1))
    return RealFs(opt, runner=_rootless_runner([]))


def test_prune_keeps_the_most_recent_releases_and_removes_the_rest(tmp_path):
    opt = tmp_path / "opt"
    fs = _releases(opt, "1.10.0", "1.11.0", "1.12.0", "1.13.0")
    fs.point_current_at("1.13.0")

    fs.prune(keep=2)

    releases_dir = opt / "releases"
    assert sorted(p.name for p in releases_dir.iterdir()) == ["1.12.0", "1.13.0"]


def test_prune_never_removes_the_current_release(tmp_path):
    """`current` is what launchd execs. Removing it is an outage, and mtime order
    does not protect it — an operator who reinstalls an OLDER build to roll
    forward-fix leaves `current` pointing at the oldest directory on disk."""
    opt = tmp_path / "opt"
    fs = _releases(opt, "1.10.0", "1.11.0", "1.12.0", "1.13.0")
    fs.point_current_at("1.10.0")  # oldest mtime, yet it is the live one

    fs.prune(keep=1)

    assert fs.has_version("1.10.0") is True
    assert fs.current == "1.10.0"


def test_prune_never_removes_the_rollback_target(tmp_path):
    """Pruning the previous version is what turns a failed upgrade into a
    manual-intervention outage — the installer refuses to roll back to a version
    that is not on disk."""
    opt = tmp_path / "opt"
    fs = _releases(opt, "1.11.0", "1.12.0", "1.13.0")
    fs.point_current_at("1.13.0")

    fs.prune(keep=1, protect=("1.12.0",))

    assert fs.has_version("1.12.0") is True


def test_prune_does_not_mistake_the_current_symlink_for_a_release(tmp_path):
    """`current` lives in the same directory and resolves as a dir.

    Treating it as a release would `rmtree` through the symlink and delete the
    live release's contents — the worst possible outcome of a cleanup step.
    """
    opt = tmp_path / "opt"
    fs = _releases(opt, "1.13.0")
    fs.point_current_at("1.13.0")

    fs.prune(keep=1)

    assert (opt / "current").is_symlink()
    assert (opt / "releases" / "1.13.0" / "bin").is_dir(), "must not have deleted through the symlink"


def test_gui_prune_removes_hardened_release_without_unhardening_retained_versions(tmp_path):
    """GUI releases are operator-owned but recursively a-w after staging.

    Pruning must restore write permission only on an obsolete release before
    deleting nested native-service venvs. The live and rollback releases remain
    immutable throughout cleanup.
    """
    policy = setup_prod.DomainPolicy(
        setup_prod.DOMAIN_GUI, "operator", tmp_path / "home"
    )
    fs = RealFs(policy.release_root, domain_policy=policy)
    versions = ("1.13.1", "1.14.1", "1.15.0")

    for index, version in enumerate(versions):
        release = fs.release_dir(version)
        (release / "bin").mkdir(parents=True)
        (release / "bin" / "sentient-gateway").write_text("binary")
        if version == "1.13.1":
            mlx_lm = (
                release / "deep-memory" / "venv" / "lib" /
                "python3.14" / "site-packages" / "mlx_lm"
            )
            mlx_lm.mkdir(parents=True)
            (mlx_lm / "__init__.py").write_text("")
        os.utime(release, (index + 1, index + 1))
        fs.harden_release(version)

    fs.point_current_at("1.15.0")

    try:
        fs.prune(keep=1, protect=("1.14.1",))

        assert fs.has_version("1.13.1") is False
        for retained in ("1.14.1", "1.15.0"):
            mode = fs.release_dir(retained).stat().st_mode
            assert mode & stat.S_IWUSR == 0
        assert fs.current == "1.15.0"
    finally:
        if policy.release_root.exists():
            subprocess.run(
                ["chmod", "-R", "u+w", str(policy.release_root)], check=False
            )


# --- domain flag (gui vs system) -----------------------------------------------
#
# `--domain gui` (default) installs a LaunchAgent in ~/Library/LaunchAgents,
# operator-owned, with code-immutability via chmod a-w. `--domain system` is the
# original headless-server path: root-owned LaunchDaemon in
# /Library/LaunchDaemons. The plist content is identical across domains.

from setup_prod import (
    DOMAIN_GUI,
    DOMAIN_SYSTEM,
    DEFAULT_DOMAIN,
    DomainPolicy,
    OPT,
    launchd_dir_for,
    launchd_domain_target,
)


def test_default_domain_is_gui():
    """The default is gui — the common case is a desktop mini, no sudo needed."""
    assert DEFAULT_DOMAIN == DOMAIN_GUI


def test_launchd_dir_for_gui_uses_home_library_launchagents(tmp_path):
    home = tmp_path / "home"
    assert launchd_dir_for(DOMAIN_GUI, home) == home / "Library" / "LaunchAgents"


def test_launchd_dir_for_system_uses_library_launchdaemons(tmp_path):
    assert launchd_dir_for(DOMAIN_SYSTEM, tmp_path) == Path("/Library/LaunchDaemons")


def test_launchd_domain_target_system_is_literal():
    assert launchd_domain_target(DOMAIN_SYSTEM) == "system"


def test_launchd_domain_target_gui_includes_uid():
    target = launchd_domain_target(DOMAIN_GUI, uid=501)
    assert target == "gui/501"


def test_gui_domain_policy_does_not_chown_plist(tmp_path):
    """gui: the operator owns the plist — no chown root:wheel."""
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", tmp_path / "home")
    assert policy.plist_owner is None
    assert policy.requires_root() is False


def test_system_domain_policy_chowns_plist_root(tmp_path):
    """system: the plist is root-owned — anyone who can write it chooses what
    root launches at boot."""
    policy = DomainPolicy(DOMAIN_SYSTEM, "kevinye", tmp_path / "home")
    assert policy.plist_owner == "root:wheel"
    assert policy.requires_root() is True


def test_gui_domain_harden_code_uses_chmod_a_w_not_chown(tmp_path):
    """gui: chmod a-w (operator owns the tree, but nobody can write it)."""
    release = tmp_path / "release"
    release.mkdir()
    (release / "bin").mkdir()
    recorded = []

    policy = DomainPolicy(DOMAIN_GUI, "kevinye", tmp_path / "home")
    policy.harden_code(_recording_runner(recorded), release)

    # gui mode uses chmod a-w, NOT chown root:wheel
    chown_calls = [argv for argv in recorded if argv[0] == "chown"]
    chmod_calls = [argv for argv in recorded if argv[0] == "chmod"]
    assert chown_calls == [], "gui mode must not chown the release tree"
    assert chmod_calls, "gui mode must chmod the release tree"
    assert chmod_calls[0] == ["chmod", "-R", "a-w", str(release)]


def test_system_domain_harden_code_chowns_root_and_chmods(tmp_path):
    """system: chown root:wheel + chmod 755 — the original hardening."""
    release = tmp_path / "release"
    release.mkdir()
    (release / "bin").mkdir()
    recorded = []

    policy = DomainPolicy(DOMAIN_SYSTEM, "kevinye", tmp_path / "home")
    policy.harden_code(_recording_runner(recorded), release)

    chown_calls = [argv for argv in recorded if argv[0] == "chown"]
    chmod_calls = [argv for argv in recorded if argv[0] == "chmod"]
    assert chown_calls, "system mode must chown the release tree"
    assert chown_calls[0] == ["chown", "-R", "root:wheel", str(release)]
    assert chmod_calls, "system mode must chmod the release tree"
    assert chmod_calls[0] == ["chmod", "-R", "755", str(release)]


def test_gui_domain_install_plist_does_not_chown(tmp_path):
    """gui: installing the plist leaves it operator-owned, just sets the mode."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    agents = tmp_path / "Library/LaunchAgents"
    agents.mkdir(parents=True)
    recorded = []
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=agents,
                     runner=_recording_runner(recorded), domain_policy=policy)

    ld.install_plist()

    installed = (agents / "io.sentient.gateway.plist").read_text()
    assert "OPERATOR" not in installed
    assert "kevinye" in installed
    chown_calls = [argv for argv in recorded if argv[0] == "chown"]
    assert chown_calls == [], "gui mode must not chown the plist"
    assert stat.S_IMODE((agents / "io.sentient.gateway.plist").stat().st_mode) == 0o644


def test_system_domain_install_plist_chowns_root(tmp_path):
    """system: installing the plist chowns root:wheel — the original behavior."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_SYSTEM, "kevinye", home)
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded), domain_policy=policy)

    ld.install_plist()

    assert ["chown", "root:wheel", str(daemons / "io.sentient.gateway.plist")] in recorded
    assert stat.S_IMODE((daemons / "io.sentient.gateway.plist").stat().st_mode) == 0o644


def test_gui_domain_kickstart_uses_gui_uid_target(tmp_path):
    """gui: launchctl bootstrap/kickstart targets gui/<uid>, not system."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    agents = tmp_path / "Library/LaunchAgents"
    agents.mkdir(parents=True)
    recorded = []
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=agents,
                     runner=_recording_runner(recorded, fails=("print",)),
                     domain_policy=policy)

    ld.kickstart()

    launchctl = [argv for argv in recorded if argv[0] == "launchctl"]
    bootstrap = [argv for argv in launchctl if argv[1] == "bootstrap"]
    assert bootstrap, "must bootstrap an unloaded job"
    assert bootstrap[0][2].startswith("gui/"), f"gui domain must target gui/<uid>, got {bootstrap[0][2]}"


def test_gui_domain_harden_release_uses_chmod_a_w(tmp_path):
    """gui: harden_release (not unpack) hardens with chmod a-w, not chown root:wheel.

    The release extracts to ~/.sentient/gateway/releases/<version>/ (operator-
    writable), NOT /opt/sentient/ — which the operator cannot write to without sudo.
    """
    tarball = _release_tarball(tmp_path, "1.13.0")
    home = tmp_path / "home"
    recorded = []
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    release_root = policy.release_root  # ~/.sentient/gateway
    fs = RealFs(release_root, runner=_rootless_runner(recorded), domain_policy=policy)

    fs.unpack("1.13.0", tarball)

    # Release is under <release_root>/releases/<version>/, NOT /opt/sentient/
    release_dir = release_root / "releases" / "1.13.0"
    assert release_dir.is_dir(), "release must extract under releases/ subdir"
    assert (release_dir / "bin" / "sentient-gateway").is_file()
    assert "/opt/sentient" not in str(release_dir), "gui must not write to /opt/sentient"

    # unpack does NOT harden
    assert not [argv for argv in recorded if argv[0] in ("chown", "chmod")], \
        "unpack must not harden in gui mode either"

    fs.harden_release("1.13.0")
    chown_calls = [argv for argv in recorded if argv[0] == "chown"]
    chmod_calls = [argv for argv in recorded if argv[0] == "chmod"]
    assert chown_calls == [], "gui mode must not chown the release"
    assert ["chmod", "-R", "a-w", str(release_dir)] in chmod_calls


def test_system_domain_harden_release_chowns_root(tmp_path):
    """system: harden_release (not unpack) chowns root:wheel — unchanged behavior,
    just moved after staging so the release is writable during native service setup.

    The release extracts to <release_root>/releases/<version>/, where
    release_root defaults to /opt/sentient for system domain.
    """
    tarball = _release_tarball(tmp_path, "1.13.0")
    opt = tmp_path / "opt"
    recorded = []
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_SYSTEM, "kevinye", home)
    fs = RealFs(opt, runner=_rootless_runner(recorded), domain_policy=policy)

    fs.unpack("1.13.0", tarball)

    assert (opt / "releases" / "1.13.0" / "bin" / "sentient-gateway").is_file()
    # unpack does NOT harden
    assert not [argv for argv in recorded if argv[0] in ("chown", "chmod")], \
        "unpack must not harden in system mode either"

    fs.harden_release("1.13.0")
    chown_calls = [argv for argv in recorded if argv[0] == "chown"]
    assert chown_calls, "system mode must chown the release"
    assert "root:wheel" in chown_calls[0]


def test_resolve_operator_gui_uses_user_not_sudo_user():
    """gui: the script runs as the operator (no sudo), so $USER is the operator."""
    assert resolve_operator({"USER": "kevinye"}, DOMAIN_GUI) == "kevinye"

    for hostile in ({}, {"USER": ""}, {"USER": "root"}):
        with pytest.raises(InstallError) as e:
            resolve_operator(hostile, DOMAIN_GUI)
        assert "operator" in str(e.value).lower()


def test_resolve_operator_system_uses_sudo_user():
    """system: the script runs under sudo, so $SUDO_USER names the operator."""
    assert resolve_operator({"SUDO_USER": "kevinye"}, DOMAIN_SYSTEM) == "kevinye"


# --- release root per domain (the bug this fixes) -----------------------------
#
# gui mode (no sudo) cannot write to /opt/sentient — the release root must be
# operator-writable. system mode stays at /opt/sentient (root-owned, unchanged).


def test_system_domain_release_root_is_opt_sentient():
    """system: release root is /opt/sentient — unchanged from the original design."""
    policy = DomainPolicy(DOMAIN_SYSTEM, "kevinye", Path("/Users/kevinye"))
    assert policy.release_root == OPT


def test_gui_domain_release_root_is_sentient_gateway():
    """gui: release root is ~/.sentient/gateway — operator-writable, already
    where state lives. NOT /opt/sentient, which the operator cannot write to
    without sudo."""
    home = Path("/Users/kevinye")
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    assert policy.release_root == home / STATE_ROOT / "gateway"
    assert policy.release_root != OPT


def test_gui_domain_current_symlink_lives_at_release_root_not_opt(tmp_path):
    """gui: the `current` symlink and `releases/` live under ~/.sentient/gateway,
    not /opt/sentient. This is the fix for the Permission denied bug."""
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    release_root = policy.release_root

    # Simulate an install: create releases/1.13.0 and point current at it.
    releases_dir = release_root / RELEASES_SUBDIR
    releases_dir.mkdir(parents=True)
    (releases_dir / "1.13.0").mkdir()
    fs = RealFs(release_root, runner=_rootless_runner([]), domain_policy=policy)
    fs.point_current_at("1.13.0")

    assert fs.current == "1.13.0"
    assert (release_root / "current").is_symlink()
    # The symlink resolves into releases/, NOT /opt/sentient
    target = Path(os.readlink(release_root / "current"))
    assert RELEASES_SUBDIR in target.parts
    assert "1.13.0" in target.parts


def test_realfs_release_dir_uses_releases_subdir(tmp_path):
    """release_dir(version) returns <release_root>/releases/<version>."""
    opt = tmp_path / "opt"
    fs = RealFs(opt, runner=_rootless_runner([]))
    assert fs.release_dir("1.13.0") == opt / RELEASES_SUBDIR / "1.13.0"


# --- RELEASE_ROOT plist substitution ------------------------------------------


PLIST_WITH_RELEASE_ROOT = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>io.sentient.gateway</string>
<key>ProgramArguments</key><array>
<string>RELEASE_ROOT/current/bin/sentient-gateway</string>
</array>
<key>UserName</key><string>OPERATOR</string>
<key>EnvironmentVariables</key><dict>
<key>GATEWAY_RUNTIME_DIR</key><string>RELEASE_ROOT/current/share</string>
<key>SENTIENT_CODE</key><string>RELEASE_ROOT/current</string>
</dict>
</dict></plist>
"""


def test_install_plist_substitutes_release_root(tmp_path):
    """The plist's RELEASE_ROOT placeholders are substituted at install time —
    system gets /opt/sentient, gui gets ~/.sentient/gateway."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(PLIST_WITH_RELEASE_ROOT)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    release_root = Path("/opt/sentient")

    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner([]), release_root=release_root)
    ld.install_plist()

    installed = (daemons / "io.sentient.gateway.plist").read_text()
    assert RELEASE_ROOT_PLACEHOLDER not in installed
    assert "/opt/sentient/current/bin/sentient-gateway" in installed
    assert "/opt/sentient/current/share" in installed
    assert "/opt/sentient/current" in installed


def test_install_plist_substitutes_release_root_for_gui(tmp_path):
    """gui domain: RELEASE_ROOT becomes ~/.sentient/gateway — the user-writable
    path, not /opt/sentient."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(PLIST_WITH_RELEASE_ROOT)
    agents = tmp_path / "Library/LaunchAgents"
    agents.mkdir(parents=True)
    home = tmp_path / "home"
    policy = DomainPolicy(DOMAIN_GUI, "kevinye", home)
    release_root = policy.release_root

    ld = RealLaunchd(source, operator="kevinye", daemon_dir=agents,
                     runner=_recording_runner([]), domain_policy=policy,
                     release_root=release_root)
    ld.install_plist()

    installed = (agents / "io.sentient.gateway.plist").read_text()
    assert RELEASE_ROOT_PLACEHOLDER not in installed
    assert "/opt/sentient" not in installed, "gui plist must not reference /opt/sentient"
    expected = str(release_root / "current" / "bin" / "sentient-gateway")
    assert expected in installed


def test_install_plist_refuses_a_surviving_release_root_placeholder(tmp_path):
    """If RELEASE_ROOT is not substituted (e.g. release_root not passed), the
    plist must not be installed — a surviving placeholder would make launchd
    exec a path that literally contains 'RELEASE_ROOT'."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(PLIST_WITH_RELEASE_ROOT)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()

    # No release_root passed — placeholder survives
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner([]))

    with pytest.raises(InstallError) as e:
        ld.install_plist()

    assert "RELEASE_ROOT" in str(e.value)
