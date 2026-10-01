#include "cube_enrollment_store.h"
#include <nvs_flash.h>

namespace sentient::cube {
namespace {
esp_err_t erased(const esp_partition_t* partition, size_t offset) {
    uint8_t buffer[256];
    for (; offset < partition->size; offset += sizeof(buffer)) {
        size_t n = std::min(sizeof(buffer), static_cast<size_t>(partition->size - offset));
        esp_err_t err = esp_partition_read(partition, offset, buffer, n);
        if (err != ESP_OK) return err;
        if (std::any_of(buffer, buffer + n, [](uint8_t x) { return x != 0xff; })) return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}
}
esp_err_t CubeEnrollmentStore::Open(CubeEnrollment& record) {
    const auto* auth = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "cube_auth");
    seal_ = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, static_cast<esp_partition_subtype_t>(0x40), "cube_seal");
    if (!auth || !seal_ || auth->address != 0x10000 || auth->size != 0xf000 ||
        seal_->address != 0x1f000 || seal_->size != 0x1000) return ESP_ERR_INVALID_STATE;
    uint32_t marker[2];
    esp_err_t err = esp_partition_read(seal_, 0, marker, sizeof(marker));
    if (err != ESP_OK) return err;
    if (!cube_seal_valid(marker[0], marker[1]) || erased(seal_, sizeof(marker)) != ESP_OK)
        return ESP_ERR_INVALID_STATE;
    // A blank seal beside nonblank NVS is NOT fresh hardware (unknown migration).
    if (marker[0] == UINT32_MAX && marker[1] == UINT32_MAX && erased(auth, 0) != ESP_OK)
        return ESP_ERR_INVALID_STATE;
    if (marker[0] != kCubeSeal) {
        err = esp_partition_write(seal_, 0, &kCubeSeal, sizeof(kCubeSeal));
        if (err != ESP_OK) return err;
    }
    err = nvs_flash_init_partition("cube_auth");
    if (err != ESP_OK) return err; // Deliberately no nvs_flash_erase_partition fallback.
    err = nvs_open_from_partition("cube_auth", "enrollment", NVS_READWRITE, &handle_);
    if (err != ESP_OK) return err;
    size_t size = sizeof(record);
    err = nvs_get_blob(handle_, "record", &record, &size);
    if (err == ESP_ERR_NVS_NOT_FOUND && !cube_record_required(marker[1])) return err;
    if (err != ESP_OK || size != sizeof(record) || !record.valid()) return ESP_ERR_INVALID_STATE;
    // Finish interrupted publication only with the exact retained valid identity.
    uint32_t published = 0;
    return esp_partition_write(seal_, sizeof(uint32_t), &published, sizeof(published));
}
esp_err_t CubeEnrollmentStore::Save(const CubeEnrollment& record) {
    if (!handle_ || !seal_ || !record.valid()) return ESP_ERR_INVALID_STATE;
    esp_err_t err = nvs_set_blob(handle_, "record", &record, sizeof(record));
    if (err == ESP_OK) err = nvs_commit(handle_);
    if (err != ESP_OK) return err;
    CubeEnrollment retained;
    size_t size = sizeof(retained);
    err = nvs_get_blob(handle_, "record", &retained, &size);
    if (err != ESP_OK || size != sizeof(retained) || std::memcmp(&retained, &record, size)) return ESP_ERR_INVALID_STATE;
    uint32_t published = 0;
    return esp_partition_write(seal_, sizeof(uint32_t), &published, sizeof(published));
}
}
