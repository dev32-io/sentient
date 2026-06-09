// ---------------------------------------------------------------------------
// objcexception.h — AVAudioEngine NSException → Kotlin-failure boundary shims.
//
// WHY: Kotlin/Native `runCatching` (and any Kotlin try/catch) only catches Kotlin
// `Throwable`. AVAudioEngine raises hard ObjC `NSException`s on a simulator with no
// audio I/O route — `prepare` / `startAndReturnError` throw "required condition is
// false: inputNode != nullptr || outputNode != nullptr". An uncaught NSException
// unwinds through K/N frames into the terminate handler → SIGABRT, violating the
// audioio adapters' no-crash contract.
//
// CINTEROP TYPE NOTE: this standalone cinterop does NOT share the platform.AVFAudio /
// platform.Foundation ObjC types. A function signature that references ObjC class
// types it would have to re-import (AVAudioEngine*, NSError**, NSString**) makes
// cinterop emit an ERROR-level "Unable to import" stub. So the signatures use ONLY:
//   • `id` for the engine (any ObjC object — the K/N AVAudioEngine bridges to it,
//     imported as Kotlin `Any?`), cast back to AVAudioEngine* inside the wrapper;
//   • `int` return (1 = ok, 0 = caught NSException / start failure).
// No NSError/NSString out-params — the wrappers log nothing; the Kotlin caller logs a
// generic soft-fail. Each wraps exactly ONE throwing AVAudioEngine call in @try/@catch.
//
// Implementation lives in the cinterop .def verbatim section (compiled into the image).
// ---------------------------------------------------------------------------

/// Wraps `[engine prepare]` in @try/@catch. Returns 1 on success, 0 if an NSException
/// was caught. `engine` is the AVAudioEngine passed as `id`.
int sentient_avEnginePrepare(id engine);

/// Wraps `[engine startAndReturnError:NULL]` in @try/@catch. Returns 1 on a clean
/// start, 0 on a normal start failure OR a caught NSException. `engine` is the
/// AVAudioEngine passed as `id`.
int sentient_avEngineStart(id engine);
