package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.DownloadProfileRefDto
import cz.stremiooffline.tv.data.DownloadSelectionDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.data.bulkEpisodes
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagSeriesDownloadPanel = "series_download_panel"
const val TagSeriesDownloadSummary = "series_download_summary"
const val TagSeriesDownloadAdd = "series_download_add"
const val TagSeriesDownloadError = "series_download_error"
const val TagSeriesDownloadAudio = "series_download_audio"
const val TagSeriesDownloadSubtitles = "series_download_subtitles"
const val TagSeriesDownloadStrategy = "series_download_strategy"
const val TagSeriesDownloadSources = "series_download_sources"
const val TagSeriesDownloadLibrary = "series_download_library"

fun seriesScopeTag(scope: DownloadScope): String = "series_scope_${scope.name.lowercase()}"
fun seriesStrategyTag(strategy: String): String = "series_strategy_$strategy"
fun seriesSourceTag(key: String): String = "series_source_$key"
fun seriesLibraryTag(id: String): String = "series_library_$id"
fun seriesAudioTag(code: String): String = "series_audio_$code"
fun seriesAudioFallbackTag(code: String): String = "series_audio_fallback_$code"
fun seriesSubtitleModeTag(mode: String): String = "series_subtitle_mode_$mode"
fun seriesSubtitleTag(code: String): String = "series_subtitle_$code"
fun seriesSubtitleFallbackTag(code: String): String = "series_subtitle_fallback_$code"

private const val SOURCE_PROFILE_STRATEGY_PREFIX = "profile:"

/** Which list the panel shows: the scopes, the settings, or one nested list of them. */
private enum class DownloadPanelScreen { Scope, Settings, Audio, Subtitles, Strategy, Sources, Library }

/**
 * The web's bulk download as D-pad panels: which episodes to queue, and the lazy rules the server
 * picks each episode's source by. Level one is the scope, level two the settings; every settings
 * row opens a nested list and Back walks the same way back. The values default exactly where the
 * web's non-follow dialog does, so leaving everything alone queues the account's own choices.
 */
