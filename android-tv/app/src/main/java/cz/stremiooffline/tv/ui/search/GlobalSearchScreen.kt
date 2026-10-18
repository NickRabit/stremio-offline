package cz.stremiooffline.tv.ui.search

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
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
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchMemberDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchSourceDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.MicIcon
import cz.stremiooffline.tv.ui.catalog.SearchScopePanel
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.catalog.rememberVoiceSearch
import cz.stremiooffline.tv.ui.catalog.scopeLabel
import cz.stremiooffline.tv.ui.catalog.scopeRows
import cz.stremiooffline.tv.ui.catalog.voiceKey
import cz.stremiooffline.tv.ui.catalog.voiceSearchAvailable
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.components.leftToNeighbour
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

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

private data class ChooserState(val anchor: String, val title: String)

internal fun globalSearchAnchor(cluster: GlobalSearchClusterDto, focusAnchor: String?): String =
  if (focusAnchor != null && focusAnchor in cluster.memberKeys) focusAnchor
  else cluster.memberKeys.firstOrNull() ?: cluster.key

@Composable
fun GlobalSearchScreen(
  api: TvApi,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
  onOpenLibrary: (String) -> Unit,
  imageUrl: (String?) -> String?,
  overlayOpen: Boolean,
  modifier: Modifier = Modifier,
  voiceAvailable: Boolean = voiceSearchAvailable(),
  voiceLauncher: VoiceLauncher? = null,
) {
  val viewModel = viewModel<GlobalSearchViewModel>(factory = GlobalSearchViewModel.factory(api))
  val state = viewModel.state
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val fieldFocus = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }
  val scopeFocus = remember { FocusRequester() }
  val scopePanelEntry = remember { FocusRequester() }
  val gridState = rememberLazyGridState()
  val cardFocus = remember { mutableMapOf<String, FocusRequester>() }
  var draft by remember { mutableStateOf("") }
  var stripExpanded by remember { mutableStateOf(false) }
  var unidentifiedExpanded by remember { mutableStateOf(false) }
  var focusedAnchor by remember { mutableStateOf<String?>(null) }
  var focusedIndex by remember { mutableIntStateOf(-1) }
  var lastLoadRevision by remember { mutableIntStateOf(-1) }
  var chooser by remember { mutableStateOf<ChooserState?>(null) }
  var chooserReturnAnchor by remember { mutableStateOf<String?>(null) }
  var memberPage by remember { mutableStateOf<GlobalSearchMemberPageDto?>(null) }
  var memberLoading by remember { mutableStateOf(false) }
  var memberError by remember { mutableStateOf(false) }
  var overlayWasOpen by remember { mutableStateOf(overlayOpen) }
  var scopePanel by remember { mutableStateOf(false) }
  var scopePanelOpener by remember { mutableStateOf<FocusRequester?>(null) }
  val memberEntry = remember { FocusRequester() }

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
    focusedAnchor = null
    focusedIndex = -1
  }

  fun requestAnchor(anchor: String?) {
    if (anchor == null) return
    scope.launch {
      awaitFrame()
      runCatching { cardFocus[anchor]?.requestFocus() }
    }
  }

  fun openChooser(cluster: GlobalSearchClusterDto, anchor: String) {
    viewModel.setFocusAnchor(anchor)
    memberPage = null
    memberError = false
    chooser = ChooserState(anchor, cluster.title)
  }

  fun loadMembers(from: Int) {
    val anchor = chooser?.anchor ?: return
    memberLoading = true
    memberError = false
    scope.launch {
      try {
        val answer = viewModel.members(anchor, from)
        memberPage = if (from == 0) answer else {
          val previous = memberPage
          answer.copy(members = previous?.members.orEmpty() + answer.members)
        }
      } catch (_: Exception) {
        memberError = true
      } finally {
        memberLoading = false
      }
    }
  }

  fun closeChooser(restoreFocus: Boolean = true) {
    val anchor = chooser?.anchor ?: state.focusAnchor
    chooserReturnAnchor = anchor.takeIf { restoreFocus }
    chooser = null
    memberPage = null
  }

  fun openMember(member: GlobalSearchMemberDto) {
    viewModel.setFocusAnchor(chooser?.anchor ?: member.memberKey)
    closeChooser(restoreFocus = false)
    val locator = member.locator
    when (locator.kind) {
      "catalog" -> {
        val type = locator.type ?: member.kind.takeIf { it == "movie" || it == "series" }
        val id = locator.id
        if (type == null || id == null) {
          Toast.makeText(context, R.string.tv_global_search_open_failed, Toast.LENGTH_SHORT).show()
          return
        }
        onOpenCatalog(
          CatalogDetailArgs(
            meta = MetaDto(id = id, type = type, name = member.title, poster = member.poster),
            addonName = addonLabel(member),
            type = type,
          ),
        )
      }
      "local" -> {
        val path = locator.key
        if (path == null) Toast.makeText(context, R.string.tv_global_search_open_failed, Toast.LENGTH_SHORT).show()
        else onOpenLibrary(path)
      }
      "remote" -> {
        val libraryId = locator.libraryId
        val itemId = locator.itemId
        if (libraryId == null || itemId == null) {
          Toast.makeText(context, R.string.tv_global_search_open_failed, Toast.LENGTH_SHORT).show()
          return
        }
        scope.launch {
          try {
            val detail = api.remoteItem(libraryId, itemId)
            onOpenRemote(
              RemoteDetailData(
                libraryId = libraryId,
                libraryName = member.sourceLabel,
                provider = locator.provider.orEmpty(),
                item = detail.item,
              ),
            )
          } catch (_: Exception) {
            Toast.makeText(context, R.string.tv_global_search_open_failed, Toast.LENGTH_SHORT).show()
          }
        }
      }
      else -> Toast.makeText(context, R.string.tv_global_search_open_failed, Toast.LENGTH_SHORT).show()
    }
  }

  fun openCanonical(canonical: cz.stremiooffline.tv.data.GlobalSearchCanonicalDto) {
    if (canonical.type != "movie" && canonical.type != "series") return
    onOpenCatalog(
      CatalogDetailArgs(
        meta = MetaDto(id = canonical.id, type = canonical.type, name = canonical.name, poster = canonical.poster),
        addonName = "",
        type = canonical.type,
      ),
    )
  }

  // A title every source shares an id for opens its one title page, which lists the library
  // copies and the addon rows and picks among them; only a title without one asks where to open.
  fun openCluster(cluster: GlobalSearchClusterDto, anchor: String) {
    viewModel.setFocusAnchor(anchor)
    scope.launch {
      val page = try { viewModel.members(anchor, 0) } catch (_: Exception) { null }
      val canonical = page?.canonical
      val distinct = openableMembers(page?.members.orEmpty())
      when {
        canonical != null && (canonical.type == "movie" || canonical.type == "series") -> openCanonical(canonical)
        page != null && distinct.size == 1 && (page.nextFrom == null || cluster.kind == "series") -> openMember(distinct.first())
        else -> openChooser(cluster, anchor)
      }
    }
  }

  val voice = rememberVoiceSearch(voiceAvailable, onVoiceResult = ::onVoice, launcher = voiceLauncher)

  DisposableEffect(Unit) {
    onDispose {
      viewModel.setActive(false)
      viewModel.leave()
    }
  }
  LaunchedEffect(overlayOpen) {
    viewModel.setActive(!overlayOpen)
    if (overlayOpen) {
      overlayWasOpen = true
    } else if (overlayWasOpen) {
      overlayWasOpen = false
      requestAnchor(state.focusAnchor)
    }
  }
  LaunchedEffect(Unit) {
    awaitFrame()
    runCatching { fieldFocus.requestFocus() }
  }
  LaunchedEffect(chooser?.anchor) {
    if (chooser != null) loadMembers(0)
  }
  LaunchedEffect(chooser) {
    val anchor = chooserReturnAnchor ?: return@LaunchedEffect
    repeat(2) { awaitFrame() }
    runCatching { cardFocus[anchor]?.requestFocus() }
    if (chooserReturnAnchor == anchor) chooserReturnAnchor = null
  }
  BackHandler(enabled = stripExpanded) { stripExpanded = false }
  LaunchedEffect(scopePanel) {
    if (!scopePanel) {
      val opener = scopePanelOpener
      scopePanelOpener = null
      runCatching { opener?.requestFocus() }
    }
  }

  val snapshot = state.snapshot
  val clustersByKey = snapshot?.clusters.orEmpty().associateBy { it.key }
  val cards = state.order.mapNotNull(clustersByKey::get)
  val unidentifiedByKey = snapshot?.unidentified.orEmpty().associateBy { it.key }
  val unidentifiedCards = state.unidentifiedOrder.mapNotNull(unidentifiedByKey::get)

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
            .onFocusChanged { if (it.isFocused) clearCardFocus() },
        )
      }
    }
    if (!state.submitted) {
      Text(stringResource(R.string.tv_global_search_hint), color = Tokens.Muted, fontSize = 12.sp)
    }

    GlobalSearchFilters(
      sources = state.sources,
      kind = state.kind,
      scope = state.scope,
      searchable = state.searchable,
      scopeFocus = scopeFocus,
      onSources = {
        viewModel.setSources(it)
        if (it != setOf(SourceClass.Catalog)) scopePanel = false
      },
      onKind = viewModel::setKind,
      onScope = {
        viewModel.loadSearchable()
        scopePanelOpener = scopeFocus
        scopePanel = true
      },
      onFocused = ::clearCardFocus,
    )

    if (state.submitted) {
      GlobalSourceStrip(
        sources = snapshot?.sources.orEmpty(),
        requested = state.sources.ifEmpty { SourceClass.entries.toSet() }.size,
        snapshotState = snapshot?.state,
        expanded = stripExpanded,
        onToggle = { stripExpanded = !stripExpanded },
        onRetry = viewModel::retry,
        onFocused = ::clearCardFocus,
      )
    }

    if (state.previousQuery) {
      Text(stringResource(R.string.tv_global_search_previous_query), color = Tokens.Muted, fontSize = 11.sp)
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(stringResource(state.error), color = Tokens.Muted, fontSize = 13.sp)
        }
        !state.submitted -> Unit
        snapshot == null && state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Text(stringResource(R.string.tv_global_search_state_loading), color = Tokens.Muted, fontSize = 13.sp)
        }
        snapshot != null && cards.isEmpty() && unidentifiedCards.isEmpty() && snapshot.state != "partial" ->
          Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
              stringResource(
                if (snapshot.limitReached) R.string.tv_global_search_limit_reached else R.string.tv_global_search_empty,
              ),
              color = Tokens.Muted,
              fontSize = 13.sp,
            )
          }
        snapshot != null -> GlobalResultGrid(
          cards = cards,
          unidentified = unidentifiedCards,
          focusAnchor = state.focusAnchor,
          snapshotRevision = snapshot.revision,
          limitReached = snapshot.limitReached,
          hasMore = state.hasMore,
          unidentifiedExpanded = unidentifiedExpanded,
          onUnidentified = { unidentifiedExpanded = !unidentifiedExpanded },
          onLoadMore = viewModel::loadMore,
          onFocusCard = { anchor, index ->
            focusedAnchor = anchor
            focusedIndex = index
            viewModel.setFocusAnchor(anchor)
          },
          onClearFocus = ::clearCardFocus,
          onOpen = ::openCluster,
          imageUrl = imageUrl,
          gridFocus = gridFocus,
          gridState = gridState,
          cardFocus = cardFocus,
          focusedIndex = focusedIndex,
          lastLoadRevision = lastLoadRevision,
          onLoadRevision = { lastLoadRevision = it },
        )
      }
    }
  }

  LaunchedEffect(snapshot?.revision, cards.size) {
    if (focusedAnchor == null || snapshot == null) return@LaunchedEffect
    val target = state.focusAnchor?.takeIf { anchor ->
      snapshot.clusters.any { anchor in it.memberKeys || anchor == it.key }
    } ?: cards.firstOrNull()?.let { globalSearchAnchor(it, state.focusAnchor) }
    requestAnchor(target)
  }
  LaunchedEffect(focusedIndex, snapshot?.revision, cards.size, state.hasMore) {
    val current = snapshot ?: return@LaunchedEffect
    if (!state.hasMore || focusedIndex < cards.size - 1 || lastLoadRevision == current.revision) return@LaunchedEffect
    lastLoadRevision = current.revision
    viewModel.loadMore()
  }

  val openChooser = chooser
  if (openChooser != null) {
    GlobalSearchMemberPanel(
      title = openChooser.title,
      page = memberPage,
      loading = memberLoading,
      error = memberError,
      entry = memberEntry,
      onClose = ::closeChooser,
      onLoadMore = { memberPage?.nextFrom?.let(::loadMembers) },
      onOpenMember = ::openMember,
      onOpenCanonical = ::openCanonical,
    )
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
  scopeFocus: FocusRequester,
  onSources: (Set<SourceClass>) -> Unit,
  onKind: (KindFilter) -> Unit,
  onScope: () -> Unit,
  onFocused: () -> Unit,
) {
  val kindSeriesFocus = remember { FocusRequester() }
  val catalog = sources == setOf(SourceClass.Catalog)
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_source_all),
      selected = sources.isEmpty(),
      tag = "source_all",
      onFocused = onFocused,
      onClick = { onSources(emptySet()) },
    )
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_source_catalog),
      selected = sources == setOf(SourceClass.Catalog),
      tag = "source_catalog",
      onFocused = onFocused,
      onClick = { onSources(setOf(SourceClass.Catalog)) },
    )
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_source_local),
      selected = sources == setOf(SourceClass.Local),
      tag = "source_local",
      onFocused = onFocused,
      onClick = { onSources(setOf(SourceClass.Local)) },
    )
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_source_remote),
      selected = sources == setOf(SourceClass.Remote),
      tag = "source_remote",
      onFocused = onFocused,
      onClick = { onSources(setOf(SourceClass.Remote)) },
    )
    Box(Modifier.width(8.dp))
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_kind_all),
      selected = kind == KindFilter.All,
      tag = "kind_all",
      onFocused = onFocused,
      onClick = { onKind(KindFilter.All) },
    )
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_kind_movies),
      selected = kind == KindFilter.Movies,
      tag = "kind_movie",
      onFocused = onFocused,
      onClick = { onKind(KindFilter.Movies) },
    )
    GlobalSearchFilter(
      text = stringResource(R.string.tv_global_search_kind_series),
      selected = kind == KindFilter.Series,
      tag = "kind_series",
      onFocused = onFocused,
      onClick = { onKind(KindFilter.Series) },
      modifier = Modifier
        .focusRequester(kindSeriesFocus)
        .then(if (catalog) Modifier.focusProperties { right = scopeFocus } else Modifier),
    )
    if (catalog) {
      GlobalSearchScopeChip(
        scope = scope,
        searchable = searchable,
        onClick = onScope,
        onFocused = onFocused,
        modifier = Modifier
          .focusRequester(scopeFocus)
          .leftToNeighbour(kindSeriesFocus),
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

@Composable
private fun GlobalResultGrid(
  cards: List<GlobalSearchClusterDto>,
  unidentified: List<GlobalSearchClusterDto>,
  focusAnchor: String?,
  snapshotRevision: Int,
  limitReached: Boolean,
  hasMore: Boolean,
  unidentifiedExpanded: Boolean,
  onUnidentified: () -> Unit,
  onLoadMore: () -> Unit,
  onFocusCard: (String, Int) -> Unit,
  onClearFocus: () -> Unit,
  onOpen: (GlobalSearchClusterDto, String) -> Unit,
  imageUrl: (String?) -> String?,
  gridFocus: FocusRequester,
  gridState: LazyGridState,
  cardFocus: MutableMap<String, FocusRequester>,
  focusedIndex: Int,
  lastLoadRevision: Int,
  onLoadRevision: (Int) -> Unit,
) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val columns = (((maxWidth.value + 18f) / 138f).toInt()).coerceAtLeast(1)
    LazyVerticalGrid(
      columns = GridCells.Fixed(columns),
      state = gridState,
      modifier = Modifier.focusRequester(gridFocus).focusGroup(),
      contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      if (limitReached) {
        item(key = "limit-reached", span = { GridItemSpan(maxLineSpan) }) {
          Text(stringResource(R.string.tv_global_search_limit_reached), color = Tokens.Muted, fontSize = 12.sp)
        }
      }
      itemsIndexed(cards, key = { _, cluster -> globalSearchAnchor(cluster, focusAnchor) }) { index, cluster ->
        val anchor = globalSearchAnchor(cluster, focusAnchor)
        val requester = remember(anchor) { FocusRequester() }
        cardFocus[anchor] = requester
        GlobalSearchCard(
          cluster = cluster,
          anchor = anchor,
          imageUrl = imageUrl,
          onFocus = {
            onFocusCard(anchor, index)
            if (hasMore && index >= cards.size - columns && lastLoadRevision != snapshotRevision) {
              onLoadRevision(snapshotRevision)
              onLoadMore()
            }
          },
          onClick = { onOpen(cluster, anchor) },
          modifier = Modifier.focusRequester(requester),
        )
      }
      if (unidentified.isNotEmpty()) {
        item(key = "unidentified-toggle", span = { GridItemSpan(maxLineSpan) }) {
          FocusButton(
            text = stringResource(R.string.tv_global_search_unidentified, unidentified.size),
            onClick = onUnidentified,
            modifier = Modifier
              .testTag(TagGlobalSearchUnidentified)
              .onFocusChanged { if (it.isFocused) onClearFocus() },
          )
        }
      }
      if (unidentifiedExpanded) {
        itemsIndexed(unidentified, key = { _, cluster -> "unidentified:${globalSearchAnchor(cluster, focusAnchor)}" }) { index, cluster ->
          val anchor = globalSearchAnchor(cluster, focusAnchor)
          val requester = remember(anchor) { FocusRequester() }
          cardFocus[anchor] = requester
          GlobalSearchCard(
            cluster = cluster,
            anchor = anchor,
            imageUrl = imageUrl,
            onFocus = { onFocusCard(anchor, index + cards.size) },
            onClick = { onOpen(cluster, anchor) },
            modifier = Modifier.focusRequester(requester),
          )
        }
      }
    }
  }
}

