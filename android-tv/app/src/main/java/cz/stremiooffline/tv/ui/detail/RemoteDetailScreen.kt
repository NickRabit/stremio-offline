package cz.stremiooffline.tv.ui.detail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.ActionCaption
import cz.stremiooffline.tv.ui.catalog.ActionIconButton
import cz.stremiooffline.tv.ui.catalog.ForgetIcon
import cz.stremiooffline.tv.ui.catalog.NativeCopyRequest
import cz.stremiooffline.tv.ui.catalog.NativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.ReplayIcon
import cz.stremiooffline.tv.ui.catalog.SourcesPanel
import cz.stremiooffline.tv.ui.catalog.nativeCopyTitle
import cz.stremiooffline.tv.ui.catalog.nativeQueueTarget
import cz.stremiooffline.tv.ui.catalog.resolveNativeCopy
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.library.RemoteSeriesScreen
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagRemoteDetailPlay = "remote_play"
const val TagRemoteDetailStartOver = "remote_start_over"
const val TagRemoteDetailFavorite = "remote_favorite"
const val TagRemoteDetailWatched = "remote_watched"
const val TagRemoteDetailVersions = "remote_versions"
const val TagRemoteStateCaption = "remote_state_caption"
const val TagRemoteSourcesRetry = "remote_sources_retry"
const val TagRemoteStateRetry = "remote_state_retry"
const val TagRemoteDetailToLibrary = "remote_to_library"
const val TagRemoteCopyNotice = "remote_copy_notice"

/** What one native remote item's detail needs: the library and the item's opaque id. */
data class RemoteDetailData(
  val libraryId: String,
  val libraryName: String,
  val provider: String,
  val item: RemoteItemDto,
  val seriesName: String? = null,
  /** The parent series' external ids, when the caller already holds them, so an episode's copy
   *  carries the series' catalogue id without reading the parent again. */
  val seriesIds: RemoteProviderIdsDto? = null,
) {
  val isEpisode: Boolean get() = item.type == "episode"
}

/**
 * The playable detail of one native remote item: its versions, an explicit Resume and Play from
 * beginning, and local favourite/watched toggles. No download, rename, delete, identify or
 * path action exists, and the caption names the state store so it is not mistaken for the server's.
 */
