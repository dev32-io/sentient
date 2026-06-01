package io.sentient.mobilesdk

import kotlin.experimental.ExperimentalObjCName
import kotlin.native.ObjCName

/**
 * P0 placeholder. Real SentientSdk lands in Plan 2 (P1).
 *
 * The `@ObjCName` pins the Swift-facing symbol to `MobileSdkKit` so it does NOT
 * collide with the framework/module name `MobileSdk` (which would otherwise force
 * SKIE to rename it to `MobileSdk_`). Kotlin/Android callers keep `MobileSdk.greeting()`.
 */
@OptIn(ExperimentalObjCName::class)
@ObjCName("MobileSdkKit")
object MobileSdk {
    fun greeting(): String = "sentient-mobile-sdk on ${Platform().name}"
}
