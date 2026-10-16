package cz.stremiooffline.tv.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowStatus
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.decodeHomeRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The web's rule for a catalogue row that came back before the addon answered. */
const val PARTIAL_RETRY_MS = 2_500L
const val PARTIAL_RETRIES = 3

sealed interface RowContent {
  /** A catalogue row that has not come within a row of focus yet. */
  data object Placeholder : RowContent

  data object Loading : RowContent

  data class Cards(val items: List<HomeCard>, val hasMore: Boolean, val partial: Boolean) : RowContent

  data object Error : RowContent
}

data class HomeRowSlot(
  val id: String,
  val title: String?,
  val catalog: Boolean,
  val content: RowContent,
  /** Automatic partial retries already spent; reset by a non-partial answer or a reload. */
  val attempts: Int = 0,
  /** Bumped on every answer, so a retry timer restarts on a fresh partial answer. */
  val answerSeq: Int = 0,
  /** The newest request that asked for this row; an older answer is dropped. */
  val request: Int = 0,
)

data class HomeState(
  val rows: List<HomeRowSlot> = emptyList(),
  val loading: Boolean = true,
  /** Either of the two built-in requests failed, so the page shows its own error panel. */
  val failed: Boolean = false,
  /** Why the page failed, when it did: a refusal or a missing route means Home is simply not
   *  there for this account, which the panel says instead of a generic load error. */
  val failure: ApiFailure? = null,
  val downloads: List<DownloadDto> = emptyList(),
  /** Bumped whenever rows land, so the screen can restore the remembered card. */
  val dataVersion: Int = 0,
)

/** The hero's lazily-loaded metadata for one catalogue card, keyed by `type:id`. [meta] is the
 *  title's own answer, or null when the card is a library one, the answer was empty or it failed.
 *  [loading] is true between the ask and its answer, success or failure. */
data class HeroMeta(val key: String, val meta: MetaDto?, val loading: Boolean = false)

/** True when a row has something to draw: an empty, complete row is the only one left out. */
fun drawnContent(content: RowContent): Boolean = when (content) {
  is RowContent.Cards -> content.items.isNotEmpty() || content.partial
  else -> true
}

/** The rows a page draws, in the server's order. */
fun drawnRowIds(rows: List<HomeRowSlot>): List<String> = rows.filter { drawnContent(it.content) }.map { it.id }

/**
 * The Home rows: the `order` probe, the built-in request, the lazy catalogue carousels and the
 * downloads summary. Rows are keyed by id, so a retry touches only the row it names.
 */
class HomeViewModel(private val api: TvApi) : ViewModel() {

  var state by mutableStateOf(HomeState())
    private set

  /** The focused catalogue card's metadata, or nothing while it is unknown. */
  var hero by mutableStateOf<HeroMeta?>(null)
    private set

