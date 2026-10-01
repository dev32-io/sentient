# Firmware review repair — seven findings

> Historical repair record, not a current runbook or fresh verification result. Commands, test counts, SDK status and artifact measurements below describe that attempt only. Use `build-profiles.md` and `agents/docs/esp32/cube/` (repository-relative) for current instructions; re-establish artifact revision/configuration before relying on these results.

Build-only repair of `/tmp/pibox-subagent-attempt-1RrRU6/report.md`.
No devices, flash, production operations, commits, or edits outside Cube.
Existing dirty implementation retained. Installed ESP-IDF and its mbedTLS
submodule remain unchanged (`git status --short` empty in both).

## Coverage

| Finding | Repair | Executed semantic check |
| --- | --- | --- |
| 1. TLS dates | Cube Kconfig selects `MBEDTLS_HAVE_TIME` and `MBEDTLS_HAVE_TIME_DATE`; defaults and CMake guard enforce date verification in retained profiles. | Actual SDK mbedTLS verifies disposable signed certificate at current time, rejects expired/future times and wrong hostname. Retained debug config regenerated with both time options enabled. |
| 2. Malformed Security2 | Hash-pinned build-local upstream patch validates outer oneof/version, command discriminant/matching payload, pointers, username/key/proof lengths before dispatch; bounds protobuf input to 512 bytes. | Actual protobuf decoder and patched Security2 under ASan: empty four-byte envelope, truncated length, wrong outer/inner oneof, unknown discriminant, missing username, empty/oversized key, 63/65-byte proof, negative/oversized frame length. |
| 3. SRP zero and cleanup | Shared upstream SRP API rejects `A mod N == 0` using checked mbedTLS MPI operation. Session close is sole SRP owner, clears handle, resets failed requests; replacement closes old session id. Arithmetic/allocation failures propagate; MPI error temporaries freed. | Actual patched SRP/Security2/MPI under ASan: zero and modulus inputs, direct SRP API, disconnect/restart/replacement, complete Cmd0 allocation-failure sweep, 40 Cmd1 allocation-failure positions. Allocation counter returns to baseline after every cycle and zero after teardown. |
| 4. RNG leak | Entropy and CTR-DRBG contexts freed after seed failure and immediately after nonce generation, before every later return. | Repeated complete handshakes; allocation sweep through nonce generation; forced post-seed and post-random failures after executing real mbedTLS operations. No retained allocations. |
| 5. HTTP total deadline/limit | Production adapter uses streaming open/write/fetch/read, 512-byte reads, 4096-byte body limit, explicit close/cleanup. Custom transport guards **every** underlying read/write, including SDK internal header/body loops, against 20-second absolute deadline. Nonblocking TLS and 1ms connection polls avoid partial-record/per-call timeout extension. Async lwIP lookup uses same deadline; at most one late lookup remains owned until callback completes. Resolved IP connects with original hostname/SNI verification. | Actual Cube adapter plus unmodified SDK HTTP client, parser, header utilities and transport dispatch under ASan. Scripted socket/clock boundary covers slow headers, slow chunked body below per-read timeout, incomplete response, oversized declared/chunked bodies, exact 4096-byte bodies, cached body during headers, redirects, DNS timeout/late callback/queue rejection and closure. |
| 6. Native short A | Accept 1–384 bytes and pass actual width into shared SRP API and diagnostic call. No padding change to proof serialization. | Independent Python client arithmetic against actual patched server for 384-, 383-, and 1-byte valid A. 33 handshake cycles (one wrong proof, 32 complete), reciprocal proofs, AES-256-GCM key, initial big-endian counter 1 and patch version 1 verified. Pinned native client untouched. |
| 7. Retry-After | Decimal parser saturates to 1–300 seconds without integer overflow; invalid/date forms use existing backoff. | Actual adapter parses HTTP headers for 0, 1, 300, 301, 3600 and arbitrarily large decimal values; invalid forms rejected. |

Crypto remains upstream SRP6a/mbedTLS, not a replacement implementation.
Three source patches require exact reviewed IDF 5.5.2 source SHA-256 values;
SDK upgrades fail configuration until corrections are reviewed. Existing salt
serialization correction remains applied before hashing/export.

