package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.AudioMode
import cz.stremiooffline.tv.data.BulkEpisodeDto
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.BulkOriginDto
import cz.stremiooffline.tv.data.BulkPrepareRequest
import cz.stremiooffline.tv.data.BulkPrepareResponse
import cz.stremiooffline.tv.data.BulkPreparedEpisodeDto
import cz.stremiooffline.tv.data.BulkRemoteOriginDto
import cz.stremiooffline.tv.data.DownloadProfileRefDto
import cz.stremiooffline.tv.data.DownloadSelectionDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.RuleSummaryPart
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.SourceProfilePolicyDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.data.formatRuleGigabytes
import cz.stremiooffline.tv.data.ruleSummaryParts
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.settings.inlineContentLanguageLabel
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagSeriesDownloadPanel = "series_download_panel"
const val TagSeriesDownloadSummary = "series_download_summary"
const val TagSeriesDownloadAdd = "series_download_add"
const val TagSeriesDownloadError = "series_download_error"
const val TagSeriesDownloadRules = "series_download_rules"
const val TagSeriesDownloadRulesUnavailable = "series_download_rules_unavailable"
const val TagSeriesDownloadLibrary = "series_download_library"
const val TagSeriesDownloadSource = "series_download_source"
const val TagSeriesDownloadSourceLibrary = "series_download_source_library"
const val TagSeriesDownloadSourceCatalogue = "series_download_source_catalogue"
const val TagSeriesDownloadSourceError = "series_download_source_error"
const val TagSeriesDownloadSpecials = "series_download_specials"
const val TagSeriesDownloadThisEpisode = "series_download_this_episode"
const val TagSeriesDownloadSkipped = "series_download_skipped"
const val TagSeriesDownloadSkippedBack = "series_download_skipped_back"
const val TagSeriesDownloadRetry = "series_download_retry"
const val TagSeriesDownloadIncomplete = "series_download_incomplete"

fun seriesScopeTag(scope: DownloadScope): String = "series_scope_${scope.name.lowercase()}"
fun seriesRuleTag(id: String): String = "series_rule_$id"
fun seriesLibraryTag(id: String): String = "series_library_$id"
fun seriesSeasonTag(season: Int): String = "series_season_$season"

private const val BALANCED_NAME_KEY = "rules.preset.balanced"

private enum class DownloadPanelScreen { Scope, Seasons, Settings, Source, Rules, Library, Skipped }

/**
 * The prepared series flow: the server decides statuses and remote identity, while every scope
 * switch is only a local filter of that answer.
 */
