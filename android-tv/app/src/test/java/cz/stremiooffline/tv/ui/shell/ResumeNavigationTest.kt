@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

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
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.resume.resumeCardTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The rail's Continue watching section: selection, and returning from a detail with the list refreshed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ResumeNavigationTest {

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

  /** A merged list the test edits, so a card removed elsewhere is gone on the next read. */
  private class ResumeFake : FakeTvApi() {
    val merged = mutableListOf<HomeCard>()

    override suspend fun resume(filter: ResumeFilter, limit: Int, skip: Int): ResumePage {
      resumeRequests += filter
      val items = merged.filter {
        when (filter) {
          ResumeFilter.All -> true
          ResumeFilter.Library -> it is HomeCard.ResumeFile
          ResumeFilter.Catalog -> it is HomeCard.ResumeCatalogue
          ResumeFilter.Remote -> it is HomeCard.Remote
        }
      }
      return ResumePage(items, items.size, false)
    }

    override suspend fun forgetProgress(keys: List<String>) {
      forgetCalls += keys
      merged.removeAll { it.key in keys }
    }
  }

  private fun fileCard(key: String, title: String = key) = HomeCard.ResumeFile(
    key = key,
    title = title,
    path = key.removePrefix("file:"),
    progress = HomeProgress(30.0, 120.0),
    forgetKeys = listOf(key),
  )

  private fun mount(api: FakeTvApi, start: Section) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = start, api = api, username = "demo", onSignOut = {}) }
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

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  @Test
  fun `the rail opens the Continue watching section`() {
    val api = ResumeFake().apply { merged += fileCard("file:browse/A.mkv", "A") }
    mount(api, Section.Catalog)

    press(Key.DirectionLeft)
    var guard = 0
    while (!focused(railTag(Section.Resume)) && guard++ < 8) press(Key.DirectionDown)
    compose.onNodeWithTag(railTag(Section.Resume)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(resumeCardTag("file:browse/A.mkv")).assertIsFocused()
  }

  @Test
  fun `a card removed elsewhere is gone on return and the remote keeps a card`() {
    val api = ResumeFake().apply {
      merged += fileCard("file:browse/A.mkv", "A")
      merged += fileCard("file:browse/B.mkv", "B")
    }
    mount(api, Section.Resume)
    val first = resumeCardTag("file:browse/A.mkv")
    val second = resumeCardTag("file:browse/B.mkv")

    press(Key.DirectionRight)
    compose.onNodeWithTag(second).assertIsFocused()
    press(Key.DirectionCenter)

    // The card's progress is forgotten while its detail is open.
    api.merged.removeAll { it.key == "file:browse/B.mkv" }
    back()

    compose.onNodeWithTag(second).assertDoesNotExist()
    compose.onNodeWithTag(first).assertIsFocused()
    assertEquals(listOf(ResumeFilter.All, ResumeFilter.All), api.resumeRequests)
  }
}
