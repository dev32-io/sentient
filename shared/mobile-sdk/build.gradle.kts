import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
    alias(libs.plugins.kotlin.serialization)
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
    }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.serialization.kotlinx.json)
            implementation(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        iosMain.dependencies { implementation(libs.ktor.client.darwin) }

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
