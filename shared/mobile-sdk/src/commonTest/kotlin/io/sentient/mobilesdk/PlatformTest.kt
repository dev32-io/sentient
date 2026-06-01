package io.sentient.mobilesdk

import kotlin.test.Test
import kotlin.test.assertTrue

class PlatformTest {
    @Test fun greeting_includes_sdk_name() {
        assertTrue(MobileSdk.greeting().startsWith("sentient-mobile-sdk on"))
    }
    @Test fun logger_tag_roots_under_sentient_mobile_sdk() {
        assertTrue(loggerTag("ws").startsWith("sentient.mobile-sdk."))
    }
}
