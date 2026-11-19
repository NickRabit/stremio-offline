package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import cz.stremiooffline.tv.data.TvApi

/** The last hide-spoilers answer this process saw, so a detail opens with it instead of
 *  showing sharp stills for a moment until the settings arrive. */
internal object SpoilerSetting {
  @Volatile var lastKnown: Boolean = false
}

/** The account's hide-spoilers choice, asked once per opened title. */
@Composable
internal fun rememberHideSpoilers(api: TvApi, key: Any?): Boolean =
  produceState(SpoilerSetting.lastKnown, key) {
    runCatching { api.settings().hideSpoilers }.onSuccess {
      SpoilerSetting.lastKnown = it
      value = it
    }
  }.value
