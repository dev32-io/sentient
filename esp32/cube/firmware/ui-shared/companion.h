#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sentient::cube {
// Reader owns immutable bytes for the entire UI lifetime. No platform headers.
using AssetReader = bool (*)(void*, const char*, const uint8_t*&, size_t&);
struct ResourceReader {
    void* context = nullptr;
    AssetReader read = nullptr;
    bool get(const char* path, const uint8_t*& data, size_t& size) const {
        data = nullptr; size = 0;
        return read && read(context, path, data, size) && data;
    }
};

struct CompanionFrame { std::string name; const uint8_t* pixels; };
struct CompanionStep { size_t frame; uint32_t duration_ms; };
enum class ClipMode { Static, OnceAndHold, Loop };
struct CompanionClip {
    std::string state, fallback;
    ClipMode mode = ClipMode::Static;
    std::vector<CompanionStep> steps;
    size_t loop_from = 0;
    uint32_t duration_ms = 0, prefix_ms = 0;
};
struct Companion {
    std::string id, name;
    uint32_t revision = 0, background = 0;
    uint16_t width = 0, height = 0;
    std::vector<CompanionFrame> frames;
    std::vector<CompanionClip> clips;
    size_t fallback = 0;
    // Transactional: failure leaves no partially usable document.
    bool load(const uint8_t* json, size_t size, ResourceReader reader);
    const CompanionClip* clip(const char* state) const;
};
struct PlaybackFrame { size_t frame = 0; uint32_t next_ms = 0; bool visible = false; };
class CompanionPlayer {
public:
    explicit CompanionPlayer(const Companion& companion) : companion_(companion) {}
    void select(const char* state, uint32_t now);
    void stop();
    PlaybackFrame sample(uint32_t now) const;
private:
    const Companion& companion_;
    const CompanionClip* clip_ = nullptr;
    std::string state_;
    uint32_t entered_ = 0;
};
} // namespace sentient::cube