@Composable
internal fun SeriesDownloadPanel(
  api: TvApi,
  type: String,
  title: String,
  videos: List<VideoDto>,
  selected: VideoDto?,
  media: BulkMediaDto,
  settings: SettingsResponse,
  addons: List<AddonDto>,
  libraries: List<LibraryDto>,
  onQueued: (added: Int, skipped: Int) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val scope = rememberCoroutineScope()
  val today = remember { utcToday() }
  val startAudio = settings.audioLanguage?.takeIf { it.isNotBlank() } ?: "en"
  val startSubtitle = settings.subtitleLanguage?.takeIf { it.isNotBlank() } ?: startAudio

  var screen by remember { mutableStateOf(DownloadPanelScreen.Scope) }
  var chosenScope by remember { mutableStateOf<DownloadScope?>(null) }
  var audio by remember { mutableStateOf(startAudio) }
  var audioFallback by remember { mutableStateOf(if (startAudio == "en") "" else "en") }
  var subtitleMode by remember { mutableStateOf("optional") }
  var subtitle by remember { mutableStateOf(startSubtitle) }
  var subtitleFallback by remember { mutableStateOf(if (startSubtitle == "en") "" else "en") }
  var strategy by remember { mutableStateOf("largest") }
  var strategyTouched by remember { mutableStateOf(false) }
  var sourceProfiles by remember { mutableStateOf<List<SourceProfileDto>>(emptyList()) }
  var sourceAddons by remember { mutableStateOf<List<StreamSourceDto>>(emptyList()) }
  var chosenAddons by remember { mutableStateOf<List<String>>(emptyList()) }
  var languageCodes by remember { mutableStateOf<List<String>>(emptyList()) }
  // Null until the viewer picks one; until then the rule below decides where the download goes.
  var pickedLibrary by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var posted by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var restoreTo by remember { mutableStateOf<String?>(null) }

  // The first row of whichever screen is up takes this requester, so the screen opens on it and a
  // return to that first row lands on it too.
  val openingFocus = remember { FocusRequester() }
  val addFocus = remember { FocusRequester() }
  val rowFocuses = remember { mutableMapOf<String, FocusRequester>() }

  // The web asks the sources off the first episode of the batch; every addon answers by default.
  val sourceVideoId = selected?.id ?: regularEpisodes(videos).firstOrNull()?.id
  LaunchedEffect(sourceVideoId) {
    val id = sourceVideoId ?: return@LaunchedEffect
    val answer = try {
      api.streamSources(type, id)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      emptyList()
    }
    sourceAddons = answer
    chosenAddons = answer.map { it.key }
  }
  LaunchedEffect(Unit) {
    languageCodes = try {
      api.languages().map { it.code }.filter { it.isNotBlank() }.distinct()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      emptyList()
    }
  }
  LaunchedEffect(Unit) {
    sourceProfiles = try {
      api.sourceProfiles()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      emptyList()
    }
  }

  val offeredProfiles = sourceProfiles.filter(::isOfferedSourceProfile)
  LaunchedEffect(offeredProfiles, settings.downloadSourceProfile) {
    if (strategyTouched) return@LaunchedEffect
    strategy = offeredProfiles.firstOrNull { it.id == settings.downloadSourceProfile }
      ?.let { sourceProfileStrategy(it.id) }
      ?: "largest"
  }
  val selectedProfile = offeredProfiles.firstOrNull { sourceProfileStrategy(it.id) == strategy }
  val profileManaged = selectedProfile != null
  val episodes = chosenScope?.let { scopeEpisodes(videos, it, selected, today) }.orEmpty()
  val writableLibraries = libraries.filter { it.canWrite && (it.type == type || it.type == "mixed") }
  // The web's `ruleTarget`: the first chosen addon's own rule first, then the library the account
  // flagged as this kind's default, then the first one it may write to at all.
  val addonRuleLibrary = addons.firstOrNull { it.key == chosenAddons.firstOrNull() }
    ?.downloadSettings?.series?.libraryId?.takeIf { it.isNotBlank() }
  val preferredLibrary = addonRuleLibrary?.takeIf { id -> writableLibraries.any { it.id == id } }
    ?: writableLibraries.firstOrNull { it.defaultSeries }?.id
    ?: writableLibraries.firstOrNull()?.id
  val targetLibrary = pickedLibrary?.takeIf { id -> writableLibraries.any { it.id == id } } ?: preferredLibrary
  val libraryName = writableLibraries.firstOrNull { it.id == targetLibrary }?.name
    ?: stringResource(R.string.save_target_default_library)

  val selection = selectedProfile?.let {
    DownloadSelectionDto(profile = DownloadProfileRefDto(it.id, it.revision))
  } ?: DownloadSelectionDto(
      addonKeys = chosenAddons,
      sourceStrategy = strategy,
      audioLanguage = audio,
      fallbackAudioLanguage = audioFallback.takeIf { it.isNotBlank() && it != audio },
      audioMode = "listed",
      subtitleMode = subtitleMode,
      subtitleLanguage = subtitle.takeIf { subtitleMode != "off" },
      fallbackSubtitleLanguage = subtitleFallback.takeIf { subtitleMode != "off" && it.isNotBlank() && it != subtitle },
    )
  val genericText = stringResource(R.string.tv_err_generic)
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val canSubmit = episodes.isNotEmpty() && (selectedProfile != null || chosenAddons.isNotEmpty()) && !busy

  fun submit() {
    if (busy || episodes.isEmpty() || (selectedProfile == null && chosenAddons.isEmpty())) return
    busy = true
    posted = true
    error = null
    scope.launch {
      try {
        val answer = api.downloadBulk(
          title = title,
          type = type,
          episodes = bulkEpisodes(episodes),
          selection = selection,
          media = media,
          target = targetLibrary?.let(::DownloadTargetDto),
        )
        onQueued(answer.added, answer.skipped)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: ApiError) {
        error = failure.serverMessage ?: if (failure.failure == ApiFailure.Forbidden) notAllowedText else genericText
      } finally {
        busy = false
      }
    }
  }

  /** Back leaves a nested list for the settings, and the settings for the scope; the row the
   *  viewer came through takes the remote back. */
  fun goBack() {
    restoreTo = when (screen) {
      DownloadPanelScreen.Settings -> chosenScope?.let(::seriesScopeTag)
      DownloadPanelScreen.Audio -> TagSeriesDownloadAudio
      DownloadPanelScreen.Subtitles -> TagSeriesDownloadSubtitles
      DownloadPanelScreen.Strategy -> TagSeriesDownloadStrategy
      DownloadPanelScreen.Sources -> TagSeriesDownloadSources
      DownloadPanelScreen.Library -> TagSeriesDownloadLibrary
      DownloadPanelScreen.Scope -> null
    }
    screen = if (screen == DownloadPanelScreen.Settings) DownloadPanelScreen.Scope else DownloadPanelScreen.Settings
  }

  // A row the map does not know is the screen's first row, which carries the opening requester.
  LaunchedEffect(screen) {
    awaitFrame()
    val restore = restoreTo
    restoreTo = null
    val target = restore?.let { rowFocuses[it] ?: openingFocus } ?: openingFocus
    runCatching { target.requestFocus() }
  }
  // The add row is disabled while it posts, so the remote it was holding is parked on the first
  // settings row and given back once the refusal is on screen.
  LaunchedEffect(busy) {
    awaitFrame()
    val target = if (busy) {
      rowFocuses[TagSeriesDownloadAudio] ?: rowFocuses[TagSeriesDownloadStrategy] ?: openingFocus
    } else {
      addFocus.takeIf { posted }
    }
    if (target != null) runCatching { target.requestFocus() }
  }

  SidePanel(
    title = when (screen) {
      DownloadPanelScreen.Scope -> stringResource(R.string.tv_download_which_episodes)
      DownloadPanelScreen.Settings -> stringResource(R.string.tv_download_settings)
      DownloadPanelScreen.Audio -> stringResource(R.string.bulk_audio)
      DownloadPanelScreen.Subtitles -> stringResource(R.string.bulk_subtitles)
      DownloadPanelScreen.Strategy -> stringResource(R.string.bulk_source_strategy)
      DownloadPanelScreen.Sources -> stringResource(R.string.bulk_sources)
      DownloadPanelScreen.Library -> stringResource(R.string.nav_library)
    },
    onClose = { if (screen == DownloadPanelScreen.Scope) onClose() else goBack() },
    modifier = modifier.testTag(TagSeriesDownloadPanel),
    initialFocus = openingFocus,
  ) {
    when (screen) {
      DownloadPanelScreen.Scope -> ScopeRows(
        videos = videos,
        selected = selected,
        today = today,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { picked ->
          chosenScope = picked
          screen = DownloadPanelScreen.Settings
        },
      )
      DownloadPanelScreen.Settings -> SettingsRows(
        rowFocuses = rowFocuses,
        openingFocus = openingFocus,
        summary = pluralStringResource(R.plurals.bulk_episode_count, episodes.size, episodes.size) + " → " + libraryName,
        audioValue = Languages.label(audio) + (audioFallback.takeIf { it.isNotBlank() }?.let { " → " + Languages.label(it) } ?: ""),
        subtitleValue = subtitleModeLabel(subtitleMode) + (subtitle.takeIf { subtitleMode != "off" }?.let { " → " + Languages.label(it) } ?: ""),
        strategyValue = strategyLabel(strategy, offeredProfiles),
        sourcesValue = "${chosenAddons.size}/${sourceAddons.size}",
        libraryValue = libraryName,
        profileManaged = profileManaged,
        busy = busy,
        canSubmit = canSubmit,
        error = error,
        addFocus = addFocus,
        onOpen = { screen = it },
        onSubmit = { submit() },
      )
      DownloadPanelScreen.Audio -> PickerRows(
        heading = stringResource(R.string.bulk_audio),
        options = languageOptions(languageCodes, audio),
        isChosen = { it == audio },
        tag = ::seriesAudioTag,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { audio = it; if (audioFallback == it) audioFallback = "" },
        fallbackHeading = stringResource(R.string.bulk_audio_fallback),
        fallbackNone = stringResource(R.string.bulk_no_fallback),
        fallbackOptions = languageOptions(languageCodes, audioFallback),
        fallbackChosen = audioFallback,
        fallbackTag = ::seriesAudioFallbackTag,
        onPickFallback = { audioFallback = it },
      )
      DownloadPanelScreen.Subtitles -> SettingsSubtitleRows(
        rowFocuses = rowFocuses,
        openingFocus = openingFocus,
        subtitleMode = subtitleMode,
        onMode = { subtitleMode = it },
        languageCodes = languageCodes,
        subtitle = subtitle,
        subtitleFallback = subtitleFallback,
        onSubtitle = { subtitle = it; if (subtitleFallback == it) subtitleFallback = "" },
        onSubtitleFallback = { subtitleFallback = it },
      )
      DownloadPanelScreen.Strategy -> StrategyRows(
        strategy = strategy,
        profiles = offeredProfiles,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = {
          strategyTouched = true
          strategy = it
          if (it.startsWith(SOURCE_PROFILE_STRATEGY_PREFIX)) {
            restoreTo = TagSeriesDownloadStrategy
            screen = DownloadPanelScreen.Settings
          }
        },
      )
      DownloadPanelScreen.Sources -> SourceRows(
        sourceAddons = sourceAddons,
        chosenAddons = chosenAddons,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onToggle = { key ->
          chosenAddons = if (key in chosenAddons) chosenAddons - key else chosenAddons + key
        },
      )
      DownloadPanelScreen.Library -> LibraryRows(
        writableLibraries = writableLibraries,
        targetLibrary = targetLibrary,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { pickedLibrary = it },
      )
    }
  }
}

