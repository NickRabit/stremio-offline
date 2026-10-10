package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.playback.DescriptorTrack
import cz.stremiooffline.tv.playback.SubtitleChoice
import org.junit.Assert.assertEquals
import org.junit.Test

/** The panel's pure decisions: which row takes the remote on open, and how the rows read. */
class PlayerTracksLabelsTest {

  private val audio = listOf(
    DescriptorTrack(index = 0, language = "en", codec = "aac", channels = 2),
    DescriptorTrack(index = 1, language = "cs", codec = "eac3", channels = 6),
  )
  private val embedded = listOf(
    DescriptorTrack(index = 0, language = "cs", codec = "subrip"),
    DescriptorTrack(index = 1, language = "en", codec = "subrip", forced = true),
  )

  @Test
  fun `the panel opens on the audio track in use, clamped to what the descriptor offers`() {
    assertEquals(TracksEntry.Audio(1), tracksEntry(audio, 1, embedded, SubtitleChoice.Off, emptyList()))
    assertEquals(TracksEntry.Audio(1), tracksEntry(audio, 9, embedded, SubtitleChoice.Off, emptyList()))
  }

  @Test
  fun `without audio the panel opens on the subtitle in use`() {
    assertEquals(TracksEntry.Off, tracksEntry(emptyList(), 0, emptyList(), SubtitleChoice.Off, emptyList()))
    assertEquals(TracksEntry.Embedded(1), tracksEntry(emptyList(), 0, embedded, SubtitleChoice.Embedded(1), emptyList()))
  }

  @Test
  fun `an addon subtitle opens on its own row`() {
    val addons = listOf(
      AddonSubtitleDto(subtitleId = "a", lang = "en"),
      AddonSubtitleDto(subtitleId = "b", lang = "cs"),
    )
    assertEquals(TracksEntry.Addon(1), tracksEntry(emptyList(), 0, emptyList(), SubtitleChoice.Addon("b"), addons))
    assertEquals(TracksEntry.Off, tracksEntry(emptyList(), 0, emptyList(), SubtitleChoice.Addon("gone"), addons))
  }

  @Test
  fun `several releases of one language are numbered so the rows can be told apart`() {
    val addons = listOf(
      AddonSubtitleDto(subtitleId = "a", lang = "en", addonName = "OpenSubtitles v3"),
      AddonSubtitleDto(subtitleId = "b", lang = "en", addonName = "OpenSubtitles v3"),
      AddonSubtitleDto(subtitleId = "c", lang = "en", addonName = "OpenSubtitles v3"),
      AddonSubtitleDto(subtitleId = "d", lang = "cs", addonName = "OpenSubtitles v3"),
    )
    assertEquals(
      listOf(
        "EN · OpenSubtitles v3 · 1",
        "EN · OpenSubtitles v3 · 2",
        "EN · OpenSubtitles v3 · 3",
        "CZ · OpenSubtitles v3",
      ),
      addonSubtitleLabels(addons),
    )
  }

  @Test
  fun `a lone addon row is not numbered`() {
    assertEquals(
      listOf("EN · OpenSubtitles v3", "CZ"),
      addonSubtitleLabels(
        listOf(
          AddonSubtitleDto(subtitleId = "a", lang = "en", addonName = "OpenSubtitles v3"),
          AddonSubtitleDto(subtitleId = "b", lang = "cs"),
        ),
      ),
    )
  }

  @Test
  fun `the tracks button shows the audio language, and nothing when there is none`() {
    assertEquals("EN", tracksButtonText("en"))
    assertEquals("XX", tracksButtonText("xx"))
    assertEquals("", tracksButtonText(null))
    assertEquals("", tracksButtonText(""))
  }
}
