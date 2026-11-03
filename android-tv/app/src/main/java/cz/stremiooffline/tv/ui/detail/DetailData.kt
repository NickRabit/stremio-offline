package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.episodeCode
import cz.stremiooffline.tv.playback.Progress
import kotlinx.coroutines.CancellationException

/** Everything a library title needs: its artwork, the meta line and the files that sit under it. */
data class DetailData(
  val gridPath: String,
  val title: String,
  val year: String?,
  val description: String?,
  val poster: String?,
  val wide: String?,
  val size: Double,
  val fileCount: Int,
  val files: List<BrowseItem.File>,
  /** Whether the starred title itself is a favourite; the browse item carries it. */
  val favorite: Boolean = false,
  /** Every stored key this title stands for when it was opened from a Continue watching card. */
  val forgetKeys: List<String> = emptyList(),
) {
  /**
   * Re-reads the stored position of every file, so returning from the player shows the resume.
   * A successful `null` clears the old position; only a failed read keeps it, and a cancellation
   * is never swallowed.
   */
  suspend fun refresh(progress: suspend (String) -> ProgressDto?): DetailData {
    val refreshed = ArrayList<BrowseItem.File>(files.size)
    for (file in files) {
      val stored = try {
        progress(Progress.libraryKey(file.path))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        refreshed += file
        continue
      }
      refreshed += file.copy(progress = stored)
    }
    return copy(files = refreshed)
  }

  companion object {
    fun ofFolder(folder: BrowseItem.Folder, files: List<BrowseItem.File>) = DetailData(
      gridPath = folder.path,
      title = folder.name,
      year = folder.year,
      description = folder.description,
      poster = folder.poster,
      wide = folder.wide,
      size = folder.size,
      fileCount = folder.fileCount,
      files = files,
      favorite = folder.favorite,
    )

    fun ofFile(file: BrowseItem.File) = DetailData(
      gridPath = file.path,
      title = file.label,
      year = file.year,
      description = file.description,
      poster = file.poster,
      wide = file.wide,
      size = file.size,
      fileCount = 1,
      files = listOf(file),
      favorite = file.favorite,
    )
  }
}

/** The episode label of one file: `S1 · E2` when the server numbered it, its label otherwise. */
fun episodeLabel(file: BrowseItem.File): String =
  episodeCode(file.season, file.episode) ?: file.label

internal fun isCompleted(file: BrowseItem.File): Boolean =
  Progress.isCompleted(file.progress?.position ?: 0.0, file.progress?.duration ?: 0.0)
