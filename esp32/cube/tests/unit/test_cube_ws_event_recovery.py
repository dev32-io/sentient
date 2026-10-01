"""Actual SDK/component: FINISH-only stop recovery and post-FIN allocation faults."""
from pathlib import Path
import os
import subprocess
from cube_envelope_host import envelope_link_args

UNIT = Path(__file__).resolve().parent
MAIN = UNIT.parents[1] / 'firmware/main'


def test_finish_only_retirement_and_post_fin_allocations(tmp_path):
    cjson = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
    subprocess.run(['cc', '-c', str(cjson / 'cJSON.c'), '-I', str(cjson), '-o', str(tmp_path / 'json.o')], check=True)
    binary = tmp_path / 'event-recovery'
    subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(UNIT), '-I', str(UNIT / 'ws_stubs'),
                    '-I', str(MAIN), '-I', str(cjson), str(UNIT / 'sentient_ws_recovery_host_test.cc'),
                    str(MAIN / 'protocols/sentient_ws_protocol.cc'), str(MAIN / 'audio/demuxer/ogg_demuxer.cc'),
                    str(tmp_path / 'json.o'), *envelope_link_args(tmp_path, cjson), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=30)
