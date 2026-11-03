package cz.stremiooffline.tv.ui.library

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.BulkOrigin
import cz.stremiooffline.tv.ui.catalog.SeriesDownloadPanel
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.catalog.TagSeriesDownloadPanel
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException

private data class RemoteBulkPanelData(
  val settings: SettingsResponse,
  val addons: List<AddonDto>,
  val libraries: List<LibraryDto>,
)

@Composable
internal fun RemoteSeriesBulkHost(
  api: TvApi,
  origin: BulkOrigin.Remote,
  title: String,
  loadDestinations: suspend () -> List<LibraryDto>,
  onQueued: (added: Int, skipped: Int) -> Unit,
  onClose: () -> Unit,
  onThisEpisode: (() -> Unit)? = null,
  thisEpisodeLabel: String? = null,
) {
  var data by remember(origin) { mutableStateOf<RemoteBulkPanelData?>(null) }
  var failure by remember(origin) { mutableStateOf<ApiError?>(null) }
  LaunchedEffect(origin) {
    data = null
    failure = null
    try {
      val libraries = loadDestinations()
      val settings = try {
        api.settings()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        SettingsResponse()
      }
      val addons = try {
        api.addons()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        emptyList()
      }
      data = RemoteBulkPanelData(settings, addons, libraries)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: ApiError) {
      failure = error
    }
  }
  val loaded = data
  if (loaded != null) {
    SeriesDownloadPanel(
      api = api,
      type = "series",
      title = title,
      origin = origin,
      selected = null,
      settings = loaded.settings,
      addons = loaded.addons,
      libraries = loaded.libraries,
      onQueued = onQueued,
      onClose = onClose,
      onThisEpisode = onThisEpisode,
      thisEpisodeLabel = thisEpisodeLabel,
    )
  } else {
    SidePanel(
      title = stringResource(R.string.series_bulk_title),
      onClose = onClose,
      modifier = Modifier.testTag(TagSeriesDownloadPanel),
    ) {
      Text(
        failure?.serverMessage ?: stringResource(
          if (failure == null) R.string.series_bulk_preparing else R.string.media_server_error,
        ),
        color = if (failure == null) Tokens.Muted else Tokens.Red,
        fontSize = 11.sp,
      )
    }
  }
}
