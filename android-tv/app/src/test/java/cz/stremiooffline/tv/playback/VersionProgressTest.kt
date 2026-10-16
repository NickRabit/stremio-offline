package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one rule about where a media-server version's position lives, read by every TV path. */
class VersionProgressTest {

  private val context = RemoteItemContext(libraryId = "lib", itemId = "item", mediaSourceId = "v1", progressKey = "remote:abc")

  @Test
  fun `a blank key is never a title key`() {
    assertFalse(VersionProgress.titleOwned("", context))
    assertFalse(VersionProgress.titleOwned("   ", context))
  }

  @Test
  fun `the server's own remote prefix is never a title key`() {
    assertFalse(VersionProgress.titleOwned("remote:abc", context))
    assertFalse(VersionProgress.titleOwned("remote:", context))
  }

  @Test
  fun `a title key of a media-server version is title owned`() {
    assertTrue(VersionProgress.titleOwned("movie:tt0133093", context))
    assertTrue(VersionProgress.titleOwned("series:tt1:1:2", context))
  }

  @Test
  fun `a play with no remote item is never title owned`() {
    assertFalse(VersionProgress.titleOwned("movie:tt1", null))
  }

  @Test
  fun `the writer names the version only when all three ids are there`() {
    assertEquals(Triple("lib", "item", "v1"), VersionProgress.writer(context))
    assertNull(VersionProgress.writer(null))
    assertNull(VersionProgress.writer(context.copy(mediaSourceId = null)))
    assertNull(VersionProgress.writer(context.copy(mediaSourceId = "   ")))
    assertNull(VersionProgress.writer(context.copy(libraryId = "")))
    assertNull(VersionProgress.writer(context.copy(itemId = " ")))
  }

  @Test
  fun `the title's row wears the playing version's own media source`() = runTest {
    var readOwn = false
    val row = VersionProgress.savedState(
      "movie:tt1",
      context,
      { ProgressDto(position = 1200.0, duration = 7200.0) },
      { _, _ -> readOwn = true; RemoteItemStateDto() },
    )

    assertEquals("movie:tt1", row?.key)
    assertEquals(1200.0, row?.position ?: -1.0, 0.001)
    assertEquals(7200.0, row?.duration ?: -1.0, 0.001)
    assertFalse(row?.watched ?: true)
    assertEquals("v1", row?.mediaSourceId)
    assertFalse(readOwn)
  }

  @Test
  fun `an unanswered title key falls back to the item's own state`() = runTest {
    val own = RemoteItemStateDto(position = 900.0, duration = 7200.0, mediaSourceId = "v1")
    val row = VersionProgress.savedState("movie:tt1", context, { null }, { _, _ -> own })
    assertEquals(own, row)
    // A null title key is never read at all.
    var readTitle = false
    assertEquals(own, VersionProgress.savedState(null, context, { readTitle = true; null }, { _, _ -> own }))
    assertFalse(readTitle)
  }

  @Test
  fun `a failed title read is no answer and a failed item read is no row`() = runTest {
    val own = RemoteItemStateDto(position = 900.0)
    val failed = ApiError(ApiFailure.Generic)
    assertEquals(own, VersionProgress.savedState("movie:tt1", context, { throw failed }, { _, _ -> own }))
    assertNull(VersionProgress.savedState("movie:tt1", context, { throw failed }, { _, _ -> throw failed }))
  }

  @Test
  fun `a cancelled read is never swallowed`() = runTest {
    val cancelled = CancellationException("gone")
    val thrown = runCatching {
      VersionProgress.savedState("movie:tt1", context, { throw cancelled }, { _, _ -> RemoteItemStateDto() })
    }.exceptionOrNull()
    assertEquals(cancelled, thrown)
  }
}
