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

// The release key lives in CI secrets, never in the repository: the four variables below are
// exported by the android job in release.yml. All four are required before the signing config
// exists -- one of them alone would fail `packageRelease` instead of producing the unsigned APK a
// local run expects.
val releaseKeystore = System.getenv("ANDROID_KEYSTORE")
val releaseStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
val hasReleaseKey = listOf(releaseKeystore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { !it.isNullOrBlank() }

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

  signingConfigs {
    if (hasReleaseKey) {
      create("release") {
        storeFile = file(releaseKeystore!!)
        storePassword = releaseStorePassword
        keyAlias = releaseKeyAlias
        keyPassword = releaseKeyPassword
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      // Media3, OkHttp and kotlinx-serialization ship their own consumer rules, and Coil 2 needs
      // none. This file holds only what a minified build proves necessary: `assembleRelease`
      // proves the build minifies, not that a reflective path survives at runtime.
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
    }
  }

  buildFeatures {
    compose = true
  }

  testOptions {
    unitTests {
      isIncludeAndroidResources = true
      all {
        // Robolectric fetches its SDK jar through Maven. An offline environment can pre-place the
        // jars and point at them with ROBOLECTRIC_DEPS; otherwise Robolectric's own fetch is used.
        val deps = System.getenv("ROBOLECTRIC_DEPS")
        if (deps != null && file(deps).isDirectory) {
          it.systemProperty("robolectric.dependency.dir", deps)
        }
        it.systemProperty(
          "sourceSelectionVectors",
          rootProject.file("../packages/source-selection/vectors.json").absolutePath,
        )
      }
    }
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
  implementation(libs.androidx.appcompat)
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
  implementation(libs.androidx.media3.exoplayer)
  implementation(libs.androidx.media3.exoplayer.hls)
  implementation(libs.androidx.media3.datasource.okhttp)
  implementation(libs.androidx.media3.ui)
  implementation(libs.androidx.media3.session)
  implementation(libs.coil.compose)

  debugImplementation(libs.androidx.compose.ui.test.manifest)

  testImplementation(libs.junit)
  testImplementation(libs.okhttp.mockwebserver)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.androidx.test.core)
  testImplementation(libs.androidx.test.ext.junit)
  testImplementation(platform(libs.androidx.compose.bom))
  testImplementation(libs.androidx.compose.ui.test.junit4)
  testImplementation(libs.androidx.compose.ui.test.manifest)
}
