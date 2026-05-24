# Third Party Notices — Cube Firmware

The firmware tree under `esp32/cube/firmware/` bundles and depends on the
following third-party software. This is in addition to the root
`THIRD_PARTY_NOTICES.md` covering host-side dependencies.

## Vendored upstream

### xiaozhi-esp32 (flat-tree vendored at SHA `b72945a`) — MIT

Upstream: https://github.com/78/xiaozhi-esp32

The firmware tree under `esp32/cube/firmware/main/` is a vendored snapshot
of xiaozhi-esp32 at commit `b72945a`. Original copyright belongs to the
upstream maintainers. Modifications by the Sentient project are also MIT.

## Managed components (pulled by ESP-IDF component manager at build time)

### Espressif official components — Apache-2.0

ESP-IDF itself, plus all `espressif/*` managed components (`lvgl_port`,
`esp_audio_codec`, `esp_audio_effects`, `esp-sr`, `button`, `knob`,
`led_strip`, all `esp_lcd_*` drivers, and the rest of the
60+ component dependency tree pulled by `idf_component.yml`).
© Espressif Systems.

### LVGL 9.x — MIT

[lvgl/lvgl](https://github.com/lvgl/lvgl). © LVGL Kft. and contributors.

### 78/xiaozhi-fonts ~1.6.0 — MIT (wrapper)

Manifest declares MIT. The bundled font files are derivatives of the
upstream font projects below — those upstream licenses apply to the
compiled `.c` glyph data shipped with the component.

#### Google Noto fonts — SIL Open Font License 1.1

[Noto Sans / Noto Sans CJK](https://fonts.google.com/noto). © Google. SIL OFL 1.1.

#### Alibaba PuHui fonts — SIL Open Font License 1.1

[Alibaba PuHuiTi](https://www.alibabafonts.com/). © Alibaba. SIL OFL 1.1.

Both font licenses permit embedding and redistribution as part of this
firmware. The OFL forbids selling the fonts standalone, which this project
does not do.

### 78/esp-ml307, 78/esp-wifi-connect, 78/esp_lcd_nv3023, 78/uart-eth-modem — Apache-2.0

Managed components by the same maintainer as xiaozhi-esp32. Apache-2.0.

### lecram/gifdec — Public Domain

Source: included at `esp32/cube/firmware/main/display/lvgl_display/gif/gifdec.c`
with the upstream `LICENSE.txt` preserved in the same directory.

## Other / unverified

A clean build resolves the full transitive set of managed components into
`esp32/cube/firmware/managed_components/`. Before each public release run:

```
cd esp32/cube/firmware
idf.py reconfigure   # forces component resolution
python -m idf_component_manager licenses
```

Any component reporting a license other than MIT, Apache-2.0, BSD,
SIL-OFL, or public-domain must be reviewed and added to this notices
file before release.
