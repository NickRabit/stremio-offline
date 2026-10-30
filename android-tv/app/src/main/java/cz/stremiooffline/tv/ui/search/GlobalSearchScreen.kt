package cz.stremiooffline.tv.ui.search

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.GlobalSearchSourceDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.MicIcon
import cz.stremiooffline.tv.ui.catalog.RecentSearches
import cz.stremiooffline.tv.ui.catalog.SearchScopePanel
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.catalog.rememberVoiceSearch
import cz.stremiooffline.tv.ui.catalog.scopeLabel
import cz.stremiooffline.tv.ui.catalog.scopeRows
import cz.stremiooffline.tv.ui.catalog.voiceKey
import cz.stremiooffline.tv.ui.catalog.voiceSearchAvailable
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame

const val TagGlobalSearchField = "global_search_field"
const val TagGlobalSearchInput = "global_search_input"
const val TagGlobalSearchVoice = "global_search_voice"
const val TagGlobalSearchScopeChip = "global_search_scope_chip"
const val TagGlobalSearchSourceStrip = "global_search_source_strip"
const val TagGlobalSearchSourceRows = "global_search_source_rows"
const val TagGlobalSearchUnidentified = "global_search_unidentified"
const val TagGlobalSearchChooser = "global_search_chooser"
const val TagGlobalSearchPanelEntry = "global_search_panel_entry"

fun globalSearchCardTag(anchor: String): String = "global_search_card_$anchor"
fun globalSearchSourceRetryTag(sourceId: String): String = "global_search_retry_$sourceId"
fun globalSearchMemberTag(memberKey: String): String = "global_search_member_$memberKey"
fun globalSearchFilterTag(value: String): String = "global_search_filter_$value"

