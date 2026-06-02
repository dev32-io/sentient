plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}
android {
    namespace = "io.sentient.android"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig {
        applicationId = "io.sentient.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1; versionName = "0.0.1"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            // 10.0.2.2 = the host loopback as seen from the Android emulator (NOT localhost,
            // which the emulator resolves to its own guest). The local gateway serves WSS with a
            // self-signed cert — SdkHolder pairs this with allowSelfSignedDevHost = BuildConfig.DEBUG.
            buildConfigField("String", "GATEWAY_WS_URL", "\"wss://10.0.2.2:8888/api/v1/ws\"")
        }
        getByName("release") {
            // Release URL is supplied by an operator build override; no self-signed host in release.
            buildConfigField("String", "GATEWAY_WS_URL", "\"wss://gateway.invalid/api/v1/ws\"")
        }
    }
}
dependencies {
    implementation(project(":shared:mobile-sdk"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
}
