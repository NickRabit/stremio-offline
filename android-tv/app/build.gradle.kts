import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

// The shared version lives in the repository's root package.json. `Versions.code` mirrors the
// arithmetic below for the JVM test that covers it.
val sharedVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
  .find(rootProject.file("../package.json").readText())!!.groupValues[1]
val sharedVersionCode = sharedVersion.split(".").map(String::toInt)
  .let { (major, minor, patch) -> major * 1_000_000 + minor * 1_000 + patch }

android {
  namespace = "cz.stremiooffline.tv"
  compileSdk = 35
  buildToolsVersion = "35.0.0"

  defaultConfig {
    applicationId = "cz.stremiooffline.tv"
    minSdk = 24
    targetSdk = 35
    versionCode = sharedVersionCode
    versionName = sharedVersion
  }

  buildFeatures {
    compose = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  compilerOptions {
    jvmTarget = JvmTarget.JVM_17
  }
}

dependencies {
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.foundation)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.graphics)
  implementation(libs.androidx.tv.material)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.security.crypto)
  implementation(libs.okhttp)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.android)

  testImplementation(libs.junit)
  testImplementation(libs.okhttp.mockwebserver)
  testImplementation(libs.kotlinx.coroutines.test)
}
