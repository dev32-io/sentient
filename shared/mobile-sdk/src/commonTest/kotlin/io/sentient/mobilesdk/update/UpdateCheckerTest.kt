package io.sentient.mobilesdk.update

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val MANIFEST = """
{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":0,"url":"/download/android/latest.apk","notes":""},
 "ios":{"bundleVersion":3,"shortVersion":"0.1.5","minSupportedBuild":2,"bundleId":"io.dev32.sentient","url":"/download/ios/latest.ipa","manifestUrl":"/download/ios/manifest.plist","notes":""}}
"""

private fun client(status: HttpStatusCode, body: String) = HttpClient(MockEngine { _ ->
  respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
}) { install(ContentNegotiation) { json() } }

class UpdateCheckerTest {
  @Test fun reports_up_to_date_when_installed_equals_latest() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.ANDROID, InstalledVersion(7, "0.1.5"))
    assertEquals(UpdateStatus.UpToDate, c.check())
  }

  @Test fun reports_optional_update_when_newer_build() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.ANDROID, InstalledVersion(6, "0.1.4"))
    val s = c.check() as UpdateStatus.Available
    assertEquals(7, s.latestBuild)
    assertTrue(!s.mandatory)
    assertEquals(UpdateTarget.AndroidApk("https://h/download/android/latest.apk"), s.target)
  }

  @Test fun reports_mandatory_when_below_min_supported() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.IOS, InstalledVersion(1, "0.1.3"))
    val s = c.check() as UpdateStatus.Available
    assertTrue(s.mandatory)
    assertTrue((s.target as UpdateTarget.IosItms).itmsUrl.startsWith("itms-services://"))
  }

  @Test fun reports_check_failed_on_500() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.InternalServerError, ""),
      UpdatePlatform.ANDROID, InstalledVersion(7, "0.1.5"))
    assertTrue(c.check() is UpdateStatus.CheckFailed)
  }
}

class DeriveHostRootTest {
  @Test fun strips_api_v1_and_ws() {
    assertEquals("https://h:3000", deriveHostRoot("wss://h:3000/api/v1/ws"))
  }
}
