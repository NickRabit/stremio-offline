package cz.stremiooffline.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a stream's per-profile rule verdicts are read off the wire. */
class StreamDtoTest {

  @Test
  fun `a stream carrying a rules map decodes one verdict per profile`() {
    val stream = ApiJson.decodeFromString(
      StreamDto.serializer(),
      """{"sourceId":"s1","kind":"remote","playable":true,"rules":{""" +
        """"p1":{"profileId":"p1","status":"breaks","reasons":["language","cinema"],""" +
        """"rank":[0,1,-1080,3],"unused":true},""" +
        """"p2":{"profileId":"p2","status":"meets","reasons":[],"rank":[1]}}}""",
    )
    assertEquals("s1", stream.sourceId)
    assertEquals("p1", stream.rules["p1"]?.profileId)
    assertEquals("breaks", stream.rules["p1"]?.status)
    assertEquals(listOf("language", "cinema"), stream.rules["p1"]?.reasons)
    assertEquals(listOf(0.0, 1.0, -1080.0, 3.0), stream.rules["p1"]?.rank)
    assertEquals("meets", stream.rules["p2"]?.status)
    assertEquals(listOf(1.0), stream.rules["p2"]?.rank)
  }

  @Test
  fun `a stream without rules leaves the map empty`() {
    val stream = ApiJson.decodeFromString(StreamDto.serializer(), """{"sourceId":"s1","kind":"remote","playable":true}""")
    assertTrue(stream.rules.isEmpty())
  }
}
