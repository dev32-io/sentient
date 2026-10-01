#include "companion.h"
#include "source_resources.h"
#include <cJSON.h>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
using namespace sentient::cube;
#define CHECK(condition) do { if (!(condition)) { \
    std::fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #condition); return 1; \
} } while (0)
static cJSON* field(cJSON* object, const char* key) { return cJSON_GetObjectItemCaseSensitive(object, key); }
int main() {
    SourceResources resources;
    const uint8_t* bytes; size_t size;
    CHECK(resources.reader().get("/companions/cat/companion.json", bytes, size));
    const std::string json(reinterpret_cast<const char*>(bytes), size);
    Companion doc;
    CHECK(doc.load(bytes, size, resources.reader()));
    CHECK(doc.width == 32 && doc.height == 32 && doc.background == 0x2b2621 && doc.revision == 1);
    CompanionPlayer player(doc);
    const auto frame = [&](const char* state, uint32_t elapsed) {
        player.stop(); player.select(state, 0); return player.sample(elapsed);
    };
    const auto ready = frame("ready", 0);
    CHECK(ready.visible && ready.next_ms == 3300);
    CHECK(frame("ready", 3300).frame != ready.frame);
    CHECK(frame("ready", 3420).frame == ready.frame);
    CHECK(frame("ready", 3600).next_ms == 3300);
    CHECK(frame("pairing", 3300).frame != ready.frame);
    CHECK(frame("volume", 900).frame != ready.frame);
    const auto listening = frame("listening", 0);
    CHECK(listening.frame != ready.frame && listening.next_ms == 900);
    CHECK(frame("listening", 900).frame != listening.frame);
    CHECK(frame("listening", 1020).frame == listening.frame);
    CHECK(frame("listening", 4500).frame != listening.frame);
    CHECK(frame("thinking", 0).frame == ready.frame);
    const auto thinking = frame("thinking", 180);
    CHECK(thinking.frame != ready.frame);
    CHECK(frame("thinking", 1080).frame != thinking.frame);
    CHECK(frame("thinking", 1200).frame == thinking.frame);
    CHECK(frame("thinking", 3780).frame == thinking.frame); // Intro does not repeat.
    const auto speaking = frame("speaking", 0);
    CHECK(speaking.frame != ready.frame && speaking.next_ms == 500);
    CHECK(frame("speaking", 500).frame == ready.frame);
    CHECK(frame("speaking", 1000).frame == speaking.frame);
    const auto quiet = frame("no-wifi", 0);
    CHECK(frame("service", 3300).frame != quiet.frame);
    CHECK(frame("account", 0).frame == quiet.frame && frame("low", 0).frame == quiet.frame);
    CHECK(frame("missing-state", 0).frame == ready.frame); // Explicit document fallback.
    player.stop(); player.select("ready", UINT32_MAX - 100);
    CHECK(player.sample(3199).frame != ready.frame); // Tick wrap: elapsed 3300.
    player.select("ready", 3199);
    CHECK(player.sample(3199).frame != ready.frame); // No restart.
    player.select("listening", 3199); CHECK(player.sample(3199).frame == listening.frame);
    player.stop(); CHECK(!player.sample(5000).visible);

    auto modified = [&](const std::function<void(cJSON*)>& edit, bool expected) {
        std::unique_ptr<cJSON, decltype(&cJSON_Delete)> root(cJSON_Parse(json.c_str()), cJSON_Delete);
        edit(root.get());
        char* printed = cJSON_PrintUnformatted(root.get());
        const bool valid = doc.load(reinterpret_cast<const uint8_t*>(printed), strlen(printed), resources.reader());
        cJSON_free(printed);
        return valid == expected && (expected || doc.frames.empty());
    };
    auto ready_clip = [](cJSON* root) { return field(field(root, "states"), "ready"); };
    CHECK(modified([&](cJSON* root) {
        cJSON_ReplaceItemInObject(ready_clip(root), "mode", cJSON_CreateString("once-and-hold"));
    }, true));
    CompanionPlayer once(doc); once.select("ready", 0);
    CHECK(once.sample(3300).next_ms == 120);
    CHECK(once.sample(3420).frame == ready.frame && once.sample(3420).next_ms == 0);
    CHECK(once.sample(50000).frame == ready.frame && once.sample(50000).next_ms == 0);
    CHECK(modified([&](cJSON* root) {
        auto* clip = ready_clip(root);
        cJSON_ReplaceItemInObject(clip, "mode", cJSON_CreateString("static"));
        auto* frames = field(clip, "frames");
        cJSON_DeleteItemFromArray(frames, 2); cJSON_DeleteItemFromArray(frames, 1);
    }, true));
    CompanionPlayer still(doc); still.select("ready", 0);
    CHECK(still.sample(9999).frame == ready.frame && still.sample(9999).next_ms == 0);
    CHECK(modified([](cJSON* root) { cJSON_SetNumberValue(field(root, "schemaVersion"), 2); }, false));
    CHECK(modified([](cJSON* root) { cJSON_SetNumberValue(field(root, "revision"), 0); }, false));
    CHECK(modified([](cJSON* root) { cJSON_SetNumberValue(field(field(root, "canvas"), "width"), 4294967296.0); }, false));
    CHECK(modified([](cJSON* root) { cJSON_SetNumberValue(field(field(root, "canvas"), "height"), 31); }, false));
    CHECK(modified([](cJSON* root) {
        cJSON_ReplaceItemInObject(field(field(root, "frames"), "ready"), "format", cJSON_CreateString("native"));
    }, false));
    CHECK(modified([](cJSON* root) {
        cJSON_ReplaceItemInObject(field(field(root, "frames"), "ready"), "asset", cJSON_CreateString("/companions/cat/../ready.rgb565"));
    }, false));
    CHECK(modified([&](cJSON* root) {
        cJSON_ReplaceItemInObject(cJSON_GetArrayItem(field(ready_clip(root), "frames"), 0), "frame", cJSON_CreateString("unknown"));
    }, false));
    for (double value : {0., -1., 0.5, 60001., 4294967296.}) CHECK(modified([&](cJSON* root) {
        cJSON_SetNumberValue(field(cJSON_GetArrayItem(field(ready_clip(root), "frames"), 0), "durationMs"), value);
    }, false));
    CHECK(modified([&](cJSON* root) { cJSON_AddNumberToObject(ready_clip(root), "loopFrom", 3); }, false));
    CHECK(modified([&](cJSON* root) {
        cJSON_ReplaceItemInObject(ready_clip(root), "mode", cJSON_CreateString("bounce"));
    }, false));
    CHECK(modified([&](cJSON* root) {
        auto* frames = field(ready_clip(root), "frames");
        for (unsigned i = 3; i < 33; ++i) cJSON_AddItemToArray(frames, cJSON_Duplicate(frames->child, true));
    }, false));
    CHECK(modified([&](cJSON* root) { cJSON_DeleteItemFromObject(root, "fallback"); }, false));
    CHECK(modified([&](cJSON* root) { cJSON_ReplaceItemInObject(root, "fallback", cJSON_CreateString("missing")); }, false));
    CHECK(modified([&](cJSON* root) {
        cJSON_ReplaceItemInObject(field(field(root, "states"), "charging"), "fallback", cJSON_CreateString("charging"));
    }, false));
    CHECK(modified([&](cJSON* root) {
        auto* states = field(root, "states");
        cJSON_ReplaceItemInObject(field(states, "charging"), "fallback", cJSON_CreateString("pairing"));
        cJSON_ReplaceItemInObject(field(states, "pairing"), "fallback", cJSON_CreateString("charging"));
    }, false));
    CHECK(modified([&](cJSON* root) { cJSON_AddItemToObject(field(root, "states"), "ready", cJSON_Duplicate(ready_clip(root), true)); }, false));
    resources.missing = "/companions/cat/blink.rgb565";
    CHECK(!doc.load(bytes, size, resources.reader()) && doc.frames.empty());
    resources.missing.clear();
    auto& raster = resources.buffers.at("/companions/cat/ready.rgb565"); raster.pop_back();
    CHECK(!doc.load(bytes, size, resources.reader()) && doc.frames.empty());
    CHECK(!doc.load(reinterpret_cast<const uint8_t*>((json + " garbage").data()), json.size() + 8, resources.reader()));
    const std::string deep = std::string(13, '[') + "0" + std::string(13, ']');
    CHECK(!doc.load(reinterpret_cast<const uint8_t*>(deep.data()), deep.size(), resources.reader()));
    std::string huge(16385, ' '); CHECK(!doc.load(reinterpret_cast<const uint8_t*>(huge.data()), huge.size(), resources.reader()));
    const char nul[] = "{\"id\":\"cat\\u0000evil\"}";
    CHECK(!doc.load(reinterpret_cast<const uint8_t*>(nul), sizeof(nul) - 1, resources.reader()));
    std::puts("companion parser/player contract checks passed");
}
