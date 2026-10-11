@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package cz.stremiooffline.tv.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.signin.messageRes
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.delay

/** How long an edit waits before it is written, so two quick moves are one save. */
const val HOME_LAYOUT_SAVE_MS = 400L

const val TagHomeLayoutReset = "home_layout_reset"
const val TagHomeLayoutNote = "home_layout_note"
const val TagHomeLayoutError = "home_layout_error"
const val TagHomeRowActions = "home_row_actions"
const val TagHomeActionToggle = "home_action_toggle"
const val TagHomeActionUp = "home_action_up"
const val TagHomeActionDown = "home_action_down"
const val TagHomeActionTop = "home_action_top"

fun homeLayoutRowTag(id: String): String = "home_layout_row:$id"

/** `confirm` is a count in Home's heading, never a shelf, so its position cannot move. */
private const val ConfirmRow = "confirm"

/** The web key a built-in row's label carries, mapped to the app's own resource. */
private val BUILTIN_LABELS: Map<String, Int> = mapOf(
  "home.continue" to R.string.home_continue,
  "home.favorites" to R.string.home_favorites,
  "home.tonight" to R.string.home_tonight,
  "home.newEpisodes" to R.string.home_new_episodes,
  "home.readyToPlay" to R.string.home_ready_to_play,
  "home.recent" to R.string.home_recent,
  "home.toConfirm" to R.string.home_to_confirm,
)

/** A feed row's catalogue type, decoded from its `catalog:<addon>:<type>:<id>` id. */
internal fun feedTypeOf(id: String): String? {
  val parts = id.split(":")
  if (parts.size != 4 || parts[0] != "catalog") return null
  return runCatching { java.net.URLDecoder.decode(parts[2], "UTF-8") }.getOrNull()
}

@Composable
private fun typeTag(type: String): String = when (type) {
  "movie" -> stringResource(R.string.catalog_type_movie)
  "series" -> stringResource(R.string.catalog_type_series)
  else -> type
}

/** A row's label: a built-in's web key as the app's own string, a feed as "addon · catalogue
 *  (film/seriál)", told apart the way the catalogue picker tells its twin lists apart. */
@Composable
internal fun homeRowLabel(row: HomeLayoutRow): String =
  if (row.kind == "builtin") {
    // An unknown built-in key still beats showing "home." at the viewer.
    BUILTIN_LABELS[row.label]?.let { stringResource(it) } ?: row.label.removePrefix("home.")
  } else {
    feedTypeOf(row.id)?.let { "${row.label} (${typeTag(it)})" } ?: row.label
  }

/**
 * The account's Home arrangement as a side panel: its rows in order with a shown/hidden mark.
 * OK opens a nested action list for the focused row -- show/hide and the moves -- and every
 * action applies at once and returns to the rows with focus on the row it touched. Every edit
 * is written once it has been quiet for [HOME_LAYOUT_SAVE_MS]; closing the panel flushes what
 * is waiting.
 */
@Composable
fun HomeLayoutPanel(
  state: HomeLayoutState,
  onToggle: (String) -> Unit,
  onMove: (String, Int) -> Unit,
  onMoveTop: (String) -> Unit,
  onReset: () -> Unit,
  onFlush: () -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var actionId by remember { mutableStateOf<String?>(null) }
  var restoreId by remember { mutableStateOf<String?>(null) }
  val firstFocus = remember { FocusRequester() }
  val actionFocus = remember { FocusRequester() }
  val rowFocuses = remember { mutableMapOf<String, FocusRequester>() }
  val listState = rememberLazyListState()
  val ready = state as? HomeLayoutState.Ready

  // Every edit restarts the wait; a change made just before the panel closes is flushed instead.
  LaunchedEffect(ready?.changeSeq) {
    if (ready == null || ready.changeSeq == 0) return@LaunchedEffect
    delay(HOME_LAYOUT_SAVE_MS)
    onFlush()
  }

  // Opening the action list takes its first action; leaving it puts focus back on the row.
  LaunchedEffect(actionId) {
    awaitFrame()
    if (actionId != null) {
      runCatching { actionFocus.requestFocus() }
      return@LaunchedEffect
    }
    val id = restoreId ?: return@LaunchedEffect
    val index = ready?.rows?.indexOfFirst { it.id == id } ?: -1
    if (index >= 0) runCatching { listState.scrollToItem(index) }
    awaitFrame()
    runCatching { rowFocuses[id]?.requestFocus() }
    restoreId = null
  }

  fun leaveAction() {
    restoreId = actionId
    actionId = null
  }

  SidePanel(
    title = stringResource(R.string.tv_home_layout),
    // Back leaves the action list first; only a second Back closes the panel and flushes.
    onClose = { if (actionId != null) leaveAction() else { onFlush(); onClose() } },
    modifier = modifier,
    initialFocus = firstFocus,
    scroll = false,
  ) {
    if (ready == null) {
      Box(Modifier.fillMaxSize().focusRequester(firstFocus).focusable())
      return@SidePanel
    }
    val active = ready.rows.firstOrNull { it.id == actionId }
    if (active != null) {
      HomeRowActions(
        row = active,
        firstFocus = actionFocus,
        onToggle = { onToggle(active.id); leaveAction() },
        onMoveUp = { onMove(active.id, -1); leaveAction() },
        onMoveDown = { onMove(active.id, 1); leaveAction() },
        onMoveTop = { onMoveTop(active.id); leaveAction() },
      )
      return@SidePanel
    }
    val firstId = ready.rows.firstOrNull()?.id
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      items(ready.rows, key = { it.id }) { row ->
        val requester = rowFocuses.getOrPut(row.id) { if (row.id == firstId) firstFocus else FocusRequester() }
        HomeLayoutRowView(
          row = row,
          onOpen = { actionId = row.id },
          modifier = Modifier.testTag(homeLayoutRowTag(row.id)).focusRequester(requester),
        )
      }
      item(key = "reset") {
        HomeResetRow(
          onClick = onReset,
          // With no rows the reset row is the only target; it takes the panel's first focus.
          modifier = Modifier
            .testTag(TagHomeLayoutReset)
            .then(if (ready.rows.isEmpty()) Modifier.focusRequester(firstFocus) else Modifier),
        )
      }
      item(key = "note") {
        Text(
          stringResource(R.string.tv_home_layout_note),
          color = Tokens.Muted,
          fontSize = 10.5.sp,
          lineHeight = 15.sp,
          modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp).testTag(TagHomeLayoutNote),
        )
      }
      val failure = ready.failure
      if (failure != null) {
        item(key = "error") {
          Text(
            ready.message ?: stringResource(failure.messageRes()),
            color = Tokens.Red,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagHomeLayoutError),
          )
        }
      }
    }
  }
}

