/**
 * @file esp32/cube/lvgl-sim/lv_conf.h
 *
 * LVGL configuration for the Sentient Cube host SDL2 simulator.
 *
 * NOT shared with the device. The device's LVGL config is generated from
 * Kconfig (CONFIG_LV_USE_*, CONFIG_LV_OS_*, etc. in
 * `esp32/cube/firmware/sdkconfig.defaults` plus xiaozhi's stock Kconfig).
 *
 * This file is hand-mirrored from those Kconfig values so the host sim
 * renders ui-shared/test_screen.c the same way the device does. When the
 * LVGL managed component is bumped, the following must move together:
 *   - bump version in firmware/main/idf_component.yml
 *   - re-clone LVGL in esp32/cube/lvgl-sim/lvgl at the matching tag
 *   - re-audit this file against the new template's defaults
 *   - audit any new/removed Kconfig flags
 *
 * Pinned LVGL version: 9.5.0
 * Pinned managed-component SHA256 of lv_conf_template.h:
 *   2ece178f34500cbb3755980c1520daee4d15fd2f0893fc68672958708c9c6291
 *
 * Why an owned file for the sim: the spec wants visual parity between
 * device + sim. The sim has no Kconfig generator. Owning the sim's
 * lv_conf.h is the cheapest path to that parity. The 30 LOC of duplication
 * here is paid for by avoiding a 145-flag transcription of the device's
 * Kconfig into a unified header (which would put Phase 1 at regression
 * risk).
 */

#ifndef LV_CONF_H
#define LV_CONF_H

/*====================
   COLOR SETTINGS
 *====================*/

/* RGB565 — matches the device's panel format (CONFIG_LV_COLOR_DEPTH=16). */
#define LV_COLOR_DEPTH 16

/*=========================
   STDLIB WRAPPER SETTINGS
 *=========================*/

/* Use the C library on the host — no FreeRTOS heap here. Device uses
 * LV_STDLIB_BUILTIN via Kconfig; either works for our widget needs. */
#define LV_USE_STDLIB_MALLOC  LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING  LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB

/*====================
   OS + TICK
 *====================*/

/* Host sim drives lv_tick via SDL_GetTicks. The device uses Kconfig's
 * CONFIG_LV_OS_NONE=y (xiaozhi pumps lv_timer_handler from its own
 * task). Both targets: no LVGL-internal OS abstraction. */
#define LV_USE_OS LV_OS_NONE

/* lv_tick_set_cb is called from main/main.c in the sim. */

/*====================
   DRAW + MEMORY
 *====================*/

/* Software draw is enough for the sim. Mirrors CONFIG_LV_USE_DRAW_SW=y. */
#define LV_USE_DRAW_SW 1

/* Static memory pool size for LVGL allocations. 256 KiB is generous for
 * the sim (host has plenty of RAM); matches the order-of-magnitude of
 * the device's pool. */
#define LV_MEM_SIZE (256U * 1024U)

/*====================
   OBJECT METADATA
 *====================*/

/* Device enables CONFIG_LV_USE_OBJ_ID=y, CONFIG_LV_USE_OBJ_NAME=y,
 * CONFIG_LV_USE_OBJ_ID_BUILTIN=y. Mirror so lv_obj layout + lookup APIs
 * match between targets. */
#define LV_USE_OBJ_ID         1
#define LV_USE_OBJ_ID_BUILTIN 1
#define LV_USE_OBJ_NAME       1

/*====================
   WIDGETS used by test_screen.c
 *====================*/

#define LV_USE_LABEL    1
#define LV_USE_SPINNER  1

/* Other widgets default off — test_screen.c uses only the above plus
 * the always-on base obj. */

/*====================
   FONTS
 *====================*/

/* Default font used by lv_label_create when no per-style font is set.
 * Montserrat 14 ships with LVGL. Mirrors CONFIG_LV_FONT_MONTSERRAT_14=y
 * + CONFIG_LV_FONT_DEFAULT_MONTSERRAT_14=y. */
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_DEFAULT       &lv_font_montserrat_14

/*====================
   LOG / DEBUG
 *====================*/

#define LV_USE_LOG       0
#define LV_USE_ASSERT_NULL 1

#endif /* LV_CONF_H */
