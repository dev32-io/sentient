// ---------------------------------------------------------------------------
// SecureTokenStore.ios.kt — iOS Keychain-backed token persistence.
//
// Uses the Security framework (kSecClassGenericPassword) directly via
// Kotlin/Native cinterop. Query dicts are NSMutableDictionary; they are
// toll-free bridged to CFDictionaryRef when passed to Security C APIs via
// @Suppress("CAST_NEVER_SUCCEEDS") casts (NS ↔ CF toll-free bridge is valid
// in K/N; the suppression silences the compiler's over-cautious warning).
//
// Security constant keys (CFStringRef) are also cast to NSString for use as
// NSDictionary keys — same toll-free bridge applies.
//
// Keychain attributes:
//   kSecClass             = kSecClassGenericPassword
//   kSecAttrService       = KEYCHAIN_SERVICE  ("io.sentient.app")
//   kSecAttrAccount       = KEYCHAIN_ACCOUNT  ("auth.token")
//   kSecAttrAccessible    = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
//
// save()  : SecItemUpdate; if errSecItemNotFound, falls back to SecItemAdd.
// load()  : SecItemCopyMatching with kSecReturnData + kSecMatchLimitOne.
// clear() : SecItemDelete (ignores errSecItemNotFound — idempotent).
//
// Thread safety: Keychain APIs are thread-safe per Apple documentation.
// This class holds no mutable state.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
@file:Suppress("CAST_NEVER_SUCCEEDS")

package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.CoreFoundation.CFDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFRetain
import platform.CoreFoundation.CFStringRef
import platform.CoreFoundation.CFTypeRefVar
import platform.Foundation.CFBridgingRelease
import platform.Foundation.CFBridgingRetain
import platform.Foundation.NSData
import platform.Foundation.NSDictionary
import platform.Foundation.NSMutableDictionary
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
import platform.Security.SecItemAdd
import platform.Security.SecItemCopyMatching
import platform.Security.SecItemDelete
import platform.Security.SecItemUpdate
import platform.Security.errSecDuplicateItem
import platform.Security.errSecItemNotFound
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccessible
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecMatchLimit
import platform.Security.kSecMatchLimitOne
import platform.Security.kSecReturnData
import platform.Security.kSecValueData

private val log = createLogger("secure", "token-store", "ios")

// ---------------------------------------------------------------------------
// Named constants — no magic strings in source.
// ---------------------------------------------------------------------------

private const val KEYCHAIN_SERVICE = "io.sentient.app"
private const val KEYCHAIN_ACCOUNT = "auth.token"

// ---------------------------------------------------------------------------
// CF → Foundation bridge helpers — Security CFStringRef constants as NSString.
//
// The Security `kSec*` constants are CFStringRef (Kotlin/Native type
// `CPointer<__CFString>`). A direct Kotlin `as NSString` cast checks the static
// Kotlin type and THROWS ClassCastException at runtime ("CPointer cannot be
// cast to NSString") — the toll-free memory-layout equivalence is NOT a Kotlin
// type relationship. The correct K/N idiom is to bridge through CoreFoundation:
// CFBridgingRelease(CFRetain(constant)) hands ARC an owned reference (CFRetain
// +1, CFBridgingRelease transfers that +1 to ARC) and returns a properly bridged
// Foundation object. Net effect on the shared constant is neutral; ARC owns the
// returned NSString. Used as NSDictionary keys/values below.
// ---------------------------------------------------------------------------

@Suppress("CAST_NEVER_SUCCEEDS")
private fun cfString(constant: CFStringRef?): NSString =
    CFBridgingRelease(CFRetain(constant as CPointer<*>?)) as NSString