/** One arrangeable row: its label, a shown/hidden mark, and OK to open its actions. */
@Composable
private fun HomeLayoutRowView(
  row: HomeLayoutRow,
  onOpen: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Row(
    modifier = modifier
      .fillMaxWidth()
      // Observes the row's own focus target, so it has to sit before `focusable()`.
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) {}
      .onPreviewKeyEvent { event ->
        val pressed = event.type == KeyEventType.KeyDown &&
          (event.key == Key.Enter || event.key == Key.DirectionCenter || event.key == Key.Spacebar)
        if (pressed) onOpen()
        pressed
      }
      .then(if (focused) Modifier.background(Tokens.Panel2, shape).border(1.5.dp, Tokens.Accent2, shape) else Modifier)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text(
      homeRowLabel(row),
      modifier = Modifier.weight(1f),
      color = Tokens.Text,
      fontSize = 13.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    Text(
      stringResource(if (row.shown) R.string.tv_home_layout_shown else R.string.tv_home_layout_hidden),
      color = if (row.shown) Tokens.Green else Tokens.Muted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
    )
  }
}

/** The nested level OK opens on a row: show/hide, and the moves unless the row cannot move. */
@Composable
private fun HomeRowActions(
  row: HomeLayoutRow,
  firstFocus: FocusRequester,
  onToggle: () -> Unit,
  onMoveUp: () -> Unit,
  onMoveDown: () -> Unit,
  onMoveTop: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxSize().testTag(TagHomeRowActions),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(
      homeRowLabel(row),
      color = Tokens.Accent,
      fontSize = 13.sp,
      fontWeight = FontWeight.Bold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
    HomeActionRow(
      text = stringResource(if (row.shown) R.string.tv_home_hide else R.string.tv_home_show),
      onClick = onToggle,
      modifier = Modifier.testTag(TagHomeActionToggle).focusRequester(firstFocus),
    )
    // `confirm` is a count in Home's heading, never a shelf, so it has no place to move.
    if (row.id != ConfirmRow) {
      HomeActionRow(stringResource(R.string.tv_home_move_up), onMoveUp, Modifier.testTag(TagHomeActionUp))
      HomeActionRow(stringResource(R.string.tv_home_move_down), onMoveDown, Modifier.testTag(TagHomeActionDown))
      HomeActionRow(stringResource(R.string.tv_home_move_top), onMoveTop, Modifier.testTag(TagHomeActionTop))
    }
  }
}

/** One action of the nested list: OK picks it, focus draws the accent border. */
@Composable
private fun HomeActionRow(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Row(
    modifier = modifier
      .fillMaxWidth()
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) {}
      .onPreviewKeyEvent { event ->
        val pressed = event.type == KeyEventType.KeyDown &&
          (event.key == Key.Enter || event.key == Key.DirectionCenter || event.key == Key.Spacebar)
        if (pressed) onClick()
        pressed
      }
      .then(if (focused) Modifier.background(Tokens.Panel2, shape).border(1.5.dp, Tokens.Accent2, shape) else Modifier)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(text, color = Tokens.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
  }
}

/** The last row: OK clears the whole arrangement back to the instance default. */
@Composable
private fun HomeResetRow(onClick: () -> Unit, modifier: Modifier = Modifier) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Row(
    modifier = modifier
      .fillMaxWidth()
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) {}
      .onPreviewKeyEvent { event ->
        val pressed = event.type == KeyEventType.KeyDown &&
          (event.key == Key.Enter || event.key == Key.DirectionCenter || event.key == Key.Spacebar)
        if (pressed) onClick()
        pressed
      }
      .then(if (focused) Modifier.background(Tokens.Panel2, shape).border(1.5.dp, Tokens.Accent2, shape) else Modifier)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      stringResource(R.string.tv_home_layout_reset),
      color = Tokens.Red,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
    )
  }
}