@Composable
internal fun SeriesDownloadPanel(
  api: TvApi,
  type: String,
  title: String,
  origin: BulkOrigin,
  selected: VideoDto?,
  settings: SettingsResponse,
  addons: List<AddonDto>,
  libraries: List<LibraryDto>,
  onQueued: (added: Int, skipped: Int) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
  /** A media-server series offers its selected episode first; that row hands off to the exact
   *  single-episode copy instead of a rules job. [thisEpisodeLabel] names the episode under it. */
  onThisEpisode: (() -> Unit)? = null,
  thisEpisodeLabel: String? = null,
) {
  val scope = rememberCoroutineScope()
  val remoteOrigin = origin as? BulkOrigin.Remote

  var screen by remember { mutableStateOf(DownloadPanelScreen.Scope) }
  var chosenScope by remember { mutableStateOf<DownloadScope?>(null) }
  var chosenSeason by remember { mutableStateOf<Int?>(null) }
  var includeSpecials by remember { mutableStateOf(false) }
  var openedScopeTag by remember { mutableStateOf<String?>(null) }

  var sourceProfiles by remember { mutableStateOf<List<SourceProfileDto>>(emptyList()) }
  var rulesLoaded by remember { mutableStateOf(false) }
  var rulesFailed by remember { mutableStateOf(false) }
  var chosenId by remember { mutableStateOf<String?>(null) }
  var ruleTouched by remember { mutableStateOf(false) }
  var chosenAddons by remember { mutableStateOf<List<String>>(emptyList()) }
  var sourceDefaultsLoaded by remember { mutableStateOf(false) }
  var sourceDefaultsInitialized by remember { mutableStateOf(false) }
  var sourceDefaultsVideoId by remember { mutableStateOf<String?>(null) }

  var pickedLibrary by remember { mutableStateOf<String?>(null) }
  var prepared by remember { mutableStateOf<BulkPrepareResponse?>(null) }
  var preparing by remember { mutableStateOf(false) }
  var prepareFailure by remember { mutableStateOf<ApiError?>(null) }
  var prepareNonce by remember { mutableStateOf(0) }

  var useCatalogueSource by remember { mutableStateOf(false) }
  var catalogueOrigin by remember { mutableStateOf<BulkOrigin.Catalogue?>(null) }
  var catalogueId by remember { mutableStateOf<String?>(null) }
  var sourceLoading by remember { mutableStateOf(false) }
  var sourceFailure by remember { mutableStateOf<ApiError?>(null) }

  var posting by remember { mutableStateOf(false) }
  var done by remember { mutableStateOf(0) }
  var total by remember { mutableStateOf(0) }
  var queueFailure by remember { mutableStateOf<ApiError?>(null) }
  var failedAfterAdding by remember { mutableStateOf(0) }
  var restoreTo by remember { mutableStateOf<String?>(null) }

  val openingFocus = remember(screen) { FocusRequester() }
  val addFocus = remember { FocusRequester() }
  val rowFocuses = remember { mutableMapOf<String, FocusRequester>() }
  val skippedScroll = rememberScrollState()

  val currentOrigin = if (remoteOrigin != null && useCatalogueSource) catalogueOrigin ?: origin else origin
  val catalogueVideos = (currentOrigin as? BulkOrigin.Catalogue)?.videos.orEmpty()
  val sourceVideoId = selected?.id ?: catalogueVideos
    .filter { it.id != null && (it.season ?: 0) >= 1 && it.episode != null }
    .minWithOrNull(compareBy({ it.season }, { it.episode }))
    ?.id

  LaunchedEffect(sourceVideoId) {
    val id = sourceVideoId
    if (sourceDefaultsInitialized && sourceDefaultsVideoId == id) {
      sourceDefaultsLoaded = true
      return@LaunchedEffect
    }
    sourceDefaultsInitialized = true
    sourceDefaultsVideoId = id
    if (id == null) {
      chosenAddons = emptyList()
      sourceDefaultsLoaded = true
      return@LaunchedEffect
    }
    sourceDefaultsLoaded = false
    chosenAddons = try {
      api.streamSources(type, id).map { it.key }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      emptyList()
    }
    sourceDefaultsLoaded = true
  }

  LaunchedEffect(Unit) {
    try {
      val loaded = api.sourceProfiles()
      sourceProfiles = loaded
      if (!ruleTouched) chosenId = defaultOfferedRuleId(loaded, settings.downloadSourceProfile)
      rulesLoaded = true
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      rulesFailed = true
      rulesLoaded = true
    }
  }

  val offered = sourceProfiles.filter(::isOfferedRule)
  val selectedRule = offered.firstOrNull { it.id == chosenId }
  val unavailable = rulesFailed || (rulesLoaded && offered.isEmpty())
  val writableLibraries = libraries.filter { it.canWrite && (it.type == type || it.type == "mixed") }
  val addonRuleLibrary = addons.firstOrNull { it.key == chosenAddons.firstOrNull() }
    ?.downloadSettings?.series?.libraryId?.takeIf { it.isNotBlank() }
  val preferredLibrary = addonRuleLibrary?.takeIf { id -> writableLibraries.any { it.id == id } }
    ?: writableLibraries.firstOrNull { it.defaultSeries }?.id
    ?: writableLibraries.firstOrNull()?.id
  val selectedLibrary = pickedLibrary?.takeIf { id -> writableLibraries.any { it.id == id } }
  val requestTarget = selectedLibrary ?: if (currentOrigin is BulkOrigin.Catalogue) preferredLibrary else null
  val libraryName = writableLibraries.firstOrNull { it.id == requestTarget }?.name
    ?: prepared?.target?.libraryName
    ?: stringResource(R.string.save_target_default_library)

  LaunchedEffect(
    currentOrigin,
    selectedRule?.id,
    selectedRule?.revision,
    requestTarget,
    sourceDefaultsLoaded,
    prepareNonce,
  ) {
    val rule = selectedRule
    if (rule == null || !sourceDefaultsLoaded) {
      preparing = false
      if (rule != null) prepared = null
      return@LaunchedEffect
    }
    prepared = null
    catalogueId = null
    prepareFailure = null
    preparing = true
    try {
      val response = api.prepareBulk(
        BulkPrepareRequest(
          scope = "series",
          specials = true,
          title = title,
          selection = DownloadSelectionDto(profile = DownloadProfileRefDto(rule.id, rule.revision)),
          target = requestTarget?.let(::DownloadTargetDto),
          origin = when (val current = currentOrigin) {
            is BulkOrigin.Catalogue -> BulkOriginDto.catalogue(
              media = current.media,
              episodes = current.videos.mapNotNull { video ->
                video.id?.let { id ->
                  BulkEpisodeDto(
                    id = id,
                    season = video.season,
                    episode = video.episode,
                    title = video.title ?: video.name,
                    released = video.released,
                  )
                }
              },
            )
            is BulkOrigin.Remote -> BulkOriginDto.remote(current.libraryId, current.seriesItemId)
          },
        ),
      )
      prepared = response
      catalogueId = response.series.catalogueId
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (failure: ApiError) {
      if (!posting) prepareFailure = failure
    } finally {
      preparing = false
    }
  }

  val preparedEpisodes = prepared?.episodes.orEmpty()
  val selectedPrepared = selected?.let { video -> preparedEpisodes.firstOrNull { it.id == video.id } }
  val seasons = preparedEpisodes.mapNotNull { episode -> episode.season }
    .filter { it >= 1 }
    .distinct()
    .sorted()

  LaunchedEffect(prepared, chosenScope, chosenSeason) {
    if (chosenScope == DownloadScope.Season && chosenSeason == null) {
      chosenSeason = selected?.season?.takeIf { it >= 1 } ?: seasons.firstOrNull()
    }
  }

  val scopedEpisodes: List<BulkPreparedEpisodeDto> = when (val picked = chosenScope) {
    null -> emptyList()
    DownloadScope.Episode -> preparedScopeEpisodes(preparedEpisodes, picked, selectedPrepared)
    DownloadScope.Season -> preparedScopeEpisodes(preparedEpisodes, picked, season = chosenSeason)
    DownloadScope.FromEpisode -> preparedScopeEpisodes(preparedEpisodes, picked, selectedPrepared)
    DownloadScope.All -> preparedScopeEpisodes(preparedEpisodes, picked, includeSpecials = includeSpecials)
  }
  val ready = preparedReadyEpisodes(scopedEpisodes)
  val skipped = scopedEpisodes.filter { it.status != "ready" }
  val complete = prepared?.listing?.complete == true

  val counts = mapOf(
    "ready" to ready.size,
    "inTarget" to scopedEpisodes.count { it.status == "inTarget" },
    "queued" to scopedEpisodes.count { it.status == "queued" },
    "unreleased" to scopedEpisodes.count { it.status == "unreleased" },
    "unnumbered" to scopedEpisodes.count { it.status == "unnumbered" || it.status == "invalid" },
  )
  val sourceNames = stringResource(
    R.string.series_bulk_from_library,
    remoteOrigin?.provider?.replaceFirstChar { it.uppercase() }.orEmpty(),
    remoteOrigin?.libraryName.orEmpty(),
  )
  val sourceValue = if (useCatalogueSource) {
    stringResource(R.string.series_bulk_from_catalogue)
  } else {
    stringResource(R.string.series_bulk_from_library, remoteOrigin?.provider?.replaceFirstChar { it.uppercase() }.orEmpty(), remoteOrigin?.libraryName.orEmpty())
  }

  fun readyCount(scope: DownloadScope, season: Int? = chosenSeason, episode: BulkPreparedEpisodeDto? = selectedPrepared): Int =
    preparedReadyEpisodes(preparedScopeEpisodes(preparedEpisodes, scope, episode, season, includeSpecials)).size

  fun pickScope(picked: DownloadScope) {
    chosenScope = picked
    openedScopeTag = seriesScopeTag(picked)
    restoreTo = null
    screen = DownloadPanelScreen.Settings
  }

  fun openSeasonPicker() {
    chosenScope = DownloadScope.Season
    openedScopeTag = seriesScopeTag(DownloadScope.Season)
    restoreTo = null
    screen = DownloadPanelScreen.Seasons
  }

  fun chooseSeason(season: Int) {
    chosenSeason = season
    chosenScope = DownloadScope.Season
    restoreTo = seriesScopeTag(DownloadScope.Season)
    screen = DownloadPanelScreen.Settings
  }

  fun openCatalogueSource() {
    val id = catalogueId ?: return
    catalogueOrigin?.let {
      useCatalogueSource = true
      sourceFailure = null
      restoreTo = TagSeriesDownloadSource
      screen = DownloadPanelScreen.Settings
      return
    }
    if (sourceLoading) return
    sourceLoading = true
    sourceFailure = null
    scope.launch {
      try {
        val meta = api.meta("series", id, settings.uiLanguage)
        val videos = meta.videos.orEmpty()
        val sourceVideoId = selected?.id ?: videos
          .filter { it.id != null && (it.season ?: 0) >= 1 && it.episode != null }
          .minWithOrNull(compareBy({ it.season }, { it.episode }))
          ?.id
        val addons = sourceVideoId?.let { videoId ->
          try {
            api.streamSources(type, videoId).map { it.key }
          } catch (cancelled: CancellationException) {
            throw cancelled
          } catch (_: ApiError) {
            emptyList()
          }
        }.orEmpty()
        val media = BulkMediaDto(
          id = meta.id.ifBlank { id },
          metaType = "series",
          poster = meta.poster,
          background = meta.background ?: meta.poster,
        )
        chosenAddons = addons
        sourceDefaultsVideoId = sourceVideoId
        sourceDefaultsInitialized = true
        sourceDefaultsLoaded = true
        catalogueOrigin = BulkOrigin.Catalogue(videos, media)
        useCatalogueSource = true
        restoreTo = TagSeriesDownloadSource
        screen = DownloadPanelScreen.Settings
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: ApiError) {
        sourceFailure = failure
      } finally {
        sourceLoading = false
      }
    }
  }

  fun submit() {
    val rule = selectedRule ?: return
    if (posting || !complete || ready.isEmpty()) return
    posting = true
    queueFailure = null
    failedAfterAdding = 0
    done = 0
    total = ready.size
    val remoteLibrarySource = remoteOrigin != null && !useCatalogueSource
    val currentCatalogue = currentOrigin as? BulkOrigin.Catalogue
    val selection = DownloadSelectionDto(profile = DownloadProfileRefDto(rule.id, rule.revision))
    scope.launch {
      var added = 0
      var skippedCount = 0
      try {
        for (batch in batches(ready)) {
          val response = api.downloadBulk(
            title = prepared?.series?.title ?: title,
            type = type,
            episodes = batch.map {
              BulkEpisodeDto(
                id = it.id,
                season = it.season,
                episode = it.episode,
                title = it.title,
                remoteItemId = it.remoteItemId.takeIf { remoteLibrarySource },
              )
            },
            selection = selection,
            media = currentCatalogue?.media ?: BulkMediaDto(
              id = remoteOrigin?.seriesItemId,
              metaType = "series",
            ),
            target = requestTarget?.let(::DownloadTargetDto),
            origin = if (remoteLibrarySource) {
              BulkRemoteOriginDto.remote(remoteOrigin.libraryId, remoteOrigin.seriesItemId)
            } else {
              null
            },
          )
          added += response.added
          skippedCount += response.skipped
          done += batch.size
        }
        onQueued(added, skippedCount)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: ApiError) {
        queueFailure = failure
        failedAfterAdding = added
      } finally {
        posting = false
      }
    }
  }

  fun goBack() {
    when (screen) {
      DownloadPanelScreen.Scope -> {
        onClose()
        return
      }
      DownloadPanelScreen.Settings -> {
        restoreTo = openedScopeTag
        screen = DownloadPanelScreen.Scope
      }
      DownloadPanelScreen.Seasons -> {
        restoreTo = seriesScopeTag(DownloadScope.Season)
        screen = DownloadPanelScreen.Scope
      }
      DownloadPanelScreen.Source -> {
        restoreTo = TagSeriesDownloadSource
        screen = DownloadPanelScreen.Settings
      }
      DownloadPanelScreen.Rules -> {
        restoreTo = TagSeriesDownloadRules
        screen = DownloadPanelScreen.Settings
      }
      DownloadPanelScreen.Library -> {
        restoreTo = TagSeriesDownloadLibrary
        screen = DownloadPanelScreen.Settings
      }
      DownloadPanelScreen.Skipped -> {
        restoreTo = TagSeriesDownloadSkipped
        screen = DownloadPanelScreen.Settings
      }
    }
  }

  val prepareError = prepareFailure?.let { apiErrorText(it) }
  val sourceError = sourceFailure?.let { apiErrorText(it) }
  val queueError = queueFailure?.let { apiErrorText(it) }?.let { message ->
    if (failedAfterAdding > 0) {
      message + " " + pluralStringResource(
        R.plurals.series_bulk_partly_added,
        failedAfterAdding,
        failedAfterAdding,
      )
    } else {
      message
    }
  }

  LaunchedEffect(screen) {
    awaitFrame()
    awaitFrame()
    val restore = restoreTo
    restoreTo = null
    val target = restore?.let { rowFocuses[it] ?: openingFocus } ?: openingFocus
    runCatching { target.requestFocus() }
  }

  LaunchedEffect(posting) {
    if (!posting) return@LaunchedEffect
    awaitFrame()
    runCatching { (rowFocuses[TagSeriesDownloadLibrary] ?: openingFocus).requestFocus() }
  }

  SidePanel(
    title = when (screen) {
      DownloadPanelScreen.Scope -> stringResource(R.string.tv_download_which_episodes)
      DownloadPanelScreen.Seasons -> stringResource(R.string.tv_series_bulk_seasons_title)
      DownloadPanelScreen.Settings -> stringResource(R.string.tv_download_settings)
      DownloadPanelScreen.Source -> stringResource(R.string.series_bulk_source)
      DownloadPanelScreen.Rules -> stringResource(R.string.rules_title)
      DownloadPanelScreen.Library -> stringResource(R.string.nav_library)
      DownloadPanelScreen.Skipped -> stringResource(R.string.tv_series_bulk_skipped_row, skipped.size)
    },
    onClose = ::goBack,
    modifier = modifier.testTag(TagSeriesDownloadPanel),
    initialFocus = openingFocus,
    scrollState = skippedScroll.takeIf { screen == DownloadPanelScreen.Skipped },
  ) {
    when (screen) {
      DownloadPanelScreen.Scope -> ScopeRows(
        catalogueWithEpisode = origin is BulkOrigin.Catalogue && selected != null,
        selected = selected,
        prepared = prepared != null && !preparing,
        preparing = preparing || !rulesLoaded || !sourceDefaultsLoaded,
        ready = { scope, season, episode -> readyCount(scope, season, episode) },
        includeSpecials = includeSpecials,
        hasSpecials = preparedEpisodes.any { it.season == 0 },
        onScope = ::pickScope,
        onSeasons = ::openSeasonPicker,
        onSpecials = { includeSpecials = !includeSpecials },
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onThisEpisode = onThisEpisode,
        thisEpisodeLabel = thisEpisodeLabel,
      )
      DownloadPanelScreen.Seasons -> SeasonRows(
        seasons = seasons,
        ready = { season -> preparedReadyEpisodes(preparedScopeEpisodes(preparedEpisodes, DownloadScope.Season, season = season)).size },
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = ::chooseSeason,
      )
      DownloadPanelScreen.Settings -> SettingsRows(
        rowFocuses = rowFocuses,
        openingFocus = openingFocus,
        summary = when {
          unavailable -> stringResource(R.string.series_bulk_nothing)
          preparing || prepared == null -> stringResource(
            if (prepareError == null) R.string.series_bulk_preparing else R.string.series_bulk_nothing,
          )
          counts.getValue("ready") == 0 -> stringResource(R.string.series_bulk_nothing)
          else -> buildList {
            add(pluralStringResource(R.plurals.series_bulk_ready, counts.getValue("ready"), counts.getValue("ready")))
            if (counts.getValue("inTarget") > 0) {
              add(stringResource(R.string.series_bulk_in_target, counts.getValue("inTarget")))
            }
            if (counts.getValue("queued") > 0) {
              add(stringResource(R.string.series_bulk_queued, counts.getValue("queued")))
            }
            if (counts.getValue("unreleased") > 0) {
              add(stringResource(R.string.series_bulk_unreleased, counts.getValue("unreleased")))
            }
            if (counts.getValue("unnumbered") > 0) {
              add(stringResource(R.string.series_bulk_unnumbered, counts.getValue("unnumbered")))
            }
          }.joinToString(" · ")
        },
        sourcesLater = stringResource(R.string.series_bulk_sources_later),
        sourceValue = sourceValue.takeIf { remoteOrigin != null && catalogueId != null },
        libraryValue = libraryName,
        rulesName = if (offered.isNotEmpty()) selectedRule?.let { ruleName(it) }.orEmpty() else null,
        unavailable = unavailable,
        incomplete = prepared != null && !complete,
        prepareError = prepareError,
        sourceError = sourceError,
        skippedCount = skipped.size,
        posting = posting,
        readyCount = ready.size,
        done = done,
        total = total,
        canSubmit = complete && ready.isNotEmpty() && !posting && !preparing,
        error = queueError,
        addFocus = addFocus,
        onRetry = { prepareNonce += 1 },
        onOpen = { restoreTo = it.second; screen = it.first },
        onOpenSkipped = { restoreTo = TagSeriesDownloadSkipped; screen = DownloadPanelScreen.Skipped },
        onSubmit = ::submit,
      )
      DownloadPanelScreen.Source -> SourceRows(
        catalogue = useCatalogueSource,
        sourceNames = sourceNames,
        loading = sourceLoading,
        error = sourceError,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onLibrary = {
          useCatalogueSource = false
          sourceFailure = null
          restoreTo = TagSeriesDownloadSource
          screen = DownloadPanelScreen.Settings
        },
        onCatalogue = ::openCatalogueSource,
      )
      DownloadPanelScreen.Rules -> RuleRows(
        chosenId = chosenId,
        profiles = offered,
        uiLanguage = settings.uiLanguage,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { id ->
          ruleTouched = true
          chosenId = id
          restoreTo = TagSeriesDownloadRules
          screen = DownloadPanelScreen.Settings
        },
      )
      DownloadPanelScreen.Library -> LibraryRows(
        writableLibraries = writableLibraries,
        targetLibrary = requestTarget,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { pickedLibrary = it },
      )
      DownloadPanelScreen.Skipped -> SkippedRows(
        skipped = skipped,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        scrollState = skippedScroll,
        onBack = ::goBack,
      )
    }
  }
}

@Composable
private fun apiErrorText(error: ApiError): String = when (error.messageKey) {
  "err.bulkRemoteNotInRules" -> stringResource(R.string.err_bulk_remote_not_in_rules)
  else -> error.serverMessage
}
  ?: stringResource(if (error.failure == ApiFailure.Forbidden) R.string.err_download_library_not_allowed else R.string.tv_err_generic)

/** Level one: one prepared answer, filtered locally for each way of picking episodes. */
@Composable
private fun ColumnScope.ScopeRows(
  catalogueWithEpisode: Boolean,
  selected: VideoDto?,
  prepared: Boolean,
  preparing: Boolean,
  ready: (DownloadScope, Int?, BulkPreparedEpisodeDto?) -> Int,
  includeSpecials: Boolean,
  hasSpecials: Boolean,
  onScope: (DownloadScope) -> Unit,
  onSeasons: () -> Unit,
  onSpecials: () -> Unit,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onThisEpisode: (() -> Unit)? = null,
  thisEpisodeLabel: String? = null,
) {
  val selectedPrepared = selected?.let {
    BulkPreparedEpisodeDto(
      id = it.id.orEmpty(),
      season = it.season,
      episode = it.episode,
      status = "ready",
    )
  }
  val preparingText = stringResource(R.string.series_bulk_preparing).takeIf { preparing }
  var first = true
  fun rowText(label: String, scope: DownloadScope, season: Int? = selected?.season, episode: BulkPreparedEpisodeDto? = selectedPrepared): String =
    if (prepared) "$label · ${ready(scope, season, episode)}" else label

  if (catalogueWithEpisode) {
    listOf(DownloadScope.Episode, DownloadScope.Season, DownloadScope.FromEpisode, DownloadScope.All).forEach { picked ->
      val label = when (picked) {
        DownloadScope.Episode -> stringResource(R.string.tv_download_this_episode)
        DownloadScope.Season -> stringResource(R.string.tv_download_this_season, (selected?.season ?: 0).toString())
        DownloadScope.FromEpisode -> stringResource(R.string.tv_download_from_episode)
        DownloadScope.All -> stringResource(R.string.tv_download_all_episodes)
      }
      PanelOption(
        text = rowText(label, picked),
        supportingText = preparingText,
        onClick = { onScope(picked) },
        modifier = Modifier.panelRow(rowFocuses, seriesScopeTag(picked), first = first, opening = openingFocus),
      )
      first = false
    }
  } else {
    if (onThisEpisode != null) {
      PanelOption(
        text = stringResource(R.string.tv_download_this_episode),
        supportingText = thisEpisodeLabel,
        onClick = onThisEpisode,
        modifier = Modifier.panelRow(rowFocuses, TagSeriesDownloadThisEpisode, first = true, opening = openingFocus),
      )
      first = false
    }
    val seasonsText = if (prepared) {
      stringResource(R.string.tv_series_bulk_season_picker) + " · " +
        ready(DownloadScope.All, null, null)
    } else {
      stringResource(R.string.tv_series_bulk_season_picker)
    }
    PanelOption(
      text = seasonsText,
      supportingText = preparingText,
      onClick = onSeasons,
      modifier = Modifier.panelRow(rowFocuses, seriesScopeTag(DownloadScope.Season), first = first, opening = openingFocus),
    )
    first = false
    val allText = if (prepared) {
      stringResource(R.string.series_bulk_whole_series) + " · " +
        ready(DownloadScope.All, null, null)
    } else {
      stringResource(R.string.series_bulk_whole_series)
    }
    PanelOption(
      text = allText,
      supportingText = preparingText,
      onClick = { onScope(DownloadScope.All) },
      modifier = Modifier.panelRow(rowFocuses, seriesScopeTag(DownloadScope.All), first = false, opening = null),
    )
  }
  if (hasSpecials) {
    val specialsText = if (prepared) {
      stringResource(R.string.episodes_specials) + " · " +
        ready(DownloadScope.Season, 0, null)
    } else {
      stringResource(R.string.episodes_specials)
    }
    PanelOption(
      text = specialsText,
      supportingText = preparingText,
      selected = includeSpecials,
      onClick = onSpecials,
      modifier = Modifier.panelRow(rowFocuses, TagSeriesDownloadSpecials, first = first, opening = null),
    )
  }
}

@Composable
private fun ColumnScope.SeasonRows(
  seasons: List<Int>,
  ready: (Int) -> Int,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (Int) -> Unit,
) {
  if (seasons.isEmpty()) {
    Text(
      stringResource(R.string.series_bulk_nothing),
      color = Tokens.Muted,
      fontSize = 11.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
    return
  }
  seasons.forEachIndexed { index, season ->
    PanelOption(
      text = stringResource(R.string.episodes_season_number, season.toString()) + " · " + ready(season),
      onClick = { onPick(season) },
      modifier = Modifier.panelRow(rowFocuses, seriesSeasonTag(season), first = index == 0, opening = openingFocus),
    )
  }
}

@Composable
private fun ColumnScope.SettingsRows(
  rowFocuses: MutableMap<String, FocusRequester>,
  openingFocus: FocusRequester,
  summary: String,
  sourcesLater: String,
  sourceValue: String?,
  libraryValue: String,
  rulesName: String?,
  unavailable: Boolean,
  incomplete: Boolean,
  prepareError: String?,
  sourceError: String?,
  skippedCount: Int,
  posting: Boolean,
  readyCount: Int,
  done: Int,
  total: Int,
  canSubmit: Boolean,
  error: String?,
  addFocus: FocusRequester,
  onRetry: () -> Unit,
  onOpen: (Pair<DownloadPanelScreen, String>) -> Unit,
  onOpenSkipped: () -> Unit,
  onSubmit: () -> Unit,
) {
  Text(
    summary,
    color = Tokens.Text,
    fontSize = 12.5.sp,
    fontWeight = FontWeight.Bold,
    maxLines = 1,
    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadSummary),
  )
  Text(
    sourcesLater,
    color = Tokens.Muted,
    fontSize = 11.sp,
    lineHeight = 16.sp,
    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
  )

  var first = true
  if (incomplete) {
    Text(
      stringResource(R.string.series_bulk_incomplete),
      color = Tokens.Red,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadIncomplete),
    )
    PanelOption(
      text = stringResource(R.string.tv_try_again),
      onClick = onRetry,
      modifier = Modifier.panelRow(rowFocuses, TagSeriesDownloadRetry, first = first, opening = openingFocus),
    )
    first = false
  }
  if (sourceValue != null) {
    SettingRow(
      stringResource(R.string.series_bulk_source),
      sourceValue,
      { onOpen(DownloadPanelScreen.Source to TagSeriesDownloadSource) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadSource, first = first, opening = openingFocus),
    )
    first = false
  }
  if (rulesName != null) {
    SettingRow(
      stringResource(R.string.rules_title),
      rulesName,
      { onOpen(DownloadPanelScreen.Rules to TagSeriesDownloadRules) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadRules, first = first, opening = openingFocus),
    )
    first = false
  } else if (unavailable) {
    Text(
      stringResource(R.string.rules_unavailable),
      color = Tokens.Text,
      fontSize = 12.5.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadRulesUnavailable),
    )
  }
  SettingRow(
    stringResource(R.string.nav_library),
    libraryValue,
    { onOpen(DownloadPanelScreen.Library to TagSeriesDownloadLibrary) },
    Modifier.panelRow(rowFocuses, TagSeriesDownloadLibrary, first = first, opening = openingFocus),
  )
  first = false
  if (skippedCount > 0) {
    PanelOption(
      text = stringResource(R.string.tv_series_bulk_skipped_row, skippedCount),
      onClick = onOpenSkipped,
      modifier = Modifier.panelRow(rowFocuses, TagSeriesDownloadSkipped, first = first, opening = openingFocus),
    )
    first = false
  }
  FocusButton(
    text = if (posting) {
      stringResource(R.string.series_bulk_adding, done, total)
    } else {
      pluralStringResource(R.plurals.series_bulk_add, readyCount, readyCount)
    },
    onClick = onSubmit,
    kind = FocusButtonKind.Primary,
    enabled = canSubmit,
    modifier = Modifier.fillMaxWidth().focusRequester(addFocus).testTag(TagSeriesDownloadAdd),
  )
  val shownError = listOfNotNull(error, prepareError, sourceError).joinToString(" ")
  if (shownError.isNotEmpty()) {
    Text(
      shownError,
      color = Tokens.Red,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadError),
    )
  }
}

