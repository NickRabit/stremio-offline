package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.TvSpinner
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame

const val TagSourcesPanel = "catalog_sources_panel"
const val TagSourcesEmpty = "catalog_sources_empty"
const val TagSourcesLoading = "catalog_sources_loading"

fun sourceRowTag(index: Int): String = "source_row_$index"

/**
 * The Sources side panel, shared by the catalogue detail and the player. It draws the rows in the
 * order it is given, marks the default and the playing one, and holds the remote: [initialFocus]
 * is taken by the row at [focusIndex] (or by the failure/empty target) once the panel is up.
 */
@Composable
fun SourcesPanel(
  streams: List<StreamDto>,
  focusIndex: Int,
  onChoose: (StreamDto) -> Unit,
  onClose: () -> Unit,
  default: StreamDto? = null,
  chosen: StreamDto? = null,
  playing: StreamDto? = null,
  anyChosen: Boolean = false,
  titleLanguage: String? = null,
  asking: Boolean = false,
  failed: Boolean = false,
  notices: List<StreamDto> = emptyList(),
  emptyText: String = "",
  failureText: String = "",
  onRetry: (() -> Unit)? = null,
  /** The test tag of the failure's Try again, so each caller keeps its own name for it. */
  retryTag: String? = null,
  modifier: Modifier = Modifier,
  initialFocus: FocusRequester? = null,
) {
  val defaultText = stringResource(R.string.tv_default)
  val nowPlayingText = stringResource(R.string.tv_now_playing)
  val loadErrorText = stringResource(R.string.tv_load_error)
  val tryAgainText = stringResource(R.string.tv_try_again)
  val findingSourcesText = stringResource(R.string.tv_finding_sources)
  val entry = focusIndex.coerceIn(0, maxOf(0, streams.size - 1))
  val listState = rememberLazyListState()

  // A row that only arrives after the panel is already up must take the remote too. A lazy list
  // only composes what is on screen, so the entry row is scrolled into view before the focus lands.
  LaunchedEffect(streams.isEmpty(), failed) {
    val target = initialFocus ?: return@LaunchedEffect
    if (streams.isNotEmpty()) runCatching { listState.scrollToItem(entry) }
    awaitFrame()
    runCatching { target.requestFocus() }
  }

  SidePanel(
    title = stringResource(R.string.sources_heading),
    onClose = onClose,
    modifier = modifier.testTag(TagSourcesPanel),
    initialFocus = initialFocus,
    // Hundreds of sources keep the panel responsive: the rows are virtualised and only what is
    // on screen is composed.
    scroll = false,
  ) {
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      when {
        failed -> item(key = "failure") {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(failureText.ifBlank { loadErrorText }, color = Tokens.Red, fontSize = 12.sp, lineHeight = 17.sp)
            FocusButton(
              text = tryAgainText,
              onClick = { onRetry?.invoke() },
              modifier = Modifier
                .then(if (retryTag != null) Modifier.testTag(retryTag) else Modifier)
                .then(if (initialFocus != null) Modifier.focusRequester(initialFocus) else Modifier),
            )
          }
        }
        streams.isEmpty() -> item(key = "empty") {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (asking) findingSourcesText else emptyText, color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
            // Something has to hold the remote while the panel is up, even with no rows yet.
            Box(
              Modifier
                .testTag(TagSourcesEmpty)
                .then(if (initialFocus != null) Modifier.focusRequester(initialFocus) else Modifier)
                .focusable(),
            )
          }
        }
        else -> {
          itemsIndexed(streams, key = { index, stream -> sourceRowKey(stream, index) }) { index, stream ->
            SourceRow(
              stream = stream,
              default = default === stream,
              chosen = chosen === stream,
              anyChosen = anyChosen,
              playing = playing === stream,
              defaultText = defaultText,
              nowPlayingText = nowPlayingText,
              titleLanguage = titleLanguage,
              onClick = { onChoose(stream) },
              modifier = Modifier
                .testTag(sourceRowTag(index))
                .then(if (initialFocus != null && index == entry) Modifier.focusRequester(initialFocus) else Modifier),
            )
          }
          // Rows have arrived but more addons still owe one: the list is not final yet.
          if (asking) item(key = "loading") {
            Row(
              modifier = Modifier.testTag(TagSourcesLoading).padding(horizontal = 12.dp, vertical = 6.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              TvSpinner(color = Tokens.Accent2)
              Text(findingSourcesText, color = Tokens.Muted, fontSize = 11.sp)
            }
          }
        }
      }
      if (notices.isNotEmpty()) {
        items(notices) { notice -> Text(Streams.noticeText(notice), color = Tokens.Muted, fontSize = 10.5.sp, lineHeight = 15.sp) }
      }
    }
  }
}

