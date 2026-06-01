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
- SecureTokenStore on Android should use EncryptedSharedPreferences (Jetpack Security), not plain SharedPreferences; the actual owns this choice, commonMain never knows.
