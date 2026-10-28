package cz.stremiooffline.tv.data

import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlinx.serialization.Serializable

/** The fields of one `GET /api/downloads` job the TVs Home summary reads. */
@Serializable
data class DownloadDto(
  val id: String = "",
  val title: String = "",
  val status: String = "queued",
  val order: Int = 0,
  val mine: Boolean? = null,
  val pauseReason: String? = null,
  val libraryGone: Boolean? = null,
)

@Serializable
data class DownloadsResponseDto(val jobs: List<DownloadDto> = emptyList())

/** The `target` the To library choice sends: the one field the route reads off the body. */
@Serializable
data class DownloadTargetDto(val libraryId: String)

/** One episode of a bulk download: the id the queue adds, and the numbers its job title needs. */
@Serializable
data class BulkEpisodeDto(
  val id: String,
  val season: Int? = null,
  val episode: Int? = null,
  val title: String? = null,
)

/** The lazy rules `POST /api/downloads/bulk` reads off the selection the web sends. */
@Serializable
data class DownloadSelectionDto(
  val addonKeys: List<String> = emptyList(),
  val sourceStrategy: String = "",
  val audioLanguage: String = "",
  val fallbackAudioLanguage: String? = null,
  val audioMode: String = "",
  val subtitleMode: String = "",
  val subtitleLanguage: String? = null,
  val fallbackSubtitleLanguage: String? = null,
  val profile: DownloadProfileRefDto? = null,
)

@Serializable
data class DownloadProfileRefDto(val profileId: String, val revision: Int)

@Serializable
data class SourceProfileDto(
  val id: String = "",
  val nameKey: String? = null,
  val name: String? = null,
  val revision: Int = 0,
  val operations: List<String> = emptyList(),
  /** The public policy fields a rule summary reads. The rest of the profile is ignored. */
  val policy: SourceProfilePolicyDto? = null,
)

@Serializable
data class SourceProfilePolicyDto(
  val constraints: SourceProfileConstraintsDto? = null,
  val criteria: List<SourceProfileCriterionDto> = emptyList(),
)

@Serializable
data class SourceProfileCriterionDto(
  val kind: String = "",
)

@Serializable
data class SourceProfileConstraintsDto(
  val audio: SourceProfileAudioDto? = null,
  val heightPixels: SourceProfileRangeDto? = null,
  val bytes: SourceProfileRangeDto? = null,
)

@Serializable
data class SourceProfileAudioDto(
  val mode: String = "",
  val preferred: SourceProfileLanguageRefDto? = null,
)

@Serializable
data class SourceProfileLanguageRefDto(
  val code: String? = null,
  val preference: String? = null,
)

@Serializable
data class SourceProfileRangeDto(
  val min: Long? = null,
  val max: Long? = null,
)

internal enum class AudioMode { ANY, PREFER, ONLY }

/** One piece of the one-line rule summary: resolution, then audio, then size. */
internal sealed interface RuleSummaryPart {
  data class Resolution(val min: Long?, val max: Long?) : RuleSummaryPart
  data class Audio(val mode: AudioMode, val language: String?) : RuleSummaryPart
  data class Size(val minBytes: Long?, val maxBytes: Long?) : RuleSummaryPart
}

/** Resolution from `heightPixels`, audio from mode/criteria/`preferred`, and `bytes` when set. */
internal fun ruleSummaryParts(policy: SourceProfilePolicyDto?): List<RuleSummaryPart> {
  val constraints = policy?.constraints ?: return emptyList()
  val parts = mutableListOf<RuleSummaryPart>()
  val height = constraints.heightPixels
  if (height != null && (height.min != null || height.max != null)) {
    parts += RuleSummaryPart.Resolution(height.min, height.max)
  }
  val audio = constraints.audio
  val audioMode = when (audio?.mode) {
    "strict" -> AudioMode.ONLY
    "preferred" -> if (policy.criteria.any { it.kind == "audioTier" }) AudioMode.PREFER else AudioMode.ANY
    else -> null
  }
  if (audioMode != null) {
    parts += RuleSummaryPart.Audio(audioMode, audio?.preferred?.code?.takeUnless { it.isBlank() })
  }
  val bytes = constraints.bytes
  if (bytes != null && (bytes.min != null || bytes.max != null)) {
    parts += RuleSummaryPart.Size(bytes.min, bytes.max)
  }
  return parts
}

/**
 * Gigabytes to one decimal, the unit the rules store (`bytes / 1e9`), with the decimal separator of
 * [locale] ("1,5" in Czech, "1.5" in English). Whole numbers drop the decimal.
 */
internal fun formatRuleGigabytes(bytes: Long, locale: Locale): String {
  val tenths = if (bytes <= 0L) 0L else (bytes + 50_000_000L) / 100_000_000L
  val whole = tenths / 10
  val fraction = (tenths % 10).toInt()
  if (fraction == 0) return whole.toString()
  return "$whole${DecimalFormatSymbols.getInstance(locale).decimalSeparator}$fraction"
}

@Serializable
data class SourceProfilesResponseDto(val profiles: List<SourceProfileDto> = emptyList())

/** The parent title a bulk body carries; the route reads the id, the type and the poster. */
@Serializable
data class BulkMediaDto(
  val id: String? = null,
  val metaType: String? = null,
  val poster: String? = null,
  val background: String? = null,
)

/** What `POST /api/downloads/bulk` answers: how many jobs it added, and how many it skipped. */
@Serializable
data class BulkDownloadResult(val added: Int = 0, val skipped: Int = 0)

/** The whole bulk body, in the order the web builds it. */
@Serializable
data class BulkDownloadRequest(
  val title: String,
  val type: String,
  val episodes: List<BulkEpisodeDto>,
  val selection: DownloadSelectionDto,
  val media: BulkMediaDto,
  val target: DownloadTargetDto? = null,
)

/** The body the web posts for a bulk download; a null target leaves the key out. */
fun bulkDownloadBody(
  title: String,
  type: String,
  episodes: List<BulkEpisodeDto>,
  selection: DownloadSelectionDto,
  media: BulkMediaDto,
  target: DownloadTargetDto?,
): BulkDownloadRequest = BulkDownloadRequest(title, type, episodes, selection, media, target)

/** The episodes a scope sends, as the route reads them: the id and the numbers it has. */
fun bulkEpisodes(videos: List<VideoDto>): List<BulkEpisodeDto> = videos.mapNotNull { video ->
  video.id?.let { BulkEpisodeDto(it, video.season, video.episode, video.title ?: video.name) }
}
