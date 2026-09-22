#!/usr/bin/env python3
"""libvips image metadata and one-pass upright crop/resize worker."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pyvips


def field(image: pyvips.Image, name: str):
    return image.get(name) if image.get_typeof(name) else None


def delays(image: pyvips.Image) -> list[int] | None:
    value = field(image, "delay")
    if not isinstance(value, list) or not value or not all(isinstance(item, int) and item >= 0 for item in value):
        return None
    return value


def describe(path: str, media_type: str, size_bytes: int) -> dict[str, object]:
    image = pyvips.Image.new_from_file(path, access="sequential")
    pages = field(image, "n-pages")
    page_count = pages if isinstance(pages, int) and pages > 1 else 1
    page_height = field(image, "page-height")
    stored_height = page_height if isinstance(page_height, int) and page_height > 0 else image.height
    orientation = field(image, "orientation")
    orientation = orientation if isinstance(orientation, int) and 1 <= orientation <= 8 else None
    width, height = image.width, stored_height
    upright_width, upright_height = (height, width) if orientation in (5, 6, 7, 8) else (width, height)
    animation = page_count > 1 and media_type != "image/tiff"
    result: dict[str, object] = {
        "kind": "animation" if animation else "multi_page_image" if page_count > 1 else "image",
        "mediaType": media_type,
        "sizeBytes": size_bytes,
        "originalAvailable": True,
        "width": upright_width,
        "height": upright_height,
        "storedWidth": width,
        "storedHeight": height,
    }
    if orientation is not None:
        result["orientation"] = orientation
    if page_count > 1:
        result["frameCount" if animation else "pageCount"] = page_count
    frame_delays = delays(image)
    if animation and frame_delays and len(frame_delays) >= page_count:
        result["durationMs"] = sum(frame_delays[:page_count])
    try:
        result["hasAlpha"] = bool(image.hasalpha())
    except pyvips.Error:
        pass
    return result


def select_frame(source: dict[str, object], image: pyvips.Image, frame_index: int | None, time_ms: int | None) -> tuple[int, int | None]:
    count = int(source.get("frameCount", source.get("pageCount", 1)))
    selected = frame_index if frame_index is not None else 0
    actual_time = None
    frame_delays = delays(image)
    if time_ms is not None:
        if not frame_delays or len(frame_delays) < count:
            raise ValueError("time selection unavailable")
        elapsed = 0
        selected = count - 1
        for index, delay in enumerate(frame_delays[:count]):
            if time_ms < elapsed + delay:
                selected = index
                actual_time = elapsed
                break
            elapsed += delay
    elif frame_delays and len(frame_delays) >= count:
        actual_time = sum(frame_delays[:selected])
    if selected < 0 or selected >= count:
        raise ValueError("frame out of range")
    return selected, actual_time


def render(args: argparse.Namespace) -> dict[str, object]:
    all_frames = pyvips.Image.new_from_file(args.input, access="sequential")
    source = describe(args.input, args.media_type, args.size_bytes)
    frame_index, actual_time = select_frame(source, all_frames, args.frame_index, args.time_ms)
    load_options = {"access": "sequential"}
    if int(source.get("frameCount", source.get("pageCount", 1))) > 1:
        load_options.update({"page": frame_index, "n": 1})
    image = pyvips.Image.new_from_file(args.input, **load_options).autorot()
    source_width, source_height = image.width, image.height
    region = None
    if args.region:
        x, y, width, height = args.region
        left = math.floor(x * source_width)
        top = math.floor(y * source_height)
        right = math.ceil((x + width) * source_width)
        bottom = math.ceil((y + height) * source_height)
        left, top = max(0, left), max(0, top)
        right, bottom = min(source_width, right), min(source_height, bottom)
        if right <= left or bottom <= top:
            raise ValueError("empty region")
        image = image.crop(left, top, right - left, bottom - top)
        region = {
            "x": left / source_width,
            "y": top / source_height,
            "width": (right - left) / source_width,
            "height": (bottom - top) / source_height,
        }
    if max(image.width, image.height) > args.max_edge:
        image = image.resize(args.max_edge / max(image.width, image.height))
    image.pngsave(args.output, strip=True)
    view: dict[str, object] = {
        "kind": "crop" if region else "frame" if source["kind"] == "animation" or args.frame_index is not None or args.time_ms is not None else "page" if source["kind"] == "multi_page_image" else "overview",
        "width": image.width,
        "height": image.height,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "downsampled": image.width < (right - left if region else source_width) or image.height < (bottom - top if region else source_height),
        "partialCoverage": region is not None or source["kind"] in ("animation", "multi_page_image"),
    }
    if region:
        view["region"] = region
    if source["kind"] == "animation" or args.frame_index is not None or args.time_ms is not None:
        view["frameIndex"] = frame_index
        if actual_time is not None:
            view["timeMs"] = actual_time
    elif source["kind"] == "multi_page_image":
        view["page"] = frame_index + 1
    return {"source": source, "view": view}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("header", "render"))
    parser.add_argument("input")
    parser.add_argument("media_type")
    parser.add_argument("size_bytes", type=int)
    parser.add_argument("--output")
    parser.add_argument("--metadata")
    parser.add_argument("--max-edge", type=int)
    parser.add_argument("--frame-index", type=int)
    parser.add_argument("--time-ms", type=int)
    parser.add_argument("--region", type=float, nargs=4)
    args = parser.parse_args()
    if args.operation == "header":
        print(json.dumps(describe(args.input, args.media_type, args.size_bytes), separators=(",", ":")))
        return
    if not args.output or not args.metadata or not args.max_edge:
        parser.error("render output, metadata and max edge required")
    result = render(args)
    Path(args.metadata).write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