@Composable
fun GlobalSearchScreen(
  api: TvApi,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
  onOpenLibrary: (String) -> Unit,
  imageUrl: (String?) -> String?,
  overlayOpen: Boolean,
  libraryScope: LibrarySearchScope? = null,
  onBack: (() -> Unit)? = null,
  modifier: Modifier = Modifier,
  voiceAvailable: Boolean = voiceSearchAvailable(),
  voiceLauncher: VoiceLauncher? = null,
) {
  val scopeKey = libraryScope?.let {
    "${it.library?.libraryId.orEmpty()}|${it.library?.path.orEmpty()}|${it.library?.parentId.orEmpty()}|" +
      it.sources.sorted().joinToString(",")
  }
  val viewModel = if (libraryScope == null) {
    viewModel<GlobalSearchViewModel>(factory = GlobalSearchViewModel.factory(api))
  } else {
    viewModel<GlobalSearchViewModel>(
      key = "library:$scopeKey",
      factory = GlobalSearchViewModel.factory(
        api = api,
        library = libraryScope.library,
        sources = libraryScope.sources.mapNotNullTo(hashSetOf()) { wire ->
          SourceClass.entries.firstOrNull { it.wire == wire }
        },
      ),
    )
  }
  val state = viewModel.state
  val fieldFocus = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }
  val scopeFocus = remember { FocusRequester() }
  val sourceFocuses = remember { List(4) { FocusRequester() } }
  val kindFocuses = remember { List(3) { FocusRequester() } }
  val recentEntryFocus = remember { FocusRequester() }
  val sourceStripFocus = remember { FocusRequester() }
  val scopePanelEntry = remember { FocusRequester() }
  var draft by remember { mutableStateOf("") }
  var stripExpanded by remember { mutableStateOf(false) }
  var clearFocusSignal by remember { mutableIntStateOf(0) }
  var resultRestore by remember { mutableIntStateOf(0) }
  var overlayWasOpen by remember { mutableStateOf(overlayOpen) }
  var scopePanel by remember { mutableStateOf(false) }
  var scopePanelOpener by remember { mutableStateOf<FocusRequester?>(null) }

  fun submit() {
    val query = draft.trim()
    if (query.isNotEmpty()) viewModel.submit(query)
  }

  fun onVoice(spoken: String) {
    val query = spoken.trim()
    if (query.isEmpty()) return
    draft = query
    viewModel.submit(query)
  }

  fun clearCardFocus() {
    clearFocusSignal++
  }

  val showRecent = libraryScope == null && !state.submitted && draft.isBlank() && state.recent.isNotEmpty()
  val scopeShown = libraryScope == null && state.sources == setOf(SourceClass.Catalog)
  val lastFilterFocus = if (scopeShown) scopeFocus else kindFocuses.first()
  val contentFocus = if (state.submitted) sourceStripFocus else recentEntryFocus

  val voice = rememberVoiceSearch(voiceAvailable, onVoiceResult = ::onVoice, launcher = voiceLauncher)

  DisposableEffect(viewModel) {
    onDispose {
      viewModel.setActive(false)
      viewModel.leave()
    }
  }
  LaunchedEffect(viewModel, overlayOpen) {
    viewModel.setActive(!overlayOpen)
    if (overlayOpen) {
      overlayWasOpen = true
    } else if (overlayWasOpen) {
      overlayWasOpen = false
      resultRestore++
    }
  }
  LaunchedEffect(viewModel) {
    awaitFrame()
    runCatching { fieldFocus.requestFocus() }
  }
  LaunchedEffect(viewModel) {
    viewModel.refreshRecent()
  }
  LaunchedEffect(viewModel, state.sources) {
    if (state.sources == setOf(SourceClass.Catalog)) viewModel.loadSearchable()
  }
  if (onBack != null) BackHandler { onBack() }
  BackHandler(enabled = stripExpanded) { stripExpanded = false }
  LaunchedEffect(scopePanel) {
    if (!scopePanel) {
      val opener = scopePanelOpener
      scopePanelOpener = null
      runCatching { opener?.requestFocus() }
    }
  }

  val snapshot = state.snapshot

  Column(
    modifier = modifier
      .fillMaxSize()
      .padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX)
      .voiceKey(voice),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      stringResource(R.string.tv_global_search_title).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    if (libraryScope != null) {
      Text(
        stringResource(R.string.tv_library_search_scope, libraryScope.title),
        color = Tokens.Muted,
        fontSize = 12.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
      TvTextField(
        label = stringResource(R.string.tv_global_search_title),
        value = draft,
        onValueChange = { draft = it },
        imeAction = ImeAction.Done,
        surfaceRequester = fieldFocus,
        testTag = TagGlobalSearchField,
        inputTestTag = TagGlobalSearchInput,
        onSubmit = ::submit,
        modifier = Modifier
          .width(520.dp)
          .focusDirections(
            down = if (libraryScope == null) sourceFocuses.first() else contentFocus.takeIf { state.submitted || showRecent },
          )
          .onFocusChanged { if (it.isFocused) clearCardFocus() },
      )
      if (voice.available) {
        FocusButton(
          text = "",
          onClick = voice.start,
          kind = FocusButtonKind.Icon,
          leading = { Icon(MicIcon, contentDescription = null, modifier = Modifier.size(18.dp)) },
          contentDescription = stringResource(R.string.tv_voice_search),
          modifier = Modifier
            .size(38.dp)
            .testTag(TagGlobalSearchVoice)
            .focusDirections(down = if (libraryScope == null) sourceFocuses.first() else contentFocus)
            .onFocusChanged { if (it.isFocused) clearCardFocus() },
        )
      }
    }
    if (!state.submitted) {
      Text(stringResource(if (libraryScope != null) R.string.tv_global_search_library_hint else R.string.tv_global_search_hint), color = Tokens.Muted, fontSize = 12.sp)
    }

    if (libraryScope == null) {
      GlobalSearchFilters(
        sources = state.sources,
        kind = state.kind,
        scope = state.scope,
        searchable = state.searchable,
        fieldFocus = fieldFocus,
        sourceFocuses = sourceFocuses,
        kindFocuses = kindFocuses,
        scopeFocus = scopeFocus,
        downFocus = contentFocus.takeIf { state.submitted || showRecent },
        onSources = {
          viewModel.setSources(it)
          if (it == setOf(SourceClass.Catalog)) {
            viewModel.loadSearchable()
          } else {
            scopePanel = false
          }
        },
        onKind = viewModel::setKind,
        onScope = {
          viewModel.loadSearchable()
          scopePanelOpener = scopeFocus
          scopePanel = true
        },
        onFocused = ::clearCardFocus,
      )
    }

    if (state.submitted) {
      GlobalSourceStrip(
        sources = snapshot?.sources.orEmpty(),
        requested = state.sources.ifEmpty { SourceClass.entries.toSet() }.size,
        snapshotState = snapshot?.state,
        expanded = stripExpanded,
        onToggle = { stripExpanded = !stripExpanded },
        onRetry = viewModel::retry,
        onFocused = ::clearCardFocus,
        upFocus = lastFilterFocus,
        downFocus = gridFocus,
        focus = sourceStripFocus,
      )
    }

    if (showRecent) {
      Box(Modifier.weight(1f).fillMaxWidth()) {
        RecentSearches(
          items = state.recent,
          fieldFocus = fieldFocus,
          onPick = { picked ->
            draft = picked
            viewModel.submit(picked)
          },
          onForget = viewModel::forget,
          firstRowUp = lastFilterFocus,
          firstRowFocus = recentEntryFocus,
        )
      }
    } else {
      GlobalSearchResults(
        search = viewModel,
        remoteApi = api,
        onOpenCatalog = onOpenCatalog,
        onOpenRemote = onOpenRemote,
        onOpenLibrary = onOpenLibrary,
        imageUrl = imageUrl,
        modifier = Modifier.weight(1f),
        gridFocus = gridFocus,
        restoreToken = resultRestore,
        clearFocusSignal = clearFocusSignal,
        firstRowUp = if (state.submitted) sourceStripFocus else null,
      )
    }
  }

  if (scopePanel) {
    val rows = scopeRows(state.searchable, state.scope)
    val entry = rows.indexOfFirst { it.selected }.coerceAtLeast(0)
    SearchScopePanel(
      rows = rows,
      focusIndex = entry,
      onPick = { picked ->
        viewModel.setScope(picked)
        scopePanel = false
      },
      onClose = { scopePanel = false },
      initialFocus = scopePanelEntry,
    )
  }
}
@Composable
private fun GlobalSearchFilters(
  sources: Set<SourceClass>,
  kind: KindFilter,
  scope: SearchScope,
  searchable: List<SearchableCatalogDto>,
  fieldFocus: FocusRequester,
  sourceFocuses: List<FocusRequester>,
  kindFocuses: List<FocusRequester>,
  scopeFocus: FocusRequester,
  downFocus: FocusRequester?,
  onSources: (Set<SourceClass>) -> Unit,
  onKind: (KindFilter) -> Unit,
  onScope: () -> Unit,
  onFocused: () -> Unit,
) {
  val catalog = sources == setOf(SourceClass.Catalog)
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
      val values = listOf(
        Triple(stringResource(R.string.tv_global_search_source_all), sources.isEmpty(), "source_all"),
        Triple(stringResource(R.string.tv_global_search_source_catalog), catalog, "source_catalog"),
        Triple(stringResource(R.string.tv_global_search_source_local), sources == setOf(SourceClass.Local), "source_local"),
        Triple(stringResource(R.string.tv_global_search_source_remote), sources == setOf(SourceClass.Remote), "source_remote"),
      )
      values.forEachIndexed { index, (text, selected, tag) ->
        GlobalSearchFilter(
          text = text,
          selected = selected,
          tag = tag,
          onFocused = onFocused,
          onClick = {
            onSources(
              when (tag) {
                "source_catalog" -> setOf(SourceClass.Catalog)
                "source_local" -> setOf(SourceClass.Local)
                "source_remote" -> setOf(SourceClass.Remote)
                else -> emptySet()
              },
            )
          },
          modifier = Modifier
            .focusRequester(sourceFocuses[index])
            .focusDirections(
              left = sourceFocuses.getOrNull(index - 1),
              right = sourceFocuses.getOrNull(index + 1),
              up = fieldFocus,
              down = kindFocuses.first(),
            ),
        )
      }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
      val values = listOf(
        Triple(stringResource(R.string.tv_global_search_kind_all), KindFilter.All, "kind_all"),
        Triple(stringResource(R.string.tv_global_search_kind_movies), KindFilter.Movies, "kind_movie"),
        Triple(stringResource(R.string.tv_global_search_kind_series), KindFilter.Series, "kind_series"),
      )
      values.forEachIndexed { index, (text, value, tag) ->
        GlobalSearchFilter(
          text = text,
          selected = kind == value,
          tag = tag,
          onFocused = onFocused,
          onClick = { onKind(value) },
          modifier = Modifier
            .focusRequester(kindFocuses[index])
            .focusDirections(
              left = kindFocuses.getOrNull(index - 1),
              right = kindFocuses.getOrNull(index + 1),
              up = sourceFocuses.first(),
              down = if (catalog) scopeFocus else downFocus,
            ),
        )
      }
    }
    if (catalog) {
      GlobalSearchScopeChip(
        scope = scope,
        searchable = searchable,
        onClick = onScope,
        onFocused = onFocused,
        modifier = Modifier
          .focusRequester(scopeFocus)
          .focusDirections(up = kindFocuses.first(), down = downFocus),
      )
    }
  }
}

