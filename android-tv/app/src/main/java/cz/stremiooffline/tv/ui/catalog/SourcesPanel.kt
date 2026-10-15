package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
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
const val TagSourcesFilters = "catalog_sources_filters"
const val TagSourcesCount = "catalog_sources_count"
const val TagSourceFilterOptions = "catalog_source_filter_options"

fun sourceRowTag(index: Int): String = "source_row_$index"
fun sourceSaveTag(index: Int): String = "source_save_$index"
fun sourceFilterTag(key: String): String = "source_filter_$key"
fun sourceFilterOptionTag(index: Int): String = "source_filter_option_$index"

/** One row of a chip's nested list: the wire value the screen stores, and its label. */
data class SourceFilterOption(val key: String, val label: String)

/** A filter chip: its own label, the label of the current value, and the choices OK opens. */
data class SourceFilterChip(
  val key: String,
  val title: String,
  val value: String,
  val selectedKey: String,
  val options: List<SourceFilterOption>,
)

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
  /** The filter chips; empty for a caller that offers none (the player's own panel). */
  filters: List<SourceFilterChip> = emptyList(),
  onFilterSelect: (chipKey: String, optionKey: String) -> Unit = { _, _ -> },
  /** The `shown of total` line beside the chips; null hides it. */
  countText: String? = null,
  /** A red line under the rows naming a remote group that could not be reached; null hides it. */
  remoteNote: String? = null,
  /** One exact stream's explicit Save action; null keeps every row without one, as before. */
  onSaveToLibrary: ((StreamDto) -> Unit)? = null,
  /** Whether one row may offer that Save at all: the caller marks exactly the rows it wants. */
  canSaveToLibrary: (StreamDto) -> Boolean = { false },
  modifier: Modifier = Modifier,
  initialFocus: FocusRequester? = null,
) {
  val defaultText = stringResource(R.string.tv_default)
  val nowPlayingText = stringResource(R.string.tv_now_playing)
  val loadErrorText = stringResource(R.string.tv_load_error)
  val tryAgainText = stringResource(R.string.tv_try_again)
  val findingSourcesText = stringResource(R.string.tv_finding_sources)
  val saveText = stringResource(R.string.save_to_library)
  val entry = focusIndex.coerceIn(0, maxOf(0, streams.size - 1))
  val listState = rememberLazyListState()

  // OK on a chip opens its choices; Back leaves them and hands the remote back to that chip.
  var openFilterKey by remember { mutableStateOf<String?>(null) }
  var restoreFilterKey by remember { mutableStateOf<String?>(null) }
  val chipFocuses = remember(filters.map { it.key }) { filters.map { FocusRequester() } }
  val optionFocus = remember { FocusRequester() }

  fun leaveFilter() {
    restoreFilterKey = openFilterKey
    openFilterKey = null
  }

  LaunchedEffect(openFilterKey) {
    awaitFrame()
    if (openFilterKey != null) {
      runCatching { optionFocus.requestFocus() }
      return@LaunchedEffect
    }
    val restore = restoreFilterKey ?: return@LaunchedEffect
    restoreFilterKey = null
    val index = filters.indexOfFirst { it.key == restore }
    if (index >= 0) runCatching { chipFocuses.getOrNull(index)?.requestFocus() }
  }

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
    onClose = { if (openFilterKey != null) leaveFilter() else onClose() },
    modifier = modifier.testTag(TagSourcesPanel),
    initialFocus = initialFocus,
    // Hundreds of sources keep the panel responsive: the rows are virtualised and only what is
    // on screen is composed.
    scroll = false,
  ) {
    val openChip = filters.firstOrNull { it.key == openFilterKey }
    if (openChip != null) {
      FilterOptionList(
        chip = openChip,
        focusRequester = optionFocus,
        onPick = { key ->
          onFilterSelect(openChip.key, key)
          leaveFilter()
        },
      )
      return@SidePanel
    }
    if (filters.isNotEmpty()) {
      SourceFilterBar(
        chips = filters,
        countText = countText,
        chipFocuses = chipFocuses,
        onOpen = { index -> openFilterKey = filters[index].key },
        downFocus = initialFocus,
      )
      Spacer(Modifier.height(8.dp))
    }
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxWidth().weight(1f),
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
            val save = if (onSaveToLibrary != null && canSaveToLibrary(stream)) onSaveToLibrary else null
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
                .then(
                  if (filters.isEmpty() || index != 0) Modifier
                  else Modifier.onPreviewKeyEvent { event ->
                    // The chips sit above the list: UP from the first row returns to them.
                    if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
                      runCatching { chipFocuses.first().requestFocus() }.isSuccess
                    } else {
                      false
                    }
                  },
                )
                .then(if (initialFocus != null && index == entry) Modifier.focusRequester(initialFocus) else Modifier),
              onSave = save?.let { callback -> { callback(stream) } },
              saveText = saveText,
              saveModifier = Modifier.testTag(sourceSaveTag(index)),
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
      // A remote group failure with rows on screen is a retryable note; when the panel is already
      // showing its own failure block, that block carries the text and the Retry instead.
      if (remoteNote != null && !failed) {
        item(key = "remote_note") {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(remoteNote, color = Tokens.Red, fontSize = 10.5.sp, lineHeight = 15.sp)
            if (onRetry != null) {
              FocusButton(
                text = tryAgainText,
                onClick = { onRetry.invoke() },
                modifier = Modifier.then(if (retryTag != null) Modifier.testTag(retryTag) else Modifier),
              )
            }
          }
        }
      }
    }
  }
}

