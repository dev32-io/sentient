"""Compile actual envelope component; SDK sees only its public header, never Boost."""
import json
from pathlib import Path
import subprocess

COMPONENT = Path(__file__).resolve().parents[2] / 'firmware/components/cube_envelope'


def envelope_link_args(out, cjson):
    includes = ['-I', str(COMPONENT / 'include'), '-I', str(cjson)]
    for module in json.loads((COMPONENT / 'vendor/sources.json').read_text()):
        includes += ['-I', str(COMPONENT / 'vendor' / module / 'include')]
    objects = []
    for name in ('bounded_envelope', 'boost_json_core'):
        obj = out / f'{name}.o'
        subprocess.run(['c++', '-std=c++17', '-O1', '-Wall', '-Wextra', '-Werror',
                        '-DBOOST_JSON_NO_LIB=1', '-DBOOST_JSON_NO_SSE2=1', *includes,
                        '-c', str(COMPONENT / f'{name}.cc'), '-o', str(obj)], check=True)
        objects.append(str(obj))
    return ['-I', str(COMPONENT / 'include'), *objects]
