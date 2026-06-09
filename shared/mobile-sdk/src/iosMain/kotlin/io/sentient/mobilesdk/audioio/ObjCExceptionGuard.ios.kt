// ---------------------------------------------------------------------------
// ObjCExceptionGuard.ios.kt — AVAudioEngine prepare/start under an ObjC @try/@catch.
//
// Kotlin/Native `runCatching` only catches Kotlin `Throwable`, NOT ObjC
// `NSException`. AVAudioEngine raises hard NSExceptions on a simulator with no audio
// I/O route — `prepare` / `startAndReturnError` throw "required condition is false:
// inputNode != nullptr || outputNode != nullptr". An uncaught NSException unwinds
// through K/N frames into the terminate handler → SIGABRT, violating the audio
// adapters' no-crash contract.
//
// [enginePrepareGuarded] / [engineStartGuarded] call dedicated per-op ObjC wrappers
// (objcexception.def) that wrap exactly one throwing AVAudioEngine call in an ObjC
// @try/@catch and return 1/0. A 0 (caught NSException or a normal start failure) is
// logged here as a soft fail. Callers degrade (log + fail soft), never throw across
// @ObjCExport. The wrappers take the engine as `id` and return `int` so the
// standalone cinterop avoids re-importing platform ObjC types (see the .def/.h).
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.cinterop.objcexception.sentient_avEnginePrepare
import io.sentient.mobilesdk.cinterop.objcexception.sentient_avEngineStart
import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import platform.AVFAudio.AVAudioEngine

private val log = createLogger("audioio", "objc-guard", "ios")

/**
 * Runs `engine.prepare()` inside an ObjC `@try/@catch (NSException *)`. Returns true
 * on success, false if an NSException was caught (logged as a soft fail). Never
 * throws — converts the otherwise-uncatchable NSException to a `false`.
 */
internal fun enginePrepareGuarded(engine: AVAudioEngine): Boolean {
    val ok = sentient_avEnginePrepare(engine) == 1
    if (!ok) {
        log.warn(
            "objc-exception-caught",
            mapOf("at" to "engine.prepare", "reason" to "AVAudioEngine NSException (no audio I/O route)"),
        )
    }
    return ok
}

/**
 * Runs `engine.startAndReturnError()` inside an ObjC `@try/@catch (NSException *)`.
 * Returns true only on a clean start; false on a normal start failure OR a caught
 * NSException (logged as a soft fail). Never throws.
 */
internal fun engineStartGuarded(engine: AVAudioEngine): Boolean {
    val ok = sentient_avEngineStart(engine) == 1
    if (!ok) {
        log.warn(
            "engine-start-failed",
            mapOf("at" to "engine.start", "reason" to "start returned false or NSException caught"),
        )
    }
    return ok
}
