package cz.stremiooffline.tv.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumeTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `the resume cards decode with their forget keys and an unknown kind is dropped`() {
    val page = json.decodeFromString<ResumePageDto>(
      """{"items":[""" +
        """{"kind":"resume-file","key":"file:lib/It.mkv","title":"It","path":"lib/It.mkv","progress":{"position":10,"duration":100},"forgetKeys":["file:lib/It.mkv","series:tt1:1:1"]},""" +
        """{"kind":"resume-catalogue","key":"series:tt1:1:2","title":"Show","type":"series","id":"tt1","name":"Show","season":1,"episode":2,"forgetKeys":["series:tt1:1:2"]},""" +
        """{"kind":"mystery","key":"x"}],"total":3,"pending":false}""",
    )

    val items = resumeCards(page)
    assertEquals(2, items.size)
    val file = items[0] as HomeCard.ResumeFile
    assertEquals(listOf("file:lib/It.mkv", "series:tt1:1:1"), file.forgetKeys)
    val catalogue = items[1] as HomeCard.ResumeCatalogue
    assertEquals(listOf("series:tt1:1:2"), catalogue.forgetKeys)
    assertTrue(page.partial.not())
  }
}