@Composable
private fun ColumnScope.SourceRows(
  catalogue: Boolean,
  sourceNames: String,
  loading: Boolean,
  error: String?,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onLibrary: () -> Unit,
  onCatalogue: () -> Unit,
) {
  PanelOption(
    text = sourceNames,
    supportingText = stringResource(R.string.series_bulk_from_library_hint),
    selected = !catalogue,
    onClick = onLibrary,
    modifier = Modifier.panelRow(
      rowFocuses,
      TagSeriesDownloadSourceLibrary,
      first = true,
      opening = openingFocus,
    ),
  )
  PanelOption(
    text = stringResource(R.string.series_bulk_from_catalogue),
    supportingText = if (loading) {
      stringResource(R.string.series_bulk_preparing)
    } else {
      stringResource(R.string.series_bulk_from_catalogue_hint)
    },
    selected = catalogue,
    onClick = onCatalogue,
    modifier = Modifier.panelRow(
      rowFocuses,
      TagSeriesDownloadSourceCatalogue,
      first = false,
      opening = null,
    ),
  )
  if (error != null) {
    Text(
      error,
      color = Tokens.Red,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadSourceError),
    )
  }
}

@Composable
private fun ColumnScope.SkippedRows(
  skipped: List<BulkPreparedEpisodeDto>,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  scrollState: ScrollState,
  onBack: () -> Unit,
) {
  val scrollScope = rememberCoroutineScope()
  PanelOption(
    text = stringResource(R.string.tv_back),
    onClick = onBack,
    modifier = Modifier
      .panelRow(
        rowFocuses,
        TagSeriesDownloadSkippedBack,
        first = true,
        opening = openingFocus,
      )
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val delta = when (event.key) {
          Key.DirectionDown -> 160f
          Key.DirectionUp -> -160f
          else -> return@onPreviewKeyEvent false
        }
        scrollScope.launch {
          scrollState.animateScrollBy(delta)
        }
        true
      },
  )
  skipped.forEach { episode ->
    val code = if (episode.season != null && episode.episode != null) {
      "S${episode.season.toString().padStart(2, '0')}E${episode.episode.toString().padStart(2, '0')}"
    } else {
      ""
    }
    Text(
      listOfNotNull(code.takeIf { it.isNotEmpty() }, episode.title, skippedReason(episode)).joinToString(" · "),
      color = Tokens.Text,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
  }
}

