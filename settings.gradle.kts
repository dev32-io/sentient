pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "sentient-mobile"
include(":shared:mobile-sdk")
include(":shared:mobile-data")
include(":android")
