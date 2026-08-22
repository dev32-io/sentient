import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.sqldelight)
}

// Shared mobile-data source version. Set to 0.1.0 with the WS-resilience + REST
// sessions work. The chat timeline is in-memory from the SDK — no durable store.
// Bumped to 0.2.0 in lockstep with shared/mobile-sdk: hold-to-talk / toggle-to-talk
// split touched ChatComponent's DI wiring (TalkModeController injection).
// Bumped to 0.3.0 in lockstep with shared/mobile-sdk: 2.0 wire rebase (turnId rename)
// + permission / delegation passthroughs on ChatComponent.
// Bumped to 0.4.0: lockstep with mobile-sdk 0.4.0 (2.0 memory-branch release).
// Bumped to 0.5.0: lockstep with mobile-sdk 0.5.0 (mobile interaction reliability).
// Bumped to 0.6.0: lockstep with mobile-sdk 0.6.0 (calendar V2 data APIs).
version = "0.6.0"

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
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.kotlinx.datetime)
            // CalendarDatabaseDriverFactory exposes the platform-neutral SqlDriver seam,
            // so runtime is API-visible. CalendarCacheStore owns domain-facing flows;
            // coroutine query helpers remain implementation-only.
            api(libs.sqldelight.runtime)
            implementation(libs.sqldelight.coroutines.extensions)
            // SettingsComponent takes a Ktor HttpClient in its public constructor so the
            // connection scope can build the settings REST clients over the same engine the
            // platform configures (generous request timeout for the restart-blocking apply).
            // `api` so consumers referencing that param type resolve HttpClient cleanly.
            api(libs.ktor.client.core)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        // The native driver is needed by the generated iOS framework only. Android
        // driver wiring belongs to the later authenticated Android session task.
        iosMain.dependencies { implementation(libs.sqldelight.native.driver) }

        // SQLDelight's JVM SQLite driver is test-only and must not enter commonMain or
        // either native target. Host-side database fixtures run with androidUnitTest.
        val androidUnitTest by getting {
            dependencies { implementation(libs.sqldelight.sqlite.driver) }
        }
    }
}

sqldelight {
    databases {
        create("CalendarDatabase") {
            packageName.set("io.sentient.mobiledata.cache.db")
            schemaOutputDirectory.set(file("src/commonMain/sqldelight/databases"))
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
