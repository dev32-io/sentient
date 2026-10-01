#include "character_data.h"

bool CharacterData::load(sentient::cube::ResourceReader reader) {
    player_.stop();
    images_.clear();
    const uint8_t* json; size_t size;
    if (!reader.get("/companions/cat/companion.json", json, size) ||
        !companion_.load(json, size, reader)) return false;
    images_.reserve(companion_.frames.size());
    for (const auto& frame : companion_.frames) {
        lv_image_dsc_t image{};
        image.header.magic = LV_IMAGE_HEADER_MAGIC;
        image.header.cf = LV_COLOR_FORMAT_RGB565;
        image.header.w = companion_.width; image.header.h = companion_.height;
        image.header.stride = companion_.width * 2;
        image.data_size = size_t(companion_.width) * companion_.height * 2;
        image.data = frame.pixels;
        images_.push_back(image);
    }
    return true;
}
void CharacterData::select(CubeScene scene, uint32_t now) {
    const char* state = "ready";
    switch (scene) {
        case CubeScene::Sleep: case CubeScene::Setup: player_.stop(); return;
        case CubeScene::Listening: state = "listening"; break;
        case CubeScene::Thinking: state = "thinking"; break;
        case CubeScene::Speaking: state = "speaking"; break;
        case CubeScene::NoWifi: state = "no-wifi"; break;
        case CubeScene::Service: state = "service"; break;
        case CubeScene::Account: state = "account"; break;
        case CubeScene::Low: state = "low"; break;
        case CubeScene::Volume: state = "volume"; break;
        case CubeScene::Charging: state = "charging"; break;
        case CubeScene::Pairing: state = "pairing"; break;
        default: break;
    }
    player_.select(state, now);
}
CharacterFrame CharacterData::sample(uint32_t now) const {
    const auto frame = player_.sample(now);
    return {frame.visible ? &images_[frame.frame] : nullptr, frame.next_ms};
}
