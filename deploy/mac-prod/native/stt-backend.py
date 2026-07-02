"""Switch the gateway's STT backend in a gateway config.yaml (comment-preserving).

native-whisper:
  - remove managed_services.stt-service   (orchestrator won't manage a container)
  - stt.url                    -> ws://host.docker.internal:8768
  - companions.stt_health_url  -> http://host.docker.internal:8769/health
docker-sensevoice:
  - stt.url                    -> ws://sentient-stt-service:8766
  - companions.stt_health_url  -> http://sentient-stt-service:8767/health
  - re-add managed_services.stt-service (canonical block) if it was removed,
    so a native-whisper -> docker-sensevoice migration is fully reversible

Dry-run by default (prints a unified diff). Pass --apply to write.

Usage:
  python stt-backend.py --backend native-whisper --config ~/.sentient/gateway/config.yaml
  python stt-backend.py --backend native-whisper --config ~/.sentient/gateway/config.yaml --apply
"""

from __future__ import annotations

import argparse
import difflib
import io
import sys
from pathlib import Path

NATIVE = "native-whisper"
DOCKER = "docker-sensevoice"

URLS = {
    NATIVE: ("ws://host.docker.internal:8768", "http://host.docker.internal:8769/health"),
    DOCKER: ("ws://sentient-stt-service:8766", "http://sentient-stt-service:8767/health"),
}

# Canonical managed_services.stt-service block — the SenseVoice sibling the
# orchestrator spawns for the docker backend. MUST stay in sync with the seed
# gateway/config.yaml. Kept as a YAML snippet (not a dict) so ruamel emits it
# with the same flow-list style as the rest of the config, keeping the diff
# surgical when re-adding it on a native -> docker migration.
STT_SERVICE_SNIPPET = """\
stt-service:
  template: stt-service.yaml
  allowed_images: ["sentient/stt-service:local"]
  networks: ["sentient-internal"]
  healthcheck:
    url: "http://sentient-stt-service:8767/health"
    timeout_ms: 60000
  depends_on: []
  optional: false
"""


def _load_yaml():
    # ruamel's default round-trip loader (typ="rt") is SAFE: unlike PyYAML's
    # yaml.load(), it does NOT construct arbitrary Python from !!python/object
    # tags (only ruamel typ="unsafe" would). Input here is the operator's own
    # local gateway config, and round-trip mode is required to preserve comments.
    try:
        from ruamel.yaml import YAML
    except ImportError:
        print("ruamel.yaml required: pip install ruamel.yaml", file=sys.stderr)
        sys.exit(2)
    y = YAML()  # typ="rt" (round-trip) — comment-preserving, no arbitrary-object construction
    y.preserve_quotes = True
    # Match the gateway config's block style so the diff stays surgical: dashes
    # sit at parent+2, sequence content at parent+4 (ruamel's default of
    # sequence=2/offset=0 would re-indent every unrelated list). A wide line
    # limit stops ruamel from re-wrapping long inline (flow) lists.
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 4096
    return y


def transform(backend: str, text: str) -> str:
    yaml = _load_yaml()
    doc = yaml.load(text)
    stt_url, health_url = URLS[backend]

    if "stt" in doc and "url" in doc["stt"]:
        doc["stt"]["url"] = stt_url
    if "companions" in doc and "stt_health_url" in doc["companions"]:
        doc["companions"]["stt_health_url"] = health_url

    ms = doc.get("managed_services")
    if backend == NATIVE:
        # Host launchd service owns STT — the orchestrator must NOT manage a
        # SenseVoice container.
        if ms is not None and "stt-service" in ms:
            del ms["stt-service"]
    elif backend == DOCKER:
        # Re-add the SenseVoice sibling so the orchestrator spawns it. Idempotent:
        # no-op when already present (leaves any operator edits untouched).
        if ms is not None and "stt-service" not in ms:
            ms["stt-service"] = yaml.load(STT_SERVICE_SNIPPET)["stt-service"]

    buf = io.StringIO()
    yaml.dump(doc, buf)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=[NATIVE, DOCKER])
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    original = args.config.read_text(encoding="utf-8")
    updated = transform(args.backend, original)

    if original == updated:
        print("[stt-backend] no change needed")
        return

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile=str(args.config),
        tofile=f"{args.config} ({args.backend})",
    )
    sys.stdout.writelines(diff)

    if args.apply:
        args.config.write_text(updated, encoding="utf-8")
        print(f"\n[stt-backend] applied {args.backend} to {args.config}")
    else:
        print(f"\n[stt-backend] dry-run — re-run with --apply to write {args.backend}")


if __name__ == "__main__":
    main()
