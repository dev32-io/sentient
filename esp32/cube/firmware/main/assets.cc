#include "assets.h"
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
#include "asset_archive.h"
extern const uint8_t cube_assets_start[] asm("_binary_cube_assets_bin_start");
extern const uint8_t cube_assets_end[] asm("_binary_cube_assets_bin_end");
#endif
#include "board.h"
#include "display.h"
#include "application.h"
#include "lvgl_theme.h"
#include "emote_display.h"
#include "expression_emote.h"
#if HAVE_LVGL
#include "display/lcd_display.h"
#include <spi_flash_mmap.h>
#endif

#include <esp_log.h>
#include <esp_timer.h>
#include <esp_heap_caps.h>
#include <cbin_font.h>
#include <cstring>


#define TAG "Assets"
#define PARTITION_LABEL "assets"

struct mmap_assets_table {
    char asset_name[32];          /*!< Name of the asset */
    uint32_t asset_size;          /*!< Size of the asset */
    uint32_t asset_offset;        /*!< Offset of the asset */
    uint16_t asset_width;         /*!< Width of the asset */
    uint16_t asset_height;        /*!< Height of the asset */
};

Assets::Assets() {
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    const int64_t started = esp_timer_get_time();
    partition_valid_ = cube_assets::Decode(cube_assets_start,
        cube_assets_end - cube_assets_start, bundled_data_, bundled_count_);
    ESP_LOGI(TAG, "Bundled assets ready=%d entries=%u load_ms=%lu", partition_valid_,
        unsigned(bundled_count_), static_cast<unsigned long>((esp_timer_get_time() - started) / 1000));
#else
#if HAVE_LVGL
    strategy_ = std::make_unique<Assets::LvglStrategy>();
#else
    strategy_ = std::make_unique<Assets::EmoteStrategy>();
#endif
    // Initialize the partition
    InitializePartition();
#endif
}

Assets::~Assets() {
    UnApplyPartition();
    // Cube decoded storage intentionally has process lifetime: theme/font
    // static destruction order must not invalidate their backing pointers.
}

bool Assets::FindPartition(Assets* assets) {
    assets->partition_ = esp_partition_find_first(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, PARTITION_LABEL);
    if (assets->partition_ == nullptr) {
        ESP_LOGI(TAG, "No assets partition found");
        return false;
    }
    return true;
}

bool Assets::Apply(bool refresh_display_theme) {
    return strategy_ ? strategy_->Apply(this, refresh_display_theme) : false;
}

bool Assets::InitializePartition() {
    return strategy_ ? strategy_->InitializePartition(this) : false;
}

void Assets::UnApplyPartition() {
    if (strategy_) {
        strategy_->UnApplyPartition(this);
    }
}

bool Assets::GetAssetData(const std::string& name, void*& ptr, size_t& size) {
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    // Legacy SR consumers use this spelling; the stored namespace is absolute.
    const char* path = name == "index.json" ? "/index.json" : name.c_str();
    return cube_assets::Find(bundled_data_, bundled_count_, path, ptr, size);
#else
    return strategy_ ? strategy_->GetAssetData(this, name, ptr, size) : false;
#endif
}

bool Assets::LoadSrmodelsFromIndex(Assets* assets, cJSON* root) {
    void* ptr = nullptr;
    size_t size = 0;
    bool need_delete_root = false;

    // If root is not provided, parse index.json
    if (root == nullptr) {
        if (!assets->GetAssetData("index.json", ptr, size)) {
            ESP_LOGE(TAG, "The index.json file is not found");
            return false;
        }

        root = cJSON_ParseWithLength(static_cast<char*>(ptr), size);
        if (root == nullptr) {
            ESP_LOGE(TAG, "The index.json file is not valid");
            return false;
        }
        need_delete_root = true;
    }

    cJSON* srmodels = cJSON_GetObjectItem(root, "srmodels");
    if (cJSON_IsString(srmodels)) {
        std::string srmodels_file = srmodels->valuestring;
        if (assets->GetAssetData(srmodels_file, ptr, size)) {
            if (assets->models_list_ != nullptr) {
                esp_srmodel_deinit(assets->models_list_);
                assets->models_list_ = nullptr;
            }
            assets->models_list_ = srmodel_load(static_cast<uint8_t*>(ptr));
            if (assets->models_list_ != nullptr) {
                auto& app = Application::GetInstance();
                app.GetAudioService().SetModelsList(assets->models_list_);
                if (need_delete_root) {
                    cJSON_Delete(root);
                }
                return true;
            } else {
                ESP_LOGE(TAG, "Failed to load srmodels.bin");
            }
        } else {
            ESP_LOGE(TAG, "The srmodels file %s is not found", srmodels_file.c_str());
        }
    }

    if (need_delete_root) {
        cJSON_Delete(root);
    }
    return false;
}

