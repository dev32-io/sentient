#pragma once
#include "companion.h"
#include "cube_presentation.h"
#include <lvgl.h>

struct CharacterFrame { const lv_image_dsc_t* image; uint32_t next_ms; };
// LVGL descriptors stay outside the document; immutable pixels remain reader-owned.
class CharacterData {
public:
    CharacterData() : player_(companion_) {}
    bool load(sentient::cube::ResourceReader reader);
    void select(CubeScene scene, uint32_t now);
    void stop() { player_.stop(); }
    CharacterFrame sample(uint32_t now) const;
    const sentient::cube::Companion& document() const { return companion_; }
private:
    sentient::cube::Companion companion_;
    sentient::cube::CompanionPlayer player_;
    std::vector<lv_image_dsc_t> images_;
};
