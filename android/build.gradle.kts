import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}
android {
    namespace = "io.sentient.android"
    compileSdk = libs.versions.compileSdk.get().toInt()
    // Debug gateway URL is sourced from local.properties (gitignored) so no private
    // host is ever committed. Key: sentient.gatewayUrl. Absent → 10.0.2.2 emulator
    // loopback fallback. See android/local.properties.example. Release bakes NO
    // default ("") → the app forces the in-app backend-setup page on first launch.
    val debugGatewayUrl: String = run {
        val props = Properties()
        val f = rootProject.file("local.properties")
        if (f.exists()) f.inputStream().use { props.load(it) }
        props.getProperty("sentient.gatewayUrl") ?: "wss://10.0.2.2:8888/api/v1/ws"
    }
    defaultConfig {
        // Prod application id. The debug build type appends ".debug" so both
        // variants install side by side (io.dev32.sentient.debug + io.dev32.sentient).
        applicationId = "io.dev32.sentient"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 2; versionName = "0.1.0"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
    buildTypes {
        getByName("debug") {
            isDebuggable = true
            applicationIdSuffix = ".debug"
            // Sourced from local.properties (gitignored) — see debugGatewayUrl above.
            buildConfigField("String", "GATEWAY_WS_URL", "\"$debugGatewayUrl\"")
        }
        getByName("release") {
            // No baked default: empty ⇒ resolver returns Unconfigured ⇒ setup page.
            buildConfigField("String", "GATEWAY_WS_URL", "\"\"")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}
dependencies {
    implementation(project(":shared:mobile-sdk"))
    implementation(project(":shared:mobile-data"))
    // Koin — runtime DI for the Android UI layer (no KSP). koin-bom aligns the module
    // versions; compose + nav integration give koinViewModel() / koinNavViewModel().
    implementation(platform(libs.koin.bom))
    implementation(libs.koin.android)
    implementation(libs.koin.androidx.compose)
    implementation(libs.koin.androidx.compose.navigation)
    // Route-based navigation.
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.kotlinx.coroutines.android)
    // Auth REST client (D-A2): OkHttp-backed Ktor HttpClient + JSON ContentNegotiation.
    // The AuthClient lives in commonMain (shared SDK) but takes an injected HttpClient;
    // the app supplies the platform OkHttp engine + dev-TLS-bypass for the localhost cert.
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    // Markdown rendering for assistant chat bubbles (GFM, pure Compose).
    implementation(libs.markdown.renderer.m3)
    // Key-value prefs: the platform owner constructs SharedPreferencesSettings for
    // ChatComponent's durable resume cursor (mobile-data declares it implementation,
    // so the app needs its own direct dependency to reference the platform class).
    implementation(libs.multiplatform.settings)
    // System splash screen handoff.
    implementation(libs.androidx.core.splashscreen)
    // JVM unit tests (Layer 1): pure use-cases, mappers, pure models.
    testImplementation(libs.kotlin.test)
}
