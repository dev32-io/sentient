// ---------------------------------------------------------------------------
// SecureTokenStore.android.kt — Android Keystore-backed token persistence.
//
// Storage approach: AndroidKeyStore AES/GCM/NoPadding (option b from the plan).
//
// RATIONALE FOR KEYSTORE-BACKED APPROACH (NOT EncryptedSharedPreferences):
//   EncryptedSharedPreferences (androidx.security:security-crypto) is officially
//   deprecated as of security-crypto 1.1.0-alpha07 (Dec 2023) and is not being
//   updated for new Android API levels. Using it would saddle the SDK with a
//   deprecated dependency that will eventually break. The manual Keystore approach
//   is what Google now recommends: generate an AES-GCM key directly in
//   AndroidKeyStore (hardware-backed on devices that support it), encrypt the
//   token, and store ciphertext + IV in a plain SharedPreferences file. This
//   gives equivalent security with no deprecated dependency.
//
// Key: alias KEYSTORE_ALIAS in the AndroidKeyStore provider.
// Prefs file: "sentient.secure.prefs" (MODE_PRIVATE).
// Keys in prefs: PREF_KEY_TOKEN_CIPHERTEXT, PREF_KEY_TOKEN_IV.
//
// Thread safety: Keystore and SharedPreferences operations are synchronous and
// called from whatever dispatcher the coroutine chooses — the implementation
// is stateless (no mutable fields) and thread-safe.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.log.createLogger
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val log = createLogger("secure", "token-store", "android")

// ---------------------------------------------------------------------------
// Named constants — no magic strings in source.
// ---------------------------------------------------------------------------

private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
private const val KEYSTORE_ALIAS = "io.sentient.app.auth.token.key"
private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
private const val GCM_TAG_LENGTH_BITS = 128
private const val PREFS_FILE = "sentient.secure.prefs"
private const val PREF_KEY_TOKEN_CIPHERTEXT = "sentient.auth.token.ciphertext"
private const val PREF_KEY_TOKEN_IV = "sentient.auth.token.iv"

/**
 * Android [SecureTokenStore] backed by AndroidKeyStore AES/GCM encryption.
 *
 * Construct with an application [Context]. In practice the SDK creates this
 * from [AndroidContextHolder.requireContext()], which is populated by
 * `MobileSdk.initAndroid(context)` called in `Application.onCreate()`.
 *
 * @param context Application context. Never stores an Activity context.
 */
class AndroidSecureTokenStore(context: Context) : SecureTokenStore {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    // -----------------------------------------------------------------------
    // SecureTokenStore
    // -----------------------------------------------------------------------

    override fun save(token: String) {
        log.debug("save", mapOf("tokenLength" to token.length))
        try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            prefs.edit()
                .putString(PREF_KEY_TOKEN_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(PREF_KEY_TOKEN_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .apply()
            log.info("save-ok", mapOf("ciphertextBytes" to ciphertext.size, "ivBytes" to iv.size))
        } catch (e: Exception) {
            log.warn("save-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }

    override fun load(): String? {
        log.debug("load")
        val ciphertextB64 = prefs.getString(PREF_KEY_TOKEN_CIPHERTEXT, null) ?: return null
        val ivB64 = prefs.getString(PREF_KEY_TOKEN_IV, null) ?: return null
        return try {
            val ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP)
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
            val plain = cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
            log.info("load-ok", mapOf("tokenLength" to plain.length))
            plain
        } catch (e: Exception) {
            log.warn("load-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
            null
        }
    }

    override fun clear() {
        log.debug("clear")
        try {
            prefs.edit()
                .remove(PREF_KEY_TOKEN_CIPHERTEXT)
                .remove(PREF_KEY_TOKEN_IV)
                .apply()
            log.info("clear-ok")
        } catch (e: Exception) {
            log.warn("clear-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }

    // -----------------------------------------------------------------------
    // Key management
    // -----------------------------------------------------------------------

    /**
     * Returns the existing AndroidKeyStore key for [KEYSTORE_ALIAS], or
     * generates a new one if it does not yet exist.
     *
     * The key is AES-256 with GCM, user-presence not required (background-safe),
     * and is hardware-backed on devices that support StrongBox / TEE.
     */
    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).also { it.load(null) }
        val existing = keyStore.getKey(KEYSTORE_ALIAS, null) as? SecretKey
        if (existing != null) {
            log.debug("key-exists", mapOf("alias" to KEYSTORE_ALIAS))
            return existing
        }
        log.info("key-generate", mapOf("alias" to KEYSTORE_ALIAS))
        val keyGenSpec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
            .also { it.init(keyGenSpec) }
            .generateKey()
    }
}

/**
 * Convenience factory that resolves the Context from [AndroidContextHolder].
 *
 * Used by C7's platform bundle. Prefer passing Context explicitly when the
 * caller already has one.
 */
fun AndroidSecureTokenStore(): AndroidSecureTokenStore =
    AndroidSecureTokenStore(AndroidContextHolder.requireContext())
