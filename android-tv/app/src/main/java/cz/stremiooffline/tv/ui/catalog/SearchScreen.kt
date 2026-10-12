package cz.stremiooffline.tv.ui.catalog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.components.leftToNeighbour
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame

const val TagSearchField = "search_field"
const val TagSearchInput = "search_input"
const val TagSearchRetry = "search_retry"
const val TagSearchScopeChip = "search_scope_chip"
const val TagSearchVoice = "search_voice"
const val TagSearchScopePanel = "search_scope_panel"
const val TagSearchScopeAll = "search_scope_all"

fun scopeHeaderTag(addonKey: String): String = "search_scope_header_$addonKey"
fun scopeAddonTag(addonKey: String): String = "search_scope_addon_$addonKey"
fun scopeCatalogTag(type: String, id: String): String = "search_scope_catalog_$type:$id"

@Composable
fun SearchScreen(
  api: TvApi,
  /** Where the query looks; the shell remembers it so the rail returns to the last used one. */
  scope: SearchScope,
  onScopeChange: (SearchScope) -> Unit,
  onOpenDetail: (CatalogDetailArgs) -> Unit,
  imageUrl: (String?) -> String?,
  modifier: Modifier = Modifier,
  /** Back to the catalogue when Search was opened from its Hledat chip. */
  onBackToCatalog: (() -> Unit)? = null,
  /** Whether a recognizer answers here; the mic button and the remote's mic key follow it. */
  voiceAvailable: Boolean = voiceSearchAvailable(),
  /** Test seam: answers a mic press without a device. Null asks the platform recognizer. */
  voiceLauncher: VoiceLauncher? = null,
) {
  val viewModel = viewModel<SearchViewModel>(factory = SearchViewModel.factory(api))
  val state = viewModel.state
  var text by rememberSaveable { mutableStateOf("") }
  val fieldFocus = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }
  val scopeFocus = remember { FocusRequester() }
  val panelEntry = remember { FocusRequester() }
  var scopePanel by remember { mutableStateOf(false) }
  var panelOpener by remember { mutableStateOf<FocusRequester?>(null) }

  // Search is everywhere, so an item carries its own addon name for the detail's eyebrow.
  fun open(item: cz.stremiooffline.tv.data.MetaDto) =
    onOpenDetail(CatalogDetailArgs(item, item.addonName.orEmpty(), item.type ?: "movie"))

  // A heard query is a typed one: the field shows it and the same submit runs, so whatever a
  // submit records it records here too.
  fun onVoice(spoken: String) {
    val query = spoken.trim()
    if (query.isEmpty()) return
    text = query
    viewModel.submit(query)
  }

  val voice = rememberVoiceSearch(voiceAvailable, onVoiceResult = ::onVoice, launcher = voiceLauncher)

  // Registered before the panel's own handler, so Back closes the panel first and
  // only returns to the catalogue when nothing is over the screen.
  if (onBackToCatalog != null) BackHandler { onBackToCatalog() }
  LaunchedEffect(scope) { viewModel.setScope(scope) }
  LaunchedEffect(scopePanel) { if (!scopePanel) runCatching { panelOpener?.requestFocus() } }
  LaunchedEffect(Unit) { runCatching { fieldFocus.requestFocus() } }

  Column(
    modifier = modifier
      .fillMaxSize()
      .padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX)
      .voiceKey(voice),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(
      stringResource(R.string.tv_nav_search).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    // Both controls carry a label of the same kind and share the field's height, so the scope sits on
    // the field's line instead of floating between the label and the field.
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
      TvTextField(
        label = stringResource(R.string.tv_nav_search),
        value = text,
        onValueChange = { text = it },
        imeAction = ImeAction.Done,
        surfaceRequester = fieldFocus,
        testTag = TagSearchField,
        inputTestTag = TagSearchInput,
        onSubmit = { viewModel.submit(text) },
        modifier = Modifier.width(430.dp),
      )
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
          stringResource(R.string.catalog_search_scope).uppercase(),
          color = Tokens.Muted,
          fontSize = 8.5.sp,
          fontWeight = FontWeight.ExtraBold,
          letterSpacing = 0.8.sp,
        )
        FocusButton(
          text = scopeLabel(state.scope, state.searchable),
          onClick = { viewModel.refreshSearchable(); panelOpener = scopeFocus; scopePanel = true },
          contentDescription = stringResource(R.string.catalog_search_scope),
          labelMaxWidth = 300.dp,
          modifier = Modifier
            .height(38.dp)
            .focusRequester(scopeFocus)
            .testTag(TagSearchScopeChip)
            .leftToNeighbour(fieldFocus),
        )
      }
      // The mic is the row's last stop: LEFT walks back to the chip the same way the chip walks
      // back to the field, because the shell's LEFT exit would otherwise send it to the rail.
      if (voice.available) {
        FocusButton(
          text = stringResource(R.string.tv_voice_search),
          onClick = voice.start,
          leading = { Icon(MicIcon, contentDescription = null, modifier = Modifier.size(16.dp)) },
          contentDescription = stringResource(R.string.tv_voice_search),
          labelMaxWidth = 240.dp,
          modifier = Modifier
            .height(38.dp)
            .testTag(TagSearchVoice)
            .leftToNeighbour(scopeFocus),
        )
      }
    }
    if (!state.submitted) {
      Text(stringResource(R.string.tv_search_hint), color = Tokens.Muted, fontSize = 12.sp)
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.submitted && state.loading -> ShimmerCards()
        state.submitted && state.error -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.tv_load_error), color = Tokens.Muted, fontSize = 12.sp)
            FocusButton(
              text = stringResource(R.string.tv_try_again),
              onClick = { viewModel.retry() },
              kind = FocusButtonKind.Primary,
              modifier = Modifier.testTag(TagSearchRetry),
            )
          }
        }
        state.submitted -> PosterGrid(
          items = state.items,
          imageUrl = imageUrl,
          onOpen = { open(it) },
          onNearEnd = { viewModel.loadMore() },
          gridFocus = gridFocus,
          modifier = Modifier.fillMaxSize(),
        )
      }
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
        onScopeChange(picked)
        scopePanel = false
      },
      onClose = { scopePanel = false },
      initialFocus = panelEntry,
    )
  }
}

