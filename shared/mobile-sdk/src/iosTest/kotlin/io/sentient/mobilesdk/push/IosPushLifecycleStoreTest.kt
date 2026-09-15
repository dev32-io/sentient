@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.secure.IosSecureTokenStore
import platform.Security.errSecDuplicateItem
import platform.Security.errSecItemNotFound
import platform.Security.errSecSuccess
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class IosPushLifecycleStoreTest {
    @Test
    fun addAndUpdateStatusesControlDurableSuccess() {
        val addFailure = IosPushLifecycleStore(
            IosSecureTokenStore("push-test-add", addItem = { -50 }, updateItem = { _, _ -> errSecSuccess }),
        )
        assertFalse(addFailure.save("frozen-revoke-envelope"))

        val updateFailure = IosPushLifecycleStore(
            IosSecureTokenStore(
                "push-test-update",
                addItem = { errSecDuplicateItem },
                updateItem = { _, _ -> -25291 },
            ),
        )
        assertFalse(updateFailure.save("frozen-revoke-envelope"))

        val success = IosPushLifecycleStore(
            IosSecureTokenStore("push-test-success", addItem = { errSecSuccess }, updateItem = { _, _ -> -1 }),
        )
        assertTrue(success.save("frozen-revoke-envelope"))
    }

    @Test
    fun missingItemAndReadFailureRemainDistinct() {
        val missing = IosPushLifecycleStore(IosSecureTokenStore(
            "push-test-missing",
            addItem = { errSecSuccess },
            updateItem = { _, _ -> errSecSuccess },
            copyItemStatus = { errSecItemNotFound },
        ))
        assertIs<PushLifecycleStoreRead.Missing>(missing.load())

        val failed = IosPushLifecycleStore(IosSecureTokenStore(
            "push-test-read-failure",
            addItem = { errSecSuccess },
            updateItem = { _, _ -> errSecSuccess },
            copyItemStatus = { -25291 },
        ))
        assertIs<PushLifecycleStoreRead.Failure>(failed.load())
    }
}