/** Level one: the scopes, each with the released episodes it would add. */
@Composable
private fun ColumnScope.ScopeRows(
  videos: List<VideoDto>,
  selected: VideoDto?,
  today: String,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (DownloadScope) -> Unit,
) {
  DownloadScope.entries.forEachIndexed { index, scope ->
    val label = when (scope) {
      DownloadScope.Episode -> stringResource(R.string.tv_download_this_episode)
      DownloadScope.Season -> stringResource(R.string.tv_download_this_season, (selected?.season ?: 0).toString())
      DownloadScope.FromEpisode -> stringResource(R.string.tv_download_from_episode)
      DownloadScope.All -> stringResource(R.string.tv_download_all_episodes)
    }
    PanelOption(
      text = label + " · " + scopeEpisodes(videos, scope, selected, today).size,
      onClick = { onPick(scope) },
      modifier = Modifier.panelRow(rowFocuses, seriesScopeTag(scope), first = index == 0, opening = openingFocus),
    )
  }
}

/** Level two: the summary line, one row per choice, and the queue action. */
@Composable
private fun ColumnScope.SettingsRows(
  rowFocuses: MutableMap<String, FocusRequester>,
  openingFocus: FocusRequester,
  summary: String,
  audioValue: String,
  subtitleValue: String,
  strategyValue: String,
  sourcesValue: String,
  libraryValue: String,
  profileManaged: Boolean,
  busy: Boolean,
  canSubmit: Boolean,
  error: String?,
  addFocus: FocusRequester,
  onOpen: (DownloadPanelScreen) -> Unit,
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
  if (!profileManaged) {
    SettingRow(stringResource(R.string.bulk_audio), audioValue, { onOpen(DownloadPanelScreen.Audio) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadAudio, first = true, opening = openingFocus))
    SettingRow(stringResource(R.string.bulk_subtitles), subtitleValue, { onOpen(DownloadPanelScreen.Subtitles) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadSubtitles, first = false, opening = null))
  }
  SettingRow(stringResource(R.string.bulk_source_strategy), strategyValue, { onOpen(DownloadPanelScreen.Strategy) },
    Modifier.panelRow(rowFocuses, TagSeriesDownloadStrategy, first = profileManaged, opening = if (profileManaged) openingFocus else null))
  if (!profileManaged) {
    SettingRow(stringResource(R.string.bulk_sources), sourcesValue, { onOpen(DownloadPanelScreen.Sources) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadSources, first = false, opening = null))
  }
  SettingRow(stringResource(R.string.nav_library), libraryValue, { onOpen(DownloadPanelScreen.Library) },
    Modifier.panelRow(rowFocuses, TagSeriesDownloadLibrary, first = false, opening = null))
  FocusButton(
    text = if (busy) stringResource(R.string.save_adding) else stringResource(R.string.bulk_add),
    onClick = onSubmit,
    kind = FocusButtonKind.Primary,
    enabled = canSubmit,
    modifier = Modifier.fillMaxWidth().focusRequester(addFocus).testTag(TagSeriesDownloadAdd),
  )
  if (error != null) {
    Text(
      error,
      color = Tokens.Red,
      fontSize = 11.sp,
      lineHeight = 16.sp,
      modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagSeriesDownloadError),
    )
  }
}