#if HAVE_LVGL
// Pinned xiaozhi cbin format: 32-bit LVGL 9 font, large glyph descriptors,
// plain 4-bpp bitmaps, class kerning. Offsets are relative to their containing
// structure (see cbin_font_create); reject unsupported layouts before loading.
static bool ValidCubeCBinTextFont(const void* data, size_t size) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    auto within = [size](size_t base, size_t offset, size_t length) {
        return base <= size && offset <= size - base && length <= size - base - offset;
    };
    auto u16 = [bytes](size_t offset) -> uint16_t {
        return uint16_t(bytes[offset]) | (uint16_t(bytes[offset + 1]) << 8);
    };
    auto u32 = [bytes](size_t offset) -> uint32_t {
        return uint32_t(bytes[offset]) | (uint32_t(bytes[offset + 1]) << 8) |
               (uint32_t(bytes[offset + 2]) << 16) | (uint32_t(bytes[offset + 3]) << 24);
    };
    if (!within(0, 0, 36)) return false;
    // Loader replaces first two callbacks only. Other pointers must be null.
    if (u32(8) || u32(28) || u32(32)) return false;
    size_t dsc = u32(24);
    if (dsc % 4 || !within(dsc, 0, 24)) return false;
    uint16_t flags = u16(dsc + 18);
    size_t count = flags & 0x1ff;
    if (!count || ((flags >> 9) & 0xf) != 4 || !(flags & 0x2000) ||
        (flags & 0xc000) || bytes[dsc + 20] != 0) return false;

    size_t bitmap = dsc + u32(dsc);
    size_t glyphs = dsc + u32(dsc + 4);
    size_t cmaps = dsc + u32(dsc + 8);
    size_t kern = dsc + u32(dsc + 12);
    if (!within(dsc, u32(dsc), 1) || !within(dsc, u32(dsc + 4), 16) ||
        !within(dsc, u32(dsc + 8), count * 20) ||
        !within(dsc, u32(dsc + 12), 16) ||
        glyphs % 4 || cmaps % 4 || kern % 4 || bitmap >= glyphs || glyphs >= cmaps || (cmaps - glyphs) % 16) return false;
    size_t glyph_count = (cmaps - glyphs) / 16;
    if (glyph_count > 65536) return false;

    // Each cbin cmap record is 20 bytes, not sizeof(lv_font_fmt_txt_cmap_t).
    for (size_t i = 0; i < count; ++i) {
        size_t record = cmaps + 20 * i;
        size_t length = u16(record + 4);
        size_t first_gid = u16(record + 6);
        size_t unicode = u32(record + 8);
        size_t ids = u32(record + 12);
        size_t list_count = u16(record + 16);
        uint8_t type = bytes[record + 18];
        if (!length || first_gid >= glyph_count) return false;
        size_t max_ofs = 0;
        if (type == 2) { // FORMAT0_TINY
            if (unicode || ids || list_count) return false;
            max_ofs = length - 1;
        } else if (type == 0) { // FORMAT0_FULL
            if (unicode || !ids || !within(cmaps, ids, length)) return false;
            for (size_t j = 0; j < length; ++j) {
                if (bytes[cmaps + ids + j] > max_ofs) max_ofs = bytes[cmaps + ids + j];
            }
        } else if (type == 3 || type == 1) { // SPARSE_TINY / SPARSE_FULL
            if (!unicode || unicode % 2 || !list_count || !within(cmaps, unicode, list_count * 2)) return false;
            for (size_t j = 0; j < list_count; ++j) {
                if (u16(cmaps + unicode + 2 * j) >= length ||
                    (j && u16(cmaps + unicode + 2 * j) <= u16(cmaps + unicode + 2 * (j - 1)))) return false;
            }
            if (type == 3) {
                if (ids) return false;
                max_ofs = list_count - 1;
            } else {
                if (!ids || ids % 2 || !within(cmaps, ids, list_count * 2)) return false;
                for (size_t j = 0; j < list_count; ++j) {
                    size_t ofs = u16(cmaps + ids + 2 * j);
                    if (ofs > max_ofs) max_ofs = ofs;
                }
            }
        } else return false;
        if (max_ofs >= glyph_count - first_gid) return false;
    }

    // LV_FONT_FMT_TXT_LARGE=1: 16-byte descriptors with 4-bpp plain rows.
    for (size_t i = 0; i < glyph_count; ++i) {
        size_t glyph = glyphs + i * 16;
        size_t pixels = ((size_t(u16(glyph + 8)) * 4 + 7) / 8) * u16(glyph + 10);
        size_t offset = u32(glyph);
        if (offset > glyphs - bitmap || pixels > glyphs - bitmap - offset) return false;
    }

    size_t pair_values = u32(kern);
    size_t left = u32(kern + 4);
    size_t right = u32(kern + 8);
    size_t left_count = bytes[kern + 12];
    size_t right_count = bytes[kern + 13];
    if (!left_count || !right_count || !pair_values || !left || !right ||
        !within(kern, pair_values, left_count * right_count) ||
        !within(kern, left, glyph_count) || !within(kern, right, glyph_count)) return false;
    for (size_t i = 0; i < glyph_count; ++i) {
        if (bytes[kern + left + i] > left_count || bytes[kern + right + i] > right_count) return false;
    }
    return true;
}