/** A stable key per row: the stream's whole identity (its remote tuple, its path or its source id),
 *  with a positional fallback only for a row that truly carries none of them. Two rows that differ
 *  in any part of that identity keep keys of their own, and a row that is still offered keeps its
 *  key across a re-sort. */
private fun sourceRowKey(stream: StreamDto, index: Int): String =
  Streams.rowIdentity(stream).ifBlank { "row-$index" }

/** The chips across the top of the panel and the `shown of total` line beside them. */
@Composable
private fun SourceFilterBar(
  chips: List<SourceFilterChip>,
  countText: String?,
  chipFocuses: List<FocusRequester>,
  onOpen: (Int) -> Unit,
  downFocus: FocusRequester?,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .testTag(TagSourcesFilters)
      .onPreviewKeyEvent { event ->
        // DOWN leaves the chips for the list; the remaining directions stay on the row.
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown && downFocus != null) {
          runCatching { downFocus.requestFocus() }.isSuccess
        } else {
          false
        }
      },
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    chips.forEachIndexed { index, chip ->
      SourceFilterChipView(
        title = chip.title,
        value = chip.value,
        onOpen = { onOpen(index) },
        onLeft = { chipFocuses.getOrNull(index - 1)?.let { runCatching { it.requestFocus() } } },
        onRight = { chipFocuses.getOrNull(index + 1)?.let { runCatching { it.requestFocus() } } },
        modifier = Modifier
          .weight(1f)
          .testTag(sourceFilterTag(chip.key))
          .focusRequester(chipFocuses[index]),
      )
    }
    if (countText != null) {
      Text(countText, color = Tokens.Muted, fontSize = 10.5.sp, maxLines = 1, modifier = Modifier.testTag(TagSourcesCount))
    }
  }
}

