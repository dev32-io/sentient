// SPDX-License-Identifier: MIT
#pragma once

#include <cstddef>
#include <memory>

namespace sentient::cube {

// One text message at a time. Feed only ordered text bytes; WS framing stays with
// caller. No output is observable until finish() validates the entire message.
class BoundedEnvelope {
public:
    enum class Error {
        None,
        InvalidJson,
        InvalidRoot,
        InvalidField,
        DuplicateField,
        DepthLimit,
        ScalarLimit,
        EnvelopeLimit,
        OutOfMemory,
        InvalidState,
    };
    static constexpr std::size_t kMaxDepth = 32;
    static constexpr std::size_t kMaxStringBytes = 256; // decoded, per selected string
    static constexpr std::size_t kMaxNumberBytes = 128; // raw selected numeric text
    static constexpr std::size_t kEnvelopeCapacity = 4096; // includes trailing NUL

    BoundedEnvelope() noexcept;
    ~BoundedEnvelope();
    BoundedEnvelope(const BoundedEnvelope&) = delete;
    BoundedEnvelope& operator=(const BoundedEnvelope&) = delete;

    // Also retries allocation after OutOfMemory. All failures stick until reset.
    Error reset() noexcept;
    Error feed(const char* bytes, std::size_t length) noexcept;
    Error finish() noexcept; // call at WS message FIN only; idempotent on success
    // nullptr/length=0 before successful finish, after any failure, or after reset.
    // Returned NUL-terminated JSON is borrowed until next non-const operation.
    const char* envelope(std::size_t& length) const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    Error error_ = Error::None;
    bool finished_ = false;
    Error parse(bool more, const char* bytes, std::size_t length) noexcept;
};

} // namespace sentient::cube
