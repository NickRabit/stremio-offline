package cz.stremiooffline.tv.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.diagnostics.AppLog
import cz.stremiooffline.tv.ui.components.BrandMark
import cz.stremiooffline.tv.ui.components.outlineIcon
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.catalog.CatalogDetailScreen
import cz.stremiooffline.tv.ui.catalog.CatalogScreen
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.catalog.remoteResumeCards
import cz.stremiooffline.tv.ui.catalog.SearchScreen
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.initialRemoteMetadata
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.remoteExtrasIdentity
import cz.stremiooffline.tv.ui.detail.remoteMetadataNeedsItem
import cz.stremiooffline.tv.ui.detail.resolveRemoteMetadata
import cz.stremiooffline.tv.ui.downloads.DownloadsScreen
import cz.stremiooffline.tv.ui.downloads.activeJobs
import cz.stremiooffline.tv.ui.favorites.FavoritesRoute
import cz.stremiooffline.tv.ui.home.HomeAction
import cz.stremiooffline.tv.ui.home.HomeScreen
import cz.stremiooffline.tv.ui.library.LibraryRoute
import cz.stremiooffline.tv.ui.player.LibraryPlaySources
import cz.stremiooffline.tv.ui.player.PlayerScreen
import cz.stremiooffline.tv.ui.resume.ResumeRoute
import cz.stremiooffline.tv.ui.search.GlobalSearchScreen
import cz.stremiooffline.tv.ui.search.SearchPreset
import cz.stremiooffline.tv.ui.search.SourceClass
import cz.stremiooffline.tv.ui.search.toPreset
import cz.stremiooffline.tv.ui.settings.SettingsRoute
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import cz.stremiooffline.tv.watchnext.WatchNextEffects
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

enum class Section(val route: String) {
  Search("search"),
  Home("home"),
  Catalog("catalog"),
  Library("library"),
  Resume("resume"),
  Favorites("favorites"),
  Downloads("downloads"),
  Account("account"),
}

/** `startView` from GET /api/settings; an absent or unknown one starts on Home. */
fun startSection(startView: String?): Section = when (startView) {
  "catalog" -> Section.Catalog
  "library" -> Section.Library
  else -> Section.Home
}

private val Section.labelRes: Int
  get() = when (this) {
    Section.Search -> R.string.tv_nav_search
    Section.Home -> R.string.nav_home
    Section.Catalog -> R.string.nav_catalog
    Section.Library -> R.string.nav_library
    Section.Resume -> R.string.nav_resume
    Section.Favorites -> R.string.nav_favorites
    Section.Downloads -> R.string.nav_downloads
    Section.Account -> R.string.nav_settings
  }

const val TAG_RAIL_PREFIX = "rail_"

private enum class SearchOrigin { Rail, Catalog, Library }
private enum class CatalogReturnOrigin { Local, Remote }

/** The rail item of the section on screen, which LEFT out of the content goes to. A focus group in
 *  the content does not inherit the shell's own LEFT, so one that has to leave by it reads this. */
val LocalRailFocus = compositionLocalOf<FocusRequester?> { null }

/** The rail is always icons only: it never widens on focus. */
private val CollapsedRail = 60.dp

internal class CatalogDetailStack {
  var entries by mutableStateOf<List<CatalogDetailArgs>>(emptyList())
    private set

  fun clear() {
    entries = emptyList()
  }

  fun pushRelated(current: CatalogDetailArgs, related: RelatedTitleDto) {
    entries = (entries + current.copy(focusRelatedId = related.id)).takeLast(10)
  }

  fun pop(): CatalogDetailArgs? {
    val previous = entries.lastOrNull() ?: return null
    entries = entries.dropLast(1)
    return previous
  }

  fun detailFor(related: RelatedTitleDto, current: CatalogDetailArgs? = null): CatalogDetailArgs = CatalogDetailArgs(
    meta = MetaDto(
      id = related.id,
      type = related.type,
      name = related.name,
      poster = related.poster,
      releaseInfo = related.year,
    ),
    addonName = current?.addonName.orEmpty(),
    type = related.type,
    addonKey = current?.addonKey,
  )
}

