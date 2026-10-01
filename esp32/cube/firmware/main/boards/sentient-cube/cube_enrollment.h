#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>

namespace sentient::cube {

enum class EnrollmentPhase : uint32_t { Bootstrap = 0, Pending = 1, Committed = 2, Active = 3 };

// These wire contracts are flat objects. Reject nesting before cJSON recursion,
// including deeply nested authenticated input that could exhaust BLE task stack.
inline bool cube_flat_object(const std::string& s) {
    bool quoted = false, escape = false;
    int depth = 0;
    for (char c : s) {
        if (quoted) {
            if (escape) escape = false;
            else if (c == '\\') escape = true;
            else if (c == '"') quoted = false;
        } else if (c == '"') quoted = true;
        else if (c == '[' || c == ']') return false;
        else if (c == '{') { if (++depth != 1) return false; }
        else if (c == '}') { if (--depth != 0) return false; }
    }
    return !quoted && depth == 0 && s.find('{') != std::string::npos;
}

inline bool cube_uuid(const std::string& s) {
    if (s.size() != 36) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    }
    return true;
}
inline bool cube_secret(const std::string& s) {
    const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (s.size() != 43) return false;
    for (char c : s) if (!c || !std::strchr(alphabet, c)) return false;
    return (std::strchr(alphabet, s.back()) - alphabet) % 4 == 0;
}
inline bool cube_origin(const std::string& s) {
    if (s.size() < 9 || s.size() > 192 || s.compare(0, 8, "https://")) return false;
    // DNS/IPv4 origins only. No credentials, redirects, path or URL normalization ambiguity.
    auto host = s.substr(8);
    auto colon = host.find(':');
    if (colon != std::string::npos) {
        auto port = host.substr(colon + 1);
        if (port.empty() || port.size() > 5) return false;
        unsigned n = 0;
        for (char c : port) { if (c < '0' || c > '9') return false; n = n * 10 + c - '0'; }
        if (!n || n > 65535) return false;
        host.resize(colon);
    }
    if (host.empty() || host.front() == '.' || host.back() == '.') return false;
    for (char c : host) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '.')) return false;
    return true;
}
inline bool cube_ws_path(const std::string& s) {
    if (s.empty() || s.size() > 96 || s.front() != '/') return false;
    for (char c : s) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '/' || c == '-' || c == '_' || c == '.')) return false;
    return true;
}
inline bool cube_wifi(const std::string& ssid, const std::string& password) {
    if (ssid.empty() || ssid.size() > 32 || ssid.find('\0') != std::string::npos ||
        password.find('\0') != std::string::npos) return false;
    if (password.empty() || (password.size() >= 8 && password.size() <= 63)) return true;
    if (password.size() != 64) return false;
    return std::all_of(password.begin(), password.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    });
}

template<size_t N> inline std::string cube_text(const char (&s)[N]) {
    return std::string(s, strnlen(s, N));
}
template<size_t N> inline void cube_copy(char (&dst)[N], const std::string& s) {
    std::memset(dst, 0, N);
    if (s.size() < N) std::memcpy(dst, s.data(), s.size());
}

// Single NVS blob: atomic replacement, never independent credential-key commits.
// Bump schema on any layout change; unknown schemas fail closed, no reset fallback.
struct CubeEnrollment {
    uint32_t schema = 1;
    EnrollmentPhase phase = EnrollmentPhase::Bootstrap;
    uint32_t generation = 0;
    uint32_t confirmed_generation = 0;
    char device_id[37]{};
    char attempt_id[37]{};
    char bootstrap[44]{};
    char enrollment[44]{};
    char renewal[44]{};
    char origin[193]{};
    char ws_path[97]{};
    uint8_t salt[32]{};
    uint8_t verifier[384]{};

    bool valid() const {
        if (schema != 1 || !cube_uuid(cube_text(device_id))) return false;
        if (phase == EnrollmentPhase::Bootstrap)
            return generation == 0 && confirmed_generation == 0 && cube_secret(cube_text(bootstrap)) &&
                attempt_id[0] == 0 && enrollment[0] == 0 && renewal[0] == 0 && origin[0] == 0;
        if (phase != EnrollmentPhase::Pending && phase != EnrollmentPhase::Committed && phase != EnrollmentPhase::Active)
            return false;
        return generation > 0 && generation <= INT32_MAX && confirmed_generation <= generation &&
            bootstrap[0] == 0 && cube_uuid(cube_text(attempt_id)) && cube_secret(cube_text(enrollment)) &&
            cube_secret(cube_text(renewal)) && cube_origin(cube_text(origin)) && cube_ws_path(cube_text(ws_path)) &&
            std::any_of(std::begin(salt), std::end(salt), [](uint8_t x) { return x != 0; }) &&
            std::any_of(std::begin(verifier), std::end(verifier), [](uint8_t x) { return x != 0; }) &&
            (phase == EnrollmentPhase::Pending || confirmed_generation == generation);
    }
    bool same_attempt(const std::string& attempt, uint32_t gen, const std::string& proof) const {
        return cube_text(attempt_id) == attempt && generation == gen && cube_text(enrollment) == proof;
    }
    bool can_enroll(const std::string& attempt, uint32_t gen, const std::string& proof,
                    const std::string& gateway, const std::string& path) const {
        if (!cube_uuid(attempt) || !cube_secret(proof) || !gen || gen > INT32_MAX ||
            !cube_origin(gateway) || !cube_ws_path(path)) return false;
        if (phase == EnrollmentPhase::Bootstrap) return true;
        if (cube_text(origin) != gateway || cube_text(ws_path) != path) return false;
        return same_attempt(attempt, gen, proof) || (gen > confirmed_generation && cube_text(attempt_id) != attempt);
    }
};

// Flash publication fence. A partially written first marker can resume ONLY while
// unpublished. Any written completion bit means an identity may have been exposed.
constexpr uint32_t kCubeSeal = 0x43554245;
inline bool cube_seal_valid(uint32_t started, uint32_t published) {
    return published == UINT32_MAX ? (started & kCubeSeal) == kCubeSeal : started == kCubeSeal;
}
inline bool cube_record_required(uint32_t published) { return published != UINT32_MAX; }

} // namespace sentient::cube