@Composable
private fun skippedReason(episode: BulkPreparedEpisodeDto): String = when (episode.status) {
  "inTarget" -> stringResource(R.string.series_bulk_reason_in_target)
  "queued" -> stringResource(R.string.series_bulk_reason_queued)
  "unreleased" -> stringResource(R.string.series_bulk_reason_unreleased)
  else -> stringResource(R.string.series_bulk_reason_unnumbered)
}

/** The rules the server offers. Choosing one applies it and returns to the settings. */
@Composable
internal fun ColumnScope.RuleRows(
  chosenId: String?,
  profiles: List<SourceProfileDto>,
  uiLanguage: String?,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (String) -> Unit,
  openingId: String? = null,
  claimOpening: Boolean = true,
) {
  profiles.forEachIndexed { index, profile ->
    val opens = claimOpening && if (openingId == null) index == 0 else profile.id == openingId
    PanelOption(
      text = ruleName(profile),
      supportingText = ruleSummary(profile.policy, uiLanguage),
      selected = profile.id == chosenId,
      onClick = { onPick(profile.id) },
      modifier = Modifier.panelRow(
        rowFocuses,
        seriesRuleTag(profile.id),
        first = opens,
        opening = if (opens) openingFocus else null,
      ),
    )
  }
}

/** The libraries this account may write this title into, the addon default preselected. */
@Composable
internal fun ColumnScope.LibraryRows(
  writableLibraries: List<LibraryDto>,
  targetLibrary: String?,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (String) -> Unit,
) {
  if (writableLibraries.isEmpty()) {
    Text(
      stringResource(R.string.save_target_no_library),
      color = Tokens.Muted,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
    return
  }
  writableLibraries.forEachIndexed { index, library ->
    PanelOption(
      text = library.name,
      selected = library.id == targetLibrary,
      onClick = { onPick(library.id) },
      modifier = Modifier.panelRow(rowFocuses, seriesLibraryTag(library.id), first = index == 0, opening = openingFocus),
    )
  }
}

@Composable
internal fun SettingRow(text: String, value: String, onClick: () -> Unit, modifier: Modifier) {
  PanelOption(text = "$text · $value", onClick = onClick, modifier = modifier)
}

/** The tag, the row's own requester, and -- for the first row of a screen -- the opening one. */
internal fun Modifier.panelRow(
  focuses: MutableMap<String, FocusRequester>,
  tag: String,
  first: Boolean,
  opening: FocusRequester?,
): Modifier {
  val row = if (first && opening != null) opening else focuses.getOrPut(tag) { FocusRequester() }
  focuses[tag] = row
  return testTag(tag).focusRequester(row)
}

private fun presetLabel(nameKey: String?): Int? = when (nameKey) {
  BALANCED_NAME_KEY -> R.string.rules_preset_balanced
  "rules.preset.best" -> R.string.rules_preset_best
  "rules.preset.smaller" -> R.string.rules_preset_smaller
  "rules.preset.myLanguage" -> R.string.rules_preset_my_language
  else -> null
}

internal fun isOfferedRule(profile: SourceProfileDto): Boolean =
  "downloadToLibrary" in profile.operations &&
    (presetLabel(profile.nameKey) != null || !profile.name.isNullOrBlank())

/** The account's rule, then Balanced, then the first offered rule. */
internal fun defaultOfferedRuleId(profiles: List<SourceProfileDto>, remembered: String?): String? {
  val offered = profiles.filter(::isOfferedRule)
  return offered.firstOrNull { it.id == remembered }?.id
    ?: offered.firstOrNull { it.nameKey == BALANCED_NAME_KEY }?.id
    ?: offered.firstOrNull()?.id
}

@Composable
internal fun ruleName(profile: SourceProfileDto): String {
  val label = presetLabel(profile.nameKey)
  return if (label != null) stringResource(label) else profile.name.orEmpty()
}

/** `720p–1080p · prefer my language · up to ~4 GB per episode`, omitting a part the policy does not carry. */
@Composable
internal fun ruleSummary(policy: SourceProfilePolicyDto?, uiLanguage: String?): String? {
  val parts = ruleSummaryParts(policy)
  if (parts.isEmpty()) return null
  val locale = LocalConfiguration.current.locales[0]
  val texts = ArrayList<String>(parts.size)
  for (part in parts) {
    texts += when (part) {
      is RuleSummaryPart.Resolution -> when {
        part.min != null && part.max != null && part.min == part.max ->
          stringResource(R.string.rules_resolution_value, part.min.toString())
        part.min != null && part.max != null ->
          stringResource(R.string.rules_resolution_range, part.min.toString(), part.max.toString())
        part.min != null ->
          stringResource(R.string.rules_resolution_at_least, part.min.toString())
        else ->
          stringResource(R.string.rules_resolution_at_most, part.max?.toString().orEmpty())
      }
      is RuleSummaryPart.Audio -> when (part.mode) {
        AudioMode.ANY -> stringResource(R.string.rules_summary_any_language)
        AudioMode.PREFER -> if (part.language == null) {
          stringResource(R.string.rules_audio_prefer).replaceFirstChar { it.lowercase(locale) }
        } else {
          stringResource(
            R.string.rules_summary_prefer_language,
            inlineContentLanguageLabel(part.language, uiLanguage),
          )
        }
        AudioMode.ONLY -> if (part.language == null) {
          stringResource(R.string.rules_audio_only).replaceFirstChar { it.lowercase(locale) }
        } else {
          stringResource(
            R.string.rules_summary_only_language,
            inlineContentLanguageLabel(part.language, uiLanguage),
          )
        }
      }
      is RuleSummaryPart.Size -> when {
        part.minBytes != null && part.maxBytes != null -> stringResource(
          R.string.rules_summary_range_episode,
          formatRuleGigabytes(part.minBytes, locale),
          formatRuleGigabytes(part.maxBytes, locale),
        )
        part.maxBytes != null -> stringResource(
          R.string.rules_summary_up_to_episode,
          formatRuleGigabytes(part.maxBytes, locale),
        )
        else -> stringResource(
          R.string.rules_summary_from_episode,
          formatRuleGigabytes(part.minBytes ?: 0L, locale),
        )
      }
      is RuleSummaryPart.Subtitles -> stringResource(
        R.string.rules_summary_subtitles_language,
        inlineContentLanguageLabel(part.language, uiLanguage),
      )
    }
  }
  var line = texts.first()
  for (index in 1 until texts.size) {
    line = stringResource(R.string.rules_summary_join, line, texts[index])
  }
  return line
}