@Composable
fun Shell(
  start: Section,
  api: TvApi,
  username: String,
  onSignOut: () -> Unit,
  /** The confirmed Back on the rail closes the app; the stored session stays signed in. */
  onExitApp: () -> Unit = {},
  address: String = "http://",
  onLocale: (String) -> Unit = {},
) {
  val shellState = rememberSaveable(start, saver = ShellStateSaver) { ShellState(start) }
  val current = shellState.selected
  val sectionStates = rememberSaveableStateHolder()

  // The one binding lookup still out. A newer choice, another detail or another section replaces
  // it, so a late answer never opens a detail over what the viewer moved on to.
  val detailLookup = remember { DetailLookup() }
  var catalogDetail by remember { mutableStateOf<CatalogDetailArgs?>(null) }
  val catalogStack = remember { CatalogDetailStack() }
  var catalogReturnOrigin by remember { mutableStateOf<CatalogReturnOrigin?>(null) }
  var player by remember { mutableStateOf<PlayTarget?>(null) }
  var downloading by remember { mutableStateOf(false) }
  /** The streams of the title the player is on: the catalogue reports them while addons answer. */
  var playerSources by remember { mutableStateOf(OfferedSources()) }
  /** The same for a play that started from the library: the title its file is bound to is looked
   *  up under the player and reported here, and stays empty for a file with no binding. */
  var librarySources by remember { mutableStateOf(OfferedSources()) }
  /** Bumped by the panel's own Try again, so the library-bound discovery reloads on its own. */
  var librarySourcesRetry by remember { mutableIntStateOf(0) }
  /** Bumped by the panel's own Try again, so a catalogue title's remote discovery reloads. */
  var catalogueSourcesRetry by remember { mutableIntStateOf(0) }
  // The native copy action's two catalogue collaborators: the destinations this account may write
  // to, read once when the action is used, and the queue call itself. A failed read is thrown so
  // the screen can say so; both stay off the remote screens' own RemoteLibraryApi.
  val nativeDestinations: suspend () -> List<LibraryDto> = { api.libraries() }
  // The caller resolves the target DTO: a library equal to the version's projected destination
  // travels as no target, so the server resolves its own configured subfolder and layout.
  val nativeQueue: suspend (String, String, MediaDto, DownloadTargetDto?) -> Unit = { title, sourceId, media, target ->
    api.download(title, sourceId, media, target)
  }
  /** The source the player ended on, so the title underneath keeps naming what was watched. */
  var playedSourceId by remember { mutableStateOf<String?>(null) }
  // A section takes the remote back when a detail or a player over it closes; a detail takes it
  // back when the player over it closes. One shared token let the hidden section underneath an open
  // detail grab the focus after the player, and the visible detail looked frozen.
  var returnToken by remember { mutableIntStateOf(0) }
  var detailReturnToken by remember { mutableIntStateOf(0) }
  // Bumped each time Home comes back into view, so re-entering refreshes the rows.
  var homeRefreshToken by remember { mutableIntStateOf(0) }
  var homeSeen by remember { mutableStateOf(false) }
  // A folder a Home card asked for; the library opens it once and clears it.
  var libraryPush by remember { mutableStateOf<String?>(null) }
  var hint by remember { mutableStateOf<String?>(null) }
  val hintScope = rememberCoroutineScope()
  // A short notice over the content: Home's own messages and Settings' confirmed actions.
  fun showHint(text: String) {
    hint = text
    hintScope.launch {
      delay(2_500)
      if (hint == text) hint = null
    }
  }
  // A crash the previous run left is worth one line on the way in; sending it is a Settings row.
  val crashContext = LocalContext.current
  val crashHint = stringResource(R.string.tv_crash_hint)
  LaunchedEffect(Unit) {
    if (AppLog.readCrash(AppLog.crashFile(crashContext.filesDir)) == null) return@LaunchedEffect
    hint = crashHint
    hintScope.launch {
      delay(4_000)
      if (hint == crashHint) hint = null
    }
  }
  // Bumped each time Library comes back into view, so re-entering refreshes without losing focus.
  var libraryRefreshToken by remember { mutableIntStateOf(0) }
  var librarySeen by remember { mutableStateOf(false) }
  // Bumped each time Favourites comes back into view, so a star removed elsewhere disappears.
  var favoritesRefreshToken by remember { mutableIntStateOf(0) }
  var favoritesSeen by remember { mutableStateOf(false) }
  var resumeRefreshToken by remember { mutableIntStateOf(0) }
  var resumeSeen by remember { mutableStateOf(false) }
  // Where the flag-off catalogue search looks, kept across a rail switch.
  var searchScope by remember { mutableStateOf(SearchScope()) }
  var searchOrigin by remember { mutableStateOf(SearchOrigin.Rail) }
  var searchPreset by remember { mutableStateOf<SearchPreset?>(null) }
  var librarySearchReturnToken by remember { mutableIntStateOf(0) }
  var searchEverywhereEnabled by remember { mutableStateOf(false) }
  fun clearCatalogHistory() {
    catalogStack.clear()
    catalogReturnOrigin = null
  }
  fun openCatalog(args: CatalogDetailArgs) {
    detailLookup.cancel()
    clearCatalogHistory()
    catalogDetail = args
  }
  fun openLibraryFolder(path: String) {
    detailLookup.cancel()
    clearCatalogHistory()
    catalogDetail = null
    libraryPush = path
    shellState.pick(Section.Library)
  }
  fun openLibraryDetail(data: DetailData) {
    detailLookup.cancel()
    if (data.files.isEmpty()) {
      openLibraryFolder(data.gridPath)
      return
    }
    val own = ownCatalogueArgs(data)
    // One file stands for itself; a folder of several only for a title bound to the folder as a
    // whole -- a folder of different films never opens as the first one's title.
    val lookupPath = if (data.files.size == 1) data.files.single().path else data.gridPath.takeIf { data.files.isNotEmpty() }
    if (lookupPath.isNullOrBlank()) {
      openCatalog(own)
      return
    }
    detailLookup.job = hintScope.launch {
      try {
        val binding = try {
          withTimeoutOrNull(2_000) { api.libraryTitle(lookupPath) }
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (_: Exception) {
          null
        }
        if (binding != null && binding.type.isNotBlank() && binding.id.isNotBlank()) {
          openCatalog(libraryCatalogueArgs(data, binding))
        } else {
          openCatalog(own)
        }
      } finally {
        detailLookup.done(coroutineContext[Job])
      }
    }
  }
  fun openRemoteDetail(data: RemoteDetailData) {
    detailLookup.cancel()
    detailLookup.job = hintScope.launch {
      try {
        val resolved = try {
          withTimeoutOrNull(2_500) {
            val resolvedItem = if (remoteMetadataNeedsItem(data.item)) {
              try {
                api.remoteItem(data.libraryId, data.item.id).item
                  .takeIf { it.type.isNotBlank() && (it.type == "episode" || it.type == "season" || it.name.isNotBlank()) }
                  ?: return@withTimeoutOrNull null
              } catch (cancelled: CancellationException) {
                throw cancelled
              } catch (_: ApiError) {
                return@withTimeoutOrNull null
              }
            } else {
              data.item
            }
            val metadata = if (resolvedItem.type == "movie" || resolvedItem.type == "series") {
              initialRemoteMetadata(data.copy(item = resolvedItem))
            } else {
              resolveRemoteMetadata(api, data.copy(item = resolvedItem))
            }
            val identity = remoteExtrasIdentity(metadata)
            if (identity == null) {
              remoteOwnCatalogueArgs(api, data, metadata)
            } else {
              val resume = if (identity.first == "series" && metadata.item.type == "series") {
                try {
                  remoteResumeCards(api, data.libraryId)
                } catch (cancelled: CancellationException) {
                  throw cancelled
                } catch (_: Exception) {
                  emptyList()
                }
              } else {
                emptyList()
              }
              remoteCatalogueArgs(data, metadata, identity, resume)
            }
          }
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (_: Exception) {
          null
        }
        if (resolved == null) {
          openCatalog(remoteFallbackCatalogueArgs(data))
        } else {
          openCatalog(resolved)
        }
      } finally {
        detailLookup.done(coroutineContext[Job])
      }
    }
  }
  fun onHomeAction(action: HomeAction) {
    when (action) {
      is HomeAction.Play -> {
        playerSources = OfferedSources()
        playedSourceId = null
        player = action.target
      }
      is HomeAction.OpenLibrary -> {
        libraryPush = action.path
        shellState.pick(Section.Library)
      }
      is HomeAction.OpenDetail -> openLibraryDetail(action.detail)
      is HomeAction.OpenCatalog -> openCatalog(action.args)
      is HomeAction.OpenRemote -> openRemoteDetail(action.data)
    }
  }
  WatchNextEffects(
    api = api,
    playerOpen = player != null,
    onAction = ::onHomeAction,
    onMissing = { shellState.pick(Section.Home) },
  )
  fun openPersonSearch(name: String) {
    catalogDetail = null
    clearCatalogHistory()
    searchScope = SearchScope()
    searchOrigin = SearchOrigin.Rail
    searchPreset = SearchPreset(query = name)
    shellState.pick(Section.Search)
  }
  fun openRelatedFromUnderlying(related: RelatedTitleDto, origin: CatalogReturnOrigin) {
    catalogStack.clear()
    catalogReturnOrigin = origin
    catalogDetail = catalogStack.detailFor(related).copy(preferRemote = origin == CatalogReturnOrigin.Remote)
  }
  LaunchedEffect(Unit) {
    searchEverywhereEnabled = runCatching { api.searchEverywhereEnabled() }.getOrDefault(false)
  }
  LaunchedEffect(player == null) {
    if (player != null) return@LaunchedEffect
    while (true) {
      try {
        downloading = activeJobs(api.downloads().jobs).isNotEmpty()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
      }
      delay(15_000L)
    }
  }
  LaunchedEffect(current) {
    detailLookup.cancel()
    if (current == Section.Library) {
      if (librarySeen) libraryRefreshToken++
      librarySeen = true
    }
    if (current == Section.Home) {
      if (homeSeen) homeRefreshToken++
      homeSeen = true
    }
    if (current == Section.Favorites) {
      if (favoritesSeen) favoritesRefreshToken++
      favoritesSeen = true
    }
    if (current == Section.Resume) {
      if (resumeSeen) resumeRefreshToken++
      resumeSeen = true
    }
  }

  // A detail or the player covers the section it was opened from; the hidden section's own Back
  // handlers must not consume Back while it is up.
  val overlayOpen = catalogDetail != null || player != null

  ShellScaffold(
    username = username,
    start = start,
    current = current,
    downloading = downloading,
    hint = hint,
    onSection = { section ->
      // The rail's Search is not the catalogue's or a library's: it starts with no preset.
      if (section == Section.Search) {
        searchOrigin = SearchOrigin.Rail
        searchPreset = null
      }
      shellState.pick(section)
      true
    },
    onBackToExit = onExitApp,
    railHidden = catalogDetail != null,
  ) { focusRequester ->
    val section = current
    val accountFocus = remember { FocusRequester() }
    // The holder keeps each section's list state and selection across the swap.
    sectionStates.SaveableStateProvider(section) {
      when (section) {
        Section.Library -> LibraryRoute(
          api = api,
          onOpenDetail = ::openLibraryDetail,
          onPlay = { target ->
            playerSources = OfferedSources()
            playedSourceId = null
            player = target
          },
          onOpenRemoteItem = { libraryId, libraryName, provider, item ->
            openRemoteDetail(RemoteDetailData(libraryId = libraryId, libraryName = libraryName, provider = provider, item = item))
          },
          restoreToken = returnToken,
          refreshToken = libraryRefreshToken,
          pushPath = libraryPush,
          onPushConsumed = { libraryPush = null },
          backEnabled = !overlayOpen,
          loadDestinations = nativeDestinations,
          onQueue = nativeQueue,
          searchEverywhereEnabled = searchEverywhereEnabled,
          onOpenSearch = { scope ->
            searchOrigin = SearchOrigin.Library
            searchPreset = scope.toPreset()
            shellState.pick(Section.Search)
          },
          searchReturnToken = librarySearchReturnToken,
        )
        Section.Resume -> ResumeRoute(
          api = api,
          onPlay = { target ->
            playerSources = OfferedSources()
            playedSourceId = null
            player = target
          },
          onOpenCatalog = ::openCatalog,
          onOpenRemote = ::openRemoteDetail,
          onOpenDetail = ::openLibraryDetail,
          restoreToken = returnToken,
          refreshToken = resumeRefreshToken,
        )
        Section.Favorites -> FavoritesRoute(
          api = api,
          onOpenDetail = ::openLibraryDetail,
          onOpenCatalog = ::openCatalog,
          onOpenRemote = ::openRemoteDetail,
          onOpenLibrary = { path ->
            libraryPush = path
            shellState.pick(Section.Library)
          },
          restoreToken = returnToken,
          refreshToken = favoritesRefreshToken,
        )
        Section.Downloads -> DownloadsScreen(api = api)
        Section.Catalog -> CatalogScreen(
          api = api,
          onOpenDetail = ::openCatalog,
          onOpenSearch = { scope ->
            searchScope = scope
            searchOrigin = SearchOrigin.Catalog
            searchPreset = SearchPreset(setOf(SourceClass.Catalog), scope)
            shellState.pick(Section.Search)
          },
          imageUrl = { path -> path?.let(api::url) },
          restoreToken = returnToken,
        )
        Section.Search -> {
          if (searchOrigin == SearchOrigin.Library || searchEverywhereEnabled) {
            GlobalSearchScreen(
              api = api,
              onOpenCatalog = ::openCatalog,
              onOpenRemote = ::openRemoteDetail,
              onOpenLibrary = { path ->
                libraryPush = path
                shellState.pick(Section.Library)
              },
              imageUrl = { path -> path?.let(api::url) },
              overlayOpen = overlayOpen,
              preset = searchPreset,
              onBack = when (searchOrigin) {
                SearchOrigin.Library -> {
                  {
                    searchOrigin = SearchOrigin.Rail
                    searchPreset = null
                    librarySearchReturnToken++
                    shellState.pick(Section.Library)
                  }
                }
                SearchOrigin.Catalog -> {
                  {
                    searchOrigin = SearchOrigin.Rail
                    searchPreset = null
                    shellState.pick(Section.Catalog)
                  }
                }
                SearchOrigin.Rail -> null
              },
            )
          } else {
            SearchScreen(
              api = api,
              scope = searchScope,
              onScopeChange = { searchScope = it },
              onOpenDetail = ::openCatalog,
              imageUrl = { path -> path?.let(api::url) },
              onBackToCatalog = if (searchOrigin == SearchOrigin.Catalog) {
                {
                  searchOrigin = SearchOrigin.Rail
                  shellState.pick(Section.Catalog)
                }
              } else null,
            )
          }
        }
        Section.Home -> HomeScreen(
          api = api,
          refreshToken = homeRefreshToken + returnToken,
          onHint = ::showHint,
          onAction = ::onHomeAction,
        )
        Section.Account -> SettingsRoute(
          api = api,
          username = username,
          focusRequester = accountFocus,
          onSignOut = onSignOut,
          onLocale = onLocale,
          onHint = ::showHint,
        )
      }
    }
  }

  val openCatalogDetail = catalogDetail
  if (openCatalogDetail != null) OverlayFocusTrap(fenced = player == null) {
    CatalogDetailScreen(
      api = api,
      args = openCatalogDetail,
      imageUrl = { path -> path?.let(api::url) },
      onPlay = {
        playedSourceId = null
        player = it
      },
      onSources = { playerSources = it },
      playedSourceId = playedSourceId,
      onShowInLibrary = { folder ->
        openLibraryFolder(folder)
      },
      onBack = {
        val previous = catalogStack.pop()
        if (previous != null) {
          catalogDetail = previous
        } else if (catalogReturnOrigin != null) {
          catalogDetail = null
          catalogStack.clear()
          catalogReturnOrigin = null
        } else {
          clearCatalogHistory()
          catalogDetail = null
          returnToken++
        }
      },
      onSearchPerson = ::openPersonSearch,
      onOpenRelated = { related ->
        catalogStack.pushRelated(openCatalogDetail, related)
        catalogDetail = catalogStack.detailFor(related, openCatalogDetail)
      },
      restoreToken = detailReturnToken,
      retryToken = catalogueSourcesRetry,
    )
  }

  val openPlayer = player
  if (openPlayer != null) {
    // A play from the library asks the addons about the title its file is bound to. The loading
    // runs beside the session, never before it: Play starts at once and the list arrives under
    // it. Leaving the player takes the effect out of the composition and cancels the loading.
    LaunchedEffect(openPlayer, librarySourcesRetry) {
      librarySources = OfferedSources()
      LibraryPlaySources(api).load(openPlayer) { librarySources = it }
    }
    val sourcesNow = playerSourcesFor(openPlayer, playerSources, librarySources)
    PlayerScreen(
      api = api,
      target = openPlayer,
      sources = sourcesNow.streams,
      sourcesLoading = sourcesNow.loading,
      sourcesRemoteFailure = sourcesNow.remoteFailure,
      ruleNoteProfileId = sourcesNow.ruleNoteProfileId,
      // The catalogue detail owns its own discovery; its Retry re-reads it through the token, and
      // a library-bound play reloads the loader it is bound to.
      onSourcesRetry = if (openPlayer.catalogue) ({ catalogueSourcesRetry++ }) else ({ librarySourcesRetry++ }),
      onExit = { endedSourceId ->
        playedSourceId = endedSourceId
        player = null
        if (catalogDetail != null) detailReturnToken++ else returnToken++
      },
    )
  }
}

/** A detail covers the section it was opened from, which stays composed underneath. Without this
 *  fence a sideways move past the last button jumps into the hidden section's cards. The fence
 *  is lifted while the player is up: a fenced detail refuses to hand the remote to anything
 *  outside it, the player's own root included, and the controls then never answered. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun OverlayFocusTrap(fenced: Boolean, content: @Composable () -> Unit) {
  Box(
    Modifier
      .fillMaxSize()
      .then(if (fenced) Modifier.focusProperties { exit = { FocusRequester.Cancel } } else Modifier)
      .focusGroup(),
  ) { content() }
}

/** The list of sources a play is offered. A catalogue play keeps the list its detail owns. Every
 *  other play starts with the rows it carried and merges the groups the library loader discovers,
 *  so late answers grow the same list and an identified native play keeps its original version. */
internal fun playerSourcesFor(target: PlayTarget, catalogue: OfferedSources, library: OfferedSources): OfferedSources {
  if (target.catalogue) return catalogue
  val carried = OfferedSources(Streams.deduped(target.initialSources ?: target.remoteSources))
  val rows = Streams.deduped(carried.streams + library.streams)
  return if (rows.isEmpty()) library else library.copy(
    streams = rows,
    ruleNoteProfileId = library.ruleNoteProfileId ?: carried.ruleNoteProfileId,
  )
}


/**
 * The rail plus the content of the current section, with the focus contract between them. The
 * slot receives the focus requester the rail's RIGHT returns to; the modifier that points its LEFT
 * back at the rail is applied around it. Extracted from [Shell] so a test can drive the rail
 * against fake content.
 */
@Composable
fun ShellScaffold(
  username: String,
  start: Section,
  current: Section,
  downloading: Boolean = false,
  onSection: (Section) -> Boolean = { false },
  onBackToExit: () -> Unit,
  railHidden: Boolean = false,
  /** A transient notice over the content; the shell's own exit warning shows when it is null. */
  hint: String? = null,
  content: @Composable (FocusRequester) -> Unit,
) {
  val railFocusRequesters = remember { Section.entries.associateWith { FocusRequester() } }
  val contentFocusRequester = remember { FocusRequester() }
  var focusedRail by remember { mutableStateOf<Section?>(null) }
  var exitArmed by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  BackHandler {
    when (railBackAction(railFocused = focusedRail != null, exitArmed = exitArmed)) {
      RailBackAction.FocusRail -> runCatching { railFocusRequesters.getValue(current).requestFocus() }
      RailBackAction.Exit -> onBackToExit()
      RailBackAction.ArmExit -> {
        exitArmed = true
        scope.launch {
          delay(2_000)
          exitArmed = false
        }
      }
    }
  }

  Box(Modifier.fillMaxSize().appBackground()) {
    Box(
      Modifier
        .fillMaxSize()
        .padding(start = CollapsedRail)
        .focusProperties {
          onExit = {
            if (requestedFocusDirection == FocusDirection.Left) {
              runCatching { railFocusRequesters.getValue(current).requestFocus() }
              cancelFocusChange()
            }
          }
        }
        .focusRequester(contentFocusRequester)
        .focusGroup(),
    ) {
      CompositionLocalProvider(LocalRailFocus provides railFocusRequesters.getValue(current)) {
        content(contentFocusRequester)
      }
    }

    if (!railHidden) {
      Rail(
        username = username,
        current = current,
        downloading = downloading,
        requesters = railFocusRequesters,
        contentRequester = { contentFocusRequester },
        onFocusChanged = { section, focused ->
          if (focused) focusedRail = section else if (focusedRail == section) focusedRail = null
        },
        onSelect = { section ->
          if (section != current && !onSection(section)) runCatching { contentFocusRequester.requestFocus() }
        },
      )
    }

    val notice = hint ?: if (exitArmed) stringResource(R.string.tv_back_to_exit) else null
    if (notice != null) {
      Hint(notice, Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp))
    }
  }
}

@Composable
private fun Rail(
  username: String,
  current: Section,
  downloading: Boolean,
  requesters: Map<Section, FocusRequester>,
  contentRequester: () -> FocusRequester,
  onFocusChanged: (Section, Boolean) -> Unit,
  onSelect: (Section) -> Unit,
) {
  val sections = remember {
    listOf(
      Section.Search to SearchIcon,
      Section.Home to HomeIcon,
      Section.Catalog to CatalogIcon,
      Section.Library to LibraryIcon,
      Section.Resume to HistoryIcon,
      Section.Favorites to StarIcon,
      Section.Downloads to DownloadIcon,
    )
  }

  Column(
    modifier = Modifier
      .fillMaxHeight()
      .width(CollapsedRail)
      .background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg, Color.Transparent)))
      .padding(vertical = Tokens.SafeY, horizontal = 11.dp),
    verticalArrangement = Arrangement.spacedBy(11.dp),
  ) {
    BrandMark(dimension = 32.dp, corner = 9.dp, modifier = Modifier.padding(start = 3.dp, bottom = 17.dp))

    sections.forEach { (section, mark) ->
      RailItem(
        label = stringResource(section.labelRes),
        selected = section == current,
        modifier = Modifier
          .fillMaxWidth()
          .testTag(railTag(section))
          .focusRequester(requesters.getValue(section))
          .focusProperties { right = contentRequester() },
        leading = {
          if (section == Section.Downloads) {
            Box(Modifier.size(24.dp)) {
              Icon(
                mark,
                contentDescription = null,
                modifier = Modifier.align(Alignment.Center).size(16.dp),
              )
              if (downloading) {
                Box(
                  Modifier
                    .align(Alignment.TopEnd)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(Tokens.Accent2)
                    .border(2.dp, Tokens.Bg, CircleShape)
                    .testTag(TagRailDownloadingDot),
                )
              }
            }
          } else {
            Icon(mark, contentDescription = null, modifier = Modifier.size(16.dp))
          }
        },
        onFocusChanged = { onFocusChanged(section, it) },
        onClick = { onSelect(section) },
      )
    }

    Spacer(Modifier.weight(1f))

    RailItem(
      label = username,
      selected = current == Section.Account,
      modifier = Modifier
        .fillMaxWidth()
        .testTag(railTag(Section.Account))
        .focusRequester(requesters.getValue(Section.Account))
        .focusProperties { right = contentRequester() },
      leading = { Avatar(username) },
      onFocusChanged = { onFocusChanged(Section.Account, it) },
      onClick = { onSelect(Section.Account) },
    )
  }
}