@Composable
private fun GlobalSearchCard(
  cluster: GlobalSearchClusterDto,
  anchor: String,
  imageUrl: (String?) -> String?,
  onFocus: () -> Unit,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = Modifier.width(110.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    PosterCard(
      name = cluster.title,
      imageUrl = imageUrl(cluster.poster ?: cluster.background),
      progress = null,
      onClick = onClick,
      cardTag = globalSearchCardTag(anchor),
      modifier = modifier.onFocusChanged { if (it.isFocused) onFocus() },
    )
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
      cluster.year?.let { Text(it.toString(), color = Tokens.Muted, fontSize = 10.sp) }
    }
    cluster.episodeCount?.takeIf { it > 0 }?.let {
      Text(
        pluralStringResource(R.plurals.tv_global_search_episodes, it, it),
        color = Tokens.Muted,
        fontSize = 9.sp,
        maxLines = 1,
      )
    }
  }
}

@Composable
private fun GlobalSearchMemberPanel(
  title: String,
  page: GlobalSearchMemberPageDto?,
  loading: Boolean,
  error: Boolean,
  entry: FocusRequester,
  onClose: () -> Unit,
  onLoadMore: () -> Unit,
  onOpenMember: (GlobalSearchMemberDto) -> Unit,
  onOpenCanonical: (cz.stremiooffline.tv.data.GlobalSearchCanonicalDto) -> Unit,
) {
  SidePanel(
    title = stringResource(R.string.tv_global_search_chooser_title, title),
    onClose = onClose,
    modifier = Modifier.testTag(TagGlobalSearchChooser),
    initialFocus = entry,
  ) {
    if (loading && page == null) Text(stringResource(R.string.tv_global_search_state_loading), color = Tokens.Muted, fontSize = 12.sp)
    if (error) Text(stringResource(R.string.tv_global_search_open_failed), color = Tokens.Muted, fontSize = 12.sp)
    openableMembers(page?.members.orEmpty()).forEachIndexed { index, member ->
      Column(
        verticalArrangement = Arrangement.spacedBy(2.dp),
        modifier = if (index == 0) Modifier.testTag(TagGlobalSearchPanelEntry) else Modifier,
      ) {
        FocusButton(
          text = memberLabel(member),
          onClick = { onOpenMember(member) },
          labelMaxWidth = 300.dp,
          modifier = Modifier
            .fillMaxWidth()
            .then(if (index == 0) Modifier.focusRequester(entry) else Modifier)
            .testTag(globalSearchMemberTag(member.memberKey)),
        )
        memberEpisode(member)?.let {
          Text(it, color = Tokens.Muted, fontSize = 10.sp)
        }
        if (member.conflict) {
          Text(stringResource(R.string.tv_global_search_conflict), color = Tokens.Muted, fontSize = 10.sp)
        }
      }
    }
    page?.canonical?.let { canonical ->
      FocusButton(
        text = stringResource(R.string.tv_global_search_open_title_page),
        onClick = { onOpenCanonical(canonical) },
        kind = FocusButtonKind.Primary,
        modifier = Modifier.fillMaxWidth(),
      )
    }
    if (page?.nextFrom != null) {
      FocusButton(
        text = stringResource(R.string.tv_global_search_load_more),
        onClick = onLoadMore,
        enabled = !loading,
      )
    }
  }
}

