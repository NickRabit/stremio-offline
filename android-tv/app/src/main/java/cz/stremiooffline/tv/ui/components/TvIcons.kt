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

val SeriesDownloadIcon: ImageVector = outlineIcon("SeriesDownloadList") {
  moveTo(3f, 4f)
  lineTo(14f, 4f)
  moveTo(3f, 8f)
  lineTo(12f, 8f)
  moveTo(3f, 12f)
  lineTo(10f, 12f)
  moveTo(18f, 4f)
  lineTo(18f, 15f)
  moveTo(14f, 11f)
  lineTo(18f, 15f)
  lineTo(22f, 11f)
  moveTo(5f, 20f)
  lineTo(21f, 20f)
}
