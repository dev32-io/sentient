#include "companion.h"
#include <cJSON.h>
#include <cmath>
#include <cstring>
#include <memory>

namespace sentient::cube {
namespace {
const cJSON* field(const cJSON* object, const char* key) {
    return cJSON_GetObjectItemCaseSensitive(object, key);
}
bool number(const cJSON* value, uint32_t min, uint32_t max, uint32_t& out) {
    if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble) ||
        value->valuedouble < min || value->valuedouble > max ||
        std::floor(value->valuedouble) != value->valuedouble) return false;
    out = static_cast<uint32_t>(value->valuedouble);
    return true;
}
bool text(const cJSON* value, std::string& out, size_t max = 48) {
    if (!cJSON_IsString(value) || !value->valuestring) return false;
    const size_t length = strlen(value->valuestring);
    if (!length || length > max) return false;
    out = value->valuestring;
    return true;
}
bool identifier(const char* name) {
    if (!name || !*name || strlen(name) > 48) return false;
    for (const char* p = name; *p; ++p)
        if (!(*p >= 'a' && *p <= 'z') && !(*p >= '0' && *p <= '9') && *p != '-') return false;
    return true;
}
bool object(const cJSON* value, size_t max) {
    if (!cJSON_IsObject(value)) return false;
    size_t count = 0;
    for (auto* p = value->child; p; p = p->next) {
        if (++count > max || !p->string) return false;
        for (auto* q = value->child; q != p; q = q->next)
            if (!strcmp(p->string, q->string)) return false;
    }
    return count > 0;
}
// Bound tree allocation and recursion before handing untrusted JSON to cJSON.
bool bounded_json(const uint8_t* json, size_t size) {
    if (!json || !size || size > 16384) return false;
    unsigned depth = 0; bool quoted = false, escaped = false;
    for (size_t i = 0; i < size; ++i) {
        char c = static_cast<char>(json[i]);
        if (!c) return false;
        if (quoted) {
            if (escaped) { escaped = false; continue; }
            if (c == '\\') {
                // cJSON strings cannot represent embedded NUL without truncation.
                if (i + 5 < size && !memcmp(json + i, "\\u0000", 6)) return false;
                escaped = true;
            } else if (c == '"') quoted = false;
        } else if (c == '"') quoted = true;
        else if (c == '{' || c == '[') { if (++depth > 12) return false; }
        else if (c == '}' || c == ']') { if (!depth) return false; --depth; }
    }
    return !depth && !quoted;
}
size_t find_clip(const Companion& doc, const std::string& name) {
    for (size_t i = 0; i < doc.clips.size(); ++i) if (doc.clips[i].state == name) return i;
    return doc.clips.size();
}
const CompanionClip* resolve(const Companion& doc, size_t index) {
    // Iterative bounded traversal, including explicit alias fallback chains.
    for (size_t n = 0; n < doc.clips.size(); ++n) {
        if (index >= doc.clips.size()) return nullptr;
        const auto& clip = doc.clips[index];
        if (clip.fallback.empty()) return &clip;
        index = find_clip(doc, clip.fallback);
    }
    return nullptr;
}
bool parse(Companion& doc, const cJSON* root, ResourceReader reader) {
    uint32_t version, width, height;
    if (!object(root, 9) || !number(field(root, "schemaVersion"), 1, 1, version) ||
        !text(field(root, "id"), doc.id) || !identifier(doc.id.c_str()) ||
        !text(field(root, "name"), doc.name, 96) ||
        !number(field(root, "revision"), 1, UINT32_MAX, doc.revision)) return false;
    const auto* canvas = field(root, "canvas");
    std::string background;
    if (!object(canvas, 3) || !number(field(canvas, "width"), 1, 128, width) ||
        !number(field(canvas, "height"), 1, 128, height) ||
        !text(field(canvas, "background"), background, 7) || background.size() != 7 || background[0] != '#') return false;
    for (size_t i = 1; i < 7; ++i) {
        const char c = background[i];
        const int digit = c >= '0' && c <= '9' ? c - '0' :
                          c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                          c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (digit < 0) return false;
        doc.background = (doc.background << 4) | digit;
    }
    doc.width = width; doc.height = height;
    const size_t bytes = size_t(width) * height * 2; // Dimensions bounded before multiplication.
    const auto* frames = field(root, "frames");
    if (!object(frames, 32)) return false;
    doc.frames.reserve(cJSON_GetArraySize(frames));
    for (auto* p = frames->child; p; p = p->next) {
        std::string path, format;
        if (!identifier(p->string) || !object(p, 2) || !text(field(p, "asset"), path, 160) ||
            !text(field(p, "format"), format) || format != "rgb565") return false;
        const std::string prefix = "/companions/" + doc.id + "/";
        if (path.compare(0, prefix.size(), prefix) || path.size() <= prefix.size() + 7 ||
            path.substr(path.size() - 7) != ".rgb565" ||
            !identifier(path.substr(prefix.size(), path.size() - prefix.size() - 7).c_str())) return false;
        const uint8_t* pixels; size_t size;
        if (!reader.get(path.c_str(), pixels, size) || size != bytes) return false;
        doc.frames.push_back({p->string, pixels});
    }
    const auto* states = field(root, "states");
    if (!object(states, 16)) return false;
    doc.clips.reserve(cJSON_GetArraySize(states));
    size_t total_steps = 0;
    for (auto* p = states->child; p; p = p->next) {
        if (!identifier(p->string) || !object(p, 4)) return false;
        CompanionClip clip; clip.state = p->string;
        if (field(p, "fallback")) {
            if (cJSON_GetArraySize(p) != 1 || !text(field(p, "fallback"), clip.fallback) ||
                !identifier(clip.fallback.c_str())) return false;
        } else {
            std::string mode;
            if (!text(field(p, "mode"), mode)) return false;
            if (mode == "static") clip.mode = ClipMode::Static;
            else if (mode == "once-and-hold") clip.mode = ClipMode::OnceAndHold;
            else if (mode == "loop") clip.mode = ClipMode::Loop;
            else return false;
            const auto* steps = field(p, "frames");
            const int count = cJSON_GetArraySize(steps);
            if (!cJSON_IsArray(steps) || count < 1 || count > 32 || (total_steps += count) > 128 ||
                (clip.mode == ClipMode::Static && count != 1)) return false;
            clip.steps.reserve(count);
            for (auto* step = steps->child; step; step = step->next) {
                std::string frame; uint32_t duration;
                if (!object(step, 2) || !text(field(step, "frame"), frame) ||
                    !number(field(step, "durationMs"), 1, 60000, duration)) return false;
                size_t index = 0;
                while (index < doc.frames.size() && doc.frames[index].name != frame) ++index;
                if (index == doc.frames.size() || duration > 3600000 - clip.duration_ms) return false;
                clip.steps.push_back({index, duration}); clip.duration_ms += duration;
            }
            if (const auto* loop = field(p, "loopFrom")) {
                uint32_t from;
                if (clip.mode != ClipMode::Loop || !number(loop, 0, count - 1, from)) return false;
                clip.loop_from = from;
            }
            for (size_t i = 0; i < clip.loop_from; ++i) clip.prefix_ms += clip.steps[i].duration_ms;
        }
        doc.clips.push_back(std::move(clip));
    }
    std::string fallback;
    if (!text(field(root, "fallback"), fallback)) return false;
    doc.fallback = find_clip(doc, fallback);
    if (!resolve(doc, doc.fallback)) return false;
    for (size_t i = 0; i < doc.clips.size(); ++i) if (!resolve(doc, i)) return false;
    return true;
}
} // namespace
bool Companion::load(const uint8_t* json, size_t size, ResourceReader reader) {
    *this = {};
    if (!bounded_json(json, size)) return false;
    const char* end = nullptr;
    std::unique_ptr<cJSON, decltype(&cJSON_Delete)> root(
        cJSON_ParseWithLengthOpts(reinterpret_cast<const char*>(json), size, &end, false), cJSON_Delete);
    if (!root || !end) return false;
    const char* limit = reinterpret_cast<const char*>(json) + size;
    while (end < limit && (*end == ' ' || *end == '\n' || *end == '\r' || *end == '\t')) ++end;
    if (end != limit) return false;
    Companion candidate;
    if (!parse(candidate, root.get(), reader)) return false;
    *this = std::move(candidate);
    return true;
}
const CompanionClip* Companion::clip(const char* state) const {
    size_t index = find_clip(*this, state);
    return resolve(*this, index == clips.size() ? fallback : index);
}
void CompanionPlayer::select(const char* state, uint32_t now) {
    if (clip_ && state_ == state) return;
    state_ = state; clip_ = companion_.clip(state); entered_ = now;
}
void CompanionPlayer::stop() { clip_ = nullptr; state_.clear(); }
PlaybackFrame CompanionPlayer::sample(uint32_t now) const {
    if (!clip_ || clip_->steps.empty()) return {};
    uint32_t elapsed = now - entered_; // Unsigned LVGL tick rollover.
    if (clip_->mode == ClipMode::Static) return {clip_->steps.front().frame, 0, true};
    if (clip_->mode == ClipMode::OnceAndHold && elapsed >= clip_->duration_ms)
        return {clip_->steps.back().frame, 0, true};
    if (clip_->mode == ClipMode::Loop && elapsed >= clip_->prefix_ms)
        elapsed = clip_->prefix_ms + (elapsed - clip_->prefix_ms) % (clip_->duration_ms - clip_->prefix_ms);
    for (size_t i = 0; i < clip_->steps.size(); ++i) {
        const auto& step = clip_->steps[i];
        if (elapsed < step.duration_ms)
            return {step.frame, clip_->mode == ClipMode::OnceAndHold && i + 1 == clip_->steps.size() ? 0 : step.duration_ms - elapsed, true};
        elapsed -= step.duration_ms;
    }
    return {};
}
} // namespace sentient::cube