fun railTag(section: Section): String = TAG_RAIL_PREFIX + section.route

const val TagRailDownloadingDot = "rail_downloading_dot"

/** RIGHT from the rail goes to the content's remembered element when that element is on screen;
 *  a section that has not attached it yet (still loading, or a screen without one) falls back to
 *  the ordinary geometric move instead of crashing on an unattached requester. */
@Composable
private fun RailItem(
  label: String,
  selected: Boolean,
  leading: @Composable () -> Unit,
  onFocusChanged: (Boolean) -> Unit,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier
      .height(36.dp)
      .clip(shape)
      // Icons only: the label lives on as the item's spoken name.
      .semantics { contentDescription = label }
      .onFocusChanged { onFocusChanged(it.isFocused) },
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Color.Transparent,
      contentColor = if (selected) Tokens.Text else Tokens.Muted,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxSize(),
      horizontalArrangement = Arrangement.Center,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      leading()
    }

    if (selected) {
      Box(
        Modifier
          .align(Alignment.CenterStart)
          .width(2.dp)
          .height(18.dp)
          .background(Tokens.Accent, RoundedCornerShape(2.dp))
      )
    }
  }
}

@Composable
private fun Avatar(username: String) {
  Box(
    modifier = Modifier.size(22.dp).clip(CircleShape).background(Tokens.Panel2).border(1.dp, Tokens.Line, CircleShape),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      username.take(1).uppercase(),
      color = Tokens.Accent2,
      fontSize = 10.sp,
      fontWeight = FontWeight.ExtraBold,
    )
  }
}

