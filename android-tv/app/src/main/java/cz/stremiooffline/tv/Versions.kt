package cz.stremiooffline.tv

/** The same arithmetic as app/build.gradle.kts applies to the shared version in package.json. */
object Versions {
  fun code(name: String): Int {
    val parts = name.split(".")
    val major = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val patch = parts.getOrNull(2)?.toIntOrNull() ?: 0
    return major * 1_000_000 + minor * 1_000 + patch
  }
}
