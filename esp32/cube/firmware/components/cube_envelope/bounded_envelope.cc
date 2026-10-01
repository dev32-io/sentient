// SPDX-License-Identifier: MIT
#include "bounded_envelope.h"

#include <boost/json/basic_parser_impl.hpp>
#include <cJSON.h>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <new>

namespace sentient::cube {
namespace {
using Error = BoundedEnvelope::Error;
using View = boost::json::string_view;
using Code = boost::system::error_code;

// Types are the union of CURRENT gateway wire shapes, not only Cube consumers.
// In particular tasklist.state has a nullable turnId after its turn has ended.
enum class Kind { String, NullableString, Cursor, PositiveInt };
struct Field { const char* name; Kind kind; };
constexpr Field fields[] = {
    {"type", Kind::String}, {"seq", Kind::Cursor}, {"epoch", Kind::Cursor},
    {"generation", Kind::PositiveInt}, {"sessionId", Kind::String},
    {"draftKey", Kind::String}, {"turnId", Kind::NullableString}, {"encoding", Kind::String},
    {"sampleRate", Kind::PositiveInt},
    {"command", Kind::String}, {"reason", Kind::String}, {"code", Kind::String},
};

struct Handler {
    // These are not selected-field limits. Unknown keys/values are never retained.
    static constexpr std::size_t max_object_size = SIZE_MAX;
    static constexpr std::size_t max_array_size = SIZE_MAX;
    static constexpr std::size_t max_key_size = SIZE_MAX;
    static constexpr std::size_t max_string_size = SIZE_MAX;

    char output[BoundedEnvelope::kEnvelopeCapacity];
    char scalar[BoundedEnvelope::kMaxStringBytes + 1];
    char key[10]; // longest relevant decoded key: generation/sampleRate
    std::size_t output_size = 0, scalar_size = 0, key_size = 0, depth = 0;
    std::uint16_t seen = 0;
    int selected = -1;
    bool long_key = false;
    Error error = Error::None;

    Handler() { reset(); }
    void reset() noexcept {
        output_size = 1;
        output[0] = '{'; output[1] = '\0';
        scalar_size = key_size = depth = 0;
        seen = 0; selected = -1; long_key = false; error = Error::None;
    }
    bool fail(Error why, Code& ec) {
        error = why;
        ec = boost::json::error::input_error;
        return false;
    }
    bool append(View bytes, Code& ec) {
        if (bytes.size() > sizeof(output) - 1 - output_size)
            return fail(Error::EnvelopeLimit, ec);
        if (!bytes.empty()) std::memcpy(output + output_size, bytes.data(), bytes.size());
        output_size += bytes.size(); output[output_size] = '\0';
        return true;
    }
    bool prefix(Code& ec) {
        return (output_size == 1 || append(",", ec)) && append("\"", ec) &&
            append(fields[selected].name, ec) && append("\":", ec);
    }
    bool primitive(Code& ec) {
        return depth != 0 || fail(Error::InvalidRoot, ec);
    }
    bool begin(bool object, Code& ec) {
        if (depth == 0 && !object) return fail(Error::InvalidRoot, ec);
        if (depth == 1 && selected >= 0) return fail(Error::InvalidField, ec);
        ++depth;
        return true;
    }
    bool on_document_begin(Code&) { return true; }
    bool on_document_end(Code&) { return true; } // never publish from callback
    bool on_object_begin(Code& ec) { return begin(true, ec); }
    bool on_array_begin(Code& ec) { return begin(false, ec); }
    bool on_object_end(std::size_t, Code&) { --depth; return true; }
    bool on_array_end(std::size_t, Code&) { --depth; return true; }