/** A transient notice at the bottom of the screen: the exit warning or a Home message. */
@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
  Row(
    modifier = modifier
      .background(Tokens.Panel2, RoundedCornerShape(999.dp))
      .border(1.dp, Tokens.Line, RoundedCornerShape(999.dp))
      .padding(horizontal = 15.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Box(Modifier.size(5.dp).clip(CircleShape).background(Tokens.Green))
    Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
  }
}

private val SearchIcon = outlineIcon("Search") {
  moveTo(4f, 11f)
  arcTo(7f, 7f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 18f, y1 = 11f)
  arcTo(7f, 7f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 4f, y1 = 11f)
  close()
  moveTo(20f, 20f)
  lineTo(16.5f, 16.5f)
}

private val HomeIcon = outlineIcon("Home") {
  moveTo(3f, 10.5f)
  lineTo(12f, 3f)
  lineTo(21f, 10.5f)
  moveTo(5f, 9f)
  lineTo(5f, 21f)
  lineTo(10f, 21f)
  lineTo(10f, 15f)
  lineTo(14f, 15f)
  lineTo(14f, 21f)
  lineTo(19f, 21f)
  lineTo(19f, 9f)
}

private val CatalogIcon = outlineIcon("Catalog") {
  moveTo(5f, 4f)
  lineTo(5f, 20f)
  moveTo(10f, 4f)
  lineTo(10f, 20f)
  moveTo(15f, 4.5f)
  lineTo(20f, 19.5f)
}

