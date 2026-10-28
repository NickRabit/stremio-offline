package cz.stremiooffline.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** How a stream's optional rule verdict is read off the wire. */
class StreamDtoTest {

  @Test
  fun `a stream carrying a rule verdict decodes rank, status and reasons`() {
    val stream = ApiJson.decodeFromString(
      StreamDto.serializer(),
      """{"sourceId":"s1","kind":"remote","playable":true,""" +
        """"rule":{"profileId":"p1","status":"breaks","reasons":["language","cinema"],""" +
        """"rank":[0,1,-1080,3],"unused":true}}""",
    )
    assertEquals("s1", stream.sourceId)
    assertEquals("p1", stream.rule?.profileId)
    assertEquals("breaks", stream.rule?.status)
    assertEquals(listOf("language", "cinema"), stream.rule?.reasons)
    assertEquals(listOf(0.0, 1.0, -1080.0, 3.0), stream.rule?.rank)
  }

  @Test
  fun `a stream without a rule leaves the verdict absent`() {
    val stream = ApiJson.decodeFromString(StreamDto.serializer(), """{"sourceId":"s1","kind":"remote","playable":true}""")
    assertNull(stream.rule)
  }
}
