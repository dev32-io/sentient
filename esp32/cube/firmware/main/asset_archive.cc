#include "asset_archive.h"
#include <esp_heap_caps.h>
#include <miniz.h>

namespace cube_assets {
bool Decode(const uint8_t* packed, size_t size, uint8_t*& data, size_t& count) {
    data = nullptr;
    count = 0;
    Header header{};
    if (!ReadHeader(packed, size, header)) return false;
    // Peak bulk memory: expanded bytes + 10,992-byte S3 ROM state, both PSRAM.
    // Non-wrapping output is also the history window: no second 32 KiB buffer.
    auto* output = static_cast<uint8_t*>(heap_caps_malloc(header.expanded, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    auto* state = static_cast<tinfl_decompressor*>(heap_caps_malloc(sizeof(tinfl_decompressor), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!output || !state) {
        heap_caps_free(state);
        heap_caps_free(output);
        return false;
    }
    tinfl_init(state);
    size_t input_size = header.compressed;
    size_t output_size = header.expanded;
    const auto status = tinfl_decompress(state, packed + kHeaderSize, &input_size,
        output, output, &output_size,
        TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    heap_caps_free(state);
    // DONE includes zlib Adler-32 verification. Reject truncation, excess output,
    // trailing streams/bytes, invalid tables and noncanonical paths before publish.
    if (status != TINFL_STATUS_DONE || input_size != header.compressed ||
        output_size != header.expanded || !Validate(output, output_size, header.count)) {
        heap_caps_free(output);
        return false;
    }
    data = output;
    count = header.count;
    return true;
}
} // namespace cube_assets
