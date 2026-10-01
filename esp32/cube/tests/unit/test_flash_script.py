"""Run the actual wizard/prompts with fake USB inventory and a fake devtool."""
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def test_flash_wizard_offline(tmp_path):
    # Reuse devtool's installed Rich/PySerial dependencies, not global Python.
    check = tmp_path / "check.py"
    check.write_text(textwrap.dedent('''
        import io
        import runpy
        import sys
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from rich.console import Console

        root = Path(sys.argv[1])
        namespace = runpy.run_path(str(root / "esp32/cube/scripts/flash.py"))
        main = namespace["main"]
        g = main.__globals__
        def port(name, serial="A", vid=0x303a):
            return SimpleNamespace(device=name, serial_number=serial, location="USB1",
                                   vid=vid, pid=0x1001, description="USB JTAG/serial")
        a, b = port("/dev/cube-a"), port("/dev/cube-b", "B")

        def exercise(inventories, answers, codes=()):
            output = io.StringIO()
            calls = []
            results = iter(codes)
            def run(command, **kwargs):
                calls.append(command)
                assert kwargs["cwd"] == root
                assert command[:7] == [str(root / "esp32/devtool/bin/esp32-devtool"),
                    "--repo-root", str(root), "--boards-dir",
                    str(root / "esp32/cube/devtool/boards"), "--board", "cube"]
                assert kwargs["stdin"] == g["subprocess"].DEVNULL
                return SimpleNamespace(returncode=next(results), stderr="", stdout="")
            console = Console(file=output, force_terminal=False, width=120)
            with patch.dict(g, CONSOLE=console), patch.object(sys, "argv", ["flash.py"]), \\
                 patch.object(sys, "stdin", io.StringIO(answers)), \\
                 patch.object(g["shutil"], "which", return_value="installed"), \\
                 patch.object(g["list_ports"], "comports", side_effect=inventories), \\
                 patch.object(g["subprocess"], "run", side_effect=run):
                try:
                    code = main()
                except EOFError:
                    code = 130
            return code, calls, output.getvalue()

        # No hardware, unrelated USB, rescan, and quit are all safe.
        assert exercise([[]], "q\\n")[1] == []
        assert exercise([[port("/dev/other", vid=123)]], "q\\n")[1] == []
        assert exercise([[], [a]], "\\nq\\n")[1] == []
        # Default confirmation is NO; EOF never reaches a device operation.
        assert exercise([[a]], "\\n\\n")[1] == []
        assert exercise([[a]], "")[1] == []
        assert exercise([[a]], "2\\n")[1] == []
        # Device disappearance or replacement after confirmation must not flash.
        assert exercise([[a], []], "2\\ny\\n")[0:2] == (3, [])
        assert exercise([[a], [port(a.device, "replacement")]], "2\\ny\\n")[0:2] == (3, [])
        # Release default, explicit YES, then separate strip audit.
        code, calls, out = exercise([[a], [a]], "\\ny\\ny\\n\\n", [0, 0])
        assert code == 0 and len(calls) == 2
        assert calls[0][-5:] == ["--port", a.device, "flash", "--profile", "prod"]
        assert calls[1][-1] == "audit-prod-strip"
        assert "Release boot cannot be verified" in out
        # A successful write is not a successful boot; unconfirmed display stops here.
        code, calls, out = exercise([[a], [a]], "1\\ny\\nn\\n", [0, 0])
        assert code == 6 and len(calls) == 2 and "display startup NOT confirmed" in out
        assert "hold PWR" in out and "not BOOT" in out
        # Multiple devices require a numbered choice, including invalid-choice retry.
        code, calls, out = exercise([[a, b], [a, b]], "9\\n2\\n2\\ny\\ny\\n\\n", [0])
        assert code == 0 and len(calls) == 1
        assert calls[0][-5:] == ["--port", b.device, "flash", "--profile", "debug"]
        # Failure never audits or silently retries; failed audit is not success.
        assert exercise([[a], [a]], "1\\ny\\n", [6])[0] == 6
        code, calls, out = exercise([[a], [a]], "1\\ny\\n", [0, 5])
        assert code == 5 and "strip audit passed" not in out
        # Another cube requires fresh discovery, profile choice and confirmation.
        code, calls, out = exercise([[a], [a], [b], [b]],
                                    "2\\ny\\ny\\ny\\n\\n2\\ny\\ny\\nn\\n", [0, 0])
        assert code == 0 and len(calls) == 2
        assert calls[0][-4] == a.device and calls[1][-4] == b.device
        print("Wizard safety/UX checks passed; no USB opened or firmware flashed.")
    '''))
    subprocess.run(["uv", "run", "--project", str(ROOT / "esp32/devtool"),
                    "python", str(check), str(ROOT)], check=True, timeout=60)
