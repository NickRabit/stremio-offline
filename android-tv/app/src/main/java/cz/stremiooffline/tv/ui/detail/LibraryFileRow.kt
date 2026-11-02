package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.playback.Progress

internal fun libraryFileRow(file: BrowseItem.File): StreamDto = StreamDto(
  sourceId = Progress.libraryKey(file.path),
  kind = "library",
  playable = true,
  name = file.label,
  localPath = file.path,
  behaviorHints = BehaviorHintsDto(
    filename = file.label,
    videoSize = file.size.takeIf { it > 0 },
  ),
)
