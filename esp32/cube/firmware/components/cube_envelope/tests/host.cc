// SPDX-License-Identifier: MIT
// Synthetic host check/probe for production helper. Never feed private content.
#include "bounded_envelope.h"
#include <cJSON.h>
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

using Envelope = sentient::cube::BoundedEnvelope;
using Error = Envelope::Error;

namespace {
std::size_t live = 0, peak = 0, largest = 0, calls = 0;
long fail_after = -1;
union alignas(__STDCPP_DEFAULT_NEW_ALIGNMENT__) Header { std::size_t size; std::max_align_t alignment; };
void* allocate(std::size_t size) {
    if (fail_after == 0) return nullptr;
    if (fail_after > 0) --fail_after;
    auto* h = static_cast<Header*>(std::malloc(sizeof(Header) + size));
    if (!h) return nullptr;
    h->size = size;
    live += size; peak = std::max(peak, live); largest = std::max(largest, size); ++calls;
    return h + 1;
}
void release(void* ptr) {
    if (!ptr) return;
    auto* h = static_cast<Header*>(ptr) - 1;
    live -= h->size;
    std::free(h);
}
void hidden(const Envelope& p) {
    std::size_t length = 123;
    assert(p.envelope(length) == nullptr && length == 0);
}
void check(Envelope& p, const char* input, const char* expected) {
    assert(p.reset() == Error::None);
    for (const char* c = input; *c; ++c) {
        assert(p.feed(c, 1) == Error::None);
        hidden(p);
    }
    assert(p.finish() == Error::None);
    std::size_t length;
    const char* output = p.envelope(length);
    assert(output && std::strcmp(output, expected) == 0 && length == std::strlen(expected));
}
void selftest() {
    {
        Envelope p;
        hidden(p);
        assert(p.feed(nullptr, 0) == Error::None);
        check(p, "{\"t\\u0079pe\":\"turn.started\",\"turnId\":\"a\\u20ac\",\"items\":[{\"seq\":-2}],\"seq\":1.00e2,\"epoch\":-0}",
                 "{\"type\":\"turn.started\",\"turnId\":\"a\xe2\x82\xac\",\"seq\":1.00e2,\"epoch\":-0}");
        assert(p.finish() == Error::None);
        assert(p.feed("", 0) == Error::InvalidState);
        hidden(p);
        for (int i = 0; i < 100; ++i) {
            assert(p.reset() == Error::None);
            assert(p.feed("{\"seq\":", 7) == Error::None);
            assert(p.finish() == Error::InvalidJson);
            hidden(p);
            assert(p.feed("0}", 2) == Error::InvalidJson); // sticky until reset
            check(p, "{\"seq\":0}", "{\"seq\":0}");
        }
        check(p, "{\"type\\u0000\":\"ignored\",\"type\":\"x\"}", "{\"type\":\"x\"}");
        assert(p.reset() == Error::None);
        assert(p.feed(nullptr, 1) == Error::InvalidJson);
        hidden(p);
    }
    assert(live == 0);
    // Fail each allocation in a fresh complete parse, including Impl, parser stack,
    // cJSON node and cJSON numeric scratch; retry successfully on the same helper.
    unsigned failures = 0;
    for (long point = 0; point < 16; ++point) {
        fail_after = point;
        {
            Envelope p;
            Error error = Error::None;
            const char* input = "{\"items\":[[]],\"seq\":123}";
            for (const char* c = input; *c && error == Error::None; ++c) error = p.feed(c, 1);
            if (error == Error::None) error = p.finish();
            if (error != Error::None) {
                ++failures;
                assert(error == Error::OutOfMemory);
                hidden(p);
            }
            fail_after = -1;
            check(p, "{\"seq\":123}", "{\"seq\":123}");
        }
        assert(live == 0);
    }
    assert(failures >= 5);
    std::puts("API/reset/allocation-fault checks: PASS");
}
} // namespace

void* operator new(std::size_t n) { if (void* p = allocate(n)) return p; throw std::bad_alloc(); }
void* operator new[](std::size_t n) { return ::operator new(n); }
void operator delete(void* p) noexcept { release(p); }
void operator delete[](void* p) noexcept { release(p); }
void operator delete(void* p, std::size_t) noexcept { release(p); }
void operator delete[](void* p, std::size_t) noexcept { release(p); }

int main(int argc, char** argv) {
    cJSON_Hooks hooks{allocate, release};
    cJSON_InitHooks(&hooks);
    if (argc > 1 && std::strcmp(argv[1], "--selftest") == 0) { selftest(); return 0; }
    const long chunk = argc > 1 ? std::strtol(argv[1], nullptr, 10) : 4096;
    if (chunk < 0 || chunk > 4096) return 2;
    {
        Envelope p;
        Error error = Error::None;
        char bytes[4096];
        unsigned random = 0x13579bdf;
        for (;;) {
            random = random * 1664525u + 1013904223u;
            const auto take = chunk ? static_cast<std::size_t>(chunk) : 1 + random % sizeof(bytes);
            const auto size = std::fread(bytes, 1, take, stdin);
            if (!size) break;
            error = p.feed(bytes, size);
            hidden(p);
            if (error != Error::None) break;
        }
        if (error == Error::None) error = p.finish();
        std::size_t length;
        const char* output = p.envelope(length);
        if (error != Error::None) hidden(p);
        std::printf("{\"error\":%d,\"length\":%zu,\"peak\":%zu,\"largest\":%zu,\"allocations\":%zu}\n",
                    static_cast<int>(error), length, peak, largest, calls);
        std::puts(output ? output : "null");
    }
    assert(live == 0);
    cJSON_InitHooks(nullptr);
}