## Changed files in this repair

Under `esp32/cube/`:

- `firmware/main/CMakeLists.txt`, `firmware/main/Kconfig.projbuild`, `firmware/sdkconfig.defaults`
- `firmware/main/boards/sentient-cube/cube_hardware.cc`
- `firmware/main/boards/sentient-cube/cube_http.h`, `cube_dns.h`
- `firmware/scripts/patch_security2.py`, `patch_srp_security.py`, `patch_srp_mpi.py`
- `tests/unit/test_cube_security2_sdk.py`, `security2_sdk_host.c`
- `tests/unit/test_cube_http_sdk.py`, `http_sdk_host.cc`
- `tests/unit/test_cube_tls_dates.py`
- This report. Other dirty Cube files predate this repair.

## Checks and artifacts

After `source scripts/env.sh`:

```sh
python3 -m pytest -q esp32/cube/tests/unit
# 34 passed in 49.86s

git diff --check -- esp32/cube
# passed

source ~/esp/esp-idf/export.sh
cd esp32/cube/firmware
idf.py -B /tmp/cube-ble-firmware-build \
  -D SDKCONFIG=/tmp/cube-ble-sdkconfig.debug reconfigure build
# passed; no device commands executed
```

Host semantic tests require local ESP-IDF 5.5.2, macOS clang/ASan, CMake and
OpenSSL. They compile full reviewed upstream code; they do not substitute a
mock `request()` or claim regex checks prove memory/crypto safety. HTTP socket,
RTOS clock and DNS callback services are host stand-ins, not on-device TLS E2E.
Certificate verification uses the SDK's real mbedTLS X.509 implementation with
a controllable host clock. Crypto allocation tracking includes mbedTLS and
protobuf allocations; ASan instruments those libraries as well.

Final artifact: `/tmp/cube-ble-firmware-build/sentient_cube.bin`

- Size: `0x3a7870` / 3,831,920 bytes.
- Smallest app partition: `0x3f0000`; free `0x48790` / 296,848 bytes (7%).
- SHA-256: `d6fefb3c711652c31c60408105dc210a033e039215fc6b437374f01d02545e93`.
- Debug companion enabled; Security2 only, NimBLE one connection, 8192-byte host stack.
- `CONFIG_MBEDTLS_HAVE_TIME=y`, `CONFIG_MBEDTLS_HAVE_TIME_DATE=y`, custom HTTP transport enabled.
- Compile database contains patched Security2/SRP/MPI sources, not installed originals.
- Protocomm compile flags: `LOG_LOCAL_LEVEL=ESP_LOG_NONE`; HTTP client: `ESP_LOG_WARN`.
- Patched object audit contains none of checked private/session-key debug strings.

Expected negative results: malformed frames, zero/modulus A, bad proof,
injected allocation/RNG errors, invalid certificate dates/hostname, deadline
and overflow requests fail. No expected test failures. One reconfigure attempt
hit an Espressif component-registry connection reset; identical retry passed.

## Physical gates still open

Parent owns all flash/device operations. This image is build evidence, not a
flash instruction or physical acceptance claim. Still verify:

- Real pinned native bootstrap/manager handshake, ATT long writes/reads,
  wrong-proof rejection, disconnect/reconnect/reboot and retired QR behavior.
- Device TLS clock/date/hostname rejection, partial TLS records, DNS/mDNS,
  slow/oversized responses and deadline responsiveness on actual Wi-Fi.
- Repeated BLE plus concurrent TLS/audio internal heap/largest block and task
  stack high-water; host allocation balance does not measure device heap.
- Power interruption across enrollment/NVS transitions, partition layout,
  voice latency/dropouts, BLE/Wi-Fi coexistence and UI/power behavior.

Async DNS deliberately allows only one outstanding lookup. If its caller times
out, further lookups fail closed until lwIP delivers completion; callback state
stays bounded and cannot touch a destroyed request. Scheduler delays and
individual crypto operations remain subject to normal non-real-time execution.
