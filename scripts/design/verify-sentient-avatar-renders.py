#!/usr/bin/env python3
"""Assert stable runtime, reduced-motion, transition, and SVG-parity gates."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

BACKGROUND = (23, 18, 15)
MAX_NORMALIZED_MAE = 0.15
MIN_FOREGROUND_IOU = 0.42


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest(root: Path, name: str) -> dict:
    data = json.loads((root / name / "manifest.json").read_text())
    if any(frame["blank"] for frame in data["frames"]):
        raise AssertionError(f"{name}: blank frame")
    return data


def frame(root: Path, directory: str, index: int) -> Path:
    return root / directory / f"frame_{index:05d}.png"


def visual_distance(reference: Path, actual: Path) -> tuple[float, float]:
    expected = Image.open(reference).convert("RGB")
    rendered = Image.open(actual).convert("RGB")
    if expected.size != rendered.size:
        raise AssertionError(f"image size mismatch: {expected.size} != {rendered.size}")
    mae = sum(ImageStat.Stat(ImageChops.difference(expected, rendered)).mean) / (3 * 255)
    intersection = union = 0
    for left, right in zip(expected.get_flattened_data(), rendered.get_flattened_data()):
        left_foreground = sum((left[i] - BACKGROUND[i]) ** 2 for i in range(3)) > 144
        right_foreground = sum((right[i] - BACKGROUND[i]) ** 2 for i in range(3)) > 144
        intersection += left_foreground and right_foreground
        union += left_foreground or right_foreground
    return mae, intersection / union


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} RENDER_DIR SVG_REFERENCE_DIR")
    root, references = map(Path, sys.argv[1:])
    names = (
        "state-idle",
        "state-thinking",
        "state-responding",
        "reduced-idle",
        "reduced-thinking",
        "reduced-responding",
        "rapid",
    )
    for name in names:
        manifest(root, name)

    idle = digest(frame(root, "state-idle", 60))
    thinking = digest(frame(root, "state-thinking", 60))
    responding = digest(frame(root, "state-responding", 120))
    if len({idle, thinking, responding}) != 3:
        raise AssertionError("idle, thinking, and responding did not render distinctly")
    if len({digest(frame(root, "state-idle", index)) for index in (0, 30, 60)}) != 1:
        raise AssertionError("idle state did not remain static")

    # Sampling at whole former aggregate periods proves independent source loops remain independent.
    if len({digest(frame(root, "state-thinking", index)) for index in (15, 243, 471)}) != 3:
        raise AssertionError("thinking motion collapsed to a shared 3.8 second period")
    if len({digest(frame(root, "state-responding", index)) for index in (15, 108, 201)}) != 3:
        raise AssertionError("responding motion collapsed to a shared 1.55 second period")

    for name in ("reduced-idle", "reduced-thinking", "reduced-responding"):
        indices = (0, 1, 60, 120)
        if len({digest(frame(root, name, index)) for index in indices}) != 1:
            raise AssertionError(f"{name}: authored reduced-motion state moved after immediate render")
    if len({digest(frame(root, name, 0)) for name in ("reduced-idle", "reduced-thinking", "reduced-responding")}) != 3:
        raise AssertionError("reduced-motion states did not render distinctly")

    for name in ("state-thinking", "state-responding"):
        transition = [digest(frame(root, name, index)) for index in (0, 8, 15)]
        if len(set(transition)) != 3:
            raise AssertionError(f"{name}: 250 ms asset-owned transition did not produce distinct endpoints and midpoint")

    rapid = {index: digest(frame(root, "rapid", index)) for index in (0, 9, 15, 25, 35, 60, 90)}
    if rapid[0] != rapid[9]:
        raise AssertionError("rapid sequence changed before its first scheduled trigger")
    if len({rapid[15], rapid[25], rapid[35]}) != 3:
        raise AssertionError("rapid sequence did not redirect through distinct transition frames")
    if rapid[60] != idle or rapid[90] != idle:
        raise AssertionError("rapid sequence did not converge to and hold the latest idle request")

    comparisons = (
        (references / "idle.png", frame(root, "state-idle", 60), "idle"),
        (references / "thinking-1.0s.png", frame(root, "state-thinking", 60), "thinking@1.0s"),
        (references / "responding-2.0s.png", frame(root, "state-responding", 120), "responding@2.0s"),
    )
    results = []
    for reference, actual, label in comparisons:
        mae, iou = visual_distance(reference, actual)
        if mae > MAX_NORMALIZED_MAE or iou < MIN_FOREGROUND_IOU:
            raise AssertionError(f"{label}: SVG parity outside bounds (mae={mae:.4f}, iou={iou:.4f})")
        results.append(f"{label}: mae={mae:.4f}, iou={iou:.4f}")

    print("render assertions passed: nonblank, distinct, deterministic reduced motion, independent periods, transition choreography, latest-state convergence")
    print("bounded SVG parity: " + "; ".join(results))


if __name__ == "__main__":
    main()
