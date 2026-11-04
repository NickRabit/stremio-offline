package cz.stremiooffline.tv.watchnext

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchNextEntriesTest {

  @Test
  fun `a catalogue movie keeps its name, progress and poster`() {
    val updatedAt = "2026-11-04T10:20:30Z"
    val cards = listOf(
      HomeCard.ResumeCatalogue(
        key = "series:tt1:1:2",
        title = "Fallback",
        name = "Movie name",
        poster = "/api/image/poster.jpg",
        progress = HomeProgress(position = 25.5, duration = 100.0),
        updatedAt = updatedAt,
      ),
    )

    val entry = watchNextEntries(cards, now = 7L).single()

    assertEquals("series:tt1:1:2", entry.key)
    assertEquals("Movie name", entry.title)
    assertEquals(25_500L, entry.positionMs)
    assertEquals(100_000L, entry.durationMs)
    assertEquals(Instant.parse(updatedAt).toEpochMilli(), entry.lastEngagementMs)
    assertEquals("/api/image/poster.jpg", entry.artPath)
    assertFalse(entry.wideArt)
  }

  @Test
  fun `a resume file keeps its episode and wide art`() {
    val card = HomeCard.ResumeFile(
      key = "file:episode",
      title = "Episode",
      wide = "/api/library/thumb?path=episode",
      season = 2,
      episode = 5,
      progress = HomeProgress(position = 10.0, duration = 100.0),
    )

    val entry = watchNextEntries(listOf(card), now = 7L).single()

    assertEquals(2, entry.season)
    assertEquals(5, entry.episode)
    assertEquals("/api/library/thumb?path=episode", entry.artPath)
    assertTrue(entry.wideArt)
  }

  @Test
  fun `only resumable resume cards are kept`() {
    fun resume(key: String, title: String, progress: HomeProgress?) = HomeCard.ResumeFile(
      key = key,
      title = title,
      progress = progress,
    )

    val cards = listOf(
      resume("missing", "Missing", null),
      resume("zero-duration", "Zero duration", HomeProgress(position = 1.0, duration = 0.0)),
      resume("zero-position", "Zero position", HomeProgress(position = 0.0, duration = 100.0)),
      resume("completed", "Completed", HomeProgress(position = 95.0, duration = 100.0)),
      resume("blank-title", " ", HomeProgress(position = 1.0, duration = 100.0)),
      HomeCard.Remote(
        key = "remote",
        title = "Remote",
        progress = HomeProgress(position = 1.0, duration = 100.0),
      ),
      resume("valid", "Valid", HomeProgress(position = 1.0, duration = 100.0)),
    )

    assertEquals(listOf("valid"), watchNextEntries(cards, now = 7L).map { it.key })
  }

  @Test
  fun `the limit keeps the first cards in order and an invalid date uses now`() {
    fun card(index: Int) = HomeCard.ResumeFile(
      key = "file:$index",
      title = "Title $index",
      progress = HomeProgress(position = 10.0, duration = 100.0),
      updatedAt = if (index == 1) "not a date" else null,
    )

    val entries = watchNextEntries(List(4) { card(it) }, now = 123_456L, limit = 2)

    assertEquals(listOf("file:0", "file:1"), entries.map { it.key })
    assertEquals(123_456L, entries[0].lastEngagementMs)
    assertEquals(123_456L, entries[1].lastEngagementMs)
  }

  @Test
  fun `the plan inserts, updates and deletes while preserving a removed program`() {
    val keep = entry("keep", "Updated")
    val hidden = entry("hidden", "Hidden")
    val added = entry("new", "New")
    val existing = listOf(
      ExistingProgram(id = 1, key = "", browsable = true),
      ExistingProgram(id = 2, key = "keep", browsable = true),
      ExistingProgram(id = 3, key = "keep", browsable = true),
      ExistingProgram(id = 4, key = "hidden", browsable = false),
      ExistingProgram(id = 5, key = "absent", browsable = true),
    )

    val plan = planWatchNext(existing, listOf(keep, hidden, added))

    assertEquals(listOf(added), plan.insert)
    assertEquals(listOf(2L to keep), plan.update)
    assertEquals(listOf(1L, 3L, 5L), plan.delete)
  }

  @Test
  fun `links round trip and reject another scheme, host or a blank key`() {
    val key = "file:Film / episode: 1 žluťoučký"
    val link = watchNextLink(key)

    assertEquals(key, watchNextKey(link))
    assertNull(watchNextKey("https://watchnext?key=$key"))
    assertNull(watchNextKey("stremiooffline://elsewhere?key=$key"))
    assertNull(watchNextKey("stremiooffline://watchnext?key="))
  }

  @Test
  fun `art names are stable SHA-1 jpeg names`() {
    val name = watchNextArtName("/api/image/poster.jpg")

    assertTrue(name.matches(Regex("^[0-9a-f]{40}\\.jpg$")))
    assertEquals(name, watchNextArtName("/api/image/poster.jpg"))
  }

  private fun entry(key: String, title: String) = WatchNextEntry(
    key = key,
    title = title,
    season = null,
    episode = null,
    positionMs = 1_000L,
    durationMs = 10_000L,
    lastEngagementMs = 2_000L,
    artPath = null,
    wideArt = false,
  )
}