/** A language list with its fallback list below it: the pick applies at once and Back leaves. */
@Composable
private fun ColumnScope.PickerRows(
  heading: String,
  options: List<String>,
  isChosen: (String) -> Boolean,
  tag: (String) -> String,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (String) -> Unit,
  fallbackHeading: String,
  fallbackNone: String,
  fallbackOptions: List<String>,
  fallbackChosen: String,
  fallbackTag: (String) -> String,
  onPickFallback: (String) -> Unit,
) {
  PanelHeading(heading)
  options.forEachIndexed { index, code ->
    PanelOption(
      text = Languages.label(code),
      selected = isChosen(code),
      onClick = { onPick(code) },
      modifier = Modifier.panelRow(rowFocuses, tag(code), first = index == 0, opening = openingFocus),
    )
  }
  PanelHeading(fallbackHeading)
  PanelOption(
    text = fallbackNone,
    selected = fallbackChosen.isBlank(),
    onClick = { onPickFallback("") },
    modifier = Modifier.panelRow(rowFocuses, fallbackTag(""), first = options.isEmpty(), opening = openingFocus),
  )
  fallbackOptions.forEach { code ->
    PanelOption(
      text = Languages.label(code),
      selected = code == fallbackChosen,
      onClick = { onPickFallback(code) },
      modifier = Modifier.panelRow(rowFocuses, fallbackTag(code), first = false, opening = null),
    )
  }
}