/** One catalogue chip label: every addon, one addon's name, or its catalogue with its type. */
@Composable
private fun scopeLabel(scope: SearchScope, searchable: List<SearchableCatalogDto>): String {
  if (scope.addonKey.isNullOrEmpty()) return stringResource(R.string.catalog_all_addons)
  val addonName = searchable.firstOrNull { it.addonKey == scope.addonKey }?.addonName ?: scope.addonKey
  if (scope.catalogId.isNullOrEmpty()) return addonName
  val catalog = searchable.firstOrNull { it.addonKey == scope.addonKey && it.type == scope.catalogType && it.id == scope.catalogId }
  return if (catalog != null) "${catalog.addonName} · ${catalog.name} (${typeTag(catalog.type)})"
  else "$addonName · ${scope.catalogId}"
}

/** The web's `typeTag`: the catalogue type in words, or the raw value when it knows neither. */
@Composable
private fun typeTag(type: String): String = when (type) {
  "movie" -> stringResource(R.string.catalog_type_movie)
  "series" -> stringResource(R.string.catalog_type_series)
  else -> type
}

private sealed interface ScopeRow {
  val selected: Boolean

  data class AllAddons(override val selected: Boolean) : ScopeRow
  data class GroupHeader(val addonKey: String, val name: String, val globalSearch: Boolean) : ScopeRow {
    override val selected: Boolean get() = false
  }
  data class AddonAll(val addonKey: String, val globalSearch: Boolean, override val selected: Boolean) : ScopeRow
  data class Catalog(
    val addonKey: String,
    val type: String,
    val id: String,
    val name: String,
    val globalSearch: Boolean,
    override val selected: Boolean,
  ) : ScopeRow
}

/** The web's `<optgroup>` tree flattened for a TV list: every addon, then its "All catalogs"
 *  row and its catalogues. */
