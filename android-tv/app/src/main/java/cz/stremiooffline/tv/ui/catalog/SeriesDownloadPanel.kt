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
import cz.stremiooffline.tv.data.BulkMediaDto
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
import cz.stremiooffline.tv.data.bulkEpisodes
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

fun seriesScopeTag(scope: DownloadScope): String = "series_scope_${scope.name.lowercase()}"
fun seriesRuleTag(id: String): String = "series_rule_$id"
fun seriesLibraryTag(id: String): String = "series_library_$id"

private const val BALANCED_NAME_KEY = "rules.preset.balanced"

/** Which list the panel shows: the scopes, the settings, or one nested list of them. */
private enum class DownloadPanelScreen { Scope, Settings, Rules, Library }

/**
 * Bulk download as D-pad panels. Level one is which episodes to queue. Level two is the download
 * rule and the library. The choice starts at the account's rule, then Balanced, then the first
 * offered rule. Submit posts only that rule's id and revision. With none offered, the panel says
 * so and the add button stays disabled.
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

  var screen by remember { mutableStateOf(DownloadPanelScreen.Scope) }
  var chosenScope by remember { mutableStateOf<DownloadScope?>(null) }
  var sourceProfiles by remember { mutableStateOf<List<SourceProfileDto>>(emptyList()) }
  var rulesLoaded by remember { mutableStateOf(false) }
  var rulesFailed by remember { mutableStateOf(false) }
  var chosenId by remember { mutableStateOf<String?>(null) }
  var ruleTouched by remember { mutableStateOf(false) }
  var chosenAddons by remember { mutableStateOf<List<String>>(emptyList()) }
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

  // The web asks the sources off the first episode of the batch; the first one's library rule
  // is the destination until the viewer picks another library.
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
    chosenAddons = answer.map { it.key }
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

  val genericText = stringResource(R.string.tv_err_generic)
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val canSubmit = episodes.isNotEmpty() && selectedRule != null && !busy

  fun submit() {
    val rule = selectedRule ?: return
    if (busy || episodes.isEmpty()) return
    busy = true
    posted = true
    error = null
    val selection = DownloadSelectionDto(profile = DownloadProfileRefDto(rule.id, rule.revision))
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
      DownloadPanelScreen.Rules -> TagSeriesDownloadRules
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
      rowFocuses[TagSeriesDownloadRules] ?: rowFocuses[TagSeriesDownloadLibrary] ?: openingFocus
    } else {
      addFocus.takeIf { posted }
    }
    if (target != null) runCatching { target.requestFocus() }
  }

  SidePanel(
    title = when (screen) {
      DownloadPanelScreen.Scope -> stringResource(R.string.tv_download_which_episodes)
      DownloadPanelScreen.Settings -> stringResource(R.string.tv_download_settings)
      DownloadPanelScreen.Rules -> stringResource(R.string.rules_title)
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
        rulesName = if (offered.isNotEmpty()) selectedRule?.let { ruleName(it) }.orEmpty() else null,
        unavailable = unavailable,
        libraryValue = libraryName,
        busy = busy,
        canSubmit = canSubmit,
        error = error,
        addFocus = addFocus,
        onOpen = { screen = it },
        onSubmit = { submit() },
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

/** Level two: the summary line, the rule and the library, and the queue action. */
@Composable
private fun ColumnScope.SettingsRows(
  rowFocuses: MutableMap<String, FocusRequester>,
  openingFocus: FocusRequester,
  summary: String,
  rulesName: String?,
  unavailable: Boolean,
  libraryValue: String,
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
  if (rulesName != null) {
    SettingRow(
      stringResource(R.string.rules_title),
      rulesName,
      { onOpen(DownloadPanelScreen.Rules) },
      Modifier.panelRow(rowFocuses, TagSeriesDownloadRules, first = true, opening = openingFocus),
    )
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
    { onOpen(DownloadPanelScreen.Library) },
    Modifier.panelRow(
      rowFocuses,
      TagSeriesDownloadLibrary,
      first = rulesName == null,
      opening = if (rulesName == null) openingFocus else null,
    ),
  )
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

/** The rules the server offers. Choosing one applies it and returns to the settings. */
@Composable
internal fun ColumnScope.RuleRows(
  chosenId: String?,
  profiles: List<SourceProfileDto>,
  uiLanguage: String?,
  openingFocus: FocusRequester,
  rowFocuses: MutableMap<String, FocusRequester>,
  onPick: (String) -> Unit,
  /** Null keeps the opening focus on the first rule, which is the series screen. */
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

/** One row that opens a nested list, named by the value it holds today. */
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