private val KEY_CLASS: NSString get() = cfString(kSecClass)
private val KEY_ATTR_SERVICE: NSString get() = cfString(kSecAttrService)
private val KEY_ATTR_ACCOUNT: NSString get() = cfString(kSecAttrAccount)
private val KEY_ATTR_ACCESSIBLE: NSString get() = cfString(kSecAttrAccessible)
private val KEY_VALUE_DATA: NSString get() = cfString(kSecValueData)
private val KEY_RETURN_DATA: NSString get() = cfString(kSecReturnData)
private val KEY_MATCH_LIMIT: NSString get() = cfString(kSecMatchLimit)
private val VALUE_CLASS_GENERIC_PASSWORD: NSString get() = cfString(kSecClassGenericPassword)
private val VALUE_ACCESSIBLE_AFTER_FIRST_UNLOCK: NSString
    get() = cfString(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
private val VALUE_MATCH_LIMIT_ONE: NSString get() = cfString(kSecMatchLimitOne)

/**
 * iOS [SecureTokenStore] backed by the system Keychain.
 *
 * No initialisation is required on iOS — the Keychain is always available
 * once the device has been unlocked for the first time after boot.
 */
class IosSecureTokenStore : SecureTokenStore {

    override fun save(token: String) {
        log.debug("save", mapOf("tokenLength" to token.length))
        // A token-save failure must degrade gracefully, never abort the process.
        // Kotlin/Native traps any exception that escapes an @ObjCExport boundary
        // (SIGABRT via trapOnUndeclaredException) — e.g. a Foundation NSException
        // from a Security/NSDictionary call surfacing as an unhandled Throwable.
        // Catch here so a Keychain hiccup logs WARN and the SDK still connects.
        runCatching { saveToKeychain(token) }.onFailure { e ->
            log.warn("save-failed", mapOf("op" to "exception", "cause" to (e.message ?: "unknown")))
        }
    }

    private fun saveToKeychain(token: String) {
        val nsData = tokenToNSData(token) ?: run {
            log.warn("save-failed", mapOf("reason" to "token encoding failed"))
            return
        }

        // Try update first (item already exists).
        val updateQuery = baseQuery()
        val updateAttrs = NSMutableDictionary()
        updateAttrs.setObject(nsData, KEY_VALUE_DATA)
        val updateStatus = updateQuery.useAsCFDict { q ->
            updateAttrs.useAsCFDict { a -> SecItemUpdate(q, a) }
        }

        when (updateStatus) {
            errSecSuccess -> {
                log.info("save-ok", mapOf("op" to "update"))
            }
            errSecItemNotFound -> {
                // Not yet in Keychain — add with accessibility attribute.
                val addQuery = baseQuery().also { d ->
                    d.setObject(nsData, KEY_VALUE_DATA)
                    d.setObject(VALUE_ACCESSIBLE_AFTER_FIRST_UNLOCK, KEY_ATTR_ACCESSIBLE)
                }
                val addStatus = addQuery.useAsCFDict { q -> SecItemAdd(q, null) }
                if (addStatus == errSecSuccess || addStatus == errSecDuplicateItem) {
                    log.info("save-ok", mapOf("op" to "add"))
                } else {
                    log.warn("save-failed", mapOf("op" to "add", "status" to addStatus))
                }
            }
            else -> {
                log.warn("save-failed", mapOf("op" to "update", "status" to updateStatus))
            }
        }
    }

    override fun load(): String? {
        log.debug("load")
        // A load failure must degrade to null, never abort the process across
        // the @ObjCExport boundary (see save()).
        return runCatching { loadFromKeychain() }.getOrElse { e ->
            log.warn("load-failed", mapOf("op" to "exception", "cause" to (e.message ?: "unknown")))
            null
        }
    }

    private fun loadFromKeychain(): String? {
        val query = baseQuery().also { d ->
            d.setObject(true, KEY_RETURN_DATA)
            d.setObject(VALUE_MATCH_LIMIT_ONE, KEY_MATCH_LIMIT)
        }

        memScoped {
            val result = alloc<CFTypeRefVar>()
            val status = query.useAsCFDict { q -> SecItemCopyMatching(q, result.ptr) }
            return when (status) {
                errSecSuccess -> {
                    // result.value is a retained CFDataRef — bridge to NSData via
                    // CFBridgingRelease (transfers the +1 to ARC). A direct
                    // `as? NSData` would throw (CPointer is not NSData in Kotlin).
                    val data = CFBridgingRelease(result.value) as? NSData
                    if (data == null) {
                        log.warn("load-nil-data")
                        return null
                    }
                    val token = NSString.create(data, NSUTF8StringEncoding)?.toString()
                    if (token == null) {
                        log.warn("load-decode-failed")
                    } else {
                        log.info("load-ok", mapOf("tokenLength" to token.length))
                    }
                    token
                }
                errSecItemNotFound -> {
                    log.debug("load-not-found")
                    null
                }
                else -> {
                    log.warn("load-failed", mapOf("status" to status))
                    null
                }
            }
        }
    }

    override fun clear() {
        log.debug("clear")
        runCatching {
            baseQuery().useAsCFDict { q -> SecItemDelete(q) }
        }.onSuccess { status ->
            when (status) {
                errSecSuccess, errSecItemNotFound -> log.info("clear-ok")
                else -> log.warn("clear-failed", mapOf("status" to status))
            }
        }.onFailure { e ->
            log.warn("clear-failed", mapOf("op" to "exception", "cause" to (e.message ?: "unknown")))
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Builds a base Keychain query [NSMutableDictionary] scoped to this service + account.
     */
    private fun baseQuery(): NSMutableDictionary {
        val dict = NSMutableDictionary()
        dict.setObject(VALUE_CLASS_GENERIC_PASSWORD, KEY_CLASS)
        dict.setObject(KEYCHAIN_SERVICE, KEY_ATTR_SERVICE)
        dict.setObject(KEYCHAIN_ACCOUNT, KEY_ATTR_ACCOUNT)
        return dict
    }

    /** Encodes [token] as UTF-8 [NSData]. Returns null on encoding failure. */
    private fun tokenToNSData(token: String): NSData? =
        NSString.create(string = token).dataUsingEncoding(NSUTF8StringEncoding)

    /**
     * Bridges this [NSDictionary] to a [CFDictionaryRef] for a single Security
     * call, then releases it.
     *
     * A direct Kotlin `as CFDictionaryRef` cast THROWS at runtime
     * ("NSDictionaryAsKMap cannot be cast to CPointer") — the NSDictionary ↔
     * CFDictionary toll-free equivalence is not a Kotlin type relationship.
     * CFBridgingRetain hands back an owned CF reference (CPointer); SecItem* do
     * not consume the dictionary, so we balance the +1 with CFRelease after the
     * call. The bridged ref is scoped to [block] only.
     */
    private inline fun <R> NSDictionary.useAsCFDict(block: (CFDictionaryRef?) -> R): R {
        // CFBridgingRetain returns an owned CPointer (CFTypeRef); reinterpret it
        // to CFDictionaryRef. Both are CPointer, so this cast is valid in K/N
        // (unlike NSDictionary `as CFDictionaryRef`, which throws).
        @Suppress("UNCHECKED_CAST")
        val cf = CFBridgingRetain(this) as CFDictionaryRef?
        try {
            return block(cf)
        } finally {
            if (cf != null) CFRelease(cf)
        }
    }
}
