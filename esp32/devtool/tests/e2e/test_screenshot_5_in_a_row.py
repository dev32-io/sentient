"""5-in-a-row screenshot parity test — regression kill for USB-CDC byte-drop."""
from pathlib import Path


def test_five_screenshots_back_to_back_succeed(devtool, tmp_path):
    for i in range(5):
        out = tmp_path / f"s{i}.png"
        p = devtool("screenshot", "--out", str(out), timeout_s=30.0)
        assert p.returncode == 0, (
            f"shot {i} failed: rc={p.returncode}, stderr={p.stderr}"
        )
        assert out.exists() and out.stat().st_size > 5000, (
            f"shot {i}: file missing or tiny "
            f"({out.stat().st_size if out.exists() else 'absent'})"
        )
