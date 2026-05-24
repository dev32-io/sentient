#ifndef _SYSTEM_INFO_H_
#define _SYSTEM_INFO_H_

#include <string>

#include <esp_err.h>
#include <freertos/FreeRTOS.h>

class SystemInfo {
public:
    static size_t GetFlashSize();
    static size_t GetMinimumFreeHeapSize();
    static size_t GetFreeHeapSize();
    static std::string GetMacAddress();
    static std::string GetChipModelName();
    static std::string GetUserAgent();
    static esp_err_t PrintTaskCpuUsage(TickType_t xTicksToWait);
    static void PrintTaskList();
    static void PrintHeapStats();
    // Single-line heap snapshot tagged with `where`. Reports internal SRAM
    // (free / min-ever / largest-free-block) + PSRAM (free / min-ever).
    // Cheap enough to call from state transitions + HTTP handler boundaries
    // during SRAM audits. Tag must be a short ASCII slug, <=32 chars.
    static void LogHeap(const char* where);
    static void PrintPmLocks();
};

#endif // _SYSTEM_INFO_H_
