// ---------------------------------------------------------------------------
// VoiceKotlinBytes — KotlinByteArray ⇄ Data bridging for the voice cluster.
//
// SKIE does NOT auto-bridge Kotlin `ByteArray` to `Data`: `VoicesUseCases.preview`
// returns `SentientResult<KotlinByteArray>` and `create` takes `audioWav:
// KotlinByteArray` (verified in the generated Swift). These two extensions convert
// at the boundary — the WAV preview bytes into `Data` for `AVAudioPlayer(data:)`,
// and a recorded/picked clip's `Data` into a `KotlinByteArray` for `create`.
//
// Conversion is a per-byte copy across the ObjC bridge (KotlinByteArray exposes no
// bulk accessor). It runs ONCE per preview / submit on clips of a few hundred KB,
// which is well within budget. NEVER log the byte contents — count only.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

extension KotlinByteArray {
    /// Copy this Kotlin byte array into a Swift `Data`. Kotlin bytes are signed
    /// `Int8`; the raw bit pattern is preserved into `Data`'s unsigned storage.
    func toData() -> Data {
        let count = Int(size)
        guard count > 0 else { return Data() }
        var data = Data(count: count)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            let dst = base.assumingMemoryBound(to: Int8.self)
            for index in 0..<count {
                dst[index] = get(index: Int32(index))
            }
        }
        return data
    }
}

extension Data {
    /// Copy this `Data` into a Kotlin `ByteArray` for a multipart voice `create`.
    func toKotlinByteArray() -> KotlinByteArray {
        let array = KotlinByteArray(size: Int32(count))
        withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let src = base.assumingMemoryBound(to: Int8.self)
            for index in 0..<count {
                array.set(index: Int32(index), value: src[index])
            }
        }
        return array
    }
}
