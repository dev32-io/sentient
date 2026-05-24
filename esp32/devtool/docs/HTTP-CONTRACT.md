## HTTP contract

Frozen wire spec. Board implementers conform. CLI assumes shape.

### `GET /info` → 200 application/json

```json
{
  "device_id": "cube-001",
  "board": "cube",
  "chip": "esp32-s3",
  "ip": "192.168.0.121",
  "mac": "aa:bb:cc:dd:ee:ff",
  "firmware": "phase6-cube-sdk-<git-sha>",
  "build_profile": "debug",
  "uptime_s": 3421,
  "wifi_ssid": "InterWeb",
  "wifi_rssi": -42,
  "capabilities": ["screenshot", "touch", "audio_record", "audio_inject", "log_relay"],
  "endpoints": {
    "screenshot": "/screenshot",
    "touch": "/touch",
    "audio_record": "/audio/record",
    "audio_inject": "/audio/inject"
  },
  "contract_version": "1.0"
}
```

### `GET /screenshot?format=png|jpeg|rgb565`

```
200 OK
Content-Type: image/png | image/jpeg | application/octet-stream
X-Screenshot-Width: <int>
X-Screenshot-Height: <int>
X-Screenshot-Format: png|jpeg|rgb565
X-Screenshot-Crc32: <hex>
<binary>
```

Defaults to png. JPEG quality 80 (fixed v1). rgb565 = raw; host converts.

Errors: 503 (LVGL not initialized), 500 (snapshot null), 408 (encoder hang 10s).

### `POST /touch`

```
Body: {"x": int, "y": int, "hold_ms": int? = 60}
200 → {"ok": true}
```

Server enqueues synthetic press at (x,y), release after hold_ms via injected `lv_indev`.

### `GET /audio/record?duration_ms=<int>&sample_rate=<int>`

```
200 OK
Content-Type: audio/L16; rate=<sample_rate>; channels=1
X-Audio-Samples: <int>
<raw PCM16 LE>
```

Default 1000 ms, 16000 Hz. Max 10000 ms. Streams during capture (no full buffer).

### `POST /audio/inject`

```
Content-Type: audio/L16; rate=16000; channels=1
<raw PCM16 LE>
200 → {"ok": true, "samples": <int>}
```

No 32 KB cap (was the USB-CDC verb's b64 limit).

### Log relay (cube → host)

UDP datagrams, NDJSON one line per packet:

```json
{"ts_ms": 12345, "level": "I", "tag": "sentient.cube.sdk.ws", "msg": "status: ..."}
```

Devtool's `logs --source udp` binds the host-side port to receive.

### Headers (all endpoints)

```
X-Devtool-Version: <semver>
```

CLI warns on major mismatch.

### Contract versioning

`contract_version` in `/info`. CLI requires `^MAJOR.MINOR`. Loud error on mismatch.

### Authentication

Out-of-scope v1 (LAN-only). OSS extraction guide will document reverse-proxy patterns.

### CORS

Off v1. Add when a web UI is built.
