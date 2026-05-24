"""e2e parity tests for /screenshot endpoint."""
from pathlib import Path


def _is_png(p: Path) -> bool:
    return p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_screenshot_writes_valid_png(devtool, tmp_path):
    out = tmp_path / "s.png"
    devtool("screenshot", "--out", str(out), check=True, timeout_s=30.0)
    assert out.exists() and out.stat().st_size > 5000
    assert _is_png(out)


def test_screenshot_rgb565_raw_matches_dimensions(devtool, tmp_path):
    out = tmp_path / "s.rgb565"
    devtool("screenshot", "--format", "rgb565", "--out", str(out),
            check=True, timeout_s=30.0)
    # 466 * 466 * 2 bytes = 434,312
    assert out.stat().st_size == 466 * 466 * 2
