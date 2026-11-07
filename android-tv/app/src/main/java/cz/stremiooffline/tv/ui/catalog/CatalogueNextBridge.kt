package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto

/** The episode after the one the detail last played: [advance] selects it and plays it with the
 *  detail's own source rules, [cancel] drops that wait. */
class CatalogueNextOffer(val title: String, val advance: () -> Unit, val cancel: () -> Unit)

/**
 * Carries the next catalogue episode between the detail and the player above it. The detail keeps
 * [offer] current for its selected episode; the player asks for it through [advance], and the
 * detail answers with a play or, when the next episode has nothing playable, with [fail].
 */
@Stable
class CatalogueNextBridge {
  var offer: CatalogueNextOffer? by mutableStateOf(null)
  var advancing by mutableStateOf(false)
    private set
  /** The row the viewer last chose by hand for this catalogue play, kept across episodes; null when the rules chose. */
  var handPick: StreamDto? = null
    private set
  private var lastSourceId: String? = null
  /** Set by the owner: the player closes on the next episode's detail. */
  var onFailed: () -> Unit = {}

  fun advance() {
    val next = offer ?: return
    advancing = true
    next.advance()
  }

  /** The detail's play arrived; true when it answers the player's [advance]. */
  fun take(): Boolean {
    if (!advancing) return false
    advancing = false
    return true
  }

  fun fail() {
    if (!advancing) return
    advancing = false
    onFailed()
  }

  /** The viewer left the player while the detail was still looking for the next episode. */
  fun cancel() {
    if (!advancing) return
    advancing = false
    offer?.cancel?.invoke()
  }

  /** The detail started [stream]. [byHand] is `pick.chosenInPanel` at that moment. */
  fun played(stream: StreamDto, byHand: Boolean) {
    val sameRulePick = handPick == null && stream.sourceId == lastSourceId
    handPick = when {
      byHand && !sameRulePick -> stream.takeIf(::carriesProvider)
      advancing -> handPick
      else -> null
    }
    lastSourceId = stream.sourceId
  }

  /** The viewer switched to [stream] in the player's own Sources panel. */
  fun choseInPlayer(stream: StreamDto) {
    handPick = stream.takeIf(::carriesProvider)
    lastSourceId = stream.sourceId
  }

  /** The row of the hand-picked provider among [rows] while advancing, else null. */
  fun carriedRow(rows: List<StreamDto>, titleLanguage: String?, fallbackLanguage: String?): StreamDto? {
    val pick = handPick?.takeIf { advancing } ?: return null
    val language = Streams.streamLanguages(pick, titleLanguage).firstOrNull() ?: fallbackLanguage ?: "en"
    return Streams.nextEpisodeRow(pick, rows, language, titleLanguage)
  }
}

internal fun carriesProvider(stream: StreamDto): Boolean =
  !Streams.isLocalStream(stream) &&
    !Streams.isRemoteStream(stream) &&
    (stream.addonKey?.isNotBlank() == true || stream.addonName?.isNotBlank() == true)

/**
 * The released episode after [current] in watching order. A regular episode never leads into the
 * specials, the way the server's own next-episode rule reads it.
 */
internal fun catalogueEpisodeAfter(videos: List<VideoDto>, current: VideoDto?, today: String = utcToday()): VideoDto? {
  val id = current?.id ?: return null
  val ordered = orderedEpisodes(videos)
  val index = ordered.indexOfFirst { it.id == id }
  if (index < 0) return null
  val next = ordered.getOrNull(index + 1) ?: return null
  if (current.season != 0 && next.season == 0) return null
  if ((releasedDate(next) ?: "0000-01-01") > today) return null
  return next
}
