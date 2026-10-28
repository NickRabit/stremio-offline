package cz.stremiooffline.tv.ui.catalog

import android.content.res.Resources
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BulkEpisodeDto
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.DownloadProfileRefDto
import cz.stremiooffline.tv.data.DownloadSelectionDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.data.bulkEpisodes
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagTitleDownloadPanel = "title_download_panel"
const val TagTitleDownloadSource = "title_download_source"
const val TagTitleDownloadAdd = "title_download_add"
const val TagTitleDownloadError = "title_download_error"
const val TagTitleDownloadLibrary = "title_download_library"
const val TagTitleDownloadRulesUnavailable = "title_download_rules_unavailable"

private enum class TitleDownloadScreen { Main, Library }

/** The line a one-item bulk queue reports, the same plurals the series batch uses. */
internal fun bulkQueuedText(resources: Resources, added: Int, skipped: Int): String {
  val addedText = resources.getQuantityString(R.plurals.episodes_bulk_added, added, added)
  val skippedText = if (skipped > 0) {
    " " + resources.getQuantityString(R.plurals.episodes_bulk_skipped, skipped, skipped)
  } else {
    ""
  }
  return addedText + skippedText
}

/**
 * The ↓ button's panel for one film or the selected episode. The first row queues the source on
 * screen; a rule posts one bulk job. The library list is the series panel's own.
 */