/** A stable key per row: the stream's own identity, with a positional fallback for one that
 *  arrived without a source id. `Streams.offeredStreams` has already dropped a repeated id, so
 *  two rows never share a key -- and a row that is still offered keeps its identity across a
 *  re-sort. */
private fun sourceRowKey(stream: StreamDto, index: Int): String = stream.sourceId.ifBlank { "row-$index" }

/** One offered stream: badge, addon, the stream's title and a size/language meta line. */
@Composable
internal fun SourceRow(
  stream: StreamDto,
  default: Boolean,
  chosen: Boolean,
  anyChosen: Boolean,
  playing: Boolean,
  defaultText: String,
  nowPlayingText: String,
  titleLanguage: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  val local = Streams.isLocalStream(stream)
  val badge = if (local) stringResource(R.string.sources_local_badge) else Streams.streamBadge(stream)
  val badgeColour = when {
    local -> Tokens.Accent2
    badge == "HTTP" -> Tokens.Green
    badge == "RD" -> Tokens.Accent
    else -> Tokens.Muted
  }
  val meta = buildList {
    formatSize(Streams.streamSize(stream))?.let(::add)
    addAll(Streams.streamLanguages(stream, titleLanguage).map { Languages.label(it) })
  }
  val localHint = stringResource(R.string.sources_local_hint)
  val rowModifier = if (local) modifier.semantics { contentDescription = localHint } else modifier
  Surface(
    onClick = onClick,
    modifier = rowModifier.fillMaxWidth(),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (default || playing) Tokens.Panel2 else Color.Transparent,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    // Panel rows do not scale on focus: the list viewport would clip the first and last row.
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f, pressedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      // The playing row's accent bar takes the place of the default tick.
      Box(Modifier.width(3.dp).height(30.dp).background(if (playing) Tokens.Accent else Color.Transparent))
      Row(
        modifier = Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text(badge, color = badgeColour, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(if (local) stream.libraryName.orEmpty() else stream.addonName.orEmpty(), color = Tokens.Muted, fontSize = 9.5.sp, maxLines = 1)
          Text(
            if (local) stream.behaviorHints?.filename ?: streamLabel(stream) else streamLabel(stream),
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          if (meta.isNotEmpty()) Text(meta.joinToString(" · "), color = Tokens.Muted, fontSize = 10.sp, maxLines = 1)
        }
        // One mark only: the playing row is the playing one, otherwise the picked row, otherwise
        // the default.
        when {
          playing -> Text(nowPlayingText, color = Tokens.Accent, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
          chosen -> Text(if (default) "✓ $defaultText" else "✓", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
          default && !anyChosen -> Text("✓ $defaultText", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
          default -> Text(defaultText, color = Tokens.Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }
      }
    }
  }
}

/** One row's headline: the stream's name, or the first line it wrote about itself. */
internal fun streamLabel(stream: StreamDto): String =
  stream.name ?: stream.title?.split("\n")?.firstOrNull() ?: stream.description?.split("\n")?.firstOrNull() ?: ""
