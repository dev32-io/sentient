#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyserial>=3.5", "rich>=13", "pyyaml>=6.0"]
# ///
"""Interactive cube flasher. USB is opened only by esp32-devtool, after confirmation."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

import yaml
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from serial.tools import list_ports

ROOT = Path(__file__).resolve().parents[3]
BOARDS = ROOT / "esp32/cube/devtool/boards"
CONSOLE = Console()


def connected_cubes():
    usb = yaml.safe_load((BOARDS / "cube.yaml").read_text())["usb"]
    # USB descriptors work for new/release cubes too: no debug firmware required.
    return sorted((p for p in list_ports.comports()
                   if (p.vid, p.pid) == (usb["vid"], usb["pid"])), key=lambda p: p.device)


def identity(port):
    return port.device, port.serial_number, port.location, port.vid, port.pid


def describe(port):
    name = port.description or "ESP32-S3 USB device"
    serial = f" · serial {port.serial_number}" if port.serial_number else ""
    return f"{name}{serial} · {port.device}"


def choose_cube():
    while True:
        ports = connected_cubes()
        if not ports:
            CONSOLE.print("\nNo cube detected. Plug it in using a USB data cable.")
            CONSOLE.print("If it stays missing, check the cable and USB connection; do not erase it.")
            if Prompt.ask("Press Enter to scan again, or q to quit", default="",
                          choices=["", "q"], show_choices=False, console=CONSOLE) == "q":
                return None
            continue
        if len(ports) == 1:
            CONSOLE.print("\nFound: " + describe(ports[0]), markup=False)
            return ports[0]
        CONSOLE.print("\nSeveral compatible USB devices found. Choose your cube:")
        for i, port in enumerate(ports, 1):
            CONSOLE.print(f"  {i}. {describe(port)}", markup=False)
        choice = Prompt.ask("Cube number (r = rescan, q = quit)",
                            choices=[str(i) for i in range(1, len(ports) + 1)] + ["r", "q"],
                            console=CONSOLE)
        if choice == "q":
            return None
        if choice != "r":
            return ports[int(choice) - 1]


def run_devtool(port, args, message):
    command = [str(ROOT / "esp32/devtool/bin/esp32-devtool"),
               "--repo-root", str(ROOT), "--boards-dir", str(BOARDS),
               "--board", "cube", "--port", port.device, *args]
    CONSOLE.print(message)
    # Devtool bounds build/flash and readiness waits and owns child cleanup.
    with CONSOLE.status("Working — keep the cube connected", spinner="dots"):
        result = subprocess.run(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, errors="replace", check=False)
    if result.returncode:
        CONSOLE.print("[red]This step did not complete successfully.[/red]")
        CONSOLE.print((result.stderr + result.stdout).strip(), markup=False)
        CONSOLE.print("Flashing may already have happened. Keep the cube connected and inspect "
                      "the error before retrying; do not erase or repeatedly reflash it.")
    return result.returncode


def main():
    argparse.ArgumentParser(description="Plug in a cube, choose Release or Debug, and confirm. "
                            "No device path or command-line options needed.").parse_args()
    CONSOLE.print(Panel("Plug in your cube. We will find it and guide you through flashing.",
                        title="Sentient Cube · USB firmware", border_style="cyan"))
    idf = Path(os.environ.get("IDF_PATH", str(Path.home() / "esp/esp-idf")))
    if not shutil.which("uv") or not (shutil.which("idf.py") or (idf / "export.sh").is_file()):
        CONSOLE.print("[red]Build tools missing.[/red] Install uv and ESP-IDF 5.5.2 first. "
                      "For a custom ESP-IDF install, set IDF_PATH.")
        return 2
    CONSOLE.print("USB IDs identify compatible ESP32 devices, not their board model. "
                  "Connect only cubes, or identify the correct device below.")
    while True:
        CONSOLE.rule("1 · Find your cube")
        port = choose_cube()
        if port is None:
            return 0
        CONSOLE.rule("2 · Choose firmware")
        CONSOLE.print("  1. Release — everyday use; debug access disabled; public CA trust")
        CONSOLE.print("  2. Debug   — development diagnostics; trusted development networks only")
        choice = Prompt.ask("Firmware (q = quit)", choices=["1", "2", "q"],
                            default="1", console=CONSOLE)
        if choice == "q":
            return 0
        profile = "prod" if choice == "1" else "debug"
        label = "Release" if profile == "prod" else "Debug"
        CONSOLE.rule("3 · Confirm")
        CONSOLE.print(f"{label} → {describe(port)}", markup=False)
        CONSOLE.print("This replaces bootloader, partition table and application. "
                      "Existing Wi-Fi and enrollment are preserved.\n"
                      "There is no automatic rollback. Do not unplug during flashing.")
        CONSOLE.print("Release excludes the development TLS certificate." if profile == "prod"
                      else "Debug trust must match your enrolled gateway; see scripts/README.md.")
        if not Confirm.ask("Flash this cube now?", default=False, console=CONSOLE):
            CONSOLE.print("Cancelled. Nothing flashed.")
            return 0
        if identity(port) not in [identity(p) for p in connected_cubes()]:
            CONSOLE.print("[red]USB device changed or disconnected. Nothing flashed.[/red] "
                          "Reconnect your cube and start again.")
            return 3
        CONSOLE.rule("4 · Install firmware")
        rc = run_devtool(port, ["flash", "--profile", profile],
                         "Building and flashing" + (", then checking debug startup."
                         if profile == "debug" else ".") + " This can take several minutes.")
        if rc:
            return rc
        if profile == "prod":
            rc = run_devtool(port, ["audit-prod-strip"], "Checking release build for debug code…")
            if rc:
                return rc
            CONSOLE.print("[green]Release firmware written; strip audit passed.[/green]\n"
                          "Check the cube's display. Release boot cannot be verified over USB.")
        else:
            CONSOLE.print("[green]Debug firmware written; startup check passed.[/green]")
        CONSOLE.rule("5 · Check the display")
        CONSOLE.print("The flasher already requested a chip reset. Check that the screen starts.\n"
                      "If it is black, first tap to wake. With our firmware initialized, hold PWR "
                      "about 4 seconds to power off, release, then press PWR briefly to power on.\n"
                      "Use PWR, not BOOT. USB unplug alone does not remove battery power. "
                      "This is not a guaranteed recovery from a power-controller fault.")
        if not Confirm.ask("Is the cube showing setup or its companion screen?",
                           default=False, console=CONSOLE):
            CONSOLE.print("[yellow]Firmware written; display startup NOT confirmed.[/yellow] "
                          "Stop and inspect before retrying. Do not repeatedly reflash or erase the cube.")
            return 6
        CONSOLE.print("New cube? Finish setup in the app using Bluetooth enrollment.")
        if not Confirm.ask("Flash another cube?", default=False, console=CONSOLE):
            return 0
        CONSOLE.print("Unplug the finished cube and connect the next one.")
        Prompt.ask("Press Enter when ready", default="", console=CONSOLE)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (EOFError, KeyboardInterrupt):
        CONSOLE.print("\nStopped. If flashing was interrupted, inspect the cube before retrying.")
        raise SystemExit(130) from None
    except OSError as error:
        CONSOLE.print(f"Could not continue: {error}", markup=False)
        raise SystemExit(1) from None
