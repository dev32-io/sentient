## Board manifest

`boards/_schema.yaml`:

```yaml
name: string
display_name: string
chip: esp32-s3 | esp32-s2 | esp32-p4 | esp32-c3 | esp32-c6
firmware_path: string?               # for `flash`
build_profiles: [string]

usb:
  vid: int?
  pid: int?
  port_glob: string?

http:
  enabled: bool
  port: int
  discover_via: usb-info | mdns | static
  static_host: string?

capabilities:
  flash:        { transport: usb-cdc, require: [usb] }
  logs:         { transport: auto, sources: [usb, udp] }
  cmd:          { transport: usb-cdc, require: [daemon] }
  screenshot:   { transport: http, require: [http], format: [png, jpeg, rgb565] }
  touch:        { transport: http, require: [http] }
  audio_record: { transport: http, require: [http] }
  audio_inject: { transport: http, require: [http] }
  audio_play:   { transport: usb-cdc }

log_relay:
  enabled: bool
  port: int
  format: text | json

verbs: [string]                       # USB-CDC JSON-RPC verbs

extensions:                           # board-specific commands
  - cmd: string
    exec: string                      # ${REPO_ROOT}-aware
    args_passthrough: bool
    transient: bool?                  # prints deprecation hint
    help: string
```

### `boards/cube.yaml`

```yaml
name: cube
display_name: "Sentient Cube (Waveshare ESP32-S3 AMOLED 2.16)"
chip: esp32-s3
firmware_path: esp32/cube/firmware
build_profiles: [debug, prod]

usb:
  port_glob: "/dev/cu.usbmodem*"

http:
  enabled: true
  port: 8081
  discover_via: usb-info               # cube /info verb returns ip

capabilities:
  flash:        { transport: usb-cdc }
  logs:         { transport: auto, sources: [usb, udp] }
  cmd:          { transport: usb-cdc }
  screenshot:   { transport: http }
  touch:        { transport: http }
  audio_record: { transport: http }
  audio_inject: { transport: http }
  audio_play:   { transport: usb-cdc }

log_relay:
  enabled: true
  port: 9000

verbs:
  - sentient.status
  - sentient.force_reconnect
  - sentient.last_transcript
  - button.toggle
  - tts.cancel
  - state
  - restart
  - log_level
  - mark
  - wifi.connect
  - wifi.disconnect
  - wifi.reconnect
  - audio.dump_state
  - audio.play_pcm
  - audio.test_tone

extensions:
  - cmd: bake-creds
    exec: ${REPO_ROOT}/esp32/cube/scripts/bake-creds.sh
    args_passthrough: true
    transient: true
    help: |
      [transient — pre-device-pairing dev hack]
      Bake WiFi/PASETO/etc. from esp32/cube/.e2e-testing into
      firmware/main/sentient_creds.h. Auto-resolves Mac LAN IP +
      mints a fresh PASETO. Retires with proper device-pairing flow.
```

### Auto-detect flow

```
1. If --board <name>: load boards/<name>.yaml. Done.
2. Else scan /dev/cu.usbmodem* (or platform equivalent).
3. For each port: optionally read MAC via esptool, match against boards/*.yaml.
4. Exactly 1 match → use; cache to ~/.config/esp32-devtool/last-board.
5. Zero → exit 3 ("no board connected; --board explicitly?").
6. Two+ → exit 3 ("multiple boards — disambiguate with --board=cube --port=...").
```

Cache key: `(port, manifest_mtime)`. Invalidate if either changes.