/** The subtitle modes, then the language and its fallback unless nothing is downloaded. */
@Composable
private fun ColumnScope.SettingsSubtitleRows(
  rowFocuses: MutableMap<String, FocusRequester>,
  openingFocus: FocusRequester,
  subtitleMode: String,
  onMode: (String) -> Unit,
  languageCodes: List<String>,
  subtitle: String,
  subtitleFallback: String,
  onSubtitle: (String) -> Unit,
  onSubtitleFallback: (String) -> Unit,
) {
  PanelHeading(stringResource(R.string.bulk_subtitles))
  listOf("off", "optional", "required").forEachIndexed { index, mode ->
    PanelOption(
      text = subtitleModeLabel(mode),
      selected = mode == subtitleMode,
      onClick = { onMode(mode) },
      modifier = Modifier.panelRow(rowFocuses, seriesSubtitleModeTag(mode), first = index == 0, opening = openingFocus),
    )
  }
  if (subtitleMode == "off") return
  PanelHeading(stringResource(R.string.bulk_subtitle_language))
  languageOptions(languageCodes, subtitle).forEach { code ->
    PanelOption(
      text = Languages.label(code),
      selected = code == subtitle,
      onClick = { onSubtitle(code) },
      modifier = Modifier.panelRow(rowFocuses, seriesSubtitleTag(code), first = false, opening = null),
    )
  }
  PanelHeading(stringResource(R.string.bulk_subtitle_fallback))
  PanelOption(
    text = stringResource(R.string.bulk_no_fallback),
    selected = subtitleFallback.isBlank(),
    onClick = { onSubtitleFallback("") },
    modifier = Modifier.panelRow(rowFocuses, seriesSubtitleFallbackTag(""), first = false, opening = null),
  )
  languageOptions(languageCodes, subtitleFallback).forEach { code ->
    PanelOption(
      text = Languages.label(code),
      selected = code == subtitleFallback,
      onClick = { onSubtitleFallback(code) },
      modifier = Modifier.panelRow(rowFocuses, seriesSubtitleFallbackTag(code), first = false, opening = null),
    )
  }
}

