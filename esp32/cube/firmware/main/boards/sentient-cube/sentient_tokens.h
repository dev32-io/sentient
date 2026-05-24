// SPDX-License-Identifier: MIT
// sentient_tokens.h
//
// Sentient design tokens — colors mirror gateway/webui/src/styles/tokens/colors.css.
// Animation timings tuned for AMOLED display + low-jank LVGL.
#pragma once

// ---------------------------------------------------------------------------
// Color palette — 0xRRGGBB
// ---------------------------------------------------------------------------
#define SENTIENT_BG_DARK     0x2B2621  // primary background (warm near-black)
#define SENTIENT_BG_DARKER   0x241F1B  // deeper background (card/overlay)
#define SENTIENT_INK         0xF2E8D6  // primary text / foreground
#define SENTIENT_TERRA       0xF2A06A  // listening / active accent (warm orange)
#define SENTIENT_SAGE        0xB9C8A6  // ready / idle accent (muted green)
#define SENTIENT_AMBER       0xE9B168  // warning / highlight (golden)
#define SENTIENT_CLAY        0x9A5A3E  // error / destructive accent (brick)

// ---------------------------------------------------------------------------
// Display geometry (480×480 AMOLED — Waveshare 2.16in)
// ---------------------------------------------------------------------------
#define SENTIENT_DISPLAY_W   480
#define SENTIENT_DISPLAY_H   480

// Toggle button: 220px circle, centered. Smaller than the v1 320px so the
// screen has room for an event/state hint line above and a transcript label
// below (Phase 6a smoke aid — operator needs visual feedback of cube-sdk
// state to drive manual smoke tests). 160px was too small for habitual taps
// to land reliably — 220 keeps the smoke-aid layout while restoring most of
// the original hit-zone (radius 110 vs. 160).
#define SENTIENT_BTN_SIZE    220

// Status hint label: offset above button center (negative Y = upward).
#define SENTIENT_HINT_Y_OFFSET (-160)

// Transcript label: offset below button center (positive Y = downward).
#define SENTIENT_TRANSCRIPT_Y_OFFSET (160)
// Transcript width — multi-line label wraps at this pixel width.
#define SENTIENT_TRANSCRIPT_W        400

// Button border width when in DISABLED state (outline-only style).
#define SENTIENT_BTN_BORDER_W  4

// ---------------------------------------------------------------------------
// Animation timings (ms)
// ---------------------------------------------------------------------------
// Breath cycle period (full in-out period = 2× SENTIENT_BREATH_HALF_MS).
#define SENTIENT_BREATH_HALF_MS   1700   // half-cycle; total = 3400ms
// Breath scale range: 1000–1050 in LVGL transform units (1000 = 1.0×).
#define SENTIENT_BREATH_SCALE_LO  1000
#define SENTIENT_BREATH_SCALE_HI  1050
// Reset scale value (1.0×).
#define SENTIENT_SCALE_NORMAL     1000
