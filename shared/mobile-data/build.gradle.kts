import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
    alias(libs.plugins.kotlin.serialization)
}

// Shared mobile-data source version. Set to 0.1.0 with the WS-resilience + REST
// sessions work. The chat timeline is in-memory from the SDK — no durable store.
// Bumped to 0.2.0 in lockstep with shared/mobile-sdk: hold-to-talk / toggle-to-talk
// split touched ChatComponent's DI wiring (TalkModeController injection).
version = "0.2.0"

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
    val xcfName = "MobileData"
    val xcf = XCFramework(xcfName)
    listOf(iosArm64(), iosSimulatorArm64()).forEach {
        it.binaries.framework {
            baseName = xcfName
            isStatic = true
            export(project(":shared:mobile-sdk"))
            xcf.add(this)
        }
    }

    sourceSets {
        commonMain.dependencies {
            api(project(":shared:mobile-sdk"))
            implementation(libs.kotlinx.coroutines.core)
            // SettingsComponent takes a Ktor HttpClient in its public constructor so the
            // connection scope can build the settings REST clients over the same engine the
            // platform configures (generous request timeout for the restart-blocking apply).
            // `api` so consumers referencing that param type resolve HttpClient cleanly.
            api(libs.ktor.client.core)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
        }
    }
}

android {
    namespace = "io.sentient.mobiledata"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}