/** The web's two source strategies. */
@Composable
private fun ColumnScope.StrategyRows(
  strategy: String,
  profiles: List<SourceProfileDto>,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (String) -> Unit,
) {
  listOf("largest", "priority").forEachIndexed { index, value ->
    PanelOption(
      text = strategyLabel(value, profiles),
      selected = value == strategy,
      onClick = { onPick(value) },
      modifier = Modifier.panelRow(rowFocuses, seriesStrategyTag(value), first = index == 0, opening = openingFocus),
    )
  }
  profiles.forEach { profile ->
    val value = sourceProfileStrategy(profile.id)
    PanelOption(
      text = sourceProfileName(profile),
      supportingText = sourceProfileHint(profile),
      selected = value == strategy,
      onClick = { onPick(value) },
      modifier = Modifier.panelRow(rowFocuses, seriesStrategyTag(value), first = false, opening = null),
    )
  }
}

/** The addons the server may take sources from; all of them are chosen at first. */
@Composable
private fun ColumnScope.SourceRows(
  sourceAddons: List<StreamSourceDto>,
  chosenAddons: List<String>,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onToggle: (String) -> Unit,
) {
  sourceAddons.forEachIndexed { index, addon ->
    PanelOption(
      text = addon.name.ifBlank { addon.key },
      selected = addon.key in chosenAddons,
      onClick = { onToggle(addon.key) },
      modifier = Modifier.panelRow(rowFocuses, seriesSourceTag(addon.key), first = index == 0, opening = openingFocus),
    )
  }
}

/** The libraries this account may write a series into, the addon default preselected. */
@Composable
private fun ColumnScope.LibraryRows(
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

/** One row that opens a nested list, named by the value it holds today. */
@Composable
private fun SettingRow(text: String, value: String, onClick: () -> Unit, modifier: Modifier) {
  PanelOption(text = "$text · $value", onClick = onClick, modifier = modifier)
}

@Composable
private fun PanelHeading(text: String) {
  Text(
    text,
    color = Tokens.Accent,
    fontSize = 13.sp,
    fontWeight = FontWeight.Bold,
    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
  )
}

/** The tag, the row's own requester, and -- for the first row of a screen -- the opening one. */
private fun Modifier.panelRow(
  focuses: MutableMap<String, FocusRequester>,
  tag: String,
  first: Boolean,
  opening: FocusRequester?,
): Modifier {
  val row = if (first && opening != null) opening else focuses.getOrPut(tag) { FocusRequester() }
  focuses[tag] = row
  return testTag(tag).focusRequester(row)
}

@Composable
private fun subtitleModeLabel(mode: String): String = stringResource(
  when (mode) {
    "off" -> R.string.bulk_subtitles_off
    "required" -> R.string.bulk_subtitles_required
    else -> R.string.bulk_subtitles_optional
  },
)

@Composable
private fun strategyLabel(strategy: String, profiles: List<SourceProfileDto>): String {
  val profile = profiles.firstOrNull { sourceProfileStrategy(it.id) == strategy }
  return profile?.let { sourceProfileName(it) }
    ?: stringResource(if (strategy == "priority") R.string.bulk_strategy_priority else R.string.bulk_strategy_largest)
}

private fun sourceProfileStrategy(id: String): String = SOURCE_PROFILE_STRATEGY_PREFIX + id

private fun isOfferedSourceProfile(profile: SourceProfileDto): Boolean =
  "downloadToLibrary" in profile.operations &&
    (sourceProfileNameKey(profile) != null || !profile.name.isNullOrBlank())

private fun sourceProfileNameKey(profile: SourceProfileDto): Int? = when (profile.nameKey) {
  "sourceProfile.travel" -> R.string.source_profile_travel
  "sourceProfile.providerPriority" -> R.string.source_profile_provider_priority
  else -> null
}

private fun sourceProfileHintKey(profile: SourceProfileDto): Int? = when (profile.nameKey) {
  "sourceProfile.travel" -> R.string.source_profile_travel_hint
  "sourceProfile.providerPriority" -> R.string.source_profile_provider_priority_hint
  else -> null
}

@Composable
private fun sourceProfileName(profile: SourceProfileDto): String =
  sourceProfileNameKey(profile)?.let { stringResource(it) } ?: profile.name.orEmpty()

@Composable
private fun sourceProfileHint(profile: SourceProfileDto): String? =
  sourceProfileHintKey(profile)?.let { stringResource(it) }

/** The languages the account's server offers, with the chosen one always in the list. */
private fun languageOptions(codes: List<String>, chosen: String): List<String> =
  (codes + chosen).filter { it.isNotBlank() }.distinct()
