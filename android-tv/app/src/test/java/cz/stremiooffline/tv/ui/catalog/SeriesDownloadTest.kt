package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.ApiJson
import cz.stremiooffline.tv.data.AudioMode
import cz.stremiooffline.tv.data.BulkPreparedEpisodeDto
import cz.stremiooffline.tv.data.RuleSummaryPart
import cz.stremiooffline.tv.data.SourceProfileAudioDto
import cz.stremiooffline.tv.data.SourceProfileConstraintsDto
import cz.stremiooffline.tv.data.SourceProfileCriterionDto
import cz.stremiooffline.tv.data.SourceProfileDto
import cz.stremiooffline.tv.data.SourceProfileLanguageRefDto
import cz.stremiooffline.tv.data.SourceProfilePolicyDto
import cz.stremiooffline.tv.data.SourceProfileRangeDto
import cz.stremiooffline.tv.data.formatRuleGigabytes
import cz.stremiooffline.tv.data.ruleSummaryParts
import cz.stremiooffline.tv.ui.settings.inlineContentLanguageLabel
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which episodes a scope queues, worked out the way the web's `toEpisodes` and its bulk filter do. */
class SeriesDownloadTest {

  private val prepared = listOf(
    episode("s0e1", 0, 1),
    episode("s1e1", 1, 1),
    episode("s1e2", 1, 2),
    episode("s1e3", 1, 3),
    episode("s2e1", 2, 1),
    BulkPreparedEpisodeDto(id = "part1", status = "unnumbered"),
  )

  private fun episode(
    id: String,
    season: Int?,
    number: Int?,
    status: String = "ready",
  ) = BulkPreparedEpisodeDto(id = id, season = season, episode = number, status = status)

  private fun ids(scope: DownloadScope, selected: BulkPreparedEpisodeDto? = null, specials: Boolean = false) =
    preparedScopeEpisodes(prepared, scope, selected, includeSpecials = specials).map { it.id }

  @Test
  fun `a season keeps that season and returns it in episode order`() {
    assertEquals(listOf("s1e1", "s1e2", "s1e3"), preparedScopeEpisodes(prepared, DownloadScope.Season, season = 1).map { it.id })
    assertEquals(listOf("s2e1"), preparedScopeEpisodes(prepared, DownloadScope.Season, season = 2).map { it.id })
  }

  @Test
  fun `the whole series leaves specials out until they are picked`() {
    assertEquals(listOf("s1e1", "s1e2", "s1e3", "s2e1"), ids(DownloadScope.All))
    assertEquals(listOf("s0e1", "s1e1", "s1e2", "s1e3", "s2e1"), ids(DownloadScope.All, specials = true))
  }

  @Test
  fun `the specials scope is season zero`() {
    assertEquals(listOf("s0e1"), preparedScopeEpisodes(prepared, DownloadScope.Season, season = 0).map { it.id })
  }

  @Test
  fun `from this episode keeps it and every later numbered episode`() {
    val selected = episode("s1e2", 1, 2)
    assertEquals(listOf("s1e2", "s1e3", "s2e1"), ids(DownloadScope.FromEpisode, selected))
  }

  @Test
  fun `only ready prepared episodes are queued`() {
    val mixed = prepared.mapIndexed { index, episode ->
      if (index % 2 == 0) episode else episode.copy(status = "queued")
    }
    assertEquals(
      listOf("s0e1", "s1e2", "s2e1"),
      preparedReadyEpisodes(preparedScopeEpisodes(mixed, DownloadScope.All, includeSpecials = true)).map { it.id },
    )
  }

  @Test
  fun `1234 episodes are batched 500 500 and 234 in order`() {
    val episodes = (1..1234).map { number ->
      episode("e$number", 1, number)
    }
    val chunks = batches(episodes)
    assertEquals(listOf(500, 500, 234), chunks.map { it.size })
    assertEquals((1..1234).map { "e$it" }, chunks.flatten().map { it.id })
  }

