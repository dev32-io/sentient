// audio_inject_ring.h — shared inject ring buffer for HIL audio injection.
//
// The cube's mic path runs through AudioService::ReadAudioData(), which calls
// the weak hook `agent_audio_inject_pop_samples()` on every codec read. When
// the hook returns >0, the codec read is bypassed and synthetic samples flow
// through the wake-word + audio_processor + OPUS encode + WS uplink pipeline
// exactly like real mic data.
//
// This file owns the strong override of that weak hook. The esp32-devtool
// HTTP `POST /audio/inject` handler calls audio_inject_ring_push() (via the
// cube_audio_inject_provider in sentient_cube.cc) to queue samples; the
// override drains them on subsequent codec reads.
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Push samples into the ring. Returns the number actually pushed (may be less
// than `n` if the ring is at capacity — surplus is silently dropped, matching
// the legacy behavior that HIL tests already tolerate).
size_t audio_inject_ring_push(const int16_t* src, size_t n);

// Drain up to `target_samples` mono int16 samples into `dst` at the requested
// `sample_rate`. Returns the number of samples written. Returns 0 if the
// requested rate is unsupported (only 16000 today) or the ring is empty.
// Called from AudioService::ReadAudioData() via the strong override of
// `agent_audio_inject_pop_samples`.
int audio_inject_ring_pop(int16_t* dst, int target_samples, int sample_rate);

// Inspector: how many samples are currently queued. Test / diagnostic use.
size_t audio_inject_ring_available(void);

#ifdef __cplusplus
}
#endif
