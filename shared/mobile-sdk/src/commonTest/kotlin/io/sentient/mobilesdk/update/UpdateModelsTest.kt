package io.sentient.mobilesdk.update

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

private const val JSON_TEXT = """
{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":5,"url":"/download/android/latest.apk","notes":"n"},
 "ios":{"bundleVersion":3,"shortVersion":"0.1.5","minSupportedBuild":2,"bundleId":"io.dev32.sentient","url":"/download/ios/latest.ipa","manifestUrl":"/download/ios/manifest.plist","notes":""}}
"""

private const val ANDROID_ONLY_JSON = """
{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":5,"url":"/download/android/latest.apk","notes":"n"}}
"""

class UpdateModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test fun deserializes_manifest() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    assertEquals(7, m.android?.versionCode)
    assertEquals(3, m.ios?.bundleVersion)
  }

  @Test fun normalizes_android_release() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    val r = m.forPlatform(UpdatePlatform.ANDROID)!!
    assertEquals(7, r.build)
    assertEquals(5, r.minSupportedBuild)
    assertEquals("/download/android/latest.apk", r.downloadPath)
    assertNull(r.itmsPath)
  }

  @Test fun normalizes_ios_release() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    val r = m.forPlatform(UpdatePlatform.IOS)!!
    assertEquals(3, r.build)
    assertEquals("/download/ios/manifest.plist", r.itmsPath)
  }

  @Test fun single_platform_manifest_tolerated() {
    val m = json.decodeFromString(UpdateManifest.serializer(), ANDROID_ONLY_JSON)
    assertNotNull(m.forPlatform(UpdatePlatform.ANDROID))
    assertNull(m.forPlatform(UpdatePlatform.IOS))
  }
}