    bool on_key_part(View part, std::size_t, Code&) {
        if (depth != 1 || long_key) return true;
        if (part.size() > sizeof(key) - key_size) { long_key = true; return true; }
        if (!part.empty()) std::memcpy(key + key_size, part.data(), part.size());
        key_size += part.size();
        return true;
    }
    bool on_key(View part, std::size_t total, Code& ec) {
        if (depth != 1) return true;
        on_key_part(part, total, ec);
        selected = -1;
        if (!long_key) {
            for (std::size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) {
                if (std::strlen(fields[i].name) == key_size &&
                    std::memcmp(key, fields[i].name, key_size) == 0) {
                    if (seen & (1u << i)) return fail(Error::DuplicateField, ec);
                    seen |= 1u << i;
                    selected = static_cast<int>(i);
                    break;
                }
            }
        }
        key_size = scalar_size = 0; long_key = false;
        return true;
    }
    bool retain(View part, std::size_t limit, Code& ec) {
        if (part.size() > limit - scalar_size) return fail(Error::ScalarLimit, ec);
        if (!part.empty()) std::memcpy(scalar + scalar_size, part.data(), part.size());
        scalar_size += part.size(); scalar[scalar_size] = '\0';
        return true;
    }
    bool on_string_part(View part, std::size_t, Code& ec) {
        if (!primitive(ec)) return false;
        if (selected < 0) return true;
        const auto kind = fields[selected].kind;
        if ((kind != Kind::String && kind != Kind::NullableString) || part.find('\0') != View::npos)
            return fail(Error::InvalidField, ec);
        return retain(part, BoundedEnvelope::kMaxStringBytes, ec);
    }
    bool on_string(View part, std::size_t total, Code& ec) {
        if (!on_string_part(part, total, ec)) return false;
        if (selected < 0) return true;
        if (!prefix(ec)) return false;
        // Preallocated string printing performs no allocations; node borrows scalar.
        cJSON string{};
        string.type = cJSON_String;
        string.valuestring = scalar;
        if (!cJSON_PrintPreallocated(&string, output + output_size,
                                    static_cast<int>(sizeof(output) - output_size), false))
            return fail(Error::EnvelopeLimit, ec);
        output_size += std::strlen(output + output_size);
        selected = -1; scalar_size = 0;
        return true;
    }
    bool on_number_part(View part, Code& ec) {
        if (!primitive(ec)) return false;
        if (selected < 0) return true;
        const auto kind = fields[selected].kind;
        if (kind != Kind::Cursor && kind != Kind::PositiveInt)
            return fail(Error::InvalidField, ec);
        return retain(part, BoundedEnvelope::kMaxNumberBytes, ec);
    }
    bool number(View part, Code& ec) {
        if (!on_number_part(part, ec)) return false;
        if (selected < 0) return true;
        // Boost already validated grammar. cJSON sees only <=128 bytes, preserving
        // exactly the double conversion used by current handle_text (not Boost's
        // dummy number_precision::none callback value or a valueint truncation).
        cJSON* value = cJSON_ParseWithLengthOpts(scalar, scalar_size + 1, nullptr, true);
        if (!value) return fail(Error::OutOfMemory, ec);
        const double n = value->valuedouble;
        const bool cursor = fields[selected].kind == Kind::Cursor;
        const bool valid = cJSON_IsNumber(value) && std::isfinite(n) && std::floor(n) == n &&
            n >= (cursor ? 0 : 1) && n <= (cursor ? 9007199254740991.0 : INT_MAX);
        cJSON_Delete(value);
        if (!valid) return fail(Error::InvalidField, ec);
        if (!prefix(ec) || !append(View(scalar, scalar_size), ec)) return false;
        selected = -1; scalar_size = 0;
        return true;
    }
    bool on_int64(std::int64_t, View part, Code& ec) { return number(part, ec); }
    bool on_uint64(std::uint64_t, View part, Code& ec) { return number(part, ec); }
    bool on_double(double, View part, Code& ec) { return number(part, ec); }
    bool on_bool(bool, Code& ec) {
        return primitive(ec) && (selected < 0 || fail(Error::InvalidField, ec));
    }
    bool on_null(Code& ec) {
        if (!primitive(ec)) return false;
        if (selected < 0) return true;
        if (fields[selected].kind != Kind::NullableString) return fail(Error::InvalidField, ec);
        if (!prefix(ec) || !append("null", ec)) return false;
        selected = -1;
        return true;
    }
    bool on_comment_part(View, Code& ec) { return fail(Error::InvalidJson, ec); }
    bool on_comment(View, Code& ec) { return fail(Error::InvalidJson, ec); }
};

boost::json::parse_options options() {
    boost::json::parse_options opts;
    opts.max_depth = BoundedEnvelope::kMaxDepth;
    opts.numbers = boost::json::number_precision::none;
    return opts; // all nonstandard syntax / invalid Unicode flags stay false
}
} // namespace

struct BoundedEnvelope::Impl {
    boost::json::basic_parser<Handler> parser{options()};
};

BoundedEnvelope::BoundedEnvelope() noexcept { reset(); }
BoundedEnvelope::~BoundedEnvelope() = default;

BoundedEnvelope::Error BoundedEnvelope::reset() noexcept {
    finished_ = false;
    error_ = Error::None;
    try {
        if (!impl_) impl_.reset(new Impl);
        else { impl_->parser.reset(); impl_->parser.handler().reset(); }
    } catch (const std::bad_alloc&) { error_ = Error::OutOfMemory; }
    return error_;
}

BoundedEnvelope::Error BoundedEnvelope::parse(bool more, const char* bytes, std::size_t length) noexcept {
    if (error_ != Error::None) return error_;
    try {
        Code ec;
        const auto consumed = impl_->parser.write_some(more, bytes, length, ec);
        if (ec) {
            error_ = impl_->parser.handler().error;
            if (error_ == Error::None)
                error_ = ec == boost::json::error::too_deep ? Error::DepthLimit : Error::InvalidJson;
        } else if (consumed != length) error_ = Error::InvalidJson;
    } catch (const std::bad_alloc&) { error_ = Error::OutOfMemory; }
    return error_;
}

BoundedEnvelope::Error BoundedEnvelope::feed(const char* bytes, std::size_t length) noexcept {
    if (error_ != Error::None) return error_;
    if (finished_) return error_ = Error::InvalidState;
    if (!bytes && length) return error_ = Error::InvalidJson;
    return parse(true, bytes ? bytes : "", length);
}

BoundedEnvelope::Error BoundedEnvelope::finish() noexcept {
    if (error_ != Error::None || finished_) return error_;
    if (parse(false, "", 0) != Error::None) return error_;
    if (!impl_->parser.done()) return error_ = Error::InvalidJson;
    Code ec;
    if (!impl_->parser.handler().append("}", ec))
        return error_ = impl_->parser.handler().error;
    finished_ = true;
    return Error::None;
}

const char* BoundedEnvelope::envelope(std::size_t& length) const noexcept {
    length = 0;
    if (!finished_ || error_ != Error::None) return nullptr;
    length = impl_->parser.handler().output_size;
    return impl_->parser.handler().output;
}
} // namespace sentient::cube
