package cz.stremiooffline.tv.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class SessionImageLoaderTest {
  @Test
  fun `each account and each server has its own image cache folder`() {
    val first = imageCacheKey("http://tv.local:8090", "anna")
    assertEquals(first, imageCacheKey("http://tv.local:8090", "anna"))
    assertNotEquals(first, imageCacheKey("http://tv.local:8090", "ben"))
    assertNotEquals(first, imageCacheKey("http://other.local:8090", "anna"))
    assertEquals(16, first.length)
  }

  /**
   * Coil 3 no longer reads an image loader from a CompositionLocal on its own: an AsyncImage without
   * `imageLoader =` silently uses the default singleton, which has no session cookie and its own cache.
   */
  @Test
  fun `every AsyncImage call names the session image loader`() {
    val sources = File("src/main/java").walkTopDown().filter { it.extension == "kt" }.toList()
    check(sources.isNotEmpty()) { "the test must run in the app module directory" }
    val offenders = sources.flatMap { file ->
      val text = file.readText()
      Regex("""(?<![\w.])AsyncImage\(""").findAll(text).mapNotNull { match ->
        var depth = 0
        var end = match.range.last
        while (end < text.length) {
          val ch = text[end]
          if (ch == '(') depth += 1
          if (ch == ')') { depth -= 1; if (depth == 0) break }
          end += 1
        }
        val call = text.substring(match.range.last, end)
        if ("imageLoader = sessionImageLoader()" in call) null
        else "${file.name}:${text.substring(0, match.range.first).count { it == '\n' } + 1}"
      }.toList()
    }
    assertEquals("AsyncImage calls without imageLoader = sessionImageLoader()", emptyList<String>(), offenders)
  }
}
