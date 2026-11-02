@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogOriginLocalTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun local(sourceId: String, path: String) = StreamDto(
    sourceId = sourceId,
    kind = "library",
    playable = true,
    localPath = path,
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
  )

  @Test
  fun `a preferred local path makes Play choose that copy`() {
    val first = "Films/Heat/Heat.1080p.mkv"
    val second = "Films/Heat/Heat.2160p.mkv"
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(
        uiLanguage = "en",
        audioLanguage = "en",
        streamSort = "recommended",
        realDebridConfigured = true,
      )
      localStreamsValues["movie:tt1"] = listOf(local("first", first), local("second", second))
    }
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(
          meta = MetaDto(id = "tt1", type = "movie", name = "Heat"),
          addonName = "",
          type = "movie",
          preferredLocalPath = second,
        ),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
      )
    }
    compose.waitUntil(5_000) { api.localStreamsRequests.contains("movie:tt1") }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).performKeyInput { pressKey(Key.DirectionCenter) }

    val target = played.single()
    assertEquals(second, target.path)
    assertEquals("file:$second", target.key)
    assertNull(target.sourceId)
  }
}
