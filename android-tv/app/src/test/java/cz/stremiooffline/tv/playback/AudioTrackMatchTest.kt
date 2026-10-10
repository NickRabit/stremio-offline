package cz.stremiooffline.tv.playback

import androidx.media3.common.C
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioTrackMatchTest {

  private fun track(language: String?, codec: String? = null, channels: Int = 0) =
    DescriptorTrack(language = language, codec = codec, channels = channels)

  private fun offered(language: String?, mime: String?, channels: Int) =
    PlayerTrack(language = language, mimeType = mime, channels = channels)

  private fun group(vararg tracks: PlayerTrack) = PlayerTrackGroup(C.TRACK_TYPE_AUDIO, tracks.toList())

  private fun descriptor(json: String): List<JsonObject> =
    Json.parseToJsonElement(json).jsonArray.map { it.jsonObject }

  @Test
  fun `several tracks pick the one the server named`() {
    val target = track("eng", "aac", 2)
    val groups = listOf(
      group(
        offered("eng", "audio/ac3", 6),
        offered("cze", "audio/mp4a-latm", 2),
        offered("en", "audio/mp4a-latm", 2),
      ),
    )

    assertEquals(TrackMatch(0, 2), matchTrack(target, groups, C.TRACK_TYPE_AUDIO))
  }

  @Test
  fun `a dropped earlier track does not shift the ordinal`() {
    val tracks = descriptor(
      """[{"index":0,"codec":"eac3","language":"eng","channels":6},
          {"index":1,"codec":"ac3","language":"cze","channels":2},
          {"index":2,"codec":"aac","language":"eng","channels":2}]""",
    )
    val target = descriptorTrack(tracks, 2)!!
    // ExoPlayer dropped the eac3 track it cannot decode, so the file's ordinal 2 is player 1.
    val groups = listOf(
      group(
        offered("eng", "audio/ac3", 2),
        offered("eng", "audio/mp4a-latm", 2),
      ),
    )

    assertEquals(TrackMatch(0, 1), matchTrack(target, groups, C.TRACK_TYPE_AUDIO))
  }

  @Test
  fun `two tracks of the same language are told apart by the codec`() {
    val target = track("eng", "aac", 2)
    val groups = listOf(
      group(
        offered("eng", "audio/ac3", 6),
        offered("eng", "audio/mp4a-latm", 2),
      ),
    )

    assertEquals(TrackMatch(0, 1), matchTrack(target, groups, C.TRACK_TYPE_AUDIO))
  }

  @Test
  fun `a track the player did not offer leaves its own choice alone`() {
    val target = track("eng", "opus", 2)
    val groups = listOf(group(offered("eng", "audio/ac3", 6), offered("cze", "audio/mp4a-latm", 2)))

    assertNull(matchTrack(target, groups, C.TRACK_TYPE_AUDIO))
  }

  @Test
  fun `only groups of the asked kind are matched`() {
    val target = track("eng", null, 0)
    val groups = listOf(
      PlayerTrackGroup(C.TRACK_TYPE_TEXT, listOf(offered("eng", "application/x-subrip", 0))),
      group(offered("eng", "audio/ac3", 6)),
    )

    assertEquals(TrackMatch(1, 0), matchTrack(target, groups, C.TRACK_TYPE_AUDIO))
  }

  @Test
  fun `a missing track index reads as nothing`() {
    assertNull(descriptorTrack(emptyList(), 0))
    assertEquals(track("cze", "ac3", 2), descriptorTrack(descriptor("""[{"codec":"ac3","language":"cze","channels":2}]"""), 0))
  }

  @Test
  fun `a language is the same code whichever spelling the container used`() {
    assertEquals("cs", normalizeLanguage("ces"))
    assertEquals("cs", normalizeLanguage("cze"))
    assertEquals("en", normalizeLanguage("EN"))
    assertEquals("en", normalizeLanguage("eng_GB"))
    assertNull(normalizeLanguage(null))
    assertNull(normalizeLanguage("  "))
  }
}
