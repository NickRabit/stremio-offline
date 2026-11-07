package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.InspectionDto
import cz.stremiooffline.tv.data.InspectionTrackDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceInspectionTest {
  private fun stream(
    playable: Boolean = true,
    kind: String = "remote",
    name: String? = null,
    title: String? = null,
    provider: String? = null,
    remoteItem: RemoteItemContext? = null,
  ) = StreamDto(
    sourceId = "source",
    kind = kind,
    playable = playable,
    name = name,
    title = title,
    provider = provider,
    remoteItem = remoteItem,
  )

  @Test
  fun `detected tracks keep distinct languages in order`() {
    assertEquals(
      DetectedTracks(
        audio = listOf("en", "cs"),
        audioKnown = true,
        subtitles = listOf("de", "fr"),
        subtitlesKnown = true,
        noSubtitleTracks = false,
        audioFacts = cz.stremiooffline.tv.data.AudioFactsDto(),
      ),
      detectedTracks(
        InspectionDto(
          audioTracks = listOf(
            InspectionTrackDto(language = "en"),
            InspectionTrackDto(language = "cs"),
            InspectionTrackDto(language = "en"),
            InspectionTrackDto(),
          ),
          subtitleTracks = listOf(
            InspectionTrackDto(language = "de"),
            InspectionTrackDto(language = "fr"),
            InspectionTrackDto(language = "de"),
          ),
        ),
      ),
    )
  }

  @Test
  fun `the first sound track's codec, untagged audio and the picture's class are read`() {
    val read = detectedTracks(
      InspectionDto(
        video = cz.stremiooffline.tv.data.InspectionVideoDto(codec = "h264", width = 1920, height = 800),
        audioTracks = listOf(InspectionTrackDto(codec = "eac3", channels = 6), InspectionTrackDto(codec = "aac", channels = 2)),
      ),
    )
    assertEquals(true, read.audioUntagged)
    assertEquals(cz.stremiooffline.tv.data.AudioFactsDto(codec = "eac3", channels = 6), read.audioFacts)
    assertEquals(1080, read.videoHeight)
    assertEquals(576, resolutionClass(720, 576))
    assertEquals(false, detectedTracks(InspectionDto()).audioUntagged)
  }

  @Test
  fun `untagged audio is unknown and no subtitle tracks is a known empty answer`() {
    val tracks = detectedTracks(
      InspectionDto(
        audioTracks = listOf(InspectionTrackDto()),
        subtitleTracks = emptyList(),
      ),
    )
    assertFalse(tracks.audioKnown)
    assertTrue(tracks.subtitlesKnown)
    assertTrue(tracks.noSubtitleTracks)
  }

  @Test
  fun `only untagged subtitles are unknown`() {
    val tracks = detectedTracks(InspectionDto(subtitleTracks = listOf(InspectionTrackDto(), InspectionTrackDto())))
    assertFalse(tracks.subtitlesKnown)
    assertFalse(tracks.noSubtitleTracks)
  }

  @Test
  fun `uncached debrid labels are detected but RD plus is cached`() {
    assertTrue(Streams.uncachedDebrid(StreamDto(name = "[RD download] Torrentio")))
    assertTrue(Streams.uncachedDebrid(StreamDto(title = "[RD ⏳] Torrentio")))
    assertFalse(Streams.uncachedDebrid(StreamDto(name = "[RD+] Torrentio")))
  }

  @Test
  fun `only plain playable addon HTTP sources are inspectable`() {
    assertFalse(Streams.inspectable(stream(kind = "library")))
    assertFalse(Streams.inspectable(stream(kind = "torrent")))
    assertFalse(Streams.inspectable(stream(playable = false)))
    assertFalse(Streams.inspectable(stream(provider = "jellyfin")))
    assertFalse(Streams.inspectable(stream(remoteItem = RemoteItemContext("library", "item", "media", "progress"))))
    assertFalse(Streams.inspectable(stream(name = "[RD download] Torrentio")))
    assertTrue(Streams.inspectable(stream()))
  }
}
