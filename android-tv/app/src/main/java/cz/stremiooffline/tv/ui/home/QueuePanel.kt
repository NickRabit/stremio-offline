package cz.stremiooffline.tv.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private const val QueueRefreshMs = 3_000L

@Composable
fun QueuePanel(api: TvApi, initial: List<DownloadDto>, onClose: () -> Unit) {
  var jobs by remember { mutableStateOf(homeQueue(initial)) }
  var focusedJobId by remember { mutableStateOf<String?>(null) }
  val requesters = remember { mutableMapOf<String, FocusRequester>() }
  val firstFocus = remember { FocusRequester() }

  LaunchedEffect(Unit) {
    while (true) {
      delay(QueueRefreshMs)
      try {
        jobs = homeQueue(api.downloads().jobs)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
      }
    }
  }

  LaunchedEffect(jobs) {
    val id = focusedJobId ?: return@LaunchedEffect
    if (jobs.any { it.id == id }) {
      runCatching { requesters[id]?.requestFocus() }
    }
  }

  SidePanel(
    title = stringResource(R.string.home_downloads),
    onClose = onClose,
    initialFocus = if (jobs.isEmpty()) null else firstFocus,
  ) {
    if (jobs.isEmpty()) {
      Text(stringResource(R.string.tv_queue_empty), color = Tokens.Muted, fontSize = 12.sp)
    }
    jobs.forEachIndexed { index, job ->
      key(job.id) {
        val rowFocus = remember { FocusRequester() }
        val targetFocus = if (index == 0) firstFocus else rowFocus
        requesters[job.id] = targetFocus
        PanelOption(
          text = job.title,
          supportingText = queueLine(job, stringResource(queueStatusRes(job))),
          onClick = {},
          modifier = Modifier
            .focusRequester(targetFocus)
            .onFocusChanged { if (it.isFocused) focusedJobId = job.id },
        )
      }
    }
  }
}
