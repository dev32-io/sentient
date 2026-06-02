// ---------------------------------------------------------------------------
// SecureTokenStore.ios.kt — iOS Keychain-backed token persistence.
//
// Query dicts are built CF-natively (CFDictionaryCreateMutable +
// CFDictionaryAddValue), NOT as NSMutableDictionary toll-free-bridged via
// `as CFDictionaryRef`. Two failure modes that idiom hits: the toll-free cast
// throws ClassCastException across the K/N ObjCExport boundary (SIGABRT), and
// an NSMutableDictionary turns a Kotlin Boolean into an NSNumber instead of the
// CFBooleanRef the Security framework requires for kSecReturnData — that type
// mismatch is what produced errSecParam (-50) on SecItemCopyMatching. The fix:
// kSecReturnData = kCFBooleanTrue (a CFBooleanRef), kSecMatchLimit =
// kSecMatchLimitOne (a CFStringRef). kSec* constants are CFStringRef already, so
// they are added directly; String/NSData values bridge via CFBridgingRetain
// (owned +1, released after CFDictionaryAddValue takes its own retain).
//
// Attrs: kSecClassGenericPassword, service "io.sentient.app", account
// "auth.token", accessible kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly.
// save(): SecItemAdd, fall back to SecItemUpdate on errSecDuplicateItem.
// load(): SecItemCopyMatching → CFDataRef → NSData → UTF-8 String.
// clear(): SecItemDelete (errSecItemNotFound is idempotent-ok).
// Keychain APIs are thread-safe; this class holds no mutable state.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.COpaquePointer
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.CoreFoundation.CFDictionaryAddValue
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFDictionaryRef
import platform.CoreFoundation.CFMutableDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFTypeRefVar
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Foundation.CFBridgingRelease
import platform.Foundation.CFBridgingRetain
import platform.Foundation.NSData
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
        // (SIGABRT via trapOnUndeclaredException). Catch here so a Keychain
        // hiccup logs WARN and the SDK still connects.
        runCatching { saveToKeychain(token) }.onFailure { e ->
            log.warn("save-failed", mapOf("op" to "exception", "cause" to (e.message ?: "unknown")))
        }
    }

    private fun saveToKeychain(token: String) {
        val nsData = tokenToNSData(token) ?: run {
            log.warn("save-failed", mapOf("reason" to "token encoding failed"))
            return
        }

        // Add first; on duplicate, update the existing item's value.
        val addStatus = withQuery(
            includeAccessible = true,
            valueData = nsData,
        ) { query -> SecItemAdd(query, null) }

        when (addStatus) {
            errSecSuccess -> log.info("save-ok", mapOf("op" to "add"))
            errSecDuplicateItem -> updateExisting(nsData)
            else -> log.warn("save-failed", mapOf("op" to "add", "status" to addStatus))
        }
    }

    /** Updates the value of an already-present Keychain item. */
    private fun updateExisting(nsData: NSData) {
        // Match dict scopes to service+account; the attrs dict carries the new value.
        val status = memScoped {
            val matchDict = buildBaseQuery(includeAccessible = false, valueData = null)
            val attrsDict = CFDictionaryCreateMutable(
                null,
                1,
                kCFTypeDictionaryKeyCallBacks.ptr,
                kCFTypeDictionaryValueCallBacks.ptr,
            )
            val dataRef = CFBridgingRetain(nsData)
            try {
                CFDictionaryAddValue(attrsDict, kSecValueData, dataRef)
                SecItemUpdate(matchDict, attrsDict)
            } finally {
                if (dataRef != null) CFRelease(dataRef)
                if (attrsDict != null) CFRelease(attrsDict)
                if (matchDict != null) CFRelease(matchDict)
            }
        }
        if (status == errSecSuccess) {
            log.info("save-ok", mapOf("op" to "update"))
        } else {
            log.warn("save-failed", mapOf("op" to "update", "status" to status))
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

    private fun loadFromKeychain(): String? = memScoped {
        // kSecReturnData MUST be a CFBooleanRef (kCFBooleanTrue); a Kotlin Bool /
        // NSNumber here is what yields errSecParam (-50). kSecMatchLimitOne is a
        // CFStringRef. Both are added CF-natively below.
        val query = buildBaseQuery(includeAccessible = false, valueData = null)
        CFDictionaryAddValue(query, kSecReturnData, kCFBooleanTrue)
        CFDictionaryAddValue(query, kSecMatchLimit, kSecMatchLimitOne)

        val result = alloc<CFTypeRefVar>()
        val status = try {
            SecItemCopyMatching(query, result.ptr)
        } finally {
            if (query != null) CFRelease(query)
        }

        when (status) {
            errSecSuccess -> decodeResult(result.value)
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

    /**
     * Converts the (owned, copy-rule) CFDataRef returned by SecItemCopyMatching
     * into a UTF-8 [String]. CFBridgingRelease transfers the +1 to ARC.
     */
    private fun decodeResult(raw: COpaquePointer?): String? {
        val data = CFBridgingRelease(raw) as? NSData
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
        return token
    }

    override fun clear() {
        log.debug("clear")
        runCatching {
            val query = buildBaseQuery(includeAccessible = false, valueData = null)
            try {
                SecItemDelete(query)
            } finally {
                if (query != null) CFRelease(query)
            }
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
     * Runs [block] with a freshly built query dict (base attrs + optional value),
     * releasing the dict afterward. Used by [saveToKeychain]'s add path.
     */
    private inline fun withQuery(
        includeAccessible: Boolean,
        valueData: NSData?,
        block: (CFDictionaryRef?) -> Int,
    ): Int {
        val query = buildBaseQuery(includeAccessible, valueData)
        return try {
            block(query)
        } finally {
            if (query != null) CFRelease(query)
        }
    }

    /**
     * Builds a CF-native Keychain query scoped to this service + account.
     *
     * Caller owns the returned [CFMutableDictionaryRef] and MUST [CFRelease] it.
     * String values are bridged to CFStringRef via CFBridgingRetain (+1) and
     * released here — CFDictionaryAddValue retains its own copy, so the dict
     * keeps them alive after this returns.
     */
    private fun buildBaseQuery(
        includeAccessible: Boolean,
        valueData: NSData?,
    ): CFMutableDictionaryRef? {
        val dict = CFDictionaryCreateMutable(
            null,
            0,
            kCFTypeDictionaryKeyCallBacks.ptr,
            kCFTypeDictionaryValueCallBacks.ptr,
        )
        // kSecClassGenericPassword and the accessibility constant are CFStringRef
        // already — add them directly. Service/account come in as Kotlin Strings
        // and are bridged to owned CFStringRef refs, released after the add.
        CFDictionaryAddValue(dict, kSecClass, kSecClassGenericPassword)
        addBridged(dict, kSecAttrService, NSString.create(string = KEYCHAIN_SERVICE))
        addBridged(dict, kSecAttrAccount, NSString.create(string = KEYCHAIN_ACCOUNT))
        if (includeAccessible) {
            CFDictionaryAddValue(dict, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        }
        if (valueData != null) {
            addBridged(dict, kSecValueData, valueData)
        }
        return dict
    }

    /**
     * Bridges a Foundation [value] to an owned CF ref, adds it under [key]
     * (CFDictionaryAddValue retains its own +1), then releases the temporary.
     */
    private fun addBridged(dict: CFMutableDictionaryRef?, key: COpaquePointer?, value: Any?) {
        val ref = CFBridgingRetain(value)
        try {
            CFDictionaryAddValue(dict, key, ref)
        } finally {
            if (ref != null) CFRelease(ref)
        }
    }

    /** Encodes [token] as UTF-8 [NSData]. Returns null on encoding failure. */
    private fun tokenToNSData(token: String): NSData? =
        NSString.create(string = token).dataUsingEncoding(NSUTF8StringEncoding)
}