@Composable
private fun GlobalSearchScopeChip(
  scope: SearchScope,
  searchable: List<SearchableCatalogDto>,
  onClick: () -> Unit,
  onFocused: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(
      stringResource(R.string.catalog_search_scope).uppercase(),
      color = Tokens.Muted,
      fontSize = 8.5.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = 0.8.sp,
    )
    FocusButton(
      text = scopeLabel(scope, searchable),
      onClick = onClick,
      contentDescription = stringResource(R.string.catalog_search_scope),
      labelMaxWidth = 300.dp,
      modifier = modifier
        .height(38.dp)
        .testTag(TagGlobalSearchScopeChip)
        .onFocusChanged { if (it.isFocused) onFocused() },
    )
  }
}

@Composable
private fun GlobalSearchFilter(
  text: String,
  selected: Boolean,
  tag: String,
  onFocused: () -> Unit,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  FocusButton(
    text = text,
    onClick = onClick,
    kind = if (selected) FocusButtonKind.Primary else FocusButtonKind.Normal,
    modifier = modifier
      .testTag(globalSearchFilterTag(tag))
      .onFocusChanged { if (it.isFocused) onFocused() },
  )
}

@Composable
private fun GlobalSourceStrip(
  sources: List<GlobalSearchSourceDto>,
  requested: Int,
  snapshotState: String?,
  expanded: Boolean,
  onToggle: () -> Unit,
  onRetry: (String) -> Unit,
  onFocused: () -> Unit,
  upFocus: FocusRequester,
  downFocus: FocusRequester,
  focus: FocusRequester,
) {
  val pending = sources.count { it.state == "queued" || it.state == "loading" || it.state == "indexing" }
  val loading = snapshotState == null || snapshotState == "partial"
  val text = if (loading) {
    pluralStringResource(R.plurals.tv_global_search_status_loading, pending.coerceAtLeast(1), pending.coerceAtLeast(1))
  } else {
    stringResource(R.string.tv_global_search_status_done)
  }
  Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
    FocusButton(
      text = text,
      onClick = onToggle,
      modifier = Modifier
        .focusRequester(focus)
        .focusDirections(up = upFocus, down = if (expanded) null else downFocus)
        .testTag(TagGlobalSearchSourceStrip)
        .onFocusChanged { if (it.isFocused) onFocused() },
    )
    if (expanded) {
      Column(
        Modifier
          .fillMaxWidth()
          .focusGroup()
          .testTag(TagGlobalSearchSourceRows),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        sources.forEach { source ->
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            FocusButton(
              text = source.label,
              onClick = {},
              labelMaxWidth = 280.dp,
              modifier = Modifier.onFocusChanged { if (it.isFocused) onFocused() },
            )
            Text(sourceStateText(source.state), color = Tokens.Muted, fontSize = 11.sp)
            if (source.retryable) {
              FocusButton(
                text = stringResource(R.string.tv_global_search_retry),
                onClick = { onRetry(source.id) },
                modifier = Modifier
                  .testTag(globalSearchSourceRetryTag(source.id))
                  .onFocusChanged { if (it.isFocused) onFocused() },
              )
            }
          }
        }
        if (sources.isEmpty()) {
          Text(
            pluralStringResource(R.plurals.tv_global_search_status_loading, requested, requested),
            color = Tokens.Muted,
            fontSize = 11.sp,
          )
        }
      }
    }
  }
}

private fun Modifier.focusDirections(
  left: FocusRequester? = null,
  right: FocusRequester? = null,
  up: FocusRequester? = null,
  down: FocusRequester? = null,
): Modifier = onPreviewKeyEvent { event ->
  if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
  val target = when (event.key) {
    Key.DirectionLeft -> left
    Key.DirectionRight -> right
    Key.DirectionUp -> up
    Key.DirectionDown -> down
    else -> null
  }
  target?.let { runCatching { it.requestFocus() }.isSuccess } ?: false
}

@Composable
private fun sourceStateText(state: String): String = stringResource(
  when (state) {
    "queued" -> R.string.tv_global_search_state_queued
    "loading" -> R.string.tv_global_search_state_loading
    "ready" -> R.string.tv_global_search_state_ready
    "exhausted" -> R.string.tv_global_search_state_exhausted
    "stalled" -> R.string.tv_global_search_state_stalled
    "failed" -> R.string.tv_global_search_state_failed
    "timedOut" -> R.string.tv_global_search_state_timed_out
    "indexing" -> R.string.tv_global_search_state_indexing
    else -> R.string.tv_global_search_state_unavailable
  },
)
