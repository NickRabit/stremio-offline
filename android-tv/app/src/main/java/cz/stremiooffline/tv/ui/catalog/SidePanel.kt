package cz.stremiooffline.tv.ui.catalog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens

private val PanelShape = RoundedCornerShape(topStart = 14.dp, bottomStart = 14.dp)

/** A panel from the right, the TV's replacement for a dialog. Back closes it. */
@Composable
fun SidePanel(
  title: String,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  BackHandler { onClose() }
  Box(modifier.fillMaxSize(), contentAlignment = Alignment.CenterEnd) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)))
    Column(
      modifier = Modifier
        .fillMaxHeight()
        .width(360.dp)
        .background(Brush.verticalGradient(listOf(Tokens.Panel, Color(0xFF11161E))), PanelShape)
        .padding(horizontal = 24.dp, vertical = Tokens.SafeY),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(title, color = Tokens.Text, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
      Spacer(Modifier.height(2.dp))
      Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
      )
    }
  }
}

/** One row of a panel: focus draws the accent border, the selected row is tinted. */
@Composable
fun PanelOption(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  selected: Boolean = false,
) {
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth(),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (selected) Tokens.Panel2 else Color.Transparent,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
  }
}
