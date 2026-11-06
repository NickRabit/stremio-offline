package cz.stremiooffline.tv.ui.downloads

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.formatSize
import cz.stremiooffline.tv.ui.sessionImageLoader
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private const val DownloadsRefreshMs = 3_000L

const val TagDownloadsScreen = "downloads_screen"
const val TagDownloadRow = "download_row_"
const val TagDownloadsFooter = "downloads_footer"

@Composable
fun DownloadsScreen(api: TvApi, active: Boolean = true) {
  var allJobs by remember { mutableStateOf<List<DownloadDto>>(emptyList()) }
  var loaded by remember { mutableStateOf(false) }
  var loadFailed by remember { mutableStateOf(false) }
  var libraryNames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
  var focusedJobId by remember { mutableStateOf<String?>(null) }
  val requesters = remember { mutableMapOf<String, FocusRequester>() }

  LaunchedEffect(api, active) {
    if (!active) return@LaunchedEffect
    while (true) {
      try {
        allJobs = api.downloads().jobs
        loaded = true
        loadFailed = false
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (!loaded) loadFailed = true
      }
      delay(DownloadsRefreshMs)
    }
  }

  LaunchedEffect(api) {
    libraryNames = try {
      api.libraries().associate { it.id to it.name }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      emptyMap()
    }
  }

  val jobs = activeJobs(allJobs)
  val currentJobs by rememberUpdatedState(jobs)
  val jobIds = jobs.map { it.id }
  LaunchedEffect(jobIds) {
    val focusedId = focusedJobId ?: return@LaunchedEffect
    val target = jobs.firstOrNull { it.id == focusedId } ?: jobs.firstOrNull() ?: return@LaunchedEffect
    runCatching { requesters[target.id]?.requestFocus() }
  }

  val counts = queueCounts(allJobs)
  val speed = totalSpeed(jobs)
  Column(
    Modifier
      .fillMaxSize()
      .testTag(TagDownloadsScreen)
      .padding(horizontal = Tokens.SafeX, vertical = Tokens.SafeY),
  ) {
    DownloadsHeader(jobs.size, speed)
    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        loadFailed -> Text(
          stringResource(R.string.tv_downloads_load_error),
          color = Tokens.Muted,
          fontSize = 12.sp,
          modifier = Modifier.align(Alignment.Center),
        )
        loaded && jobs.isEmpty() -> DownloadsEmpty(counts.queued)
        else -> LazyColumn(
          modifier = Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          items(jobs, key = { it.id }) { job ->
            key(job.id) {
              val requester = remember(job.id) { FocusRequester() }
              requesters[job.id] = requester
              DownloadRow(
                job = job,
                libraryName = job.libraryId?.let(libraryNames::get),
                imageUrl = job.media?.poster?.let(api::url),
                requester = requester,
                onFocus = { focused ->
                  if (focused) {
                    focusedJobId = job.id
                  } else if (focusedJobId == job.id && currentJobs.any { it.id == job.id }) {
                    // The viewer moved off the list; only a row that vanished hands focus on.
                    focusedJobId = null
                  }
                },
              )
            }
          }
        }
      }
    }
    if (allJobs.isNotEmpty()) DownloadsFooter(counts)
  }
}

@Composable
private fun DownloadsHeader(activeCount: Int, speed: Double) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text(
      stringResource(R.string.nav_downloads),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.Bold,
    )
    if (activeCount > 0) {
      Text(
        pluralStringResource(R.plurals.tv_downloads_running, activeCount, activeCount),
        color = Tokens.Muted,
        fontSize = 14.sp,
      )
    }
    Spacer(Modifier.weight(1f))
    formatSize(speed)?.let {
      Text("↓ $it/s", color = Tokens.Green, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
  }
}

@Composable
private fun DownloadsEmpty(queued: Int) {
  Column(
    modifier = Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    DownloadIcon(Modifier.size(56.dp), Tokens.Muted)
    Spacer(Modifier.height(12.dp))
    Text(
      stringResource(R.string.downloads_empty_active),
      color = Tokens.Text,
      fontSize = 20.sp,
      fontWeight = FontWeight.SemiBold,
    )
    if (queued > 0) {
      Spacer(Modifier.height(6.dp))
      Text(
        pluralStringResource(R.plurals.tv_downloads_in_queue, queued, queued),
        color = Tokens.Muted,
        fontSize = 13.sp,
      )
    }
  }
}

@Composable
private fun DownloadRow(
  job: DownloadDto,
  libraryName: String?,
  imageUrl: String?,
  requester: FocusRequester,
  onFocus: (Boolean) -> Unit,
) {
  val shape = RoundedCornerShape(12.dp)
  Surface(
    onClick = {},
    modifier = Modifier
      .fillMaxWidth()
      .testTag(TagDownloadRow + job.id)
      .focusRequester(requester)
      .onFocusChanged { onFocus(it.isFocused) },
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
    ),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Tokens.Panel,
      focusedContainerColor = Tokens.Panel2,
    ),
  ) {
    Row(
      modifier = Modifier.padding(start = 10.dp, top = 10.dp, end = 16.dp, bottom = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(14.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      DownloadPoster(imageUrl)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(
            job.title,
            color = Tokens.Text,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
          )
          Spacer(Modifier.width(8.dp))
          StatusChip(job)
        }
        Text(
          activeDetail(job, libraryName),
          color = Tokens.Muted,
          fontSize = 12.5.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        ProgressBar(job)
      }
      DownloadNumbers(job)
    }
  }
}

