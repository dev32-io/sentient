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
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.CoreFoundation.CFDictionaryRef
import platform.CoreFoundation.CFTypeRefVar
import platform.Foundation.NSData
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
// Toll-free bridge helpers — Security CFStringRef constants cast to NSString.
//
// CFStringRef and NSString share the same memory layout (toll-free bridge).
// Kotlin/Native exposes Security constants as CPointer<__CFString> (= CFStringRef).
// The @Suppress("CAST_NEVER_SUCCEEDS") at file level silences the spurious warning.
// ---------------------------------------------------------------------------

private val KEY_CLASS: NSString get() = kSecClass as NSString
private val KEY_ATTR_SERVICE: NSString get() = kSecAttrService as NSString
private val KEY_ATTR_ACCOUNT: NSString get() = kSecAttrAccount as NSString
private val KEY_ATTR_ACCESSIBLE: NSString get() = kSecAttrAccessible as NSString
private val KEY_VALUE_DATA: NSString get() = kSecValueData as NSString
private val KEY_RETURN_DATA: NSString get() = kSecReturnData as NSString
private val KEY_MATCH_LIMIT: NSString get() = kSecMatchLimit as NSString
private val VALUE_CLASS_GENERIC_PASSWORD: NSString get() = kSecClassGenericPassword as NSString
private val VALUE_ACCESSIBLE_AFTER_FIRST_UNLOCK: NSString
    get() = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as NSString
private val VALUE_MATCH_LIMIT_ONE: NSString get() = kSecMatchLimitOne as NSString

/**
 * iOS [SecureTokenStore] backed by the system Keychain.
 *
 * No initialisation is required on iOS — the Keychain is always available
 * once the device has been unlocked for the first time after boot.
 */
class IosSecureTokenStore : SecureTokenStore {

    override fun save(token: String) {
        log.debug("save", mapOf("tokenLength" to token.length))
        val nsData = tokenToNSData(token) ?: run {
            log.warn("save-failed", mapOf("reason" to "token encoding failed"))
            return
        }

        // Try update first (item already exists).
        val updateQuery = baseQuery()
        val updateAttrs = NSMutableDictionary()
        updateAttrs.setObject(nsData, KEY_VALUE_DATA)
        val updateStatus = SecItemUpdate(updateQuery.asCFDict(), updateAttrs.asCFDict())

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
                val addStatus = SecItemAdd(addQuery.asCFDict(), null)
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
        val query = baseQuery().also { d ->
            d.setObject(true, KEY_RETURN_DATA)
            d.setObject(VALUE_MATCH_LIMIT_ONE, KEY_MATCH_LIMIT)
        }

        memScoped {
            val result = alloc<CFTypeRefVar>()
            val status = SecItemCopyMatching(query.asCFDict(), result.ptr)
            return when (status) {
                errSecSuccess -> {
                    // result.value is a CFTypeRef (toll-free bridged NSData).
                    val data = result.value as? NSData
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
        val status = SecItemDelete(baseQuery().asCFDict())
        when (status) {
            errSecSuccess, errSecItemNotFound -> log.info("clear-ok")
            else -> log.warn("clear-failed", mapOf("status" to status))
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
     * Toll-free bridges [NSMutableDictionary] to [CFDictionaryRef].
     *
     * NSMutableDictionary and CFMutableDictionary share the same runtime
     * representation (toll-free bridge). The cast is always valid at runtime;
     * the compiler warning is suppressed at the file level.
     */
    private fun NSMutableDictionary.asCFDict(): CFDictionaryRef? =
        this as CFDictionaryRef?
}