/** One addon answers the same title from several of its catalogues; it is one copy. */
/** What a card can open: a series card opens the series, never one of the episodes under it. */
internal fun openableMembers(members: List<GlobalSearchMemberDto>): List<GlobalSearchMemberDto> {
  val distinct = distinctMembers(members)
  val series = distinct.filter { it.kind == "series" }
  return if (series.isNotEmpty()) distinct.filter { it.kind != "episode" } else distinct
}

internal fun distinctMembers(members: List<GlobalSearchMemberDto>): List<GlobalSearchMemberDto> {
  val seen = mutableSetOf<String>()
  return members.filter { member ->
    val locator = member.locator
    locator.kind != "catalog" || seen.add("${locator.addonKey}|${locator.type}|${locator.id}")
  }
}

private fun addonLabel(member: GlobalSearchMemberDto): String =
  if (member.locator.kind == "catalog") member.sourceLabel.substringBefore(" · ") else member.sourceLabel

@Composable
private fun memberLabel(member: GlobalSearchMemberDto): String {
  return stringResource(R.string.tv_global_search_member_label, addonLabel(member), member.title)
}

@Composable
private fun memberEpisode(member: GlobalSearchMemberDto): String? {
  val season = member.season
  val episode = member.episode
  if (season == null || episode == null) return null
  return if (member.episodeEnd != null && member.episodeEnd != episode) {
    stringResource(R.string.tv_global_search_episode_range, season, episode, member.episodeEnd)
  } else {
    stringResource(R.string.tv_global_search_episode_label, season, episode)
  }
}
