package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import kotlinx.coroutines.CancellationException

/** The one prefix the server reserves for a media-server item's own state; a key that starts with
 *  it names that store and never a title. */
private const val REMOTE_KEY_PREFIX = "remote:"

/** Where one media-server version's position lives: the title's own key when the catalogue can
 *  name it, its own remote state otherwise -- the web's `sourceProgressOwner` rule. */
object VersionProgress {
  /** True when [key] is a title key and the play is a media-server version, so the title owns it. */
  fun titleOwned(key: String, remote: RemoteItemContext?): Boolean =
    remote != null && key.isNotBlank() && !key.startsWith(REMOTE_KEY_PREFIX)

  /** The `remote` writer a title-owned save names, or null unless all three ids are non-blank. */
  fun writer(remote: RemoteItemContext?): Triple<String, String, String>? {
    val context = remote ?: return null
    val mediaSourceId = context.mediaSourceId?.takeIf { it.isNotBlank() } ?: return null
    if (context.libraryId.isBlank() || context.itemId.isBlank()) return null
    return Triple(context.libraryId, context.itemId, mediaSourceId)
  }

  /**
   * The row one version resumes from, as the remote-state shape every caller already reads: the
   * title's own row when [titleKey] is non-null and answers, and otherwise the item's own remote
   * state. The title's row carries the playing version's own media-source id, so the same-version
   * guard reads it as it reads the item's own store.
   */
  suspend fun savedState(
    titleKey: String?,
    item: RemoteItemContext,
    readTitle: suspend (String) -> ProgressDto?,
    readOwn: suspend (libraryId: String, itemId: String) -> RemoteItemStateDto,
  ): RemoteItemStateDto? {
    if (!titleKey.isNullOrBlank()) {
      val title = try {
        readTitle(titleKey)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        null
      }
      if (title != null) {
        return RemoteItemStateDto(
          key = titleKey,
          position = title.position,
          duration = title.duration,
          watched = false,
          mediaSourceId = item.mediaSourceId,
        )
      }
    }
    return try {
      readOwn(item.libraryId, item.itemId)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      null
    }
  }
}
