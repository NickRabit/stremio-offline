package cz.stremiooffline.tv.watchnext

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.diagnostics.AppLog
import cz.stremiooffline.tv.ui.home.HomeAction
import cz.stremiooffline.tv.ui.home.actionFor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun WatchNextEffects(
  api: TvApi,
  playerOpen: Boolean,
  onAction: (HomeAction) -> Unit,
  onMissing: () -> Unit,
) {
  val context = LocalContext.current.applicationContext
  val scope = remember {
    CoroutineScope(SupervisorJob() + Dispatchers.IO)
  }
  DisposableEffect(scope) {
    onDispose { scope.cancel() }
  }

  fun publish() {
    scope.launch {
      WatchNextPublisher.publish(context, api)
    }
  }

  LaunchedEffect(Unit) {
    publish()
  }

  var wasPlayerOpen by remember { mutableStateOf(playerOpen) }
  LaunchedEffect(playerOpen) {
    // The player saves its last position as it closes; the list is read once that has landed.
    if (wasPlayerOpen && !playerOpen) {
      delay(PUBLISH_AFTER_PLAYER_MS)
      publish()
    }
    wasPlayerOpen = playerOpen
  }

  LaunchedEffect(WatchNextLaunch.pendingKey) {
    val key = WatchNextLaunch.pendingKey ?: return@LaunchedEffect
    try {
      val card = api.resume(ResumeFilter.All, 60, 0).items.firstOrNull { it.key == key }
      if (card == null) onMissing() else onAction(actionFor(card))
    } catch (error: Throwable) {
      if (error is CancellationException) throw error
      AppLog.error("Watch Next link failed", mapOf("type" to error.javaClass.name))
      onMissing()
    } finally {
      WatchNextLaunch.pendingKey = null
    }
  }
}

private const val PUBLISH_AFTER_PLAYER_MS = 2_000L