@Composable
fun RemoteDetailScreen(
  api: RemoteLibraryApi,
  data: RemoteDetailData,
  /** The session image loader; remote artwork is same-origin and content-authorized. */
  imageUrl: (String?) -> String? = { null },
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  backEnabled: Boolean = true,
  restoreToken: Int = 0,
  /** The destinations this account may copy into, read once when the copy action is pressed.
   *  Null keeps the action off entirely, which is what a harness with no catalogue surface passes. */
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  /** Queues one exact version into the exact library the viewer picked. */
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
) {
  // A series has no playable versions of its own: its card opens the episode grid instead.
  if (data.item.type == "series" || data.item.type == "season") {
    RemoteSeriesScreen(
      api = api,
      data = data,
      imageUrl = imageUrl,
      onPlay = onPlay,
      onBack = onBack,
      backEnabled = backEnabled,
      restoreToken = restoreToken,
      loadDestinations = loadDestinations,
      onQueue = onQueue,
    )
    return
  }

  val scope = rememberCoroutineScope()
  // Back over an item detail closes it; a hidden section-level handler must never take it, and the
  // versions panel installed later in this composition still closes first.
  BackHandler(enabled = backEnabled) { onBack() }
  val identity = data.libraryId to data.item.id
  val live = rememberUpdatedState(identity)

  var sources by remember(identity) { mutableStateOf<List<StreamDto>>(emptyList()) }
  var sourcesLoading by remember(identity) { mutableStateOf(true) }
  var sourcesError by remember(identity) { mutableStateOf(false) }
  var state by remember(identity) { mutableStateOf<RemoteItemStateDto?>(null) }
  var stateLoading by remember(identity) { mutableStateOf(true) }
  var stateError by remember(identity) { mutableStateOf(false) }
  var mutationError by remember(identity) { mutableStateOf(false) }
  var favouriteBusy by remember(identity) { mutableStateOf(false) }
  var watchedBusy by remember(identity) { mutableStateOf(false) }
  var forgetBusy by remember(identity) { mutableStateOf(false) }
  var sourceListOpen by remember(identity) { mutableStateOf(false) }
  // The copy panel: nothing is read for it until the viewer presses the action.
  var copyRequest by remember(identity) { mutableStateOf<NativeCopyRequest?>(null) }
  var copyResolving by remember(identity) { mutableStateOf(false) }
  var copyBusy by remember(identity) { mutableStateOf(false) }
  var copyNotice by remember(identity) { mutableStateOf<String?>(null) }
  var copyWasOpen by remember(identity) { mutableStateOf(false) }
  val caption = remember(identity) { ActionCaption() }

  val playFocus = remember { FocusRequester() }
  val versionsFocus = remember { FocusRequester() }
  val copyFocus = remember { FocusRequester() }
  val sourcesRetryFocus = remember { FocusRequester() }
  val stateRetryFocus = remember { FocusRequester() }
  val statusFocus = remember { FocusRequester() }
  val sourcesEntry = remember { FocusRequester() }

  /** Reads with the token it was asked under; a landed answer for a replaced item is dropped. */
  suspend fun loadSources(mine: Pair<String, String>) {
    sourcesLoading = true
    sourcesError = false
    try {
      val found = api.remoteSources(data.libraryId, data.item.id).filter { Streams.isRemoteStream(it) }
      if (live.value != mine) return
      sources = found
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      if (live.value == mine) sourcesError = true
    } finally {
      if (live.value == mine) sourcesLoading = false
    }
  }

  suspend fun loadState(mine: Pair<String, String>) {
    stateLoading = true
    stateError = false
    try {
      val loaded = api.remoteItemState(data.libraryId, data.item.id)
      if (live.value != mine) return
      state = loaded
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      if (live.value == mine) stateError = true
    } finally {
      if (live.value == mine) stateLoading = false
    }
  }

  val mine = identity
  LaunchedEffect(identity, restoreToken) {
    sourceListOpen = false
    caption.text = ""
    mutationError = false
    loadSources(mine)
    loadState(mine)
  }

  val stateLoaded = state != null && !stateError
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val destinationsFailedText = stringResource(R.string.media_server_error)
  val canCopy = onQueue != null && loadDestinations != null && sources.any { Streams.canQueue(it, false) }
  val stored = state
  val savedSourceId = stored?.mediaSourceId
  val favorite = stored?.favorite == true
  val watched = stored?.watched == true
  // The version the viewer last watched leads, so its Resume is the one offered.
  val primary = sources.firstOrNull { it.remoteItem?.mediaSourceId != null && it.remoteItem.mediaSourceId == savedSourceId }
    ?: sources.firstOrNull()
  // The saved position belongs to the exact version that stored it; another version shows none.
  val sameVersion = primary?.remoteItem?.mediaSourceId == savedSourceId
  // Resume is offered only for the same version that stored the position and never for an item
  // already marked watched; any other version, or an unknown one, starts from the beginning.
  val resuming = stateLoaded && savedSourceId != null && !watched && sameVersion &&
    Progress.resumePosition(stored?.position ?: 0.0, stored?.duration ?: 0.0) != null
  /** A stored position the primary version owns, so Start over can still be offered beside Play. */
  val savedOnPrimary = stateLoaded && sameVersion && (stored?.position ?: 0.0) > 0.0

  fun play(source: StreamDto?, resume: Boolean) {
    val context = source?.remoteItem ?: return
    onPlay(
      PlayTarget(
        key = context.progressKey,
        title = titleOf(data),
        resume = resume,
        sourceId = source.sourceId.takeIf { it.isNotBlank() },
        remoteItem = context,
        remoteSources = sources,
      ),
    )
  }

  fun toggleFavourite() {
    if (favouriteBusy || !stateLoaded) return
    val wanted = !favorite
    favouriteBusy = true
    mutationError = false
    scope.launch {
      try {
        val next = api.patchRemoteItemState(data.libraryId, data.item.id, RemoteItemStatePatch(favorite = wanted))
        if (live.value == mine) state = next
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) favouriteBusy = false
      }
    }
  }

  fun toggleWatched() {
    if (watchedBusy || !stateLoaded) return
    val wanted = !watched
    watchedBusy = true
    mutationError = false
    scope.launch {
      try {
        val next = api.patchRemoteItemState(data.libraryId, data.item.id, RemoteItemStatePatch(watched = wanted))
        if (live.value == mine) state = next
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) watchedBusy = false
      }
    }
  }

  /** Forgetting this item's stored position: the same local remote-state endpoint, cleared to
   *  zero, never the generic forget route. */
  fun forgetProgress() {
    if (forgetBusy || !stateLoaded) return
    forgetBusy = true
    mutationError = false
    scope.launch {
      try {
        val next = api.patchRemoteItemState(data.libraryId, data.item.id, RemoteItemStatePatch(position = 0.0, duration = 0.0))
        if (live.value == mine) state = next
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) forgetBusy = false
      }
    }
  }

  /** Reads, once the action is pressed, the parent series, the versions and the destinations the
   *  copy needs; the panel opens only once it has them, so no row ever acts on nothing. The read
   *  stays cancellable: leaving the item drops a late answer. */
  fun openCopy() {
    val load = loadDestinations ?: return
    if (copyResolving || copyBusy) return
    copyResolving = true
    copyNotice = null
    scope.launch {
      try {
        val resolved = resolveNativeCopy(
          api = api,
          libraryId = data.libraryId,
          item = data.item,
          seriesName = data.seriesName,
          seriesIds = data.seriesIds,
          sources = sources.takeIf { it.isNotEmpty() },
          loadDestinations = load,
        )
        if (live.value == mine) copyRequest = resolved
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine) copyNotice = error.serverMessage
          ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
      } catch (_: Exception) {
        if (live.value == mine) copyNotice = destinationsFailedText
      } finally {
        if (live.value == mine) copyResolving = false
      }
    }
  }

  /** Queues the exact version the panel captured. A refusal leaves the panel and its choice up,
   *  so another destination can be tried without picking the version again. */
  fun queueCopy(stream: StreamDto, libraryId: String) {
    val queue = onQueue ?: return
    val subject = copyRequest?.subject ?: return
    if (copyBusy) return
    copyBusy = true
    copyNotice = null
    scope.launch {
      try {
        queue(nativeCopyTitle(subject), stream.sourceId, subject.media(), nativeQueueTarget(stream, libraryId))
        if (live.value == mine) { copyRequest = null; copyNotice = null }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine) copyNotice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (live.value == mine) copyNotice = notAllowedText
      } finally {
        if (live.value == mine) copyBusy = false
      }
    }
  }

  // Closing the panel, whether it queued or the viewer backed out, returns the remote to the
  // action that opened it once the panel and its focus trap are gone.
  LaunchedEffect(copyRequest) {
    if (copyRequest != null) {
      copyWasOpen = true
    } else if (copyWasOpen) {
      copyWasOpen = false
      runCatching { copyFocus.requestFocus() }
    }
  }

  // Focus follows what is actually actionable: the Retry on a failure, otherwise Play once a
  // version exists. Loading and empty states still hold a focusable target so the remote cannot
  // go dead over the player-less detail.
  LaunchedEffect(identity, restoreToken, sourcesLoading, sourcesError, sources.isEmpty(), stateLoaded, stateError) {
    if (sourcesLoading) {
      awaitFrame()
      runCatching { statusFocus.requestFocus() }
      return@LaunchedEffect
    }
    awaitFrame()
    val target = when {
      sourcesError -> sourcesRetryFocus
      sources.isEmpty() -> statusFocus
      stateError -> stateRetryFocus
      else -> playFocus
    }
    runCatching { target.requestFocus() }
  }

  Box(Modifier.fillMaxSize().background(Tokens.Bg)) {
    // The item's own artwork when the server exposed it, else the plain gradient behind it.
    val art = imageUrl(data.item.wide ?: data.item.poster)
    if (art != null) {
      AsyncImage(model = art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Panel2.copy(alpha = 0.4f), Tokens.Bg, Tokens.Bg))))
    Column(
      Modifier.fillMaxSize().padding(start = 60.dp, top = Tokens.SafeY, end = 60.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(eyebrow(data), color = Tokens.Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
      Text(
        titleOf(data),
        color = Tokens.Text,
        fontSize = 40.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(820.dp),
      )
      Text(
        listOfNotNull(data.provider.ifBlank { null }, data.libraryName.ifBlank { null }, stringResource(R.string.media_server_read_only))
          .joinToString(" · "),
        color = Tokens.Muted,
        fontSize = 11.5.sp,
        fontWeight = FontWeight.Medium,
      )
      // The same bar the local detail draws, from the same saved position numbers.
      if (stateLoaded && sameVersion) {
        SavedPlaybackProgress(
          position = stored?.position ?: 0.0,
          duration = stored?.duration ?: 0.0,
          tag = TagRemoteDetailWatched,
        )
      }
      Text(stringResource(R.string.media_server_state_local), color = Tokens.Muted, fontSize = 10.sp, modifier = Modifier.testTag(TagRemoteStateCaption))
      Spacer(Modifier.height(3.dp))

      Row(horizontalArrangement = Arrangement.spacedBy(11.dp), verticalAlignment = Alignment.CenterVertically) {
        FocusButton(
          text = stringResource(if (resuming) R.string.tv_resume else R.string.tv_play),
          onClick = { play(primary, resume = resuming) },
          kind = FocusButtonKind.Primary,
          enabled = primary != null,
          modifier = Modifier.focusRequester(playFocus).testTag(TagRemoteDetailPlay),
        )
        if (resuming || savedOnPrimary) {
          ActionIconButton(
            label = stringResource(R.string.tv_start_over),
            icon = ReplayIcon,
            onClick = { play(primary, resume = false) },
            caption = caption,
            modifier = Modifier.testTag(TagRemoteDetailStartOver),
          )
        }
        if (sources.size > 1) {
          FocusButton(
            text = stringResource(R.string.media_server_versions),
            onClick = { sourceListOpen = true },
            modifier = Modifier.focusRequester(versionsFocus).testTag(TagRemoteDetailVersions),
          )
        }
        // The copy action is shown only when an exactly copyable version is in hand: the device
        // save stays denied and a denied native right offers nothing rather than a failing button.
        if (canCopy) {
          FocusButton(
            text = stringResource(R.string.save_to_library),
            onClick = { openCopy() },
            enabled = !copyResolving && !copyBusy,
            modifier = Modifier.focusRequester(copyFocus).testTag(TagRemoteDetailToLibrary),
          )
        }
        // The local toggles act on the stored state; without it they would be no-ops, so they are
        // not drawn at all until the state is known.
        if (stateLoaded) {
          ActionIconButton(
            label = stringResource(if (favorite) R.string.favorite_remove else R.string.favorite_add),
            icon = null,
            glyph = if (favorite) "★" else "☆",
            onClick = { toggleFavourite() },
            enabled = !favouriteBusy && !watchedBusy,
            caption = caption,
            modifier = Modifier.testTag(TagRemoteDetailFavorite),
          )
          ActionIconButton(
            label = stringResource(if (watched) R.string.media_server_unwatch else R.string.media_server_mark_watched),
            icon = null,
            glyph = if (watched) "✔" else "✓",
            onClick = { toggleWatched() },
            enabled = !favouriteBusy && !watchedBusy,
            caption = caption,
          )
          // A stored position is this item's to forget, through the same state endpoint.
          if ((stored?.position ?: 0.0) > 0) {
            ActionIconButton(
              label = stringResource(R.string.tv_forget_progress),
              icon = ForgetIcon,
              onClick = { forgetProgress() },
              enabled = !favouriteBusy && !watchedBusy && !forgetBusy,
              caption = caption,
            )
          }
        }
        if (caption.text.isNotEmpty()) Text(caption.text, color = Tokens.Muted, fontSize = 12.sp, maxLines = 1)
      }

      // A copy that never opened its panel (no readable destinations, no native right) says why
      // here instead; pressing the action again is the retry.
      if (copyNotice != null && copyRequest == null) {
        Text(copyNotice!!, color = Tokens.Red, fontSize = 11.5.sp, modifier = Modifier.testTag(TagRemoteCopyNotice))
      }
      if (mutationError) Text(stringResource(R.string.media_server_state_error), color = Tokens.Red, fontSize = 11.5.sp)

      Box(Modifier.weight(1f)) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          when {
            sourcesLoading -> Text(
              stringResource(R.string.media_server_finding_versions),
              color = Tokens.Muted,
              fontSize = 11.5.sp,
              modifier = Modifier.focusRequester(statusFocus).focusable(),
            )
            sourcesError -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(stringResource(R.string.media_server_sources_error), color = Tokens.Red, fontSize = 11.5.sp)
              FocusButton(
                stringResource(R.string.tv_try_again),
                onClick = { scope.launch { loadSources(mine) } },
                modifier = Modifier.focusRequester(sourcesRetryFocus).testTag(TagRemoteSourcesRetry),
              )
            }
            sources.isEmpty() -> Box(
              Modifier.focusRequester(statusFocus).focusable(),
            ) {
              Text(stringResource(R.string.media_server_sources_empty), color = Tokens.Muted, fontSize = 11.5.sp)
            }
            else -> Text(stringResource(R.string.media_server_versions_available, sources.size.toString()), color = Tokens.Muted, fontSize = 11.sp)
          }
          if (stateError) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(stringResource(R.string.media_server_state_error), color = Tokens.Red, fontSize = 11.5.sp)
              FocusButton(
                stringResource(R.string.tv_try_again),
                onClick = { scope.launch { loadState(mine) } },
                modifier = Modifier.focusRequester(stateRetryFocus).testTag(TagRemoteStateRetry),
              )
            }
          }
        }
      }
    }

    if (sourceListOpen) {
      SourcesPanel(
        streams = sources,
        focusIndex = 0,
        onChoose = {
          sourceListOpen = false
          play(it, resume = false)
        },
        onClose = {
          sourceListOpen = false
          runCatching { versionsFocus.requestFocus() }
        },
        default = primary,
        emptyText = stringResource(R.string.media_server_sources_empty),
        failureText = stringResource(R.string.media_server_sources_error),
        initialFocus = sourcesEntry,
      )
    }

    val request = copyRequest
    if (request != null) {
      val kind = if (data.isEpisode) "series" else "movie"
      NativeQueuePanel(
        versions = request.versions,
        libraries = request.destinations.filter { it.canWrite && (it.type == kind || it.type == "mixed") },
        preferred = primary,
        busy = copyBusy,
        notice = copyNotice,
        onQueue = { stream, libraryId -> queueCopy(stream, libraryId) },
        onClose = {
          copyRequest = null
          copyNotice = null
        },
      )
    }
  }
}

@Composable
private fun eyebrow(data: RemoteDetailData): String =
  when {
    data.isEpisode && !data.seriesName.isNullOrBlank() -> stringResource(R.string.media_server_eyebrow_episode, data.seriesName)
    else -> stringResource(R.string.media_server_eyebrow)
  }.uppercase()

private fun titleOf(data: RemoteDetailData): String =
  if (data.isEpisode && (data.item.season != null || data.item.episode != null)) {
    "${data.item.name} · S${data.item.season ?: 0} · E${data.item.episode ?: 0}"
  } else {
    data.item.name
  }
