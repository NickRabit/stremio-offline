package cz.stremiooffline.tv.ui.player

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView

/**
 * Keeps the television awake while it is on. A film is watched with the remote untouched, so
 * without this the screensaver started after about ten minutes and the set went to sleep a few
 * minutes later. The flag goes with the composition: it is dropped the moment the player closes
 * or [enabled] turns false (paused, failed), so a forgotten pause still lets the set rest.
 */
@Composable
fun KeepScreenOn(enabled: Boolean) {
  val view = LocalView.current
  DisposableEffect(view, enabled) {
    view.keepScreenOn = enabled
    onDispose { view.keepScreenOn = false }
  }
}
