package cz.stremiooffline.tv.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** The house icon: a 24 dp stroke drawing that `Icon` tints with the surrounding content colour. */
fun outlineIcon(name: String, builder: PathBuilder.() -> Unit): ImageVector =
  ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
  ).apply {
    path(
      stroke = SolidColor(Color.White),
      strokeLineWidth = 2f,
      strokeLineCap = StrokeCap.Round,
      strokeLineJoin = StrokeJoin.Round,
      pathBuilder = builder,
    )
  }.build()

/** Play random: two crossing arrows. */
val ShuffleIcon: ImageVector = outlineIcon("Shuffle") {
  moveTo(16f, 3f); lineTo(21f, 3f); lineTo(21f, 8f)
  moveTo(4f, 20f); lineTo(21f, 3f)
  moveTo(21f, 16f); lineTo(21f, 21f); lineTo(16f, 21f)
  moveTo(15f, 15f); lineTo(21f, 21f)
  moveTo(4f, 4f); lineTo(9f, 9f)
}

/** A strip of film: what a title without artwork shows in place of its picture. */
val FilmIcon: ImageVector = outlineIcon("Film") {
  moveTo(4f, 3f); lineTo(20f, 3f); lineTo(20f, 21f); lineTo(4f, 21f); close()
  moveTo(8f, 3f); lineTo(8f, 21f)
  moveTo(16f, 3f); lineTo(16f, 21f)
  moveTo(4f, 8f); lineTo(8f, 8f)
  moveTo(4f, 16f); lineTo(8f, 16f)
  moveTo(16f, 8f); lineTo(20f, 8f)
  moveTo(16f, 16f); lineTo(20f, 16f)
  moveTo(4f, 12f); lineTo(20f, 12f)
}
