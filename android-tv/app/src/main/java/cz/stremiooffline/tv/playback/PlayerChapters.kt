package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.PlaybackChapterDto

fun chapterAt(chapters: List<PlaybackChapterDto>?, position: Double): Int {
  if (chapters == null) return -1
  for (index in chapters.lastIndex downTo 0) {
    val chapter = chapters[index]
    if (position >= chapter.start && position < chapter.end) return index
  }
  return -1
}

fun chapterLabelOf(
  chapters: List<PlaybackChapterDto>,
  index: Int,
  numbered: (Int) -> String,
): String = chapters.getOrNull(index)?.title?.takeIf { it.isNotBlank() } ?: numbered(index + 1)
