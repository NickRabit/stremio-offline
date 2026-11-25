package cz.stremiooffline.tv.playback

import android.net.Uri
import androidx.media3.datasource.FileDataSource
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.mkv.MatroskaExtractor
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.test.utils.FakeExtractorOutput
import androidx.media3.test.utils.TestUtil
import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The player's own Matroska extractor over the files the server's seek-index fix is tested with
 * (server/test-fixtures/matroska, see matroska-seek-index.test.ts there). mkvmerge's layout,
 * where the Cues are listed only in a second SeekHead at the end, leaves the film unseekable:
 * every seek lands on 0:00. The bytes the server serves for that file must be seekable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MatroskaSeekIndexTest {
  private val fixtures = File("../../server/test-fixtures/matroska")

  private fun seekMap(name: String): SeekMap {
    val file = File(fixtures, name)
    assertTrue("missing fixture ${file.absolutePath}", file.isFile)
    return TestUtil.extractSeekMap(
      MatroskaExtractor(SubtitleParser.Factory.UNSUPPORTED),
      FakeExtractorOutput(),
      FileDataSource(),
      Uri.fromFile(file),
    )
  }

  private fun assertSeeksIntoTheFilm(map: SeekMap) {
    assertTrue("the film is seekable", map.isSeekable)
    assertTrue("a seek to 3 s starts past the first cluster", map.getSeekPoints(3_000_000).first.position > 497)
  }

  @Test
  fun cuesListedInTheFrontSeekHeadAreSeekable() {
    assertSeeksIntoTheFilm(seekMap("cues-pointed.mkv"))
  }

  @Test
  fun cuesListedOnlyInTheSecondSeekHeadAreNotSeekable() {
    assertFalse(seekMap("cues-behind-second-seekhead.mkv").isSeekable)
  }

  @Test
  fun theServedBytesOfThatFileAreSeekable() {
    assertSeeksIntoTheFilm(seekMap("cues-behind-second-seekhead.served.mkv"))
  }
}