  private var started = false
  private val pendingReveal = mutableSetOf<String>()
  private var revealJob: Job? = null
  private var loadJob: Job? = null
  private var requestCounter = 0
  /** Answers already received, keyed by `type:id`; a second visit asks nothing again. Only the
   *  most recent [HERO_CACHE_SIZE] titles are kept, and a failed ask is never stored. */
  private val heroCache = object : LinkedHashMap<String, MetaDto>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, MetaDto>?) =
      size > HERO_CACHE_SIZE
  }
  private var heroJob: Job? = null
  /** The account's interface language, read once for the session; a failure leaves it null. */
  private var uiLanguageJob: Deferred<String?>? = null

  private fun uiLanguage(): Deferred<String?> {
    uiLanguageJob?.let { return it }
    val job = viewModelScope.async { runCatching { api.settings().uiLanguage }.getOrNull() }
    uiLanguageJob = job
    return job
  }

  /**
   * The hero asks one catalogue title for its own metadata. A cached title answers without a
   * request; a new one replaces whatever the previous focus had in flight, so only the last
   * focused card is ever asked.
   */
  fun heroMeta(type: String, id: String) {
    val key = "$type:$id"
    val cached = heroCache[key]
    if (cached != null) {
      if (hero?.key != key) hero = HeroMeta(key, cached)
      return
    }
    // The card is drawn with a placeholder from the moment it is asked until its answer lands.
    hero = HeroMeta(key, null, loading = true)
    heroJob?.cancel()
    heroJob = viewModelScope.launch {
      val language = uiLanguage().await()
      val meta = try {
        api.meta(type, id, language)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        null
      }
      if (meta != null) heroCache[key] = meta
      if (hero?.key == key) hero = HeroMeta(key, meta)
    }
  }

  fun start() {
    if (started) return
    started = true
    load()
  }

  /** Re-entering Home, or returning from detail or the player: built-in rows and every
   *  catalogue row already revealed, and every partial counter starts again. */
  fun refresh() {
    if (!started) {
      start()
      return
    }
    load()
  }

  private fun load() {
    loadJob?.cancel()
    loadJob = viewModelScope.launch {
      val existing = state.rows.associateBy { it.id }
      state = state.copy(loading = existing.isEmpty(), failed = false, failure = null)
      val probe = ask(emptyList())
      if (probe is RowAnswer.Failed) {
        state = state.copy(loading = false, failed = true, failure = probe.failure)
        return@launch
      }
      val probeResponse = (probe as RowAnswer.Ok).response
      // `confirm` is administrator curation and never drawn; every other ordered id gets a slot.
      val slots = probeResponse.order.filter { it.id != "confirm" }.map { entry ->
        existing[entry.id]?.copy(title = entry.title, attempts = 0)
          ?: HomeRowSlot(entry.id, entry.title, entry.catalog, if (entry.catalog) RowContent.Placeholder else RowContent.Loading)
      }
      state = state.copy(rows = slots)

      val builtin = slots.filter { !it.catalog }.map { it.id }
      if (builtin.isNotEmpty()) {
        val claims = begin(builtin)
        val answer = ask(builtin)
        if (answer is RowAnswer.Failed) {
          state = state.copy(loading = false, failed = true, failure = answer.failure)
          return@launch
        }
        apply(builtin, (answer as RowAnswer.Ok).response, catalog = false, claims = claims)
      }
      state = state.copy(loading = false)

      // The catalogue is asked once, right after the built-ins: the rows already on screen plus
      // the first rows a viewer would reach next. A row asked here is marked Loading like one
      // revealed by focus, so nothing asks it a second time.
      val prefetch = slots.filter { it.catalog && it.content == RowContent.Placeholder }.map { it.id }.take(CATALOG_PREFETCH)
      prefetch.forEach { id -> update(id) { it.copy(content = RowContent.Loading, answerSeq = it.answerSeq + 1) } }
      val asked = (revealedCatalogRows(slots) + prefetch).distinct()
      if (asked.isNotEmpty()) {
        val claims = begin(asked)
        val answer = ask(asked)
        if (answer is RowAnswer.Ok) apply(asked, answer.response, catalog = true, claims = claims)
      }
      refreshDownloads()
    }
  }

  /** The catalogue rows already on screen, which a refresh asks again along with the built-ins. */
  private fun revealedCatalogRows(slots: List<HomeRowSlot>): List<String> =
    slots.filter { it.catalog && it.content != RowContent.Placeholder }.map { it.id }

  private fun refreshDownloads() {
    viewModelScope.launch {
      val jobs = try {
        api.downloads().jobs
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        return@launch
      }
      state = state.copy(downloads = jobs)
    }
  }

  /** A catalogue row came within a row of focus: reveal it, batching rows revealed together. */
  fun reveal(rowId: String) {
    val slot = state.rows.firstOrNull { it.id == rowId } ?: return
    if (!slot.catalog || slot.content != RowContent.Placeholder) return
    update(rowId) { it.copy(content = RowContent.Loading, answerSeq = it.answerSeq + 1) }
    pendingReveal += rowId
    if (revealJob?.isActive == true) return
    revealJob = viewModelScope.launch {
      // Rows revealed in the same moment go out as one request; a row revealed while one is in
      // flight joins the next batch instead of waiting for the next entry to Home.
      while (pendingReveal.isNotEmpty()) {
        delay(0)
        val ids = pendingReveal.toList()
        pendingReveal.clear()
        if (ids.isEmpty()) continue
        val claims = begin(ids)
        val answer = ask(ids)
        if (answer is RowAnswer.Failed) {
          ids.forEach { id -> update(id) { it.copy(content = RowContent.Error, answerSeq = it.answerSeq + 1) } }
        } else {
          apply(ids, (answer as RowAnswer.Ok).response, catalog = true, claims = claims)
        }
      }
    }
  }

  /** The Try again button of one row: asks that row alone and leaves the others alone. */
  fun retry(rowId: String) {
    viewModelScope.launch {
      val catalog = state.rows.firstOrNull { it.id == rowId }?.catalog == true
      val claims = begin(listOf(rowId))
      val answer = ask(listOf(rowId))
      if (answer is RowAnswer.Failed) update(rowId) { it.copy(content = RowContent.Error, answerSeq = it.answerSeq + 1) }
      else apply(listOf(rowId), (answer as RowAnswer.Ok).response, catalog = catalog, claims = claims)
    }
  }

  /** The automatic partial retry, fired by the screen after [PARTIAL_RETRY_MS]. */
  fun autoRetry(rowId: String) {
    val slot = state.rows.firstOrNull { it.id == rowId } ?: return
    if (!slot.catalog || slot.attempts >= PARTIAL_RETRIES) return
    update(rowId) { it.copy(attempts = it.attempts + 1) }
    retry(rowId)
  }

  /** One Home call; a failure carries the reason, a cancellation propagates. */
  private sealed interface RowAnswer {
    data class Ok(val response: HomeResponseDto) : RowAnswer
    data class Failed(val failure: ApiFailure) : RowAnswer
  }

  private suspend fun ask(ids: List<String>): RowAnswer = try {
    RowAnswer.Ok(api.home(ids))
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (error: ApiError) {
    RowAnswer.Failed(error.failure)
  }

  /** Marks the rows a request is about to ask, so a superseded answer can be dropped. */
  private fun begin(ids: List<String>): Map<String, Int> {
    val wanted = ids.toSet()
    val claims = mutableMapOf<String, Int>()
    state = state.copy(
      rows = state.rows.map { slot ->
        if (slot.id in wanted) {
          val next = ++requestCounter
          claims[slot.id] = next
          slot.copy(request = next)
        } else {
          slot
        }
      },
    )
    return claims
  }

  private fun apply(ids: List<String>, response: HomeResponseDto, catalog: Boolean, claims: Map<String, Int>) {
    val wanted = ids.toSet()
    state = state.copy(
      rows = state.rows.map { slot ->
        if (slot.id !in wanted || claims[slot.id] != slot.request) slot
        else {
          val row = response.rows[slot.id]
          val content = if (row == null) {
            RowContent.Cards(emptyList(), false, false)
          } else {
            val decoded = decodeHomeRow(row)
            if (decoded.status == HomeRowStatus.Error) RowContent.Error
            else RowContent.Cards(decoded.items, decoded.hasMore, decoded.partial)
          }
          val attempts = if (catalog && content is RowContent.Cards && !content.partial) 0 else slot.attempts
          slot.copy(content = content, attempts = attempts, answerSeq = slot.answerSeq + 1)
        }
      },
      dataVersion = state.dataVersion + 1,
    )
  }

  private fun update(rowId: String, transform: (HomeRowSlot) -> HomeRowSlot) {
    state = state.copy(rows = state.rows.map { if (it.id == rowId) transform(it) else it })
  }

  companion object {
    /** How many catalogue rows are asked before focus ever reaches them. */
    private const val CATALOG_PREFETCH = 2
    private const val HERO_CACHE_SIZE = 60
    fun factory(api: TvApi) = viewModelFactory { initializer { HomeViewModel(api) } }
  }
}