@Composable
private fun DownloadPoster(imageUrl: String?) {
  Box(
    Modifier
      .size(width = 40.dp, height = 60.dp)
      .clip(RoundedCornerShape(6.dp))
      .background(Tokens.Panel2),
  ) {
    if (imageUrl != null) {
      AsyncImage(
        model = imageUrl,
        contentDescription = null,
        imageLoader = sessionImageLoader(),
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

@Composable
private fun StatusChip(job: DownloadDto) {
  val color = when (job.status) {
    "downloading" -> Tokens.Green
    "waiting" -> Tokens.Gold
    else -> Tokens.Muted
  }
  Box(
    Modifier
      .background(color.copy(alpha = 0.15f), RoundedCornerShape(9.dp))
      .padding(horizontal = 8.dp, vertical = 2.dp),
  ) {
    Text(
      stringResource(queueStatusRes(job)),
      color = color,
      fontSize = 11.sp,
      fontWeight = FontWeight.Bold,
    )
  }
}

@Composable
private fun ProgressBar(job: DownloadDto) {
  val percent = activePercent(job) ?: 0
  Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(Tokens.Line)) {
    if (percent > 0) {
      val fill = if (job.status == "waiting") {
        Modifier.background(Tokens.Gold)
      } else {
        Modifier.background(Tokens.AccentGradient)
      }
      Box(
        Modifier
          .fillMaxWidth(percent / 100f)
          .height(6.dp)
          .then(fill),
      )
    }
  }
}

@Composable
private fun DownloadNumbers(job: DownloadDto) {
  val parts = buildList {
    formatSize(job.speed)?.let { add("$it/s") }
    etaSeconds(job)?.let { add(stringResource(R.string.tv_downloads_left, formatEta(it))) }
  }
  Column(
    modifier = Modifier.width(150.dp),
    horizontalAlignment = Alignment.End,
    verticalArrangement = Arrangement.spacedBy(3.dp),
  ) {
    Text(
      activePercent(job)?.let { "$it %" } ?: "—",
      color = Tokens.Text,
      fontSize = 20.sp,
      fontWeight = FontWeight.Bold,
      textAlign = TextAlign.End,
    )
    Text(
      parts.joinToString(" · "),
      color = Tokens.Muted,
      fontSize = 12.5.sp,
      textAlign = TextAlign.End,
    )
  }
}

@Composable
private fun activeDetail(job: DownloadDto, libraryName: String?): String {
  if (job.status == "waiting") return stringResource(R.string.downloads_waiting_debrid)
  if (job.status == "checking" && job.total == null) return ""
  val received = formatSize(job.received) ?: "0 kB"
  val total = formatSize(job.total) ?: return ""
  val progress = stringResource(R.string.tv_downloads_progress, received, total)
  return if (libraryName != null) "$progress · $libraryName" else progress
}

@Composable
private fun DownloadsFooter(counts: QueueCounts) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .testTag(TagDownloadsFooter)
      .drawBehind {
        drawLine(Tokens.Line, Offset.Zero, Offset(size.width, 0f), 1.dp.toPx())
      }
      .padding(top = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(18.dp),
  ) {
    CountPart(R.string.downloads_status_queued, counts.queued)
    CountPart(R.string.downloads_status_paused, counts.paused)
    CountPart(R.string.downloads_status_failed, counts.failed, failed = true)
    Spacer(Modifier.weight(1f))
    Text(
      stringResource(R.string.tv_downloads_manage_on_web),
      color = Tokens.Muted,
      fontSize = 13.sp,
      textAlign = TextAlign.End,
    )
  }
}

@Composable
private fun CountPart(labelRes: Int, count: Int, failed: Boolean = false) {
  Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(stringResource(labelRes), color = Tokens.Muted, fontSize = 13.sp)
    Text(
      count.toString(),
      color = if (failed && count > 0) Tokens.Red else Tokens.Text,
      fontSize = 13.sp,
      fontWeight = FontWeight.Bold,
    )
  }
}

@Composable
private fun DownloadIcon(modifier: Modifier = Modifier, color: Color = Tokens.Muted) {
  androidx.compose.foundation.Canvas(modifier) {
    val stroke = 1.5.dp.toPx()
    val x = size.width
    val y = size.height
    drawLine(color, Offset(x * 0.5f, y * 4f / 24f), Offset(x * 0.5f, y * 15f / 24f), stroke)
    drawLine(color, Offset(x * 7f / 24f, y * 10f / 24f), Offset(x * 0.5f, y * 15f / 24f), stroke)
    drawLine(color, Offset(x * 0.5f, y * 15f / 24f), Offset(x * 17f / 24f, y * 10f / 24f), stroke)
    drawLine(color, Offset(x * 5f / 24f, y * 19f / 24f), Offset(x * 19f / 24f, y * 19f / 24f), stroke)
  }
}
