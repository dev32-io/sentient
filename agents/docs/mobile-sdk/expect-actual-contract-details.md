# expect/actual Contract — Details

Each platform capability is bridged with a single `expect`/`actual` pair. Business logic stays in commonMain; platform glue lives exclusively in the `actual`.

## Examples

**Minimal expect interface (preferred over expect class):**
```kotlin
// commonMain
expect fun createAudioCaptureAdapter(): AudioCaptureAdapter

interface AudioCaptureAdapter {
    val frames: Flow<ByteArray>   // PCM16 LE chunks
    suspend fun start()
    suspend fun stop()
}
```

**actual in androidMain — adapter only, zero business logic:**
```kotlin
// androidMain
actual fun createAudioCaptureAdapter(): AudioCaptureAdapter =
    AndroidAudioCaptureAdapter()

internal class AndroidAudioCaptureAdapter : AudioCaptureAdapter {
    private val _frames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
    override val frames: Flow<ByteArray> = _frames
    private var record: AudioRecord? = null

    override suspend fun start() {
        record = AudioRecord(/* … */)
        record!!.startRecording()
        // pump raw PCM into _frames
    }
    override suspend fun stop() { record?.stop(); record?.release(); record = null }
}
```

**In-memory fake for commonTest:**
```kotlin
// commonTest
class FakeAudioCaptureAdapter : AudioCaptureAdapter {
    private val _frames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
    override val frames: Flow<ByteArray> = _frames
    override suspend fun start() {}
    override suspend fun stop() {}
    suspend fun emit(chunk: ByteArray) { _frames.emit(chunk) }
}
```

## Gotchas

- An `expect class` with a constructor needs `actual constructor()` in every target or the build fails per-target with a confusing 'no actual' error. Prefer `expect fun` factory + interface to sidestep this.
- `actual` files must live in the exact source-set directory (`androidMain/kotlin/…`, `iosMain/kotlin/…`); misplaced files silently become dead code.
- Do not put `@Throws` annotations in commonMain `expect` declarations — add them only on the `actual` side where Swift interop requires it.
- SecureTokenStore on Android uses the **AndroidKeyStore-backed AES/GCM approach** (not `EncryptedSharedPreferences`). `EncryptedSharedPreferences` from `androidx.security:security-crypto` was officially deprecated in 1.1.0-alpha07 (Dec 2023) and is no longer receiving updates for new API levels. The chosen approach generates an AES-256-GCM key in `AndroidKeyStore` (hardware-backed on TEE/StrongBox devices), encrypts the token with GCM, and stores `(ciphertext, IV)` as Base64 strings in a plain `MODE_PRIVATE` `SharedPreferences` file. Equivalent security, no deprecated dependency.
- SecureTokenStore on iOS uses the system Keychain via `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — survives app restart/background, not backed up to iCloud, bound to the device hardware.
- `SessionIdStore` is NOT a credential — Android uses plain `SharedPreferences`, iOS uses `NSUserDefaults`. Encrypted storage is unwarranted for an ephemeral resume handle.
- iOS Keychain cinterop note: Security framework constants (`kSecClass`, `kSecAttrService`, etc.) are `CFStringRef` = `CPointer<__CFString>`. They toll-free bridge to `NSString`; cast via `@Suppress("CAST_NEVER_SUCCEEDS") kSecClass as NSString`. Query dicts are `NSMutableDictionary`, bridged to `CFDictionaryRef` the same way for Security C API calls.
