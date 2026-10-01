#pragma once
#include "cube_enrollment.h"
#include <esp_err.h>
#include <esp_partition.h>
#include <nvs.h>

namespace sentient::cube {
class CubeEnrollmentStore {
public:
    // ESP_ERR_NVS_NOT_FOUND means unpublished initialization may be completed.
    // All other errors are fatal recovery, never automatic erase/reassignment.
    esp_err_t Open(CubeEnrollment& record);
    esp_err_t Save(const CubeEnrollment& record);
private:
    nvs_handle_t handle_ = 0;
    const esp_partition_t* seal_ = nullptr;
};
}