@Composable
internal fun TitleDownloadPanel(
  api: TvApi,
  type: String,
  title: String,
  catalogueId: String,
  video: VideoDto?,
  stream: StreamDto,
  explicitPick: Boolean,
  media: BulkMediaDto,
  settings: SettingsResponse,
  addons: List<AddonDto>,
  libraries: List<LibraryDto>,
  opener: FocusRequester,
  openerScope: CoroutineScope,
  onUseSelected: () -> Unit,
  onQueued: (added: Int, skipped: Int) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val scope = rememberCoroutineScope()
  var screen by remember { mutableStateOf(TitleDownloadScreen.Main) }
  var sourceProfiles by remember { mutableStateOf(emptyList<SourceProfileDto>()) }
  var rulesLoaded by remember { mutableStateOf(false) }
  var rulesFailed by remember { mutableStateOf(false) }
  var chosenId by remember { mutableStateOf<String?>(null) }
  var openingRuleId by remember { mutableStateOf<String?>(null) }
  var ruleTouched by remember { mutableStateOf(false) }
  var chosenAddons by remember { mutableStateOf<List<String>>(emptyList()) }
  var pickedLibrary by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var posted by remember { mutableStateOf(false) }
  var succeeded by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var restoreTo by remember { mutableStateOf<String?>(null) }
  var placed by remember { mutableStateOf(false) }
  // Set false before the exact-source path closes the panel, so disposal does not steal the
  // focus that path hands to Play or to the library list.
  val restoreOpener = remember { mutableStateOf(true) }

  val openingFocus = remember { FocusRequester() }
  val addFocus = remember { FocusRequester() }
  val rowFocuses = remember { mutableMapOf<String, FocusRequester>() }

  val sourceItemId = if (type == "movie") catalogueId else video?.id
  LaunchedEffect(sourceItemId) {
    val id = sourceItemId ?: return@LaunchedEffect
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
      if (!ruleTouched) {
        val id = defaultOfferedRuleId(loaded, settings.downloadSourceProfile)
        chosenId = id
        openingRuleId = id
      }
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
  val episodes = if (type == "movie") {
    listOf(BulkEpisodeDto(catalogueId, null, null, title))
  } else {
    bulkEpisodes(listOfNotNull(video))
  }
  val writableLibraries = libraries.filter { it.canWrite && (it.type == type || it.type == "mixed") }
  val addonRuleLibrary = addons.firstOrNull { it.key == chosenAddons.firstOrNull() }?.defaultLibraryId(type)
  val preferredLibrary = addonRuleLibrary?.takeIf { id -> writableLibraries.any { it.id == id } }
    ?: writableLibraries.firstOrNull { if (type == "series") it.defaultSeries else it.defaultMovie }?.id
    ?: writableLibraries.firstOrNull()?.id
  val targetLibrary = pickedLibrary?.takeIf { id -> writableLibraries.any { it.id == id } } ?: preferredLibrary
  val libraryName = writableLibraries.firstOrNull { it.id == targetLibrary }?.name
    ?: stringResource(R.string.save_target_default_library)
  // The source row takes the opening focus when the viewer picked that source, and also when no
  // rule arrived to take it. Otherwise the preselected rule does.
  val focusSource = explicitPick || (rulesLoaded && openingRuleId == null)

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
          episodes = episodes,
          selection = selection,
          media = media,
          target = targetLibrary?.let(::DownloadTargetDto),
        )
        succeeded = true
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

  fun back() {
    if (screen == TitleDownloadScreen.Library) {
      restoreTo = TagTitleDownloadLibrary
      screen = TitleDownloadScreen.Main
    } else {
      onClose()
    }
  }

  // Back on the root screen removes the panel; the remote then returns to the ↓ button. The
  // exact-source row clears the flag first, because that path has its own focus to restore.
  DisposableEffect(opener) {
    onDispose {
      if (!restoreOpener.value) return@onDispose
      openerScope.launch {
        awaitFrame()
        runCatching { opener.requestFocus() }
      }
    }
  }

  LaunchedEffect(screen, rulesLoaded) {
    awaitFrame()
    val restore = restoreTo
    restoreTo = null
    if (restore != null) {
      runCatching { (rowFocuses[restore] ?: openingFocus).requestFocus() }
      return@LaunchedEffect
    }
    if (screen == TitleDownloadScreen.Library) {
      runCatching { openingFocus.requestFocus() }
      return@LaunchedEffect
    }
    if (placed) return@LaunchedEffect
    if (!explicitPick && !rulesLoaded) return@LaunchedEffect
    // requestFocus throws while the row is not on screen yet, so a miss is retried once rules land.
    if (runCatching { openingFocus.requestFocus() }.isSuccess) placed = true
  }
  LaunchedEffect(busy) {
    if (!posted || succeeded) return@LaunchedEffect
    awaitFrame()
    val target = if (busy) {
      rowFocuses[TagTitleDownloadLibrary] ?: rowFocuses[TagTitleDownloadSource] ?: openingFocus
    } else {
      addFocus
    }
    runCatching { target.requestFocus() }
  }

  SidePanel(
    title = stringResource(if (type == "movie") R.string.bulk_title_movie else R.string.bulk_title_episode),
    onClose = { back() },
    modifier = modifier.testTag(TagTitleDownloadPanel),
    initialFocus = openingFocus,
  ) {
    when (screen) {
      TitleDownloadScreen.Main -> {
        PanelOption(
          text = stringResource(R.string.rules_selected_source),
          supportingText = streamLabel(stream).ifBlank { null },
          onClick = {
            restoreOpener.value = false
            onUseSelected()
          },
          modifier = Modifier.panelRow(
            rowFocuses,
            TagTitleDownloadSource,
            first = focusSource,
            opening = if (focusSource) openingFocus else null,
          ),
        )
        if (offered.isNotEmpty()) {
          RuleRows(
            chosenId = chosenId,
            profiles = offered,
            uiLanguage = settings.uiLanguage,
            openingFocus = openingFocus,
            rowFocuses = rowFocuses,
            onPick = { id ->
              ruleTouched = true
              chosenId = id
            },
            openingId = openingRuleId,
            claimOpening = !focusSource && openingRuleId != null,
          )
        } else if (unavailable) {
          Text(
            stringResource(R.string.rules_unavailable),
            color = Tokens.Text,
            fontSize = 12.5.sp,
            lineHeight = 16.sp,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagTitleDownloadRulesUnavailable),
          )
        }
        SettingRow(
          stringResource(R.string.nav_library),
          libraryName,
          { screen = TitleDownloadScreen.Library },
          Modifier.panelRow(rowFocuses, TagTitleDownloadLibrary, first = false, opening = null),
        )
        FocusButton(
          text = if (busy) stringResource(R.string.save_adding) else stringResource(R.string.bulk_add),
          onClick = { submit() },
          kind = FocusButtonKind.Primary,
          enabled = canSubmit,
          modifier = Modifier.fillMaxWidth().focusRequester(addFocus).testTag(TagTitleDownloadAdd),
        )
        error?.let { message ->
          Text(
            message,
            color = Tokens.Red,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag(TagTitleDownloadError),
          )
        }
      }
      TitleDownloadScreen.Library -> LibraryRows(
        writableLibraries = writableLibraries,
        targetLibrary = targetLibrary,
        openingFocus = openingFocus,
        rowFocuses = rowFocuses,
        onPick = { pickedLibrary = it },
      )
    }
  }
}
