package cz.stremiooffline.tv.ui.search

import android.widget.Toast
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.GlobalSearchCanonicalDto
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchMemberDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

private data class ChooserState(val anchor: String, val title: String)

internal fun globalSearchAnchor(cluster: GlobalSearchClusterDto, focusAnchor: String?): String =
  if (focusAnchor != null && focusAnchor in cluster.memberKeys) focusAnchor
  else cluster.memberKeys.firstOrNull() ?: cluster.key

@Composable
internal fun GlobalSearchResults(
  search: GlobalSearchViewModel,
  remoteApi: RemoteLibraryApi,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
  onOpenLibrary: (String) -> Unit,
  imageUrl: (String?) -> String?,
  modifier: Modifier = Modifier,
  gridFocus: FocusRequester = remember { FocusRequester() },
  restoreToken: Int = 0,
  clearFocusSignal: Int = 0,
  canonicalTitles: Boolean = true,
  firstRowUp: FocusRequester? = null,
) {
  val state = search.state
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val gridState = rememberLazyGridState()
  val cardFocus = remember { mutableMapOf<String, FocusRequester>() }
  var unidentifiedExpanded by remember { mutableStateOf(false) }
  var focusedAnchor by remember { mutableStateOf<String?>(null) }
  var focusedIndex by remember { mutableIntStateOf(-1) }
  var lastLoadRevision by remember { mutableIntStateOf(-1) }
  var chooser by remember { mutableStateOf<ChooserState?>(null) }
  var chooserReturnAnchor by remember { mutableStateOf<String?>(null) }
  var memberPage by remember { mutableStateOf<GlobalSearchMemberPageDto?>(null) }
  var memberLoading by remember { mutableStateOf(false) }
  var memberError by remember { mutableStateOf(false) }
  val memberEntry = remember { FocusRequester() }

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
    search.setFocusAnchor(anchor)
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
        val answer = search.members(anchor, from)
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
    search.setFocusAnchor(chooser?.anchor ?: member.memberKey)
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
            val detail = remoteApi.remoteItem(libraryId, itemId)
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

  fun openCanonical(canonical: GlobalSearchCanonicalDto) {
    if (canonical.type != "movie" && canonical.type != "series") return
    onOpenCatalog(
      CatalogDetailArgs(
        meta = MetaDto(id = canonical.id, type = canonical.type, name = canonical.name, poster = canonical.poster),
        addonName = "",
        type = canonical.type,
      ),
    )
  }

  fun openCluster(cluster: GlobalSearchClusterDto, anchor: String) {
    search.setFocusAnchor(anchor)
    scope.launch {
      val page = try { search.members(anchor, 0) } catch (_: Exception) { null }
      val canonical = page?.canonical
      val distinct = openableMembers(page?.members.orEmpty())
      when {
        canonicalTitles && canonical != null && (canonical.type == "movie" || canonical.type == "series") -> openCanonical(canonical)
        page != null && distinct.size == 1 && (page.nextFrom == null || cluster.kind == "series") -> openMember(distinct.first())
        else -> openChooser(cluster, anchor)
      }
    }
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
  LaunchedEffect(clearFocusSignal) {
    if (clearFocusSignal > 0) clearCardFocus()
  }
  LaunchedEffect(restoreToken) {
    if (restoreToken > 0) requestAnchor(state.focusAnchor)
  }

  val snapshot = state.snapshot
  val clustersByKey = snapshot?.clusters.orEmpty().associateBy { it.key }
  val cards = state.order.mapNotNull(clustersByKey::get)
  val unidentifiedByKey = snapshot?.unidentified.orEmpty().associateBy { it.key }
  val unidentifiedCards = state.unidentifiedOrder.mapNotNull(unidentifiedByKey::get)

  Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
          onLoadMore = search::loadMore,
          onFocusCard = { anchor, index ->
            focusedAnchor = anchor
            focusedIndex = index
            search.setFocusAnchor(anchor)
          },
          onClearFocus = ::clearCardFocus,
          onOpen = ::openCluster,
          imageUrl = imageUrl,
          firstRowUp = firstRowUp,
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
    search.loadMore()
  }

  val openChooserState = chooser
  if (openChooserState != null) {
    GlobalSearchMemberPanel(
      title = openChooserState.title,
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
}

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
  firstRowUp: FocusRequester?,
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
        GlobalSearchResultCard(
          cluster = cluster,
          focusAnchor = focusAnchor,
          imageUrl = imageUrl,
          hasMore = hasMore,
          columns = columns,
          index = index,
          cardCount = cards.size,
          snapshotRevision = snapshotRevision,
          lastLoadRevision = lastLoadRevision,
          onLoadRevision = onLoadRevision,
          onLoadMore = onLoadMore,
          onFocus = { anchor ->
            onFocusCard(anchor, index)
          },
          onOpen = onOpen,
          cardFocus = cardFocus,
          firstRowUp = firstRowUp.takeIf { index == 0 },
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
          GlobalSearchResultCard(
            cluster = cluster,
            focusAnchor = focusAnchor,
            imageUrl = imageUrl,
            hasMore = false,
            columns = columns,
            index = index + cards.size,
            cardCount = cards.size + unidentified.size,
            snapshotRevision = snapshotRevision,
            lastLoadRevision = lastLoadRevision,
            onLoadRevision = onLoadRevision,
            onLoadMore = onLoadMore,
            onFocus = { anchor -> onFocusCard(anchor, index + cards.size) },
            onOpen = onOpen,
            cardFocus = cardFocus,
            firstRowUp = null,
          )
        }
      }
    }
  }
}

@Composable
private fun GlobalSearchResultCard(
  cluster: GlobalSearchClusterDto,
  focusAnchor: String?,
  imageUrl: (String?) -> String?,
  hasMore: Boolean,
  columns: Int,
  index: Int,
  cardCount: Int,
  snapshotRevision: Int,
  lastLoadRevision: Int,
  onLoadRevision: (Int) -> Unit,
  onLoadMore: () -> Unit,
  onFocus: (String) -> Unit,
  onOpen: (GlobalSearchClusterDto, String) -> Unit,
  cardFocus: MutableMap<String, FocusRequester>,
  firstRowUp: FocusRequester?,
) {
  val anchor = globalSearchAnchor(cluster, focusAnchor)
  val requester = remember(anchor) { FocusRequester() }
  cardFocus[anchor] = requester
  GlobalSearchCard(
    cluster = cluster,
    anchor = anchor,
    imageUrl = imageUrl,
    onFocus = {
      onFocus(anchor)
      if (hasMore && index >= cardCount - columns && lastLoadRevision != snapshotRevision) {
        onLoadRevision(snapshotRevision)
        onLoadMore()
      }
    },
    onClick = { onOpen(cluster, anchor) },
    modifier = Modifier
      .focusRequester(requester)
      .then(if (firstRowUp != null) Modifier.focusProperties { up = firstRowUp } else Modifier),
  )
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
    cluster.itemCount?.takeIf { it > 0 }?.let {
      Text(
        pluralStringResource(R.plurals.tv_global_search_folder_items, it, it),
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
  onOpenCanonical: (GlobalSearchCanonicalDto) -> Unit,
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
private fun memberLabel(member: GlobalSearchMemberDto): String =
  stringResource(R.string.tv_global_search_member_label, addonLabel(member), member.title)

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