/** One chip: the filter's name over the current value. OK opens its choices. */
@Composable
private fun SourceFilterChipView(
  title: String,
  value: String,
  onOpen: () -> Unit,
  onLeft: () -> Unit,
  onRight: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Column(
    modifier = modifier
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) {}
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
          Key.Enter, Key.DirectionCenter, Key.Spacebar -> { onOpen(); true }
          Key.DirectionLeft -> { onLeft(); true }
          Key.DirectionRight -> { onRight(); true }
          else -> false
        }
      }
      .then(if (focused) Modifier.background(Tokens.Panel2, shape).border(1.5.dp, Tokens.Accent2, shape) else Modifier)
      .padding(horizontal = 8.dp, vertical = 7.dp),
    verticalArrangement = Arrangement.spacedBy(1.dp),
  ) {
    Text(title, color = Tokens.Muted, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text(value, color = Tokens.Text, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

/** The nested list a chip opens: its choices with the current one ticked. */
@Composable
private fun FilterOptionList(
  chip: SourceFilterChip,
  focusRequester: FocusRequester,
  onPick: (String) -> Unit,
) {
  val selectedIndex = chip.options.indexOfFirst { it.key == chip.selectedKey }.let { if (it >= 0) it else 0 }
  Column(
    modifier = Modifier.fillMaxSize().testTag(TagSourceFilterOptions),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(
      chip.title,
      color = Tokens.Accent,
      fontSize = 13.sp,
      fontWeight = FontWeight.Bold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
    chip.options.forEachIndexed { index, option ->
      FilterOptionRow(
        text = option.label,
        selected = option.key == chip.selectedKey,
        onClick = { onPick(option.key) },
        modifier = Modifier
          .testTag(sourceFilterOptionTag(index))
          .then(if (index == selectedIndex) Modifier.focusRequester(focusRequester) else Modifier),
      )
    }
  }
}

/** One choice of a nested filter list: OK picks it, a tick marks the current one. */
@Composable
private fun FilterOptionRow(
  text: String,
  selected: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Row(
    modifier = modifier
      .fillMaxWidth()
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) { this.selected = selected }
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
      text,
      modifier = Modifier.weight(1f),
      color = Tokens.Text,
      fontSize = 13.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    if (selected) Text("✓", color = Tokens.Green, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
  }
}

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
  /** An explicit Save action for this exact row; null draws none. */
  onSave: (() -> Unit)? = null,
  saveText: String = "",
  saveModifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  val local = Streams.isLocalStream(stream)
  val remote = Streams.isRemoteStream(stream)
  val badge = when {
    local -> stringResource(R.string.sources_local_badge)
    remote -> stringResource(R.string.media_server_source_badge)
    else -> Streams.streamBadge(stream)
  }
  val badgeColour = when {
    local -> Tokens.Accent2
    remote -> Tokens.Accent2
    badge == "HTTP" -> Tokens.Green
    badge == "RD" -> Tokens.Accent
    else -> Tokens.Muted
  }
  val meta = buildList {
    formatSize(Streams.streamSize(stream))?.let(::add)
    addAll(Streams.streamLanguages(stream, titleLanguage).map { Languages.label(it) })
  }
  val localHint = stringResource(R.string.sources_local_hint)
  val remoteHint = stringResource(R.string.media_server_source_hint)
  val rowModifier = when {
    local -> Modifier.semantics { contentDescription = localHint }
    remote -> Modifier.semantics { contentDescription = remoteHint }
    else -> Modifier
  }
  // A remote version names the server and library it comes from, so a viewer sees which account
  // and which collection a row belongs to before playing it.
  val sourceName = when {
    remote -> listOfNotNull(stream.provider?.takeIf { it.isNotBlank() }, stream.libraryName?.takeIf { it.isNotBlank() })
      .joinToString(" · ")
    local -> stream.libraryName.orEmpty()
    else -> stream.addonName.orEmpty()
  }

  @Composable
  fun body(bodyModifier: Modifier) {
    Surface(
      onClick = onClick,
      modifier = bodyModifier.then(rowModifier),
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
            Text(sourceName, color = Tokens.Muted, fontSize = 9.5.sp, maxLines = 1)
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

  if (onSave == null) {
    body(modifier.fillMaxWidth())
  } else {
    // The Save is this row's sibling, not its child: a focusable inside a focusable row cannot be
    // reached with the D-pad, and the group is what walks between the row and its own action.
    Row(
      modifier = Modifier.fillMaxWidth().focusGroup(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      body(modifier.weight(1f))
      FocusButton(text = saveText, onClick = onSave, modifier = saveModifier)
    }
  }
}

/** One row's headline: the stream's name, or the first line it wrote about itself. */
internal fun streamLabel(stream: StreamDto): String =
  stream.name ?: stream.title?.split("\n")?.firstOrNull() ?: stream.description?.split("\n")?.firstOrNull() ?: ""


/**
 * The web's three filter menus as chips. Kept out of the detail screen on purpose: that
 * composable is already so large that adding this inline made ART refuse to verify it.
 */
@Composable
internal fun sourceFilterChips(
  filters: Streams.StreamFilters,
  options: Streams.SourceFilterOptions,
): List<SourceFilterChip> {
  val sortValue = filters.sort
  val streamAddon = filters.addon
  val streamLanguage = filters.language
  val sortingTitle = stringResource(R.string.common_sorting)
  val addonTitle = stringResource(R.string.sources_addon)
  val languageTitle = stringResource(R.string.auth_language)
  val allAddonsLabel = stringResource(R.string.sources_all_addons)
  val localLabel = stringResource(R.string.sources_local_filter)
  val anyLanguageLabel = stringResource(R.string.sources_any_language)
  val sortLabels = listOf(
    Streams.StreamSort.Recommended to stringResource(R.string.sources_sort_recommended),
    Streams.StreamSort.SizeDesc to stringResource(R.string.sources_sort_largest),
    Streams.StreamSort.SizeAsc to stringResource(R.string.sources_sort_smallest),
    Streams.StreamSort.Addon to stringResource(R.string.sources_sort_addon),
  )
  val languageOptions = options.languages
  val chips = buildList {
    add(
      SourceFilterChip(
        key = "sort",
        title = sortingTitle,
        value = sortLabels.first { it.first == sortValue }.second,
        selectedKey = sortValue.wire,
        options = sortLabels.map { SourceFilterOption(it.first.wire, it.second) },
      ),
    )
    add(
      SourceFilterChip(
        key = "addon",
        title = addonTitle,
        value = when {
          streamAddon == Streams.LOCAL_FILTER -> localLabel
          else -> options.remoteGroups.firstOrNull { it.value == streamAddon }?.label
            // A chosen remote group whose descriptor is gone (offline discovery) keeps its id
            // rather than silently falling back to the addon list.
            ?: Streams.remoteFilterLibrary(streamAddon)
            ?: streamAddon.ifEmpty { allAddonsLabel }
        },
        selectedKey = streamAddon,
        options = listOf(SourceFilterOption("", allAddonsLabel)) +
          // The viewer's own copies, as on the web: offered while there are any, and kept while chosen.
          (if (options.localCount > 0 || streamAddon == Streams.LOCAL_FILTER) {
            listOf(SourceFilterOption(Streams.LOCAL_FILTER, localLabel))
          } else {
            emptyList()
          }) +
          // One remote choice per library, labelled `provider · library` with its row count.
          options.remoteGroups.map { group ->
            SourceFilterOption(group.value, if (group.count > 0) "${group.label} · ${group.count}" else group.label)
          } +
          options.addons.map { SourceFilterOption(it.value, it.value) },
      ),
    )
    // With no language to offer the web hides the field; a chosen one always stays visible.
    if (languageOptions.isNotEmpty()) {
      add(
        SourceFilterChip(
          key = "language",
          title = languageTitle,
          value = if (streamLanguage.isEmpty()) anyLanguageLabel else Languages.label(streamLanguage),
          selectedKey = streamLanguage,
          options = listOf(SourceFilterOption("", anyLanguageLabel)) +
            languageOptions.map { SourceFilterOption(it.value, Languages.label(it.value)) },
        ),
      )
    }
  }
  return chips
}

/** The detail screen's source filters; held in one object so the screen keeps a single local. */
internal class SourceFilterState {
  private var addon by mutableStateOf("")
  private var language by mutableStateOf("")
  private var sort by mutableStateOf<Streams.StreamSort?>(null)

  fun filters(accountSort: String?) =
    Streams.StreamFilters(addon, language, sort ?: Streams.StreamSort.of(accountSort))

  fun select(chip: String, key: String) {
    when (chip) {
      "sort" -> sort = Streams.StreamSort.of(key)
      "addon" -> addon = key
      "language" -> language = key
    }
  }

  fun reset() {
    addon = ""
    language = ""
    sort = null
  }
}
