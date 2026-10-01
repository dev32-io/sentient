#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Compile/run production helper on synthetic/public JSON, never device or service.

Source scripts/env.sh first. Requires existing ESP-IDF cJSON (IDF_PATH or ~/esp/esp-idf).
Requires repository Bun for current GatewayMessage schema fixtures.
Optional --corpus points to JSONTestSuite/test_parsing; no automatic downloads.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

COMPONENT = Path(__file__).resolve().parents[1]
ERROR = dict(zip(('None', 'InvalidJson', 'InvalidRoot', 'InvalidField', 'DuplicateField',
                  'DepthLimit', 'ScalarLimit', 'EnvelopeLimit', 'OutOfMemory', 'InvalidState'), range(10)))


def build(out, sanitize):
    cjson = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
    if not (cjson / 'cJSON.c').is_file():
        raise SystemExit('Existing ESP-IDF cJSON required; set IDF_PATH')
    modules = json.loads((COMPONENT / 'vendor/sources.json').read_text())
    includes = ['-I' + str(COMPONENT / 'include'), '-I' + str(cjson)]
    includes += ['-I' + str(COMPONENT / 'vendor' / module / 'include') for module in modules]
    sanitizer = ['-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-fno-omit-frame-pointer'] if sanitize else []
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c99', '-O1', *sanitizer,
                    '-I' + str(cjson), '-c', str(cjson / 'cJSON.c'), '-o', str(out / 'cjson.o')], check=True)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-O1', '-Wall', '-Wextra', '-Werror',
                    *sanitizer, '-DBOOST_JSON_NO_LIB=1', '-DBOOST_JSON_NO_SSE2=1', *includes,
                    str(COMPONENT / 'bounded_envelope.cc'), str(COMPONENT / 'boost_json_core.cc'),
                    str(COMPONENT / 'tests/host.cc'), str(out / 'cjson.o'), '-o', str(out / 'host')], check=True)
    return out / 'host'