private fun scopeRows(searchable: List<SearchableCatalogDto>, scope: SearchScope): List<ScopeRow> {
  val rows = mutableListOf<ScopeRow>(ScopeRow.AllAddons(scope.addonKey.isNullOrEmpty()))
  val groups = LinkedHashMap<String, MutableList<SearchableCatalogDto>>()
  for (item in searchable) groups.getOrPut(item.addonKey) { mutableListOf() } += item
  for ((key, items) in groups) {
    val first = items.first()
    rows += ScopeRow.GroupHeader(key, first.addonName, first.globalSearch)
    rows += ScopeRow.AddonAll(key, first.globalSearch, scope.addonKey == key && scope.catalogId.isNullOrEmpty())
    for (item in items) {
      rows += ScopeRow.Catalog(
        addonKey = key,
        type = item.type,
        id = item.id,
        name = item.name,
        globalSearch = first.globalSearch,
        selected = scope.addonKey == key && scope.catalogType == item.type && scope.catalogId == item.id,
      )
    }
  }
  return rows
}

private fun scopeRowKey(row: ScopeRow): String = when (row) {
  is ScopeRow.AllAddons -> "all"
  is ScopeRow.GroupHeader -> "group:${row.addonKey}"
  is ScopeRow.AddonAll -> "addon:${row.addonKey}"
  is ScopeRow.Catalog -> "catalog:${row.addonKey}:${row.type}:${row.id}"
}

@Composable
private fun SearchScopePanel(
  rows: List<ScopeRow>,
  focusIndex: Int,
  onPick: (SearchScope) -> Unit,
  onClose: () -> Unit,
  initialFocus: FocusRequester,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  val entry = focusIndex.coerceIn(0, maxOf(0, rows.size - 1))
  LaunchedEffect(rows) {
    runCatching { listState.scrollToItem(entry) }
    awaitFrame()
    runCatching { initialFocus.requestFocus() }
  }
  val allAddonsText = stringResource(R.string.catalog_all_addons)
  val allCatalogsText = stringResource(R.string.catalog_all_catalogs)
  val onlyWhenPickedText = stringResource(R.string.catalog_only_when_picked)
  SidePanel(
    title = stringResource(R.string.catalog_search_scope),
    onClose = onClose,
    modifier = modifier.testTag(TagSearchScopePanel),
    initialFocus = initialFocus,
    scroll = false,
  ) {
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      itemsIndexed(rows, key = { _, row -> scopeRowKey(row) }) { index, row ->
        val entryModifier = if (index == entry) Modifier.focusRequester(initialFocus) else Modifier
        when (row) {
          is ScopeRow.AllAddons -> PanelOption(
            text = allAddonsText,
            selected = row.selected,
            onClick = { onPick(SearchScope()) },
            modifier = Modifier.testTag(TagSearchScopeAll).then(entryModifier),
          )
          is ScopeRow.GroupHeader -> ScopeGroupHeader(
            name = row.name + if (row.globalSearch) "" else " ·",
            note = if (row.globalSearch) null else onlyWhenPickedText,
            modifier = Modifier.testTag(scopeHeaderTag(row.addonKey)),
          )
          is ScopeRow.AddonAll -> PanelOption(
            text = allCatalogsText + if (row.globalSearch) "" else " ·",
            selected = row.selected,
            onClick = { onPick(SearchScope(addonKey = row.addonKey)) },
            modifier = Modifier.testTag(scopeAddonTag(row.addonKey)).then(entryModifier),
          )
          is ScopeRow.Catalog -> PanelOption(
            text = "${row.name} (${typeTag(row.type)})" + if (row.globalSearch) "" else " ·",
            selected = row.selected,
            onClick = { onPick(SearchScope(row.addonKey, row.type, row.id)) },
            modifier = Modifier.testTag(scopeCatalogTag(row.type, row.id)).then(entryModifier),
          )
        }
      }
    }
  }
}

/** A group heading inside the scope panel: the addon's name and, when only a picked addon is
 *  searched, the web's note. */
@Composable
private fun ScopeGroupHeader(name: String, note: String?, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
    Text(name, color = Tokens.Text, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    if (note != null) Text(note, color = Tokens.Muted, fontSize = 9.5.sp)
  }
}
