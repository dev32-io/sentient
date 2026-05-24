// lvgl-sim/main/main.c — Sentient Cube LVGL host simulator entry point.
//
// Two modes:
//   1. Windowed (default): opens an SDL2 window, runs the test screen, pumps
//      LVGL ticks at ~200 Hz until the window is closed. For human UI work.
//   2. Headless snapshot: --snapshot PATH renders a single frame of the test
//      screen with SDL_VIDEODRIVER=dummy, dumps the framebuffer to PATH as a
//      PNG, exits. For agentic UI work (an automated operator runs the binary
//      and reads the resulting PNG to verify rendering without needing a
//      display server).
//
// PNG encoding via the bundled stb_image_write.h (single-header public
// domain library; sha256 recorded in the README).

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <SDL.h>

#include "lvgl/lvgl.h"
#include "sdl2_driver.h"
#include "test_screen.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#define SENTIENT_SIM_WIDTH       466
#define SENTIENT_SIM_HEIGHT      466
// Frames to drive before snapshot. ~500 ms simulated time at 5 ms/tick:
// long enough for the spinner to settle into a clearly non-zero rotation
// and for any one-shot anim init code paths to land.
#define SENTIENT_SIM_SETTLE_TICKS 100
#define SENTIENT_SIM_TICK_MS     5

static uint32_t tick_get_ms(void) {
    return SDL_GetTicks();
}

// RGB565 -> packed RGB888 (3 bytes per pixel). Returns malloc'd buffer
// caller must free.
static uint8_t* rgb565_to_rgb888(const uint8_t* fb, int width, int height) {
    size_t pixels = (size_t)width * (size_t)height;
    uint8_t* out = (uint8_t*)malloc(pixels * 3);
    if (out == NULL) return NULL;
    for (size_t i = 0; i < pixels; ++i) {
        uint16_t v = ((uint16_t)fb[i * 2 + 1] << 8) | (uint16_t)fb[i * 2];
        uint8_t r5 = (v >> 11) & 0x1f;
        uint8_t g6 = (v >>  5) & 0x3f;
        uint8_t b5 =  v        & 0x1f;
        out[i * 3 + 0] = (uint8_t)((r5 << 3) | (r5 >> 2));
        out[i * 3 + 1] = (uint8_t)((g6 << 2) | (g6 >> 4));
        out[i * 3 + 2] = (uint8_t)((b5 << 3) | (b5 >> 2));
    }
    return out;
}

static int run_snapshot(const char* out_path) {
    SDL_setenv("SDL_VIDEODRIVER", "dummy", 1);

    lv_init();
    lv_tick_set_cb(tick_get_ms);

    int rc = sentient_sim_sdl2_init(SENTIENT_SIM_WIDTH, SENTIENT_SIM_HEIGHT);
    if (rc != 0) {
        fprintf(stderr, "[lvgl-sim] SDL2 init failed (rc=%d) under dummy driver\n", rc);
        return 1;
    }

    sentient_test_screen_build();

    for (int i = 0; i < SENTIENT_SIM_SETTLE_TICKS; ++i) {
        lv_timer_handler();
        SDL_Delay(SENTIENT_SIM_TICK_MS);
    }

    int width = 0, height = 0;
    const uint8_t* fb = sentient_sim_sdl2_framebuffer(&width, &height);
    if (fb == NULL || width == 0 || height == 0) {
        fprintf(stderr, "[lvgl-sim] framebuffer not available for snapshot\n");
        sentient_sim_sdl2_shutdown();
        return 2;
    }

    uint8_t* rgb888 = rgb565_to_rgb888(fb, width, height);
    if (rgb888 == NULL) {
        fprintf(stderr, "[lvgl-sim] RGB888 conversion malloc failed\n");
        sentient_sim_sdl2_shutdown();
        return 3;
    }

    int ok = stbi_write_png(out_path, width, height, 3, rgb888, width * 3);
    free(rgb888);
    sentient_sim_sdl2_shutdown();

    if (ok == 0) {
        fprintf(stderr, "[lvgl-sim] stbi_write_png failed for %s\n", out_path);
        return 4;
    }

    printf("[lvgl-sim] snapshot saved: %s (%dx%d)\n", out_path, width, height);
    return 0;
}

static int run_windowed(void) {
    lv_init();
    lv_tick_set_cb(tick_get_ms);

    int sdl_rc = sentient_sim_sdl2_init(SENTIENT_SIM_WIDTH, SENTIENT_SIM_HEIGHT);
    if (sdl_rc != 0) {
        fprintf(stderr, "[lvgl-sim] SDL2 init failed (rc=%d)\n", sdl_rc);
        return 1;
    }

    sentient_test_screen_build();
    printf("[lvgl-sim] running %dx%d. Close the window to exit.\n",
           SENTIENT_SIM_WIDTH, SENTIENT_SIM_HEIGHT);

    bool running = true;
    while (running) {
        running = sentient_sim_sdl2_pump_events();
        lv_timer_handler();
        SDL_Delay(SENTIENT_SIM_TICK_MS);
    }

    sentient_sim_sdl2_shutdown();
    return 0;
}

int main(int argc, char* argv[]) {
    const char* snapshot_path = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--snapshot") == 0 && (i + 1) < argc) {
            snapshot_path = argv[++i];
        } else if (strncmp(argv[i], "--snapshot=", 11) == 0) {
            snapshot_path = argv[i] + 11;
        }
    }

    if (snapshot_path != NULL) {
        return run_snapshot(snapshot_path);
    }
    return run_windowed();
}
