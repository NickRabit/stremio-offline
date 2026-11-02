package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto

/**
 * What to play: the progress key and title, and either a library [path] to mint a source from or
 * a catalogue [sourceId] the server already handed out. The player skips `librarySource()` when a
 * source id is present.
 */
data class PlayTarget(
  val key: String,
  val title: String,
  val resume: Boolean,
  val path: String? = null,
  val sourceId: String? = null,
  /** The stable handle of the row this play starts, written with every progress save so the detail
   *  that offers it next time opens on the same source. */
  val stableKey: String? = null,
  /** The artwork and addon the catalogue title came from, saved with the progress so Home can
   *  draw a resume card; a library file leaves them empty and gets its art from the library. */
  val poster: String? = null,
  val addonKey: String? = null,
  /** A catalogue title's type and the id the addon subtitles must be asked for (the video's id
   *  for a series episode, the meta's own id for a movie); a library play leaves both null. A
   *  native detail's play carries the title's own identity here whatever kind of row started it:
   *  it is the generic key and subtitle context a switch to an addon row inside the player keeps,
   *  while the file or remote version the target itself plays keeps its own key. */
  val subtitleType: String? = null,
  val subtitleTarget: String? = null,
  /** The catalogue title behind [subtitleType]/[subtitleTarget]: a show name for an episode. */
  val subtitleName: String? = null,
  /** True when the catalogue detail started this play. The player then keeps the sources that
   *  detail offers, the title's own library copy included; a library view or a Continue card
   *  leaves it false and gets no catalogue sources at all. */
  val catalogue: Boolean = false,
  /** Set only for a native media-server play: the opaque remote identity and the stable progress
   *  key the player stores state under. No path, addon or catalogue flag stands in for it. */
  val remoteItem: RemoteItemContext? = null,
  /** The versions of one remote item the player offers; empty for every other kind of play. */
  val remoteSources: List<StreamDto> = emptyList(),
  /** The exact addon rows a native detail had already loaded when one of them was played: a
   *  snapshot the player offers as its own sources. Nonnull means the player must not discover
   *  any other addon or library, and it is never set by a catalogue or library play. */
  val initialSources: List<StreamDto>? = null,
)
