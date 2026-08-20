import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
    alias(libs.plugins.kotlin.serialization)
}

// Shared mobile-SDK source version. Set to 0.1.0 with the WS-resilience +
// chat-mirror work (resumable WS, REST sessions, device chat mirror).
// Bumped to 0.1.1: send conversationId in session.configure on reconnect (Task 3).
// Bumped to 0.1.2: SentientMobileVitals (Task 14).
// Bumped to 0.1.3: surface-isolation (per-tab/per-app surfaceId in session.configure).
// Bumped to 0.1.4: cycleId render-key fix (committed-history entryId dedup).
// Bumped to 0.1.6: iOS mic-dead fix (defer SharedAudioEngine prepare/start off the
// empty render graph — eager prepare() threw "no I/O route" on real devices).
// Skips 0.1.5 to re-align with the app versionName lockstep (app was already 0.1.5).
// 0.1.6 also carries the voice-uplink refactor + the VoiceAudio one-engine
// consolidation / full-duplex lazy-arm downlink (same feature branch, no bump).
// Bumped to 0.2.0: hold-to-talk / toggle-to-talk split (TalkModeController,
// per-path audio engines, buffer-and-defer TTS). NOTE — the app versionName
// (android/build.gradle.kts, ios/project.yml) jumped to its own 1.x OTA-trigger
// release track (chore 0824423) and is no longer numerically equal to this
// module's source version; "lockstep" from here on means bump-together cadence
// on every mobile release, not equal digits.
// Bumped to 0.3.0: Sentient 2.0 wire rebase — turn.*/permission.*/delegation.progress
// frames, cycleId→turnId across protocol/connectors/sdk, per-turn downlink audio queue
// (§7.2: a new turn queues behind, never flushes), permission + delegation connectors.
// Bumped to 0.4.0: 2.0 memory-branch protocol touches — AuthUser gains `role`
// (tool-permission role gate readable by clients); dead 1.x decoders flagged for
// removal (see native-todo "Mobile protocol cleanup").
// Bumped to 0.5.0: mobile interaction reliability — fresh-chat isolation,
// mic envelope metering, and shared talk-mode barge-in behavior.
// Bumped to 0.6.0: calendar V2 wire contracts and client operations.
version = "0.6.0"

// The gateway JSON is the cross-client wire fixture. Generate a test-only
// Kotlin holder from that file instead of copying its values into SDK tests.
val calendarWireFixture = rootProject.file("gateway/src/calendar/fixtures/calendar-wire.json")
val generatedCalendarFixtureDir = layout.buildDirectory.dir("generated/calendar-test-fixture")
val generateCalendarWireFixture by tasks.registering {
    inputs.file(calendarWireFixture)
    val outputFile = generatedCalendarFixtureDir.map { it.file("io/sentient/mobilesdk/calendar/CalendarGoldenFixture.kt") }
    outputs.file(outputFile)
    doLast {
        val escaped = calendarWireFixture.readText()
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
        val output = outputFile.get().asFile
        output.parentFile.mkdirs()
        output.writeText(
            """package io.sentient.mobilesdk.calendar

internal object CalendarGoldenFixture {
    const val JSON: String = "$escaped"
}
""",
        )
    }
}

kotlin {
    androidTarget {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
                }
            }
        }
    }
    val xcfName = "MobileSdk"
    val xcf = XCFramework(xcfName)
    listOf(iosArm64(), iosSimulatorArm64()).forEach {
        it.binaries.framework {
            baseName = xcfName
            isStatic = true
            xcf.add(this)
        }
        // ObjC NSException → Kotlin-failure boundary shim. K/N runCatching cannot
        // catch AVFoundation NSExceptions (AVAudioEngine prepare/start on a sim with
        // no audio route raises 'inputNode != nullptr || outputNode != nullptr' →
        // terminate → SIGABRT). SharedAudioEngine wraps engine.prepare/start in this
        // @try/@catch shim so the audioio no-crash contract holds. See
        // src/nativeInterop/cinterop/objcexception.{def,h}.
        it.compilations.getByName("main").cinterops.create("objcexception") {
            definitionFile.set(project.file("src/nativeInterop/cinterop/objcexception.def"))
            includeDirs(project.file("src/nativeInterop/cinterop"))
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.serialization.kotlinx.json)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.kopus)
        }
        commonTest {
            kotlin.srcDir(generatedCalendarFixtureDir)
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.kotlinx.coroutines.test)
                implementation(libs.ktor.client.mock)
            }
        }
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        iosMain.dependencies { implementation(libs.ktor.client.darwin) }

        // iosTest is the home for tests that call into kopus' libopus native code
        // (A3 Opus wrapper round-trip). That native lib is built into the iOS
        // framework targets and loads on the simulator, but NOT under the host
        // JVM testDebugUnitTest target (no Android .so on the host) — so any
        // kopus-calling test MUST live here, never in commonTest. It inherits
        // commonTest via the default hierarchy template; it only needs kotlin-test.
        iosTest.dependencies { implementation(kotlin("test")) }

        // androidUnitTest is the JVM-host home for the @live round-trip harness
        // (C8): the testDebugUnitTest JVM host can open real HTTP/WS to the local
        // gateway via the OkHttp engine, which commonTest's MockEngine-only /
        // network-less native targets cannot. It inherits commonTest (kotlin-test,
        // coroutines-test, fakes) and androidMain (OkHttp engine); it adds the
        // real OkHttp ktor engine + ContentNegotiation for the live AuthClient
        // HttpClient. The @live tests are GATED on SENTIENT_LIVE=1 so a normal
        // allTests / testDebugUnitTest run skips them (see LiveTextRoundTripTest).
        val androidUnitTest by getting {
            dependencies {
                implementation(libs.ktor.client.okhttp)
                implementation(libs.ktor.client.content.negotiation)
                implementation(libs.ktor.serialization.kotlinx.json)
            }
        }
    }
}

tasks.matching { it.name.contains("compile") && it.name.contains("TestKotlin") }.configureEach {
    dependsOn(generateCalendarWireFixture)
}

android {
    namespace = "io.sentient.mobilesdk"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // android.util.Log is a stub in JVM unit tests and throws "not mocked" on
    // any call. The shared logger (LogSink.android.kt) routes to it, so any
    // commonMain logic that logs would fail testDebugUnitTest. Return defaults
    // (no-op) so commonMain logic runs under the Android JVM test target too.
    testOptions { unitTests.isReturnDefaultValues = true }
}
