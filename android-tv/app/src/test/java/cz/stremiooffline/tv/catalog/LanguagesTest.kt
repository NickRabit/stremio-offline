package cz.stremiooffline.tv.catalog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One JVM test per `web/src/languages.test.ts` case covering a function `streamLanguages` needs. */
class LanguagesTest {

  @Test
  fun `guessLanguages reads flags`() {
    assertEquals(listOf("cs"), Languages.guessLanguages("Titulky 🇨🇿"))
    assertEquals(listOf("en"), Languages.guessLanguages("🇺🇸 dub"))
  }

  @Test
  fun `guessLanguages maps both English flags onto one code`() {
    assertEquals(listOf("en"), Languages.guessLanguages("🇬🇧 🇺🇸"))
  }

  @Test
  fun `guessLanguages reads words case-insensitively`() {
    assertEquals(listOf("cs"), Languages.guessLanguages("Czech audio"))
    assertEquals(listOf("sk"), Languages.guessLanguages("SLOVENSKY"))
    assertEquals(listOf("de"), Languages.guessLanguages("Deutsch"))
  }

  @Test
  fun `guessLanguages collects every language mentioned`() {
    assertEquals(listOf("cs", "en"), Languages.guessLanguages("CZ/EN dual audio").sorted())
  }

  @Test
  fun `guessLanguages does not match a code inside another word`() {
    assertEquals(emptyList<String>(), Languages.guessLanguages("Encoded by someone"))
    assertEquals(emptyList<String>(), Languages.guessLanguages("Skyfall"))
  }

  @Test
  fun `guessLanguages returns nothing when the text says nothing`() {
    assertEquals(emptyList<String>(), Languages.guessLanguages("1080p WEB-DL x265"))
  }

  @Test
  fun `bingeGroupLanguages reads the language field Cineshare puts in the group`() {
    assertEquals(listOf("cs"), Languages.bingeGroupLanguages("Webshare|CZ|1080p|"))
    assertEquals(listOf("cs", "sk"), Languages.bingeGroupLanguages("Webshare|CZ,SK|720p|BLURAY").sorted())
  }

  @Test
  fun `bingeGroupLanguages reads the language names AIOStreams spells out`() {
    assertEquals(listOf("en", "pl"), Languages.bingeGroupLanguages("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|Dubbed|English|Polish").sorted())
  }

  @Test
  fun `bingeGroupLanguages ignores quality, codec and release group fields`() {
    assertEquals(emptyList<String>(), Languages.bingeGroupLanguages("torrentio|4k|BluRay REMUX|hevc|10bit|DV|HDR"))
    assertEquals(emptyList<String>(), Languages.bingeGroupLanguages("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|Atmos|TrueHD|WhiteRhino"))
  }

  @Test
  fun `bingeGroupLanguages matches whole fields only`() {
    assertEquals(emptyList<String>(), Languages.bingeGroupLanguages("provider|Skyfall|Encoded"))
    assertEquals(emptyList<String>(), Languages.bingeGroupLanguages("torrentio|aba496ab7b4ccd69cd106585771ad411de048be3"))
  }

  @Test
  fun `bingeGroupLanguages returns nothing when the addon sends no group`() {
    assertEquals(emptyList<String>(), Languages.bingeGroupLanguages(null))
  }

  @Test
  fun `titleLanguage reads the English name Cinemeta sends`() {
    assertEquals("cs", Languages.titleLanguage("Czech"))
    assertEquals("de", Languages.titleLanguage("German"))
  }

  @Test
  fun `titleLanguage takes the first language it knows from a list`() {
    assertEquals("cs", Languages.titleLanguage("Czech, Slovak"))
  }

  @Test
  fun `titleLanguage gives up on a name it does not know and on a missing field`() {
    assertNull(Languages.titleLanguage("Klingon"))
    assertNull(Languages.titleLanguage(null))
    assertNull(Languages.titleLanguage(42))
  }

  @Test
  fun `leavesLanguageBlank spots the field Cineshare leaves empty`() {
    assertTrue(Languages.leavesLanguageBlank("Webshare||1080p|"))
    assertTrue(Languages.leavesLanguageBlank("Webshare|||"))
  }

  @Test
  fun `leavesLanguageBlank does not read a torrent listing as an admission`() {
    assertFalse(Languages.leavesLanguageBlank("torrentio|4k|BluRay|x265|10bit|HDR"))
    assertFalse(Languages.leavesLanguageBlank("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|WhiteRhino"))
  }

  @Test
  fun `leavesLanguageBlank treats an addon that sends no group as admitting nothing`() {
    assertFalse(Languages.leavesLanguageBlank(null))
    assertFalse(Languages.leavesLanguageBlank(""))
    assertFalse(Languages.leavesLanguageBlank("Webshare"))
  }

  @Test
  fun `label uses the display label, not the code`() {
    assertEquals("CZ", Languages.label("cs"))
    assertEquals("UA", Languages.label("uk"))
  }

  @Test
  fun `label upper-cases codes it does not know`() {
    assertEquals("XX", Languages.label("xx"))
  }

  @Test
  fun `label marks a missing code`() {
    assertEquals("?", Languages.label(null))
  }

  @Test
  fun `pickAddonSubtitle stays silent over dialogue the viewer understands`() {
    val items = listOf(sub("a", "cs"), sub("b", "en"))
    assertNull(Languages.pickAddonSubtitle(items, preferred = "cs", spoken = "cs", understood = "cs"))
  }

  @Test
  fun `pickAddonSubtitle prefers the asked language and falls back to English`() {
    val items = listOf(sub("a", "de"), sub("b", "en"), sub("c", "cs"))
    assertEquals("c", Languages.pickAddonSubtitle(items, preferred = "cs", spoken = "de", understood = "cs")?.subtitleId)
    assertEquals("b", Languages.pickAddonSubtitle(items, preferred = "fr", spoken = "de", understood = "cs")?.subtitleId)
    assertNull(Languages.pickAddonSubtitle(listOf(sub("a", "de")), preferred = "fr", spoken = "de", understood = "cs"))
  }

  @Test
  fun `pickAddonSubtitle matches a regional tag by its language`() {
    val items = listOf(sub("a", "pt-BR"))
    assertEquals("a", Languages.pickAddonSubtitle(items, preferred = "pt", spoken = "en", understood = "cs")?.subtitleId)
  }

  private fun sub(id: String, lang: String?) =
    cz.stremiooffline.tv.data.AddonSubtitleDto(subtitleId = id, lang = lang, addonName = id)
}
