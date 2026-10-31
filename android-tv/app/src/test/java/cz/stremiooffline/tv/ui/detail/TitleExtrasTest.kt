@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.NextEpisodeDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.data.TitleRatingsDto
import cz.stremiooffline.tv.data.TitleVideoDto
import cz.stremiooffline.tv.data.VideoFactsDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class TitleExtrasTest {

  @get:Rule val compose = createComposeRule()

  private fun extras() = TitleExtrasDto(
    people = listOf(
      TitlePersonDto(name = "Tom Hanks", role = "cast", character = "Woody"),
      TitlePersonDto(name = "Jane Doe", role = "director"),
    ),
    related = listOf(
      RelatedTitleDto(
        type = "movie",
        id = "tt2",
        name = "Toy Story 2",
        year = "1999",
        inLibrary = true,
      ),
    ),
  )

  private fun mount(
    state: TitleExtrasState,
    onPerson: (String) -> Unit = {},
    onRelated: (RelatedTitleDto) -> Unit = {},
    onUpFromRows: () -> Unit = {},
    videoResolver: ((String) -> Boolean)? = null,
    onVideo: ((TitleVideoDto) -> Unit)? = null,
  ) {
    compose.setContent {
      TitleExtrasRows(
        state = state,
        imageUrl = { null },
        onPerson = onPerson,
        onRelated = onRelated,
        onUpFromRows = onUpFromRows,
        videoResolver = videoResolver,
        onVideo = onVideo,
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `rows render portraits with initials and related library titles`() {
    val state = TitleExtrasState().apply { this.extras = extras() }
    mount(state)

    compose.onNodeWithText("Cast and crew").assertExists()
    compose.onNodeWithText("TH").assertExists()
    compose.onNodeWithText("Tom Hanks").assertExists()
    compose.onNodeWithText("Woody").assertExists()
    compose.onNodeWithText("More like this").assertExists()
    compose.onNodeWithTag(relatedTitleTag("tt2")).assertExists()
    compose.onNodeWithText("1999").assertExists()
    compose.onNodeWithText("In a library").assertExists()
  }

  @Test
  fun `the director leads the strip with the role where a character would be`() {
    val state = TitleExtrasState().apply { this.extras = extras() }
    mount(state)

    assertEquals(listOf("Jane Doe", "Tom Hanks"), state.cast.map { it.name })
    compose.onNodeWithText("Jane Doe").assertExists()
    compose.onNodeWithText("Director").assertExists()
    compose.onNodeWithText("JD").assertExists()
  }

  @Test
  fun `empty and failed replies draw no rows`() {
    val empty = TitleExtrasState()
    val api = FakeTvApi()
    api.titleExtrasFailure = ApiError(ApiFailure.Generic)
    runBlocking { empty.load(api, "movie", "tt1", "en") }
    assertNull(empty.extras)
    assertFalse(empty.loading)

    mount(empty)
    compose.onNodeWithText("Cast and crew").assertDoesNotExist()
    compose.onNodeWithText("More like this").assertDoesNotExist()
  }

  @Test
  fun `loading draws a skeleton`() {
    val state = TitleExtrasState().apply { loading = true }
    mount(state)

    compose.onNodeWithTag(TagTitleExtrasSkeleton).assertExists()
    compose.onNodeWithText("Cast and crew").assertDoesNotExist()
  }

  @Test
  fun `focus first chooses the cast strip`() {
    val cast = TitleExtrasState().apply { extras = extras() }
    mount(cast)
    compose.runOnIdle { assertTrue(cast.focusFirst()) }
    compose.onNodeWithTag(titlePersonTag("Jane Doe")).assertIsFocused()
  }

  @Test
  fun `focus first falls back to related and then false`() {
    val related = TitleExtrasState().apply {
      extras = TitleExtrasDto(
        related = listOf(RelatedTitleDto(type = "movie", id = "tt2", name = "Toy Story 2")),
      )
    }
    compose.setContent {
      TitleExtrasRows(related, imageUrl = { null }, onPerson = {}, onRelated = {}, onUpFromRows = {})
    }
    compose.waitForIdle()
    compose.runOnIdle { assertTrue(related.focusFirst()) }
    compose.onNodeWithTag(relatedTitleTag("tt2")).assertIsFocused()

    val empty = TitleExtrasState()
    compose.runOnIdle { assertFalse(empty.focusFirst()) }
  }

  @Test
  fun `UP from the cast strip returns to the title rows`() {
    var ups = 0
    val state = TitleExtrasState().apply { extras = extras() }
    mount(state, onUpFromRows = { ups++ })
    compose.runOnIdle { state.focusFirst() }

    compose.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()

    assertEquals(1, ups)
  }

  @Test
  fun `UP from related returns when there is no cast`() {
    var ups = 0
    val state = TitleExtrasState().apply {
      extras = TitleExtrasDto(
        related = listOf(RelatedTitleDto(type = "movie", id = "tt2", name = "Toy Story 2")),
      )
    }
    mount(state, onUpFromRows = { ups++ })
    compose.runOnIdle { state.focusFirst() }

    compose.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()

    assertEquals(1, ups)
  }

  @Test
  fun `OK on a person and a related card carries their identity`() {
    var person = ""
    var related: RelatedTitleDto? = null
    val state = TitleExtrasState().apply { extras = extras() }
    mount(state, onPerson = { person = it }, onRelated = { related = it })

    compose.onNodeWithTag(titlePersonTag("Tom Hanks"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals("Tom Hanks", person)

    compose.onNodeWithTag(relatedTitleTag("tt2"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals("tt2", related?.id)
  }

  @Test
  fun `the next episode pill disappears after its release time`() {
    val released = "2026-11-07T00:00:00.000Z"
    val releaseMillis = parseReleaseTime(released)!!
    var now = releaseMillis - 1
    val state = TitleExtrasState().apply {
      extras = TitleExtrasDto(
        nextEpisode = NextEpisodeDto(season = 6, episode = 3, name = "Last", released = released),
      )
    }
    compose.setContent {
      TitleExtraFacts(
        state = state,
        name = "Show",
        metaLine = "2026",
        uiLanguage = "en",
        clock = { now },
      )
    }
    compose.waitForIdle()
    compose.onNodeWithTag(TagTitleExtrasNextEpisode).assertExists()

    now = releaseMillis + 1
    compose.mainClock.advanceTimeBy(60_001)
    compose.waitForIdle()

    compose.onNodeWithTag(TagTitleExtrasNextEpisode).assertDoesNotExist()
  }

  @Test
  fun `ratings draw the age IMDb and TMDB pills and remove the duplicate facts rating`() {
    val state = TitleExtrasState().apply {
      extras = TitleExtrasDto(
        ageRating = "15",
        ratings = TitleRatingsDto(imdb = "9.3", tmdb = 8.7, tmdbVotes = 31_720),
      )
    }
    compose.setContent {
      TitleExtraFacts(
        state = state,
        name = "Movie",
        metaLine = "1994 · Drama · ★ 9.3",
        uiLanguage = "en",
      )
    }
    compose.waitForIdle()

    compose.onNodeWithTag(TagTitleExtrasAge).assertExists()
    compose.onNodeWithTag(TagTitleExtrasImdb).assertExists()
    compose.onNodeWithTag(TagTitleExtrasTmdb).assertExists()
    compose.onNodeWithText("1994 · Drama").assertExists()
    compose.onNodeWithText("1994 · Drama · ★ 9.3").assertDoesNotExist()
  }

  @Test
  fun `the technical block names source video audio and subtitle facts`() {
    val stream = StreamDto(
      sourceId = "s1",
      kind = "remote",
      playable = true,
      name = "Movie.2026.2160p.HEVC.HDR10.DTS-HD.MA.5.1.mkv",
      provider = "Cineshare",
      libraryName = "Tišnov",
      remoteItem = RemoteItemContext(libraryId = "l1", itemId = "i1", progressKey = "remote:l1:i1"),
      audioLanguages = listOf("cs", "en"),
      subtitleLanguages = listOf("cs"),
      videoFacts = VideoFactsDto(heightPixels = 2160, codec = "hevc", range = "hdr"),
      behaviorHints = cz.stremiooffline.tv.data.BehaviorHintsDto(videoSize = 6_700_000_000.0),
    )
    compose.setContent {
      TitleTechBlock(stream, uiLanguage = "en")
    }
    compose.waitForIdle()

    compose.onNodeWithText("Cineshare", substring = true).assertExists()
    compose.onNodeWithText("6.7 GB", substring = true).assertExists()
    compose.onNodeWithText("2160p", substring = true).assertExists()
    compose.onNodeWithText("HDR10", substring = true).assertExists()
    compose.onNodeWithText("HEVC", substring = true).assertExists()
    compose.onNodeWithText("Czech, English", substring = true).assertExists()
    compose.onNodeWithText("DTS-HD MA 5.1", substring = true).assertExists()
    compose.onNodeWithText("Subtitles", substring = true).assertExists()
  }

  @Test
  fun `the videos row is hidden without a resolving activity`() {
    val state = TitleExtrasState().apply {
      extras = extras().copy(
        videos = listOf(
          TitleVideoDto(
            key = "abcdefghijk",
            name = "Official trailer",
            kind = "trailer",
            thumbnail = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
          ),
        ),
      )
    }
    mount(state, videoResolver = { false })
    compose.onNodeWithTag(TagTitleExtrasVideos).assertDoesNotExist()
  }

  @Test
  fun `the videos row is shown with a resolving activity`() {
    val state = TitleExtrasState().apply {
      extras = extras().copy(
        videos = listOf(
          TitleVideoDto(
            key = "abcdefghijk",
            name = "Official trailer",
            kind = "trailer",
            thumbnail = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
          ),
        ),
      )
    }
    mount(state, videoResolver = { true })
    compose.onNodeWithTag(TagTitleExtrasVideos).assertExists()
    compose.onNodeWithTag(videoCardTag("abcdefghijk")).assertExists()
    compose.onNodeWithText("Trailer").assertExists()
  }

  @Test
  fun `the activity check is cached on the state`() {
    val state = TitleExtrasState().apply {
      extras = extras().copy(videos = listOf(TitleVideoDto(key = "abcdefghijk")))
    }
    var checks = 0

    assertTrue(state.videosShown { checks++; true })
    assertTrue(state.videosShown { checks++; false })
    assertEquals(1, checks)
  }

  @Test
  fun `OK on a video fires the injected intent callback`() {
    var opened: TitleVideoDto? = null
    val state = TitleExtrasState().apply {
      extras = extras().copy(videos = listOf(TitleVideoDto(key = "abcdefghijk", name = "Trailer", kind = "trailer")))
    }
    mount(state, videoResolver = { true }, onVideo = { opened = it })

    compose.onNodeWithTag(videoCardTag("abcdefghijk"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals("abcdefghijk", opened?.key)
  }

  @Test
  fun `focus walks cast to videos to related and back up`() {
    val state = TitleExtrasState().apply {
      extras = extras().copy(
        videos = listOf(TitleVideoDto(key = "abcdefghijk", name = "Trailer", kind = "trailer")),
      )
    }
    mount(state, videoResolver = { true })
    compose.runOnIdle { assertTrue(state.focusFirst()) }
    compose.onNodeWithTag(titlePersonTag("Jane Doe")).assertIsFocused()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(videoCardTag("abcdefghijk")).assertIsFocused()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(relatedTitleTag("tt2")).assertIsFocused()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()
    compose.onNodeWithTag(videoCardTag("abcdefghijk")).assertIsFocused()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()
    compose.onNodeWithTag(titlePersonTag("Jane Doe")).assertIsFocused()
  }
}
