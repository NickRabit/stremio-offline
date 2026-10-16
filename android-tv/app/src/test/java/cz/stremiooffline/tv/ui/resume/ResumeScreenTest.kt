@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.resume

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeProgress
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.ResumePage
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.home.HomeAction
import cz.stremiooffline.tv.ui.home.actionFor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The one Continue watching grid: the filter chips, where OK goes and how the remote keeps its place. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ResumeScreenTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun fileCard(
    key: String = "file:browse/A.mkv",
    title: String = "A",
    path: String = "browse/A.mkv",
    season: Int? = null,
    episode: Int? = null,
    progress: HomeProgress? = HomeProgress(30.0, 120.0),
  ) = HomeCard.ResumeFile(
    key = key,
    title = title,
    path = path,
    progress = progress,
    season = season,
    episode = episode,
    forgetKeys = listOf(key),
  )

  private fun catalogueCard(
    key: String = "series:tt1:1:2",
    title: String = "Show · Two",
    type: String = "series",
    id: String = "tt1",
    name: String = "Show",
    season: Int? = 1,
    episode: Int? = 2,
    path: String? = null,
  ) = HomeCard.ResumeCatalogue(
    key = key,
    title = title,
    type = type,
    id = id,
    name = name,
    season = season,
    episode = episode,
    progress = HomeProgress(30.0, 120.0),
    path = path,
    forgetKeys = listOf(key),
  )

  private fun mount(
    api: FakeTvApi,
    onPlay: (PlayTarget) -> Unit = {},
    onOpenCatalog: (CatalogDetailArgs) -> Unit = {},
  ) {
    scenario.onActivity { activity ->
      activity.setContent {
        ResumeRoute(api = api, onPlay = onPlay, onOpenCatalog = onOpenCatalog)
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusBy(tag: String, key: Key, times: Int = 8) {
    repeat(times) {
      if (focused(tag)) return
      press(key)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `the filter chips send the filter they name`() {
    val api = FakeTvApi()
    api.resumeValue = ResumePage(emptyList(), 0, false)
    mount(api)

    compose.onNodeWithTag(resumeFilterTag(ResumeFilter.All)).assertIsFocused()
    focusBy(resumeFilterTag(ResumeFilter.Movies), Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(listOf(ResumeFilter.All, ResumeFilter.Movies), api.resumeRequests)
  }

  @Test
  fun `up from the grid reaches the chips and narrows the list`() {
    val api = FakeTvApi()
    api.resumeValue = ResumePage(listOf(fileCard()), 1, false)
    mount(api)

    compose.onNodeWithTag(resumeCardTag(fileCard().key)).assertIsFocused()
    press(Key.DirectionUp)
    focusBy(resumeFilterTag(ResumeFilter.All), Key.DirectionLeft)
    focusBy(resumeFilterTag(ResumeFilter.Series), Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(listOf(ResumeFilter.All, ResumeFilter.Series), api.resumeRequests)
  }

  @Test
  fun `ok on a library file plays it, the way Home does`() {
    val api = FakeTvApi()
    api.resumeValue = ResumePage(listOf(fileCard()), 1, false)
    val played = mutableListOf<PlayTarget>()
    mount(api, onPlay = { played += it })

    compose.onNodeWithTag(resumeCardTag(fileCard().key)).assertIsFocused()
    press(Key.DirectionCenter)

    // The very target the one rule builds, which is what Home hands the shell for the same card.
    assertEquals(listOf((actionFor(fileCard()) as HomeAction.Play).target), played)
  }

  @Test
  fun `ok on a catalogue card that names its file plays that file`() {
    val api = FakeTvApi()
    val card = catalogueCard(path = "browse/A.mkv", title = "Which file")
    api.resumeValue = ResumePage(listOf(card), 1, false)
    val played = mutableListOf<PlayTarget>()
    val opened = mutableListOf<CatalogDetailArgs>()
    mount(api, onPlay = { played += it }, onOpenCatalog = { opened += it })

    compose.onNodeWithTag(resumeCardTag(card.key)).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(listOf((actionFor(card) as HomeAction.Play).target), played)
    assertEquals(0, opened.size)
  }

  @Test
  fun `ok on a catalogue card opens the catalogue detail at the episode`() {
    val api = FakeTvApi()
    api.resumeValue = ResumePage(listOf(catalogueCard()), 1, false)
    val opened = mutableListOf<CatalogDetailArgs>()
    mount(api, onOpenCatalog = { opened += it })

    compose.onNodeWithTag(resumeCardTag(catalogueCard().key)).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(1, opened.size)
    assertEquals("tt1", opened[0].meta.id)
    assertEquals("series", opened[0].type)
    assertEquals(1, opened[0].episode?.season)
    assertEquals(2, opened[0].episode?.number)
    assertEquals(listOf("series:tt1:1:2"), opened[0].forgetKeys)
  }

  @Test
  fun `focus near the end asks for the next page`() {
    val api = FakeTvApi()
    api.resumePages[0] = ResumePage(listOf(fileCard(key = "file:browse/A.mkv", title = "A"), fileCard(key = "file:browse/B.mkv", title = "B", path = "browse/B.mkv")), 3, false)
    api.resumePages[2] = ResumePage(listOf(fileCard(key = "file:browse/C.mkv", title = "C", path = "browse/C.mkv")), 3, false)
    mount(api)

    compose.waitForIdle()
    assertTrue(api.resumeSkips.contains(2))
    compose.onNodeWithTag(resumeCardTag("file:browse/C.mkv")).assertExists()
  }
}
