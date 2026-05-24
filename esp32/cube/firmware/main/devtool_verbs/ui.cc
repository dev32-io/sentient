// SPDX-License-Identifier: MIT
// devtool_verbs/ui.cc — ui.dump_tree verb.
//
// Walks the active LVGL screen and returns a flat JSON array of widget
// descriptors (one entry per node). The pixel-snapshot path is served via
// HTTP /screenshot in the devtool companion (Task 15) — there is no
// ui.snapshot verb here.
//
// Migrated from components/agent_console/verbs/ui.cc in Task 24.
// All LVGL ops hold the LVGL mutex via lvgl_port_lock/unlock.
// Compile-out: gate on CONFIG_AGENT_CONSOLE_LAYOUT_INSPECTOR (same flag the
// agent_console version used — prod still flips this off; debug keeps =y).
//
// Registered via __attribute__((constructor)) static-init.

#include "sdkconfig.h"

#ifdef CONFIG_AGENT_CONSOLE_LAYOUT_INSPECTOR

#include "esp32_devtool/verbs.h"
#include <cstdio>
#include <cstring>

#include <esp_log.h>
#include <lvgl.h>
#include <esp_lvgl_port.h>

namespace {

constexpr const char* TAG = "sentient.cube.devtool.ui";

constexpr int kDefaultMaxDepth      = 8;
constexpr int kDefaultMaxNodes      = 200;
constexpr int kLvglLockTimeoutMs    = 1000;
constexpr int kLabelPreviewMaxChars = 48;

// ---------------------------------------------------------------------------
// Class-name registry. lv_obj_class_t is opaque in public LVGL headers; we
// resolve a few well-known classes by address. Unknown classes render as
// "unknown" — the addr field still lets the agent grep symbols if curious.
// ---------------------------------------------------------------------------
struct ClassEntry {
    const lv_obj_class_t* cls;
    const char* name;
};

const char* resolve_class_name(const lv_obj_class_t* cls) {
    if (cls == nullptr) return "null";
    static const ClassEntry kRegistry[] = {
        { &lv_obj_class,    "lv_obj"    },
        { &lv_label_class,  "lv_label"  },
        { &lv_button_class, "lv_button" },
        { &lv_image_class,  "lv_image"  },
    };
    for (const ClassEntry& e : kRegistry) {
        if (e.cls == cls) return e.name;
    }
    return "unknown";
}

// ---------------------------------------------------------------------------
// ui.dump_tree
// ---------------------------------------------------------------------------

struct DumpState {
    cJSON* nodes;
    int    max_depth;
    int    max_nodes;
    int    emitted;
    bool   truncated;
    const char* truncate_reason;
};

void dump_node(lv_obj_t* obj, int depth, DumpState* st) {
    if (obj == nullptr || st->truncated) return;
    if (st->emitted >= st->max_nodes) {
        st->truncated = true;
        st->truncate_reason = "max_nodes";
        return;
    }
    if (depth > st->max_depth) {
        st->truncated = true;
        st->truncate_reason = "depth";
        return;
    }

    cJSON* node = cJSON_CreateObject();
    cJSON_AddNumberToObject(node, "depth", depth);
    cJSON_AddStringToObject(node, "class", resolve_class_name(lv_obj_get_class(obj)));

    char addr[20];
    std::snprintf(addr, sizeof(addr), "%p", (const void*)obj);
    cJSON_AddStringToObject(node, "addr", addr);

#if LV_USE_OBJ_NAME
    const char* nm = lv_obj_get_name(obj);
    if (nm != nullptr && nm[0] != '\0') cJSON_AddStringToObject(node, "name", nm);
#endif

    cJSON_AddNumberToObject(node, "x", lv_obj_get_x(obj));
    cJSON_AddNumberToObject(node, "y", lv_obj_get_y(obj));
    cJSON_AddNumberToObject(node, "w", lv_obj_get_width(obj));
    cJSON_AddNumberToObject(node, "h", lv_obj_get_height(obj));

    cJSON_AddBoolToObject(node, "hidden",
        lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN));
    cJSON_AddBoolToObject(node, "clickable",
        lv_obj_has_flag(obj, LV_OBJ_FLAG_CLICKABLE));

    if (lv_obj_get_class(obj) == &lv_label_class) {
        const char* txt = lv_label_get_text(obj);
        if (txt != nullptr) {
            char preview[kLabelPreviewMaxChars + 4];
            size_t n = std::strlen(txt);
            if (n > kLabelPreviewMaxChars) {
                std::memcpy(preview, txt, kLabelPreviewMaxChars);
                std::memcpy(preview + kLabelPreviewMaxChars, "...", 4);
            } else {
                std::memcpy(preview, txt, n + 1);
            }
            cJSON_AddStringToObject(node, "label", preview);
        }
    }

    uint32_t child_count = lv_obj_get_child_count(obj);
    cJSON_AddNumberToObject(node, "child_count", (double)child_count);

    cJSON_AddItemToArray(st->nodes, node);
    st->emitted++;

    for (uint32_t i = 0; i < child_count; i++) {
        dump_node(lv_obj_get_child(obj, i), depth + 1, st);
        if (st->truncated) return;
    }
}

int handle_ui_dump_tree(const cJSON* params, cJSON* out_result,
                        int* ec, const char** em) {
    int max_depth = kDefaultMaxDepth;
    int max_nodes = kDefaultMaxNodes;
    if (cJSON_IsObject(params)) {
        const cJSON* d = cJSON_GetObjectItem(params, "depth");
        const cJSON* n = cJSON_GetObjectItem(params, "max_nodes");
        if (cJSON_IsNumber(d) && d->valueint > 0)  max_depth = d->valueint;
        if (cJSON_IsNumber(n) && n->valueint > 0)  max_nodes = n->valueint;
    }

    if (!lvgl_port_lock(kLvglLockTimeoutMs)) {
        ESP_LOGW(TAG, "dump_tree: lvgl-lock-timeout");
        *ec = -32603;
        *em = "lvgl lock timeout";
        return 1;
    }

    DumpState st = {
        .nodes = cJSON_CreateArray(),
        .max_depth = max_depth,
        .max_nodes = max_nodes,
        .emitted = 0,
        .truncated = false,
        .truncate_reason = nullptr,
    };

    lv_obj_t* screen = lv_screen_active();
    dump_node(screen, 0, &st);

    lvgl_port_unlock();

    cJSON_AddItemToObject(out_result, "nodes", st.nodes);
    cJSON_AddBoolToObject(out_result, "truncated", st.truncated);
    if (st.truncated && st.truncate_reason != nullptr) {
        cJSON_AddStringToObject(out_result, "truncate_reason", st.truncate_reason);
    }
    cJSON_AddNumberToObject(out_result, "node_count", st.emitted);

    ESP_LOGD(TAG, "dump_tree emitted=%d truncated=%d", st.emitted, (int)st.truncated);
    return 0;
}

__attribute__((constructor))
static void register_ui_dump_tree_verb(void) {
    devtool_register_verb("ui.dump_tree", handle_ui_dump_tree);
}

}  // namespace

#endif  // CONFIG_AGENT_CONSOLE_LAYOUT_INSPECTOR
