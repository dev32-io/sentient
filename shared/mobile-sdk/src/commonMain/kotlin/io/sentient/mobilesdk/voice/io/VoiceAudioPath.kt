package io.sentient.mobilesdk.voice.io

/**
 * Routing hint carried on [VoiceAudio.configure] for the otherwise-ambiguous
 * (mic=true, playback=false) cell: Hold mode wants the future MicCapture engine
 * (scoped `.playAndRecord` + `.default`, no VPIO) while Continuous wants the
 * existing duplex engine's mic-only cell.
 *
 *  - [Duplex] — continuous / VPIO path (today's full-duplex engine; the default).
 *  - [Manual] — hold-mode capture path (future MicCapture engine).
 *
 * Platform actuals may ignore this hint until they implement path-split engines
 * (S4 iOS / S5 Android) — see [VoiceAudio.configure]'s default-delegating overload.
 */
enum class VoiceAudioPath { Duplex, Manual }