#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
// Upstream cbin_font_create dereferences unchecked allocations. Cube boot must
// fail closed on OOM. The validator above admits only this pinned cbin layout.
class CubeTextFont final : public LvglFont {
public:
    explicit CubeTextFont(const uint8_t* bytes) {
        const auto* d = bytes + cube_assets::Read32(bytes + 24);
        size_t count = (uint16_t(d[18]) | uint16_t(d[19]) << 8) & 0x1ff;
        size_t total = sizeof(Storage) + count * sizeof(lv_font_fmt_txt_cmap_t);
        storage_ = static_cast<Storage*>(heap_caps_calloc(1, total, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (!storage_) return;
        auto& font = storage_->font;
        auto& desc = storage_->desc;
        std::memcpy(&font, bytes, sizeof(font));
        std::memcpy(&desc, d, sizeof(desc));
        font.get_glyph_dsc = lv_font_get_glyph_dsc_fmt_txt;
        font.get_glyph_bitmap = lv_font_get_bitmap_fmt_txt;
        font.dsc = &desc;
        desc.glyph_bitmap = d + cube_assets::Read32(d);
        desc.glyph_dsc = reinterpret_cast<const lv_font_fmt_txt_glyph_dsc_t*>(d + cube_assets::Read32(d + 4));
        const auto* cmaps = d + cube_assets::Read32(d + 8);
        auto* maps = reinterpret_cast<lv_font_fmt_txt_cmap_t*>(storage_ + 1);
        desc.cmaps = maps;
        for (size_t i = 0; i < count; ++i) {
            const auto* c = cmaps + i * 20;
            maps[i].range_start = cube_assets::Read32(c);
            maps[i].range_length = uint16_t(c[4]) | uint16_t(c[5]) << 8;
            maps[i].glyph_id_start = uint16_t(c[6]) | uint16_t(c[7]) << 8;
            auto unicode = cube_assets::Read32(c + 8);
            auto ids = cube_assets::Read32(c + 12);
            maps[i].unicode_list = unicode ? reinterpret_cast<const uint16_t*>(cmaps + unicode) : nullptr;
            maps[i].glyph_id_ofs_list = ids ? cmaps + ids : nullptr;
            maps[i].list_length = uint16_t(c[16]) | uint16_t(c[17]) << 8;
            maps[i].type = static_cast<lv_font_fmt_txt_cmap_type_t>(c[18]);
        }
        const auto* k = d + cube_assets::Read32(d + 12);
        auto& kern = storage_->kern;
        std::memcpy(&kern, k, sizeof(kern));
        kern.class_pair_values = reinterpret_cast<const int8_t*>(k + cube_assets::Read32(k));
        kern.left_class_mapping = k + cube_assets::Read32(k + 4);
        kern.right_class_mapping = k + cube_assets::Read32(k + 8);
        desc.kern_dsc = &kern;
    }
    ~CubeTextFont() override { heap_caps_free(storage_); }
    const lv_font_t* font() const override { return storage_ ? &storage_->font : nullptr; }
private:
    struct Storage {
        lv_font_t font;
        lv_font_fmt_txt_dsc_t desc;
        lv_font_fmt_txt_kern_classes_t kern;
    };
    Storage* storage_ = nullptr;
};
#endif

bool Assets::LoadTextFont(void* data, size_t size) {
    auto display = Board::GetInstance().GetDisplay();
    DisplayLockGuard lock(display);
    std::shared_ptr<LvglFont> text_font;
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    try {
        text_font = std::make_shared<CubeTextFont>(static_cast<const uint8_t*>(data));
    } catch (const std::bad_alloc&) {
        return false;
    }
#else
    text_font = std::make_shared<LvglCBinFont>(data);
#endif
    if (text_font->font() == nullptr) {
        ESP_LOGE(TAG, "Failed to load text font");
        return false;
    }
    auto& themes = LvglThemeManager::GetInstance();
    if (auto light = themes.GetTheme("light")) light->set_text_font(text_font);
    if (auto dark = themes.GetTheme("dark")) dark->set_text_font(text_font);
    return true;
}

bool Assets::ApplyTextFont() {
    void* data = nullptr;
    size_t size = 0;
    if (!GetAssetData("index.json", data, size)) {
        ESP_LOGE(TAG, "Text font index is missing");
        return false;
    }
    cJSON* root = cJSON_ParseWithLength(static_cast<char*>(data), size);
    if (root == nullptr) {
        ESP_LOGE(TAG, "Text font index is invalid");
        return false;
    }
    auto font = cJSON_GetObjectItem(root, "text_font");
    std::string name = cJSON_IsString(font) ? font->valuestring : "";
    cJSON_Delete(root);
    if (name.empty() || !GetAssetData(name, data, size)) {
        ESP_LOGE(TAG, "Text font asset is missing");
        return false;
    }
    if (sizeof(lv_font_t) != 36 || sizeof(lv_font_fmt_txt_dsc_t) != 24 ||
        sizeof(lv_font_fmt_txt_glyph_dsc_t) != 16 ||
        sizeof(lv_font_fmt_txt_kern_classes_t) != 16 ||
        !LV_FONT_FMT_TXT_LARGE || !ValidCubeCBinTextFont(data, size)) {
        ESP_LOGE(TAG, "Text font asset has invalid or unsupported cbin layout");
        return false;
    }
    auto display = Board::GetInstance().GetDisplay();
    DisplayLockGuard lock(display);
    if (!LoadTextFont(data, size)) return false;

    // SetupUI has finished, including the custom Cube screen. Set only its
    // inherited font; SetTheme also changes colors and persists display config.
    auto theme = static_cast<LvglTheme*>(display->GetTheme());
    if (theme != nullptr) {
        lv_obj_set_style_text_font(lv_screen_active(), theme->text_font()->font(), 0);
    }
    return theme != nullptr;
}

uint32_t Assets::LvglStrategy::CalculateChecksum(const char* data, uint32_t length) {
    uint32_t checksum = 0;
    for (uint32_t i = 0; i < length; i++) {
        checksum += data[i];
    }
    return checksum & 0xFFFF;
}

bool Assets::LvglStrategy::InitializePartition(Assets* assets) {
    assets->partition_valid_ = false;
    assets_.clear();

    if (!Assets::FindPartition(assets)) {
        return false;
    }

    int free_pages = spi_flash_mmap_get_free_pages(SPI_FLASH_MMAP_DATA);
    uint32_t storage_size = free_pages * 64 * 1024;
    ESP_LOGI(TAG, "The storage free size is %ld KB", storage_size / 1024);
    ESP_LOGI(TAG, "The partition size is %ld KB", assets->partition_->size / 1024);
    if (storage_size < assets->partition_->size) {
        ESP_LOGE(TAG, "The free size %ld KB is less than assets partition required %ld KB", storage_size / 1024, assets->partition_->size / 1024);
        return false;
    }

    esp_err_t err = esp_partition_mmap(assets->partition_, 0, assets->partition_->size, ESP_PARTITION_MMAP_DATA, (const void**)&mmap_root_, &mmap_handle_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to mmap assets partition: %s", esp_err_to_name(err));
        return false;
    }

    assets->partition_valid_ = true;

    uint32_t stored_files = *(uint32_t*)(mmap_root_ + 0);
    uint32_t stored_chksum = *(uint32_t*)(mmap_root_ + 4);
    uint32_t stored_len = *(uint32_t*)(mmap_root_ + 8);

    if (stored_len > assets->partition_->size - 12) {
        ESP_LOGD(TAG, "The stored_len (0x%lx) is greater than the partition size (0x%lx) - 12", stored_len, assets->partition_->size);
        return false;
    }

    auto start_time = esp_timer_get_time();
    uint32_t calculated_checksum = CalculateChecksum(mmap_root_ + 12, stored_len);
    auto end_time = esp_timer_get_time();
    ESP_LOGI(TAG, "The checksum calculation time is %d ms", int((end_time - start_time) / 1000));

    if (calculated_checksum != stored_chksum) {
        ESP_LOGE(TAG, "The calculated checksum (0x%lx) does not match the stored checksum (0x%lx)", calculated_checksum, stored_chksum);
        return false;
    }

    checksum_valid_ = true;

    for (uint32_t i = 0; i < stored_files; i++) {
        auto item = (const mmap_assets_table*)(mmap_root_ + 12 + i * sizeof(mmap_assets_table));
        auto asset = Asset{
            .size = static_cast<size_t>(item->asset_size),
            .offset = static_cast<size_t>(12 + sizeof(mmap_assets_table) * stored_files + item->asset_offset)
        };
        assets_[item->asset_name] = asset;
    }
    return checksum_valid_;
}

void Assets::LvglStrategy::UnApplyPartition(Assets* assets) {
    if (mmap_handle_ != 0) {
        esp_partition_munmap(mmap_handle_);
        mmap_handle_ = 0;
        mmap_root_ = nullptr;
    }
    checksum_valid_ = false;
    assets_.clear();
    (void)assets; // Unused parameter
}

bool Assets::LvglStrategy::GetAssetData(Assets* assets, const std::string& name, void*& ptr, size_t& size) {
    auto asset = assets_.find(name);
    if (asset == assets_.end()) {
        return false;
    }
    auto data = (const char*)(mmap_root_ + asset->second.offset);
    if (data[0] != 'Z' || data[1] != 'Z') {
        ESP_LOGE(TAG, "The asset %s is not valid with magic %02x%02x", name.c_str(), data[0], data[1]);
        return false;
    }

    ptr = static_cast<void*>(const_cast<char*>(data + 2));
    size = asset->second.size;
    return true;
}

bool Assets::LvglStrategy::Apply(Assets* assets, bool refresh_display_theme) {
    void* ptr = nullptr;
    size_t size = 0;
    if (!assets->GetAssetData("index.json", ptr, size)) {
        ESP_LOGE(TAG, "The index.json file is not found");
        return false;
    }

    cJSON* root = cJSON_ParseWithLength(static_cast<char*>(ptr), size);
    if (root == nullptr) {
        ESP_LOGE(TAG, "The index.json file is not valid");
        return false;
    }

    cJSON* version = cJSON_GetObjectItem(root, "version");
    if (cJSON_IsNumber(version)) {
        if (version->valuedouble > 1) {
            ESP_LOGE(TAG, "The assets version %d is not supported, please upgrade the firmware", version->valueint);
            return false;
        }
    }

    Assets::LoadSrmodelsFromIndex(assets, root);

    auto& theme_manager = LvglThemeManager::GetInstance();
    auto light_theme = theme_manager.GetTheme("light");
    auto dark_theme = theme_manager.GetTheme("dark");

    cJSON* font = cJSON_GetObjectItem(root, "text_font");
    if (cJSON_IsString(font)) {
        std::string fonts_text_file = font->valuestring;
        if (assets->GetAssetData(fonts_text_file, ptr, size)) {
            if (!assets->LoadTextFont(ptr, size)) {
                cJSON_Delete(root);
                return false;
            }
        } else {
            ESP_LOGE(TAG, "The font file %s is not found", fonts_text_file.c_str());
        }
    }

    cJSON* emoji_collection = cJSON_GetObjectItem(root, "emoji_collection");
    if (cJSON_IsArray(emoji_collection)) {
        auto custom_emoji_collection = std::make_shared<EmojiCollection>();
        int emoji_count = cJSON_GetArraySize(emoji_collection);
        for (int i = 0; i < emoji_count; i++) {
            cJSON* emoji = cJSON_GetArrayItem(emoji_collection, i);
            if (cJSON_IsObject(emoji)) {
                cJSON* name = cJSON_GetObjectItem(emoji, "name");
                cJSON* file = cJSON_GetObjectItem(emoji, "file");
                cJSON* eaf = cJSON_GetObjectItem(emoji, "eaf");
                if (cJSON_IsString(name) && cJSON_IsString(file) && (NULL== eaf)) {
                    if (!assets->GetAssetData(file->valuestring, ptr, size)) {
                        ESP_LOGE(TAG, "Emoji %s image file %s is not found", name->valuestring, file->valuestring);
                        continue;
                    }
                    custom_emoji_collection->AddEmoji(name->valuestring, new LvglRawImage(ptr, size));
                }
            }
        }
        if (light_theme != nullptr) {
            light_theme->set_emoji_collection(custom_emoji_collection);
        }
        if (dark_theme != nullptr) {
            dark_theme->set_emoji_collection(custom_emoji_collection);
        }
    }

    cJSON* skin = cJSON_GetObjectItem(root, "skin");
    if (cJSON_IsObject(skin)) {
        cJSON* light_skin = cJSON_GetObjectItem(skin, "light");
        if (cJSON_IsObject(light_skin) && light_theme != nullptr) {
            cJSON* text_color = cJSON_GetObjectItem(light_skin, "text_color");
            cJSON* background_color = cJSON_GetObjectItem(light_skin, "background_color");
            cJSON* background_image = cJSON_GetObjectItem(light_skin, "background_image");
            if (cJSON_IsString(text_color)) {
                light_theme->set_text_color(LvglTheme::ParseColor(text_color->valuestring));
            }
            if (cJSON_IsString(background_color)) {
                light_theme->set_background_color(LvglTheme::ParseColor(background_color->valuestring));
                light_theme->set_chat_background_color(LvglTheme::ParseColor(background_color->valuestring));
            }
            if (cJSON_IsString(background_image)) {
                if (!assets->GetAssetData(background_image->valuestring, ptr, size)) {
                    ESP_LOGE(TAG, "The background image file %s is not found", background_image->valuestring);
                    return false;
                }
                auto background_image = std::make_shared<LvglCBinImage>(ptr);
                light_theme->set_background_image(background_image);
            }
        }
        cJSON* dark_skin = cJSON_GetObjectItem(skin, "dark");
        if (cJSON_IsObject(dark_skin) && dark_theme != nullptr) {
            cJSON* text_color = cJSON_GetObjectItem(dark_skin, "text_color");
            cJSON* background_color = cJSON_GetObjectItem(dark_skin, "background_color");
            cJSON* background_image = cJSON_GetObjectItem(dark_skin, "background_image");
            if (cJSON_IsString(text_color)) {
                dark_theme->set_text_color(LvglTheme::ParseColor(text_color->valuestring));
            }
            if (cJSON_IsString(background_color)) {
                dark_theme->set_background_color(LvglTheme::ParseColor(background_color->valuestring));
                dark_theme->set_chat_background_color(LvglTheme::ParseColor(background_color->valuestring));
            }
            if (cJSON_IsString(background_image)) {
                if (!assets->GetAssetData(background_image->valuestring, ptr, size)) {
                    ESP_LOGE(TAG, "The background image file %s is not found", background_image->valuestring);
                    return false;
                }
                auto background_image = std::make_shared<LvglCBinImage>(ptr);
                dark_theme->set_background_image(background_image);
            }
        }
    }

    if (refresh_display_theme) {
        auto display = Board::GetInstance().GetDisplay();
        ESP_LOGI(TAG, "Refreshing display theme...");

        auto current_theme = display->GetTheme();
        if (current_theme != nullptr) {
            display->SetTheme(current_theme);
        }

        // Parse hide_subtitle configuration
        cJSON* hide_subtitle = cJSON_GetObjectItem(root, "hide_subtitle");
        if (cJSON_IsBool(hide_subtitle)) {
            bool hide = cJSON_IsTrue(hide_subtitle);
            auto lcd_display = dynamic_cast<LcdDisplay*>(display);
            if (lcd_display != nullptr) {
                lcd_display->SetHideSubtitle(hide);
                ESP_LOGI(TAG, "Set hide_subtitle to %s", hide ? "true" : "false");
            }
        }
    }
    
    cJSON_Delete(root);
    return true;
}
#endif // HAVE_LVGL

bool Assets::EmoteStrategy::InitializePartition(Assets* assets) {
    assets->partition_valid_ = false;

    if (!Assets::FindPartition(assets)) {
        return false;
    }

    esp_err_t ret = ESP_ERR_INVALID_STATE;
    auto display = Board::GetInstance().GetDisplay();
    auto* emote_display = dynamic_cast<emote::EmoteDisplay*>(display);
    if (emote_display && emote_display->GetEmoteHandle() != nullptr) {
        const emote_data_t data = {
            .type = EMOTE_SOURCE_PARTITION,
            .source = {
                .partition_label = PARTITION_LABEL,
            },
            .flags = {
                .mmap_enable = true, //must be true here!!!
            },
        };
        ret = emote_mount_assets(emote_display->GetEmoteHandle(), &data);
    } else {
        ESP_LOGE(TAG, "Emote display is not initialized");
    }
    assets->partition_valid_ = ((ret == ESP_OK) ? true : false);
    return assets->partition_valid_;
}

void Assets::EmoteStrategy::UnApplyPartition(Assets* assets) {
    auto display = Board::GetInstance().GetDisplay();
    auto* emote_display = dynamic_cast<emote::EmoteDisplay*>(display);
    if (emote_display && emote_display->GetEmoteHandle() != nullptr) {
        emote_unmount_assets(emote_display->GetEmoteHandle());
    }
    (void)assets; // Unused parameter
}

bool Assets::EmoteStrategy::GetAssetData(Assets* assets, const std::string& name, void*& ptr, size_t& size) {
    auto display = Board::GetInstance().GetDisplay();
    auto* emote_display = dynamic_cast<emote::EmoteDisplay*>(display);
    if (emote_display && emote_display->GetEmoteHandle() != nullptr) {
        const uint8_t* data = nullptr;
        size_t data_size = 0;
        if (ESP_OK == emote_get_asset_data_by_name(emote_display->GetEmoteHandle(), name.c_str(), &data, &data_size)) {
            ptr = const_cast<void*>(static_cast<const void*>(data));
            size = data_size;
            return true;
        }
        ESP_LOGE(TAG, "Failed to get asset data by name: %s", name.c_str());
        return false;
    }
    (void)assets; // Unused parameter
    return false;
}

bool Assets::EmoteStrategy::Apply(Assets* assets, bool refresh_display_theme) {
    Assets::LoadSrmodelsFromIndex(assets);

    auto display = Board::GetInstance().GetDisplay();
    auto* emote_display = dynamic_cast<emote::EmoteDisplay*>(display);

    if (emote_display && emote_display->GetEmoteHandle() != nullptr) {
        emote_load_assets(emote_display->GetEmoteHandle());
    }
    return true;
}

bool Assets::Download(std::string url, std::function<void(int progress, size_t speed)> progress_callback) {
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    return false; // USB-only, immutable bundled assets.
#else
    ESP_LOGI(TAG, "Downloading new version of assets from %s", url.c_str());

    // Unmap the current assets partition
    UnApplyPartition();

    // Download the new assets file
    auto network = Board::GetInstance().GetNetwork();
    auto http = network->CreateHttp(0);
    
    if (!http->Open("GET", url)) {
        ESP_LOGE(TAG, "Failed to open HTTP connection");
        return false;
    }

    if (http->GetStatusCode() != 200) {
        ESP_LOGE(TAG, "Failed to get assets, status code: %d", http->GetStatusCode());
        return false;
    }

    size_t content_length = http->GetBodyLength();
    if (content_length == 0) {
        ESP_LOGE(TAG, "Failed to get content length");
        return false;
    }

    if (content_length > partition_->size) {
        ESP_LOGE(TAG, "Assets file size (%u) is larger than partition size (%lu)", content_length, partition_->size);
        return false;
    }

    // Get the flash sector size (typically 4 KB on ESP32)
    const size_t SECTOR_SIZE = esp_partition_get_main_flash_sector_size();
    
    // Calculate the number of sectors to erase
    size_t sectors_to_erase = (content_length + SECTOR_SIZE - 1) / SECTOR_SIZE; // Round up
    size_t total_erase_size = sectors_to_erase * SECTOR_SIZE;
    
    ESP_LOGI(TAG, "Sector size: %u, content length: %u, sectors to erase: %u, total erase size: %u", 
             SECTOR_SIZE, content_length, sectors_to_erase, total_erase_size);
    
    // Erase sectors as the new assets file is written to the partition
    char* buffer = (char*)heap_caps_malloc(SECTOR_SIZE, MALLOC_CAP_INTERNAL);
    if (buffer == nullptr) {
        ESP_LOGE(TAG, "Failed to allocate buffer");
        return false;
    }
    size_t total_written = 0;
    size_t recent_written = 0;
    size_t current_sector = 0;
    auto last_calc_time = esp_timer_get_time();
    
    while (true) {
        int ret = http->Read(buffer, SECTOR_SIZE);
        if (ret < 0) {
            ESP_LOGE(TAG, "Failed to read HTTP data: %s", esp_err_to_name(ret));
            heap_caps_free(buffer);
            return false;
        }

        if (ret == 0) {
            break;
        }

        // Check whether more sectors need erasing
        size_t write_end_offset = total_written + ret;
        size_t needed_sectors = (write_end_offset + SECTOR_SIZE - 1) / SECTOR_SIZE;
        
        // Erase required sectors
        while (current_sector < needed_sectors) {
            size_t sector_start = current_sector * SECTOR_SIZE;
            size_t sector_end = (current_sector + 1) * SECTOR_SIZE;
            
            // Keep the erase range within the partition
            if (sector_end > partition_->size) {
                ESP_LOGE(TAG, "Sector end (%u) exceeds partition size (%lu)", sector_end, partition_->size);
                heap_caps_free(buffer);
                return false;
            }
            
            ESP_LOGD(TAG, "Erasing sector %u (offset: %u, size: %u)", current_sector, sector_start, SECTOR_SIZE);
            esp_err_t err = esp_partition_erase_range(partition_, sector_start, SECTOR_SIZE);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "Failed to erase sector %u at offset %u: %s", current_sector, sector_start, esp_err_to_name(err));
                heap_caps_free(buffer);
                return false;
            }
            
            current_sector++;
        }

        // Write data to the partition
        esp_err_t err = esp_partition_write(partition_, total_written, buffer, ret);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to write to assets partition at offset %u: %s", total_written, esp_err_to_name(err));
            heap_caps_free(buffer);
            return false;
        }

        total_written += ret;
        recent_written += ret;

        // Calculate progress and speed
        if (esp_timer_get_time() - last_calc_time >= 1000000 || total_written == content_length || ret == 0) {
            size_t progress = total_written * 100 / content_length;
            size_t speed = recent_written; // Bytes per second
            ESP_LOGI(TAG, "Progress: %u%% (%u/%u), Speed: %u B/s, Sectors erased: %u", 
                     progress, total_written, content_length, speed, current_sector);
            if (progress_callback) {
                progress_callback(progress, speed);
            }
            last_calc_time = esp_timer_get_time();
            recent_written = 0; // Reset bytes written since the last update
        }
    }
    
    http->Close();
    heap_caps_free(buffer);

    if (total_written != content_length) {
        ESP_LOGE(TAG, "Downloaded size (%u) does not match expected size (%u)", total_written, content_length);
        return false;
    }

    ESP_LOGI(TAG, "Assets download completed, total written: %u bytes, total sectors erased: %u", 
             total_written, current_sector);

    // Reinitialize the assets partition
    if (!InitializePartition()) {
        ESP_LOGE(TAG, "Failed to re-initialize assets partition");
        return false;
    }

    return true;
#endif
}
