// lvgl-sim/main/sdl2_driver.c — Minimal SDL2 display + indev glue for LVGL.
//
// Adapted from lvgl/lv_port_pc_vscode (simulator template). Single window,
// software framebuffer, mouse-as-touch indev.

#include "sdl2_driver.h"

#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include "lvgl/lvgl.h"

static SDL_Window*    s_window     = NULL;
static SDL_Renderer*  s_renderer   = NULL;
static SDL_Texture*   s_texture    = NULL;
static lv_display_t*  s_display    = NULL;
static lv_indev_t*    s_indev      = NULL;
// LVGL's RGB565 framebuffer. Hoisted to file scope so the snapshot path
// in main.c can read the pixels directly (SDL_RenderReadPixels does not
// work under SDL_VIDEODRIVER=dummy). Intentionally not freed on
// shutdown — process exit reclaims it.
static uint8_t*       s_fb         = NULL;
static int            s_fb_width   = 0;
static int            s_fb_height  = 0;
static int            s_mouse_x    = 0;
static int            s_mouse_y    = 0;
static bool           s_mouse_down = false;

static void flush_cb(lv_display_t* disp, const lv_area_t* area, uint8_t* px_map) {
    (void)disp;
    int w = area->x2 - area->x1 + 1;
    int h = area->y2 - area->y1 + 1;
    SDL_Rect r = { area->x1, area->y1, w, h };
    SDL_UpdateTexture(s_texture, &r, px_map, w * 2);
    SDL_RenderClear(s_renderer);
    SDL_RenderCopy(s_renderer, s_texture, NULL, NULL);
    SDL_RenderPresent(s_renderer);
    lv_display_flush_ready(disp);
}

static void indev_read_cb(lv_indev_t* indev, lv_indev_data_t* data) {
    (void)indev;
    data->point.x = s_mouse_x;
    data->point.y = s_mouse_y;
    data->state = s_mouse_down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

int sentient_sim_sdl2_init(int width, int height) {
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return -1;

    s_window = SDL_CreateWindow("Sentient Cube — lvgl-sim",
                                SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                width, height, 0);
    if (!s_window) return -2;
    // Prefer accelerated; fall back to software so the sim works under
    // SDL_VIDEODRIVER=dummy (used by the headless snapshot mode in main.c,
    // which doesn't expose a GPU to SDL).
    s_renderer = SDL_CreateRenderer(s_window, -1, SDL_RENDERER_ACCELERATED);
    if (!s_renderer) {
        s_renderer = SDL_CreateRenderer(s_window, -1, SDL_RENDERER_SOFTWARE);
    }
    if (!s_renderer) return -3;
    s_texture = SDL_CreateTexture(s_renderer, SDL_PIXELFORMAT_RGB565,
                                  SDL_TEXTUREACCESS_STREAMING, width, height);
    if (!s_texture) return -4;

    s_display = lv_display_create(width, height);
    size_t buf_bytes = (size_t)width * (size_t)height * 2;
    s_fb = (uint8_t*)malloc(buf_bytes);
    if (!s_fb) return -5;
    s_fb_width  = width;
    s_fb_height = height;
    lv_display_set_buffers(s_display, s_fb, NULL, buf_bytes,
                           LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(s_display, flush_cb);

    s_indev = lv_indev_create();
    lv_indev_set_type(s_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_indev, indev_read_cb);
    lv_indev_set_display(s_indev, s_display);

    return 0;
}

bool sentient_sim_sdl2_pump_events(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        switch (e.type) {
            case SDL_QUIT:
                return false;
            case SDL_MOUSEBUTTONDOWN:
                if (e.button.button == SDL_BUTTON_LEFT) s_mouse_down = true;
                break;
            case SDL_MOUSEBUTTONUP:
                if (e.button.button == SDL_BUTTON_LEFT) s_mouse_down = false;
                break;
            case SDL_MOUSEMOTION:
                s_mouse_x = e.motion.x;
                s_mouse_y = e.motion.y;
                break;
            default: break;
        }
    }
    return true;
}

void sentient_sim_sdl2_shutdown(void) {
    if (s_texture)  SDL_DestroyTexture(s_texture);
    if (s_renderer) SDL_DestroyRenderer(s_renderer);
    if (s_window)   SDL_DestroyWindow(s_window);
    SDL_Quit();
}

const uint8_t* sentient_sim_sdl2_framebuffer(int* out_width, int* out_height) {
    if (s_fb == NULL) return NULL;
    if (out_width != NULL)  *out_width  = s_fb_width;
    if (out_height != NULL) *out_height = s_fb_height;
    return s_fb;
}
