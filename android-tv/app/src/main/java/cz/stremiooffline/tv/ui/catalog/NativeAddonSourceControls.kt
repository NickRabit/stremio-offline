package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagAddonDiscover = "addon_discover"
const val TagAddonFinding = "addon_finding"
const val TagAddonDiscoveryRetry = "addon_discovery_retry"
const val TagAddonNoProviders = "addon_no_providers"

fun addonProviderTag(key: String): String = "addon_provider_$key"
fun addonProviderRetryTag(key: String): String = "addon_provider_retry_$key"

/**
 * The explicit addon discovery the native detail draws as the last row of its Sources panel. One
 * press names the providers, one press loads one provider's own key; the loaded rows join the
 * panel's own list above, so a failed or empty provider leaves every native row where it was.
 *
 * Every control here keeps its node for as long as the block is up: a button whose label changes
 * with the state is never unmounted, because a replaced node hands the remote back to the detail
 * behind the panel and the viewer loses the D-pad to a screen they cannot see.
 */
@Composable
fun NativeAddonSourceControls(
  state: NativeAddonSources,
  onDiscover: () -> Unit,
  onLoadProvider: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  val findingText = stringResource(R.string.tv_finding_sources)
  val errorText = stringResource(R.string.tv_load_error)
  val retryText = stringResource(R.string.tv_try_again)
  val emptyText = stringResource(R.string.sources_none)
  val loadText = stringResource(R.string.sources_load_provider)
  val discoverText = stringResource(R.string.sources_load_addons)
  val noProvidersText = stringResource(R.string.sources_no_addon_providers)
  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    val retried = state.discovery == AddonDiscovery.Failed || state.discovery == AddonDiscovery.Empty
    FocusButton(
      text = if (retried) retryText else discoverText,
      onClick = onDiscover,
      modifier = Modifier.testTag(if (retried) TagAddonDiscoveryRetry else TagAddonDiscover),
    )
    when (state.discovery) {
      AddonDiscovery.Loading -> StatusLine(findingText, TagAddonFinding)
      AddonDiscovery.Failed -> Text(errorText, color = Tokens.Red, fontSize = 12.sp, lineHeight = 17.sp)
      AddonDiscovery.Empty -> StatusLine(noProvidersText, TagAddonNoProviders)
      else -> Unit
    }
    if (state.discovery == AddonDiscovery.Ready) {
      state.providers.forEach { provider ->
        ProviderControl(
          provider = provider,
          state = state.providerState(provider.key),
          findingText = findingText,
          errorText = errorText,
          emptyText = emptyText,
          retryText = retryText,
          loadText = loadText,
          onLoad = { onLoadProvider(provider.key) },
        )
      }
    }
  }
}

/** One provider: its own name, one button that loads this provider's key and then retries it, and
 *  the state that load left behind. The button is the same node throughout, so a failure or an
 *  empty answer never hands the remote back to what is behind the panel. */
@Composable
private fun ProviderControl(
  provider: StreamSourceDto,
  state: AddonProviderState?,
  findingText: String,
  errorText: String,
  emptyText: String,
  retryText: String,
  loadText: String,
  onLoad: () -> Unit,
) {
  val label = provider.name.ifBlank { provider.key }
  val load = state?.load
  val retried = load == AddonProviderLoad.Failed || load == AddonProviderLoad.Empty
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(label, color = Tokens.Text, fontSize = 12.5.sp, lineHeight = 17.sp)
    FocusButton(
      text = if (retried) retryText else loadText,
      onClick = onLoad,
      modifier = Modifier.testTag(if (retried) addonProviderRetryTag(provider.key) else addonProviderTag(provider.key)),
    )
    when (load) {
      AddonProviderLoad.Loading -> Text(findingText, color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
      AddonProviderLoad.Failed -> Text(errorText, color = Tokens.Red, fontSize = 12.sp, lineHeight = 17.sp)
      AddonProviderLoad.Empty -> Text(emptyText, color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
      else -> Unit
    }
  }
}

/** A provider status still has to hold the remote, or the D-pad would fall out of the list. */
@Composable
private fun StatusLine(text: String, tag: String) {
  Box(Modifier.testTag(tag).focusable()) {
    Text(text, color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
  }
}
