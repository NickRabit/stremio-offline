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

  /** `major.minor` of a version, or null when either side is missing. */
  private fun minorOf(name: String?): String? {
    val parts = name?.trim()?.split(".") ?: return null
    if (parts.size < 2 || parts[0].toIntOrNull() == null || parts[1].toIntOrNull() == null) return null
    return "${parts[0]}.${parts[1]}"
  }

  /** True only when both versions are known and their `major.minor` differ, which is what the
   *  Settings screen warns about: a patch release never needs the two updated together. */
  fun differsInMinor(app: String?, server: String?): Boolean {
    val a = minorOf(app) ?: return false
    val b = minorOf(server) ?: return false
    return a != b
  }
}
