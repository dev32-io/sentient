#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

// Cube pack v1: LE header, zlib stream containing a sorted fixed-width table
// followed by 4-byte-aligned payloads. No filesystem, copies, or heap index.
namespace cube_assets {
constexpr size_t kHeaderSize = 24;
constexpr size_t kPathSize = 96;
constexpr size_t kEntrySize = kPathSize + 8;
constexpr size_t kMaxEntries = 128;
constexpr size_t kMaxExpanded = 6 * 1024 * 1024;
constexpr size_t kMaxPacked = 0xfe0000;

inline uint32_t Read32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

// Successful storage stays alive for all font/image consumers. Caller owns it.
bool Decode(const uint8_t* packed, size_t size, uint8_t*& data, size_t& count);

struct Header { size_t count; size_t expanded; size_t compressed; };
inline bool ReadHeader(const uint8_t* data, size_t size, Header& h) {
    if (!data || size < kHeaderSize || size > kMaxPacked ||
        std::memcmp(data, "CUBEPAK1", 8) || Read32(data + 8) != 1) return false;
    h = {Read32(data + 12), Read32(data + 16), Read32(data + 20)};
    return h.count && h.count <= kMaxEntries && h.expanded <= kMaxExpanded &&
           h.expanded >= h.count * kEntrySize && h.compressed >= 6 &&
           h.compressed == size - kHeaderSize;
}

inline bool ValidPath(const char* path, size_t length) {
    if (length < 2 || length >= kPathSize || path[0] != '/') return false;
    size_t start = 1;
    for (size_t i = 1; i <= length; ++i) {
        if (i == length || path[i] == '/') {
            size_t n = i - start;
            if (!n || (n == 1 && path[start] == '.') ||
                (n == 2 && path[start] == '.' && path[start + 1] == '.')) return false;
            start = i + 1;
        } else {
            char c = path[i];
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) return false;
        }
    }
    return true;
}

inline bool Validate(const uint8_t* data, size_t size, size_t count) {
    if (!data || !count || count > kMaxEntries || size > kMaxExpanded ||
        size < count * kEntrySize) return false;
    size_t end = count * kEntrySize;
    const char* previous = nullptr;
    for (size_t i = 0; i < count; ++i) {
        const auto* entry = data + i * kEntrySize;
        const char* path = reinterpret_cast<const char*>(entry);
        const char* nul = static_cast<const char*>(std::memchr(path, 0, kPathSize));
        if (!nul || !ValidPath(path, nul - path) ||
            (previous && std::strcmp(previous, path) >= 0)) return false;
        for (size_t j = nul - path; j < kPathSize; ++j) if (entry[j]) return false;
        size_t offset = Read32(entry + kPathSize);
        size_t length = Read32(entry + kPathSize + 4);
        size_t aligned = (end + 3) & ~size_t(3);
        if (offset != aligned || offset > size || !length || length > size - offset) return false;
        for (; end < aligned; ++end) if (data[end]) return false;
        end = offset + length;
        previous = path;
    }
    return end == size;
}

inline bool Find(const uint8_t* data, size_t count, const char* name, void*& ptr, size_t& size) {
    ptr = nullptr;
    size = 0;
    if (!data) return false;
    for (size_t i = 0; i < count; ++i) {
        const auto* entry = data + i * kEntrySize;
        if (!std::strcmp(reinterpret_cast<const char*>(entry), name)) {
            ptr = const_cast<uint8_t*>(data + Read32(entry + kPathSize));
            size = Read32(entry + kPathSize + 4);
            return true;
        }
    }
    return false;
}
} // namespace cube_assets
