"""Companion document/parser/player consumer contract; no firmware build."""
from pathlib import Path
import os
import subprocess
import tempfile

CUBE = Path(__file__).resolve().parents[2]
BOARD = CUBE / 'firmware/main/boards/sentient-cube'


def test_companion_parser_and_player():
    cjson = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        obj = tmp / 'cJSON.o'
        subprocess.run(['cc', '-c', str(cjson / 'cJSON.c'), '-o', str(obj)], check=True)
        binary = tmp / 'companion'
        subprocess.run([
            'c++', '-std=c++17', '-I', str(cjson), '-I', str(CUBE / 'firmware/ui-shared'),
            '-I', str(CUBE / 'lvgl-sim/main'), f'-DSENTIENT_BOARD_DIR="{BOARD}"',
            str(CUBE / 'tests/unit/cube_companion_host_test.cc'),
            str(CUBE / 'firmware/ui-shared/companion.cc'), str(obj), '-o', str(binary)
        ], check=True)
        subprocess.run([str(binary)], check=True)
