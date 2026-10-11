@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package cz.stremiooffline.tv.ui.settings

import android.content.Context
import android.os.Build
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.Versions
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.LanguageDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.TvPreferences
import cz.stremiooffline.tv.diagnostics.AppLog
import cz.stremiooffline.tv.playback.decodedLabels
import cz.stremiooffline.tv.playback.passthroughLabels
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.signin.messageRes
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale
import kotlinx.coroutines.android.awaitFrame

/** The ten interface languages by their own names, mirroring `LOCALE_NAMES` in web/src/i18n. */
val UI_LOCALE_NAMES: List<Pair<String, String>> = listOf(
  "en" to "English", "cs" to "Čeština", "sk" to "Slovenčina", "de" to "Deutsch",
  "es" to "Español", "fr" to "Français", "it" to "Italiano", "pl" to "Polski",
  "pt-BR" to "Português (Brasil)", "ru" to "Русский",
)

const val TagSettingsRowServer = "settings_row_server"
const val TagSettingsRowAccount = "settings_row_account"
const val TagSettingsRowUiLanguage = "settings_row_ui_language"
const val TagSettingsRowAudio = "settings_row_audio"
const val TagSettingsRowSubtitle = "settings_row_subtitle"
const val TagSettingsRowStartView = "settings_row_start_view"
const val TagSettingsRowHomeLayout = "settings_row_home_layout"
const val TagSettingsRowPreferConversion = "settings_row_prefer_conversion"
const val TagSettingsRowDevice = "settings_row_device"
const val TagSettingsRowVersion = "settings_row_version"
const val TagSettingsRowDiagnostics = "settings_row_diagnostics"
const val TagSettingsPanel = "settings_panel"
const val TagSettingsSignOutCancel = "settings_sign_out_cancel"
const val TagSettingsSignOutConfirm = "settings_sign_out_confirm"
const val TagSettingsError = "settings_error"

fun settingsOptionTag(kind: String, code: String): String = "settings_${kind}_option_$code"

/** The three Start page values the server accepts, with the catalog the fallback for anything
 *  else -- the same value drives the row's label, the panel's tint and the panel's focus. */
private val START_VIEWS = listOf("home", "catalog", "library")

private enum class SettingsPanel { SignOut, UiLanguage, AudioLanguage, SubtitleLanguage, StartView, HomeLayout }

/** The Device/Version line: the model, the Android release and what the device plays, all from
 *  the capability DTO the player already builds. */
@Composable
fun SettingsRoute(
  api: TvApi,
  username: String,
  focusRequester: FocusRequester,
  onSignOut: () -> Unit,
  onLocale: (String) -> Unit,
) {
  val viewModel = viewModel<SettingsViewModel>(factory = SettingsViewModel.factory(api, onLocale))
  val context = LocalContext.current
  val capabilities = remember(context) { runCatching { cz.stremiooffline.tv.playback.detectCapabilities(context) }.getOrElse { ClientCapabilitiesDto() } }
  // The conversion preference belongs to this television, so it lives in the device store, not
  // in the account settings the screen patches.
  val preferences = remember(context) { TvPreferences(context) }
  var preferConversion by remember(preferences) { mutableStateOf(preferences.preferConversion) }
  val appVersion = remember(context) { appVersionOf(context) }
  val device = remember {
    listOfNotNull(Build.MODEL.takeIf { !it.isNullOrBlank() }, "Android ${Build.VERSION.RELEASE}".takeIf { Build.VERSION.RELEASE?.isNotBlank() == true })
      .joinToString(" · ")
  }
  val crashFile = remember(context) { AppLog.crashFile(context.filesDir) }
  // A crash the previous run recorded travels with the bundle, and is dropped once it is away.
  LaunchedEffect(viewModel.diagnostics) {
    if (viewModel.diagnostics is DiagnosticsState.Sent) AppLog.clearCrash(crashFile)
  }
  val diagnosticsValue = when (val state = viewModel.diagnostics) {
    DiagnosticsState.Idle, DiagnosticsState.Sending -> null
    is DiagnosticsState.Sent -> stringResource(R.string.tv_diagnostics_sent, state.id)
    // The server may say why it refused the bundle; without that, the row names the failure kind.
    is DiagnosticsState.Failed -> state.serverMessage ?: stringResource(state.failure.messageRes())
  }
  SettingsScreen(
    state = viewModel.state,
    languages = viewModel.languages,
    address = api.serverAddress,
    username = username,
    appVersion = appVersion,
    deviceModel = Build.MODEL.orEmpty(),
    deviceRelease = Build.VERSION.RELEASE.orEmpty(),
    capabilities = capabilities,
    onUiLanguage = viewModel::setUiLanguage,
    onAudioLanguage = viewModel::setAudioLanguage,
    onSubtitleLanguage = viewModel::setSubtitleLanguage,
    onStartView = viewModel::setStartView,
    homeLayout = viewModel.homeLayout,
    onToggleHomeRow = viewModel::toggleHomeRow,
    onMoveHomeRow = viewModel::moveHomeRow,
    onMoveTopHomeRow = viewModel::moveHomeRowToTop,
    onResetHomeLayout = viewModel::resetHomeLayout,
    onFlushHomeLayout = viewModel::flushHomeLayout,
    preferConversion = preferConversion,
    onPreferConversion = {
      preferConversion = !preferConversion
      preferences.preferConversion = preferConversion
    },
    diagnosticsValue = diagnosticsValue,
    onSendDiagnostics = { viewModel.sendDiagnostics(appVersion, device, AppLog.readCrash(crashFile)) },
    onSignOut = onSignOut,
    focusRequester = focusRequester,
  )
}

