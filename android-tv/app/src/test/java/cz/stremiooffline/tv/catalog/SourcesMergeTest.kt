package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonManifestDto
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A title with hundreds of sources must stay usable: the merge, sort and filter the detail runs
 * once per change must finish well inside a frame budget even for the whole list, so a focus move
 * that changes nothing never re-parses it.
 */
class SourcesMergeTest {

  private fun stream(index: Int) =
    StreamDto(sourceId = "s$index", kind = "remote", playable = true, title = "Czech ${index} GB", addonName = "alpha")

  private fun addons(count: Int) =
    (0 until count).map { AddonDto(key = "a$it", manifest = AddonManifestDto(id = "id$it", name = "addon$it")) }

  @Test
  fun `merging six hundred streams across addons stays under a generous bound`() {
    val parts = (0 until 30).map { part -> (0 until 20).map { index -> stream(part * 20 + index) } }
    val addons = addons(30)
    val accumulated = mutableListOf<StreamDto>()
    var visible = 0

    val started = System.nanoTime()
    for (part in parts) {
      accumulated += part
      visible = Streams.sourceLists(accumulated, addons, Streams.StreamSort.Recommended, "cs", true, "cs").visible.size
    }
    val elapsedMs = (System.nanoTime() - started) / 1_000_000

    assertEquals(600, visible)
    assertTrue("the merge took ${elapsedMs}ms", elapsedMs < 2_000)
  }
}
