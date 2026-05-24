#pragma once

#include <stdbool.h>
#include <stdint.h>

int  sentient_sim_sdl2_init(int width, int height);
void sentient_sim_sdl2_shutdown(void);
bool sentient_sim_sdl2_pump_events(void);

// Returns a const pointer to LVGL's RGB565 framebuffer + writes the
// width/height in pixels. Returns NULL if the driver hasn't been
// initialized. Used by the snapshot path to encode the framebuffer
// without going through SDL_RenderReadPixels (which doesn't work under
// SDL_VIDEODRIVER=dummy).
const uint8_t* sentient_sim_sdl2_framebuffer(int* out_width, int* out_height);