@Suppress("DEPRECATION")
private fun appVersionOf(context: Context): String =
  runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()

@Composable
fun SettingsScreen(
  state: SettingsState,
  languages: List<LanguageDto>,
  address: String,
  username: String,
  appVersion: String,
  deviceModel: String,
  deviceRelease: String,
  capabilities: ClientCapabilitiesDto,
  onUiLanguage: (String) -> Unit,
  onAudioLanguage: (String) -> Unit,
  onSubtitleLanguage: (String) -> Unit,
  onStartView: (String) -> Unit,
  homeLayout: HomeLayoutState,
  onToggleHomeRow: (String) -> Unit,
  onMoveHomeRow: (String, Int) -> Unit,
  onMoveTopHomeRow: (String) -> Unit,
  onResetHomeLayout: () -> Unit,
  onFlushHomeLayout: () -> Unit,
  preferConversion: Boolean,
  onPreferConversion: () -> Unit,
  diagnosticsValue: String? = null,
  onSendDiagnostics: () -> Unit = {},
  onSignOut: () -> Unit,
  focusRequester: FocusRequester,
) {
  var panel by remember { mutableStateOf<SettingsPanel?>(null) }
  var returnFocus by remember { mutableStateOf<FocusRequester?>(null) }

  val accountFocus = remember { FocusRequester() }
  val uiFocus = remember { FocusRequester() }
  val audioFocus = remember { FocusRequester() }
  val subtitleFocus = remember { FocusRequester() }
  val startFocus = remember { FocusRequester() }
  val homeFocus = remember { FocusRequester() }
  val panelFocus = remember { FocusRequester() }

  LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

  // A frame after a panel closes the opener row is back in the tree, so focus can return to it.
  LaunchedEffect(panel) {
    if (panel != null) return@LaunchedEffect
    val target = returnFocus ?: return@LaunchedEffect
    returnFocus = null
    awaitFrame()
    runCatching { target.requestFocus() }
  }

  fun closePanel() {
    panel = null
  }

  fun openPanel(target: SettingsPanel, opener: FocusRequester) {
    returnFocus = opener
    panel = target
  }

  val uiLanguage = state.uiLanguage
  val interfaceName = UI_LOCALE_NAMES.firstOrNull { it.first == uiLanguage }?.second ?: uiLanguage.orEmpty()
  val audioName = state.audioLanguage?.let { contentLanguageLabel(it, uiLanguage) }.orEmpty()
  val subtitleName = state.subtitleLanguage?.let { contentLanguageLabel(it, uiLanguage) }.orEmpty()
  val startView = state.startView?.takeIf { it in START_VIEWS } ?: "catalog"
  val startName = when (startView) {
    "home" -> stringResource(R.string.nav_home)
    "library" -> stringResource(R.string.nav_library)
    else -> stringResource(R.string.nav_catalog)
  }
  val serverVersion = state.serverVersion?.takeIf { it.isNotBlank() }
  val decodeLine = decodedLabels(capabilities).joinToString(" · ")
  val passthroughLine = passthroughLabels(capabilities).let {
    if (it.isEmpty()) "" else stringResource(R.string.tv_passthrough) + " " + it.joinToString(" · ")
  }

  Column(
    // The list grew past one screen; it scrolls so the bottom rows still take focus.
    modifier = Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(
      stringResource(R.string.nav_settings).uppercase(),
      color = Tokens.Accent,
      fontSize = 8.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.5.sp,
    )
    Text(
      stringResource(R.string.tv_settings_title),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    Spacer(Modifier.height(8.dp))
    Column(
      modifier = Modifier.width(720.dp).focusGroup(),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      SettingsRow(
        label = stringResource(R.string.tv_server_address),
        value = address,
        onClick = onSignOut,
        modifier = Modifier.testTag(TagSettingsRowServer).focusRequester(focusRequester),
      )
      SettingsRow(
        label = stringResource(R.string.tv_account),
        value = stringResource(R.string.auth_signed_in_as, username),
        onClick = { openPanel(SettingsPanel.SignOut, accountFocus) },
        modifier = Modifier.testTag(TagSettingsRowAccount).focusRequester(accountFocus),
      )
      SettingsRow(
        label = stringResource(R.string.settings_ui_language),
        value = interfaceName,
        onClick = { openPanel(SettingsPanel.UiLanguage, uiFocus) },
        modifier = Modifier.testTag(TagSettingsRowUiLanguage).focusRequester(uiFocus),
      )
      SettingsRow(
        label = stringResource(R.string.settings_audio_language),
        value = audioName,
        onClick = { openPanel(SettingsPanel.AudioLanguage, audioFocus) },
        modifier = Modifier.testTag(TagSettingsRowAudio).focusRequester(audioFocus),
      )
      SettingsRow(
        label = stringResource(R.string.settings_subtitle_language),
        value = subtitleName,
        onClick = { openPanel(SettingsPanel.SubtitleLanguage, subtitleFocus) },
        modifier = Modifier.testTag(TagSettingsRowSubtitle).focusRequester(subtitleFocus),
      )
      SettingsRow(
        label = stringResource(R.string.settings_start_view),
        value = startName,
        onClick = { openPanel(SettingsPanel.StartView, startFocus) },
        modifier = Modifier.testTag(TagSettingsRowStartView).focusRequester(startFocus),
      )
      SettingsRow(
        label = stringResource(R.string.tv_home_layout),
        value = if (homeLayout is HomeLayoutState.Unavailable) stringResource(R.string.tv_home_layout_unavailable) else "",
        onClick = { if (homeLayout is HomeLayoutState.Ready) openPanel(SettingsPanel.HomeLayout, homeFocus) },
        modifier = Modifier.testTag(TagSettingsRowHomeLayout).focusRequester(homeFocus),
      )
      ToggleRow(
        label = stringResource(R.string.tv_prefer_conversion),
        note = stringResource(R.string.tv_prefer_conversion_note),
        value = stringResource(if (preferConversion) R.string.tv_on else R.string.tv_off),
        onToggle = onPreferConversion,
        modifier = Modifier.testTag(TagSettingsRowPreferConversion),
      )
      InfoRow(
        label = stringResource(R.string.tv_device),
        value = listOfNotNull(deviceModel.takeIf { it.isNotBlank() }, stringResource(R.string.android_version, deviceRelease)).joinToString(" · "),
        note = listOf(decodeLine, passthroughLine).filter { it.isNotBlank() }.joinToString(" · "),
        modifier = Modifier.testTag(TagSettingsRowDevice),
      )
      InfoRow(
        label = stringResource(R.string.tv_version),
        value = if (serverVersion == null) appVersion else stringResource(R.string.tv_version_row, appVersion, serverVersion),
        note = if (Versions.differsInMinor(appVersion, serverVersion)) {
          stringResource(R.string.tv_version_mismatch, serverVersion.orEmpty(), appVersion)
        } else {
          ""
        },
        noteColor = Tokens.Gold,
        modifier = Modifier.testTag(TagSettingsRowVersion),
      )
      DiagnosticsRow(
        label = stringResource(R.string.tv_send_diagnostics),
        note = stringResource(R.string.tv_send_diagnostics_note),
        value = diagnosticsValue,
        onClick = onSendDiagnostics,
        modifier = Modifier.testTag(TagSettingsRowDiagnostics),
      )
    }
    state.error?.let { failure ->
      Text(
        stringResource(failure.messageRes()),
        color = Tokens.Red,
        fontSize = 11.sp,
        modifier = Modifier.testTag(TagSettingsError),
      )
    }
  }

  when (panel) {
    null -> Unit
    SettingsPanel.SignOut -> SidePanel(
      title = stringResource(R.string.auth_sign_out),
      onClose = { closePanel() },
      modifier = Modifier.testTag(TagSettingsPanel),
      initialFocus = panelFocus,
    ) {
      Text(stringResource(R.string.tv_sign_out_confirm), color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
      Spacer(Modifier.height(4.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        FocusButton(
          text = stringResource(R.string.common_cancel),
          onClick = { closePanel() },
          modifier = Modifier.focusRequester(panelFocus).testTag(TagSettingsSignOutCancel),
        )
        FocusButton(
          text = stringResource(R.string.auth_sign_out),
          onClick = { closePanel(); onSignOut() },
          kind = FocusButtonKind.Primary,
          modifier = Modifier.testTag(TagSettingsSignOutConfirm),
        )
      }
    }
    SettingsPanel.UiLanguage -> SidePanel(
      title = stringResource(R.string.settings_ui_language),
      onClose = { closePanel() },
      modifier = Modifier.testTag(TagSettingsPanel),
      initialFocus = panelFocus,
    ) {
      val selected = UI_LOCALE_NAMES.indexOfFirst { it.first == uiLanguage }.coerceAtLeast(0)
      UI_LOCALE_NAMES.forEachIndexed { index, (code, name) ->
        PanelOption(
          text = name,
          selected = code == uiLanguage,
          onClick = { closePanel(); onUiLanguage(code) },
          modifier = Modifier
            .testTag(settingsOptionTag("ui", code))
            .then(if (index == selected) Modifier.focusRequester(panelFocus) else Modifier),
        )
      }
    }
    SettingsPanel.AudioLanguage -> ContentLanguagePanel(
      title = stringResource(R.string.settings_audio_language),
      languages = languages,
      current = state.audioLanguage,
      uiLanguage = uiLanguage,
      kind = "audio",
      panelFocus = panelFocus,
      onClose = { closePanel() },
      onPick = { closePanel(); onAudioLanguage(it) },
    )
    SettingsPanel.SubtitleLanguage -> ContentLanguagePanel(
      title = stringResource(R.string.settings_subtitle_language),
      languages = languages,
      current = state.subtitleLanguage,
      uiLanguage = uiLanguage,
      kind = "subtitle",
      panelFocus = panelFocus,
      onClose = { closePanel() },
      onPick = { closePanel(); onSubtitleLanguage(it) },
    )
    SettingsPanel.StartView -> SidePanel(
      title = stringResource(R.string.settings_start_view),
      onClose = { closePanel() },
      modifier = Modifier.testTag(TagSettingsPanel),
      initialFocus = panelFocus,
    ) {
      val selected = START_VIEWS.indexOf(startView)
      START_VIEWS.forEachIndexed { index, view ->
        PanelOption(
          text = when (view) {
            "home" -> stringResource(R.string.nav_home)
            "library" -> stringResource(R.string.nav_library)
            else -> stringResource(R.string.nav_catalog)
          },
          selected = view == startView,
          onClick = { closePanel(); onStartView(view) },
          modifier = Modifier
            .testTag(settingsOptionTag("start", view))
            .then(if (index == selected) Modifier.focusRequester(panelFocus) else Modifier),
        )
      }
    }
    SettingsPanel.HomeLayout -> HomeLayoutPanel(
      state = homeLayout,
      onToggle = onToggleHomeRow,
      onMove = onMoveHomeRow,
      onMoveTop = onMoveTopHomeRow,
      onReset = onResetHomeLayout,
      onFlush = onFlushHomeLayout,
      onClose = { closePanel() },
      modifier = Modifier.testTag(TagSettingsPanel),
    )
  }
}

@Composable
private fun ContentLanguagePanel(
  title: String,
  languages: List<LanguageDto>,
  current: String?,
  uiLanguage: String?,
  kind: String,
  panelFocus: FocusRequester,
  onClose: () -> Unit,
  onPick: (String) -> Unit,
) {
  SidePanel(title = title, onClose = onClose, modifier = Modifier.testTag(TagSettingsPanel), initialFocus = panelFocus) {
    val selected = languages.indexOfFirst { it.code == current }.let { if (it >= 0) it else 0 }
    languages.forEachIndexed { index, language ->
      PanelOption(
        text = contentLanguageLabel(language.code, uiLanguage),
        selected = language.code == current,
        onClick = { onPick(language.code) },
        modifier = Modifier
          .testTag(settingsOptionTag(kind, language.code))
          .then(if (index == selected) Modifier.focusRequester(panelFocus) else Modifier),
      )
    }
  }
}

/** Localizes a content language from its code, the way the web's `languageName` does. */
fun contentLanguageLabel(code: String, uiLanguage: String?): String {
  val display = Locale.forLanguageTag(uiLanguage ?: "en")
  val label = Locale.forLanguageTag(code).getDisplayLanguage(display)
  if (label.isBlank()) return code.uppercase(Locale.ROOT)
  return label.replaceFirstChar { if (it.isLowerCase()) it.titlecase(display) else it.toString() }
}

@Composable
private fun SettingsRow(
  label: String,
  value: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth().height(44.dp),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Color.Transparent,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f, pressedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(label, modifier = Modifier.weight(1f), color = Tokens.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(value, modifier = Modifier.weight(1f, fill = false), color = Tokens.Muted, fontSize = 13.sp, textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Spacer(Modifier.width(10.dp))
      Chevron()
    }
  }
}

/** A device-local switch: OK flips it in place, with no panel and nothing sent to the server. */
@Composable
private fun ToggleRow(
  label: String,
  note: String,
  value: String,
  onToggle: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Row(
    modifier = modifier
      .fillMaxWidth()
      .height(56.dp)
      // Observes the row's own focus target, so it has to sit before `focusable()`.
      .onFocusChanged { focused = it.isFocused }
      .focusable()
      .semantics(mergeDescendants = true) {}
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
          Key.Enter, Key.DirectionCenter, Key.Spacebar -> { onToggle(); true }
          else -> false
        }
      }
      .then(if (focused) Modifier.background(Tokens.Panel2, shape).border(1.5.dp, Tokens.Accent2, shape) else Modifier)
      .padding(horizontal = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(label, color = Tokens.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(note, color = Tokens.Muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    Text(value, modifier = Modifier.weight(1f, fill = false), color = Tokens.Muted, fontSize = 13.sp, textAlign = TextAlign.End, maxLines = 1)
  }
}

/** An action with a note under its label: OK posts the app's diagnostics buffer to the server. */
@Composable
private fun DiagnosticsRow(
  label: String,
  note: String,
  value: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth().height(56.dp),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Color.Transparent,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f, pressedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = Tokens.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(note, color = Tokens.Muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
      }
      if (value != null) {
        Text(value, color = Tokens.Muted, fontSize = 13.sp, textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

/** A row the viewer cannot focus: a fact about the device, not a choice. */
@Composable
private fun InfoRow(
  label: String,
  value: String,
  note: String,
  modifier: Modifier = Modifier,
  noteColor: Color = Tokens.Muted,
) {
  Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(label, modifier = Modifier.weight(1f), color = Tokens.Muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
      Text(value, modifier = Modifier.weight(1f, fill = false), color = Tokens.Muted, fontSize = 13.sp, textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (note.isNotBlank()) {
      Text(note, color = noteColor, fontSize = 11.sp, lineHeight = 15.sp, modifier = Modifier.testTag("settings_note_$label"))
    }
  }
}

@Composable
private fun Chevron() {
  androidx.tv.material3.Icon(
    ChevronIcon,
    contentDescription = null,
    tint = Tokens.Muted,
    modifier = Modifier.size(14.dp),
  )
}

private val ChevronIcon: ImageVector = ImageVector.Builder(
  name = "Chevron",
  defaultWidth = 24.dp,
  defaultHeight = 24.dp,
  viewportWidth = 24f,
  viewportHeight = 24f,
).apply {
  path(
    stroke = SolidColor(Color.White),
    strokeLineWidth = 2f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
  ) {
    moveTo(9f, 5f)
    lineTo(16f, 12f)
    lineTo(9f, 19f)
  }
}.build()
