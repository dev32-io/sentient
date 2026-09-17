package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.secure.IosSecureStoreRead
import io.sentient.mobilesdk.secure.IosSecureTokenStore

/** Keychain persistence reserved solely for frozen push lifecycle envelope. */
class IosPushLifecycleStore internal constructor(
    private val keychain: IosSecureTokenStore = IosSecureTokenStore(keychainAccount = "push.revocation.lifecycle"),
) : PushLifecycleStore {
    override fun load(): PushLifecycleStoreRead = when (val result = keychain.loadDurably()) {
        IosSecureStoreRead.Missing -> PushLifecycleStoreRead.Missing
        is IosSecureStoreRead.Value -> PushLifecycleStoreRead.Value(result.value)
        IosSecureStoreRead.Failure -> PushLifecycleStoreRead.Failure
    }
    override fun save(value: String): Boolean = keychain.saveDurably(value)
    override fun clear() = keychain.clear()
}
