package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.secure.IosSecureTokenStore

/** Keychain persistence reserved solely for the frozen push lifecycle envelope. */
class IosPushLifecycleStore : PushLifecycleStore {
    private val keychain = IosSecureTokenStore(keychainAccount = "push.revocation.lifecycle")
    override fun load(): String? = keychain.load()
    override fun save(value: String) = keychain.save(value)
    override fun clear() = keychain.clear()
}