  @Test
  fun `a rule summary is the resolution, the audio mode and the max size`() {
    val smaller = SourceProfilePolicyDto(
      SourceProfileConstraintsDto(
        audio = SourceProfileAudioDto("preferred"),
        heightPixels = SourceProfileRangeDto(min = 480, max = 720),
        bytes = SourceProfileRangeDto(max = 1_500_000_000),
      ),
      criteria = listOf(SourceProfileCriterionDto("audioTier")),
    )
    assertEquals(
      listOf(
        RuleSummaryPart.Resolution(480, 720),
        RuleSummaryPart.Audio(AudioMode.PREFER, language = null),
        RuleSummaryPart.Size(minBytes = null, maxBytes = 1_500_000_000),
      ),
      ruleSummaryParts(smaller),
    )
    assertEquals(
      listOf(RuleSummaryPart.Resolution(null, 720), RuleSummaryPart.Audio(AudioMode.ONLY, language = null)),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(
            audio = SourceProfileAudioDto("strict"),
            heightPixels = SourceProfileRangeDto(max = 720),
          ),
        ),
      ),
    )
    assertEquals(
      emptyList<RuleSummaryPart>(),
      ruleSummaryParts(SourceProfilePolicyDto(SourceProfileConstraintsDto(audio = SourceProfileAudioDto("listed")))),
    )
    assertEquals("1.5", formatRuleGigabytes(1_500_000_000, Locale.ENGLISH))
    assertEquals("1,5", formatRuleGigabytes(1_500_000_000, Locale.forLanguageTag("cs")))
    assertEquals("4", formatRuleGigabytes(4_000_000_000, Locale.forLanguageTag("cs")))
    assertEquals("0.1", formatRuleGigabytes(100_000_000, Locale.ENGLISH))
  }

  @Test
  fun `preferred audio without an audioTier criterion is any language`() {
    assertEquals(
      listOf(RuleSummaryPart.Audio(AudioMode.ANY, language = null)),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(audio = SourceProfileAudioDto("preferred")),
        ),
      ),
    )
  }

  @Test
  fun `a chosen English language is prefer or only from the audio mode`() {
    val english = SourceProfileLanguageRefDto(code = "en")
    assertEquals(
      listOf(RuleSummaryPart.Audio(AudioMode.PREFER, language = "en")),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(audio = SourceProfileAudioDto("preferred", english)),
          criteria = listOf(SourceProfileCriterionDto("audioTier")),
        ),
      ),
    )
    assertEquals(
      listOf(RuleSummaryPart.Audio(AudioMode.ONLY, language = "en")),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(audio = SourceProfileAudioDto("strict", english)),
        ),
      ),
    )
  }

  @Test
  fun `a size part is added for a min, a max, or both`() {
    assertEquals(
      listOf(RuleSummaryPart.Size(500_000_000, 4_000_000_000)),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(bytes = SourceProfileRangeDto(min = 500_000_000, max = 4_000_000_000)),
        ),
      ),
    )
    assertEquals(
      listOf(RuleSummaryPart.Size(500_000_000, null)),
      ruleSummaryParts(
        SourceProfilePolicyDto(
          SourceProfileConstraintsDto(bytes = SourceProfileRangeDto(min = 500_000_000)),
        ),
      ),
    )
  }

  @Test
  fun `a profile json carries preferred code, criteria and a bytes min`() {
    val profile = ApiJson.decodeFromString(
      SourceProfileDto.serializer(),
      """{"id":"p1","policy":{"constraints":{"audio":{"mode":"preferred","preferred":{"code":"en"}},""" +
        """"bytes":{"min":500000000,"max":4000000000}},"criteria":[{"kind":"audioTier"},""" +
        """{"kind":"size","direction":"asc"}]},"unused":true}""",
    )
    assertEquals("en", profile.policy?.constraints?.audio?.preferred?.code)
    assertEquals(listOf("audioTier", "size"), profile.policy?.criteria?.map { it.kind })
    assertEquals(500_000_000L, profile.policy?.constraints?.bytes?.min)
  }

  @Test
  fun `a chosen language reads in lower case inside a Czech summary`() {
    assertEquals("angličtina", inlineContentLanguageLabel("en", "cs"))
    assertEquals("English", inlineContentLanguageLabel("en", "en"))
  }

  @Test
  fun `a chosen subtitle language is the last part, mine and off add nothing`() {
    fun parts(subtitles: String) = ruleSummaryParts(
      ApiJson.decodeFromString(
        SourceProfileDto.serializer(),
        """{"id":"p","policy":{"constraints":{"audio":{"mode":"preferred","preferred":{"preference":"audio"}},""" +
          """"subtitles":$subtitles}}}""",
      ).policy,
    )
    assertEquals(
      listOf(RuleSummaryPart.Audio(AudioMode.ANY, null), RuleSummaryPart.Subtitles("cs")),
      parts("""{"mode":"optional","preferred":{"code":"cs"}}"""),
    )
    assertEquals(
      listOf(RuleSummaryPart.Audio(AudioMode.ANY, null)),
      parts("""{"mode":"optional","preferred":{"preference":"subtitle"}}"""),
    )
    assertEquals(listOf(RuleSummaryPart.Audio(AudioMode.ANY, null)), parts("""{"mode":"off"}"""))
  }
}