def verify_vendor():
    vendor = COMPONENT / 'vendor'
    for line in (vendor / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.sha256((vendor / name).read_bytes()).hexdigest() == digest, name


def tests(exe, corpus):
    subprocess.run([str(exe), '--selftest'], check=True)
    count = 0
    peak_seen = 0

    def probe(data, chunk=4096, error='None', expected=None):
        nonlocal count, peak_seen
        result = subprocess.run([str(exe), str(chunk)], input=data, capture_output=True, timeout=30, check=True)
        assert not result.stderr, result.stderr.decode()
        lines = result.stdout.splitlines()
        info = json.loads(lines[0])
        assert info['error'] == ERROR[error], (error, info, len(data), chunk)
        # Includes helper's fixed allocation, Boost stack, and cJSON node/number scratch.
        assert info['peak'] <= 8192, info
        peak_seen = max(peak_seen, info['peak'])
        if error == 'None':
            assert info['length'] == len(lines[1])
            if expected is not None:
                assert json.loads(lines[1]) == expected, (len(data), chunk, info)
        else:
            assert info['length'] == 0 and lines[1] == b'null'
        count += 1
        return info, lines[1]

    all_fields = dict(type='turn.audio.start', seq=9007199254740991, epoch=0, generation=2,
                      sessionId='session', draftKey='draft', turnId='turn', encoding='pcm',
                      sampleRate=44100, command='audio.start', reason='session_busy', code='test')
    document = json.dumps(dict(items=[dict(seq=-1, type=[], aborted=0)], **all_fields)).encode()
    for chunk in (1, 7, 4096, 0):
        probe(document, chunk, expected=all_fields)
        probe(b'{}', chunk, expected={})  # helper projects, not a complete per-event schema validator
        probe(b'{"type":"x","ignored":null,"seq":1.00e2,"epoch":-0}', chunk,
              expected=dict(type='x', seq=100, epoch=0))

    # Validate producer-shaped fixtures against the actual shared discriminated union,
    # not a parallel client-only schema or the helper's own type assumptions.
    wire_frames = json.loads(subprocess.check_output(
        ['bun', str(COMPONENT / 'tests/gateway_shapes.ts')], text=True))
    for frame in wire_frames:
        for stamped in (frame, dict(frame, seq=7, epoch=2)):
            expected = {key: value for key, value in stamped.items() if key in all_fields}
            # Type may arrive last: payload projection types cannot depend on key order.
            data = json.dumps(dict(reversed(list(stamped.items())))).encode()
            for chunk in (1, 7, 4096, 0):
                probe(data, chunk, expected=expected)

    strings = ('type', 'sessionId', 'draftKey', 'turnId', 'encoding', 'command', 'reason', 'code')
    for key in strings:
        for wrong in (None, False, 1, [], {}):
            if key == 'turnId' and wrong is None:
                probe(json.dumps({key: wrong}).encode(), 1, expected={key: None})
            else:
                probe(json.dumps({key: wrong}).encode(), 1, 'InvalidField')
        probe(json.dumps({key: 'x\x00y'}).encode(), 1, 'InvalidField')
    for key in ('seq', 'epoch', 'generation', 'sampleRate'):
        for wrong in (None, False, '1', [], {}):
            probe(json.dumps({key: wrong}).encode(), 1, 'InvalidField')
    # Unrecognized fields remain ignorable, including the removed audio extension.
    for ignored in (None, False, True, 0, 'true', [], {}):
        probe(json.dumps(dict(aborted=ignored)).encode(), 1, expected={})
    for key in ('seq', 'epoch'):
        for valid in ('0', '-0', '9007199254740991', '9.007199254740991e15', '1.000e0', '1e-999'):
            probe(('{"'+key+'":'+valid+'}').encode(), 1)
        for invalid in ('-1', '0.5', '9007199254740992', '1e999'):
            probe(('{"'+key+'":'+invalid+'}').encode(), 1, 'InvalidField')
    for key in ('generation', 'sampleRate'):
        probe(('{"'+key+'":2147483647}').encode(), 1)
        for invalid in ('0', '-1', '1.1', '2147483648', '1e999'):
            probe(('{"'+key+'":'+invalid+'}').encode(), 1, 'InvalidField')
    _, raw = probe(b'{"seq":1.00e2,"epoch":-0}', 1)
    assert raw == b'{"seq":1.00e2,"epoch":-0}'

    for key, value in all_fields.items():
        encoded = json.dumps(value)
        escaped_key = ''.join('\\u%04x' % ord(c) for c in key)
        data = ('{"'+key+'":'+encoded+',"'+escaped_key+'":'+encoded+'}').encode()
        for chunk in (1, 4096, 0):
            probe(data, chunk, 'DuplicateField')
    for data in (b'{"turnId":null,"turn\\u0049d":"turn"}',
                 b'{"turnId":"turn","turn\\u0049d":null}',
                 b'{"turnId":null,"turn\\u0049d":null}'):
        for chunk in (1, 4096, 0):
            probe(data, chunk, 'DuplicateField')
    probe(b'{"items":{"seq":0,"s\\u0065q":1},"seq":2}', 1, expected=dict(seq=2))
    probe(b'{"type\\u0000":"ignored","type":"x"}', 1, expected=dict(type='x'))

    mixed = b'{"t\\u0079pe":"a\\\"\\\\\\u20ac\\ud83d\\ude00\xe2\x82\xac","seq":1e2,"items":[null,{"seq":[]}]}'
    expected = {'type': 'a"\\\u20ac\U0001f600\u20ac', 'seq': 100}
    for chunk in range(1, len(mixed) + 1):
        probe(mixed, chunk, expected=expected)

    for malformed in (b'', b'{', b'{"items":[', b'{"items":["abc', b'{}junk', b'{}{}',
                      b'{"items":["a" "b"]}', b'{"items":[-01]}', b'{"items":[1.e2]}',
                      b'{"items":[1e2.3]}', b'{"items":["\\u123x"]}', b'{"items":[1,]}',
                      b'{"items":["\x1f"]}', b'{"items":["\xff"]}', b'{"items":["\xc0\xaf"]}',
                      b'{"items":["\xed\xa0\x80"]}', b'{"items":["\xf4\x90\x80\x80"]}',
                      b'{"items":["\\ud800"]}', b'{"items":["\\udc00"]}', b'{/*x*/"items":[]}',
                      b'{"items":[NaN]}'):
        for chunk in (1, 7, 4096, 0):
            probe(malformed, chunk, 'InvalidJson')
    for root in (b'[]', b'"x"', b'1', b'true', b'null'):
        probe(root, 1, 'InvalidRoot')

    probe(b'{"type":"' + b'\\u0061' * 256 + b'"}', 1, expected=dict(type='a'*256))
    probe(b'{"type":"' + b'a'*257 + b'"}', 1, 'ScalarLimit')
    probe(b'{"seq":0.' + b'0'*126 + b'}', 1, expected=dict(seq=0))
    probe(b'{"seq":0.' + b'0'*127 + b'}', 1, 'ScalarLimit')
    probe(json.dumps({key: '\x01'*256 for key in strings}).encode(), 1, 'EnvelopeLimit')
    for depth in (1, 16, 31, 32, 33, 64):
        data = b'{"items":' + b'['*(depth-1) + b'0' + b']'*(depth-1) + b'}'
        probe(data, 1, 'None' if depth <= 32 else 'DepthLimit')

    # Same structure at different payload sizes must have identical peak allocation.
    peaks = {}
    for size in (1024, 1024*1024+1, 4*1024*1024):
        for name, value in (
            ('plain', b'"'+b'x'*size+b'"'),
            ('escaped', b'"'+b'\\u20ac'*(size//6+1)+b'"'),
            ('integer', b'1'+b'2'*size),
            ('fraction', b'0.'+b'2'*size),
        ):
            data = b'{"type":"conversation.snapshot","seq":1,"items":['+value+b'],"epoch":2}'
            for chunk in (1, 4096, 0):
                info, _ = probe(data, chunk, expected=dict(type='conversation.snapshot', seq=1, epoch=2))
                key = name, chunk
                # For random chunking, allocation peak may differ with number splits,
                # but all remain below fixed 8KiB above. Bytewise is exact invariant.
                if chunk == 1:
                    assert peaks.setdefault(key, info['peak']) == info['peak']
        data = b'{"type'+b'x'*size+b'":{"items":[]},"type":"x","seq":2}'
        for chunk in (1, 4096, 0):
            probe(data, chunk, expected=dict(type='x', seq=2))
    entries = b','.join([b'{"type":"nested","seq":-1,"entry":[0,true,"x"]}'] * 25000)
    assert len(entries) > 1024 * 1024
    for chunk in (1, 4096, 0):
        probe(b'{"type":"x","items":['+entries+b'],"seq":3}', chunk, expected=dict(type='x', seq=3))
        probe(b'{"seq":3,"items":['+entries+b',{"x":["a" "b"]}]}', chunk, 'InvalidJson')
    background = next(frame for frame in wire_frames
                      if frame['type'] == 'tasklist.state' and frame['turnId'] is None)
    # Same declared/produced row shape, expanded to a >1MiB list of unique task ids.
    items = [dict(background['items'][0], id=f'task-{i}') for i in range(10000)]
    prefix = json.dumps(dict(items=items)).encode()[:-1]
    assert len(prefix) > 1024 * 1024
    for chunk in (1, 7, 4096, 0):
        probe(prefix + b',"turnId":null,"seq":37,"epoch":4,"type":"tasklist.state"}', chunk,
              expected=dict(type='tasklist.state', turnId=None, seq=37, epoch=4))
        for field in ('seq', 'epoch'):
            probe(prefix + (',"turnId":null,"'+field+'":null,"type":"tasklist.state"}').encode(),
                  chunk, 'InvalidField')
    print(f'Synthetic production-helper checks: {count} PASS; peak tracked allocation {peak_seen} bytes')

    if corpus:
        corpus_count = 0
        for path in sorted(corpus.glob('[yn]_*.json')):
            data = b'{"items":' + path.read_bytes() + b'}'
            for chunk in (1, 7, 4096, 0):
                if path.name.startswith('y_'):
                    probe(data, chunk, expected={})
                else:
                    # Some invalid inputs also hit explicit nesting/resource bounds.
                    result = subprocess.run([str(exe), str(chunk)], input=data, capture_output=True,
                                            timeout=30, check=True)
                    assert not result.stderr, result.stderr.decode()
                    lines = result.stdout.splitlines()
                    info = json.loads(lines[0])
                    assert info['error'] in (ERROR['InvalidJson'], ERROR['DepthLimit']), path.name
                    assert info['length'] == 0 and lines[1] == b'null', path.name
                corpus_count += 1
        assert corpus_count, 'No JSONTestSuite y_/n_ files found'
        print(f'JSONTestSuite production-helper parses: {corpus_count} PASS')
    else:
        print('JSONTestSuite not run (provide --corpus); synthetic tests above are self-contained')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true')
    parser.add_argument('--corpus', type=Path)
    parser.add_argument('--build-dir', type=Path)
    args = parser.parse_args()
    verify_vendor()
    if args.build_dir:
        args.build_dir.mkdir(parents=True, exist_ok=True)
        tests(build(args.build_dir, args.sanitize), args.corpus)
    else:
        with tempfile.TemporaryDirectory(prefix='cube-envelope-') as directory:
            tests(build(Path(directory), args.sanitize), args.corpus)


if __name__ == '__main__':
    main()
