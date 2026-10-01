# Cube bounded JSON envelope

Independent IDF component, integrated into `SentientWsProtocol` text ingress. Uses
unmodified, pinned Boost.JSON 1.91.0 `basic_parser`, strict defaults and numeric
validation-only mode. No history model, incoming JSON tree, subscription/filter
message, or callbacks into SDK/Application. Vendor/build details: `vendor/README.md`.

## API

```cpp
#include "bounded_envelope.h"
using sentient::cube::BoundedEnvelope;

BoundedEnvelope text; // construction never throws; feed/reset report allocation failure
text.reset();        // check returned Error before accepting a new text message
text.feed(bytes, length); // zero or more ordered fragments; check every Error
text.finish();       // only at final WS message FIN; check Error
size_t length;
const char* json = text.envelope(length); // nullptr unless finish succeeded
// Existing handle_text(json, length) can consume this bounded object once.
```

`Error::None` on feed does not mean complete/committed. Failures are sticky until
reset. Output is borrowed and invalidated by subsequent non-const calls. Successful
finish is idempotent; feed after finish fails with `InvalidState` and hides output.
Null input is allowed only for zero length. Instance is owned by one receiving
thread, not thread-safe. Constructor/reset/feed catch `std::bad_alloc`; cJSON
allocation failure also returns `OutOfMemory`.

## Projection and limits

Only decoded, case-sensitive **top-level** keys are selected:

- Strings: `type`, `sessionId`, `draftKey`, `encoding`, `command`, `reason`, `code`.
- String or JSON null: `turnId`. `tasklist.state` legitimately emits null after
  its foreground turn ends; null is preserved, not converted to an empty string.
- Cursor numbers: `seq`, `epoch` — cJSON double conversion, finite, integral,
  nonnegative, at most 9007199254740991; raw spelling retained in output.
- Positive integer numbers: `generation`, `sampleRate` — same conversion,
  integral in `[1, INT_MAX]`, matching current int-based consumer representation.
  Supported audio rates/encoding are still SDK domain policy, not parser policy.

Duplicate selected decoded keys (including escaped aliases and null/string pairs),
wrong selected types and selected string NUL fail. Only `turnId` permits null;
`seq`, `epoch`, `sessionId`, `draftKey` and other selected fields do not. Nested
fields never impersonate top-level fields. Unknown fields, including huge
keys/strings/numbers, are discarded but **fully syntax/UTF-8/escape validated**. Missing selected fields are not invented
or required; event-specific required fields remain existing consumer policy.

Selected types are the union of shapes in **all** current `GatewayMessage`
variants, not an assumption that every retained name is mandatory identity on
all events. `type` routes events and optional `seq`/`epoch` always receive strict
cursor checks when present. Other retained names are event payload projections;
null `turnId` on a task list is not permission to treat null as a playback/turn
owner. Relevant SDK handlers still enforce their required identities. Helper
accepts the nullable projection regardless of where `type` appears in the frame;
it does not duplicate per-event schemas or interpret task rows.

Fixed limits (`bounded_envelope.h`):

| Resource | Limit / failure |
| --- | --- |
| Container nesting, including root object | 32 / `DepthLimit` |
| Each selected decoded string | 256 UTF-8 bytes / `ScalarLimit` |
| Each selected raw numeric token | 128 bytes / `ScalarLimit` |
| Encoded output including NUL | 4096 bytes / `EnvelopeLimit` |

Unknown key/value length has no retained-buffer limit. Valid selected values that
exceed these bounds fail explicitly, never truncate. Worst-case escaping can hit
output bound before all per-string limits. One fixed heap state holds output,
key discriminator and current scalar; no growing string/container retained.
Boost's bounded nesting stack uses small allocations. cJSON encodes strings into
preallocated output and parses only a <=128-byte numeric scalar; it never sees
ignored payload. Current double behavior (including exponent/rounding/underflow)
is preserved, not replaced by Boost dummy numeric callback values.

Strict default rejects lone escaped UTF-16 surrogates, consistent with existing
cJSON decoding. ECMAScript can emit such escapes; those frames still fail. Do not
enable lossy global replacement, particularly for selected identifiers. Escaped
NUL in ignored content is valid and can be skipped; selected C-string values reject
it instead of silently truncating.

## Integration invariants

This component is already wired into main's `PRIV_REQUIRES` and `SentientWsProtocol` text ingress. The following are maintenance constraints, not pending integration work.

1. Retain the `cube_envelope` component dependency and public header; the component owns its source/include/dependency CMake entry.
2. Keep **text accumulation** out of `BoundedWsMessage`/`handle_data`; binary handling remains separate. Feed actual ordered text fragments directly to the helper. Do not restore the former text full-frame copy or `total > 16384` text rejection, and do not feed a truncated/synthetic substring.
3. Preserve IDF frame-local `payload_offset`/`payload_len` validation and WS opcode /
   continuation / FIN rules. New text message resets helper once; continuation
   frames do not. Interleaved control frames never reset or feed it. Transport
   framing remains caller responsibility; this helper receives bytes only.
4. At end of final WS frame, call finish. Dispatch `handle_text` exactly once only
   after success with non-null envelope. Parser root-end/done before FIN is **not**
   publication authority. Trailing junk/two roots or late invalid skipped content
   invalidates entire message, even if selected fields appeared first.
5. Any helper error retires or recovers attachment using existing coherent failure
   path. Log only typed error/category/aggregate sizes, never keys/values/envelope.
6. Reset on disconnect/new message in receive-thread ownership. Keep binary header,
   cursor, PCM/Ogg framing and playback paths unchanged. No events emitted while
   text parse is incomplete, including seq/epoch advancement.

## Checks

From repository root, with repository Bun and existing ESP-IDF cJSON (`IDF_PATH`
or `~/esp/esp-idf`):

```sh
source scripts/env.sh
python3 esp32/cube/firmware/components/cube_envelope/tests/run_tests.py --sanitize
```

Optional independent corpus (never auto-fetched): add
`--corpus /path/to/JSONTestSuite/test_parsing`. Evaluated corpus upstream
`https://github.com/nst/JSONTestSuite`, commit
`1ef36fa01286573e846ac449e8683f8833c5b26a`. `y_`/`n_` cases are wrapped as ignored
payload inside a root object and tested bytewise, 7-byte, 4096-byte and deterministic
random chunking. Implementation-defined cases are not counted as conformance PASS.
`--build-dir /tmp/...` retains host artifacts; otherwise scratch directory removed.

Tests compile actual helper, narrow Boost support and existing IDF cJSON, verify
vendor checksums, and validate fixtures for every current GatewayMessage union
branch using the actual shared schema (`tests/gateway_shapes.ts`). Fixtures cover
nullable task-list ownership, optional conversation-entry turn IDs, ordinary audio
completion and ignored extension fields; a >1MiB task-list regression places null
turnId and cursor fields after items. They also check type/duplicate/numeric/root/
resource boundaries, escaped
keys/values, large ignored payloads, reset/retry and injected C++/cJSON allocation
failure. Global test allocators measure helper storage + parser stack + cJSON
scratch independent of input length; no sanitizers disabled in production code.

Host and standalone Xtensa cross-link are not IDF integration, firmware heap/stack
margin, WS E2E or acoustic proof. Parent owns real native build/map, 8192-byte WS
task-stack high-water measurement, flash and physical acceptance. Huge input costs
linear CPU time even though memory is bounded; watchdog/timing remains native check.