private val LibraryIcon = outlineIcon("Library") {
  moveTo(5f, 12f)
  lineTo(19f, 12f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 21f, y1 = 14f)
  lineTo(21f, 18f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 19f, y1 = 20f)
  lineTo(5f, 20f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 3f, y1 = 18f)
  lineTo(3f, 14f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 5f, y1 = 12f)
  close()
  moveTo(5.5f, 12f)
  lineTo(8f, 5f)
  lineTo(16f, 5f)
  lineTo(18.5f, 12f)
  moveTo(7f, 16f)
  lineTo(7.01f, 16f)
}

private val HistoryIcon = outlineIcon("History") {
  moveTo(12f, 3f)
  arcTo(9f, 9f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 12f, y1 = 21f)
  arcTo(9f, 9f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 12f, y1 = 3f)
  close()
  moveTo(12f, 7f)
  lineTo(12f, 12f)
  lineTo(15.5f, 14f)
}

private val StarIcon = outlineIcon("Star") {
  moveTo(12f, 3.5f)
  lineTo(14.6f, 9f)
  lineTo(20.6f, 9.9f)
  lineTo(16.3f, 14.1f)
  lineTo(17.3f, 20f)
  lineTo(12f, 17.2f)
  lineTo(6.7f, 20f)
  lineTo(7.7f, 14.1f)
  lineTo(3.4f, 9.9f)
  lineTo(9.4f, 9f)
  close()
}

private val DownloadIcon = outlineIcon("Download") {
  moveTo(12f, 4f)
  lineTo(12f, 15f)
  moveTo(7f, 10f)
  lineTo(12f, 15f)
  lineTo(17f, 10f)
  moveTo(5f, 19f)
  lineTo(19f, 19f)
}
