package cz.stremiooffline.tv.ui.shell

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.components.BrandMark
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import cz.stremiooffline.tv.ui.theme.appBackground
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class Section(val route: String) {
  Search("search"),
  Home("home"),
  Catalog("catalog"),
  Library("library"),
  Account("account"),
}

/** `startView` from GET /api/settings; anything the app does not know starts on the catalog. */
fun startSection(startView: String?): Section = when (startView) {
  "home" -> Section.Home
  "library" -> Section.Library
  else -> Section.Catalog
}

private val Section.labelRes: Int
  get() = when (this) {
    Section.Search -> R.string.tv_nav_search
    Section.Home -> R.string.nav_home
    Section.Catalog -> R.string.nav_catalog
    Section.Library -> R.string.nav_library
    Section.Account -> R.string.nav_settings
  }

private val CollapsedRail = 60.dp
private val ExpandedRail = 200.dp

@Composable
fun Shell(username: String, start: Section, onSignOut: () -> Unit) {
  val navController = rememberNavController()
  val backStackEntry by navController.currentBackStackEntryAsState()
  val current = Section.entries.firstOrNull { it.route == backStackEntry?.destination?.route } ?: start
  val railFocusRequesters = remember { Section.entries.associateWith { FocusRequester() } }
  val contentFocusRequesters = remember { Section.entries.associateWith { FocusRequester() } }
  var focusedRail by remember { mutableStateOf<Section?>(null) }
  var pendingContentFocus by remember { mutableStateOf<Section?>(start) }
  var exitArmed by remember { mutableStateOf(false) }
  val activity = LocalContext.current as? Activity
  val scope = rememberCoroutineScope()

  BackHandler {
    val rail = focusedRail
    if (rail != null) {
      if (exitArmed) {
        activity?.finish()
      } else {
        exitArmed = true
        scope.launch {
          delay(2_000)
          exitArmed = false
        }
      }
    } else {
      railFocusRequesters.getValue(current).requestFocus()
    }
  }

  Box(Modifier.fillMaxSize().appBackground()) {
    NavHost(
      navController = navController,
      startDestination = start.route,
      modifier = Modifier.fillMaxSize().padding(start = CollapsedRail),
    ) {
      Section.entries.forEach { section ->
        composable(section.route) {
          SectionContent(
            section = section,
            username = username,
            onSignOut = onSignOut,
            onAction = { navigate(navController, start, Section.Home) },
            focusRequester = contentFocusRequesters.getValue(section),
            autoFocus = pendingContentFocus == section,
            onFocused = { if (pendingContentFocus == section) pendingContentFocus = null },
            modifier = Modifier.focusProperties { left = railFocusRequesters.getValue(section) },
          )
        }
      }
    }

    Rail(
      username = username,
      current = current,
      expanded = focusedRail != null,
      requesters = railFocusRequesters,
      contentRequester = { contentFocusRequesters.getValue(current) },
      onFocusChanged = { section, focused ->
        if (focused) focusedRail = section else if (focusedRail == section) focusedRail = null
      },
      onSelect = { section ->
        pendingContentFocus = section
        if (section != current) navigate(navController, start, section)
      },
    )

    if (exitArmed) {
      ExitHint(Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp))
    }
  }
}

private fun navigate(navController: NavHostController, start: Section, section: Section) {
  navController.navigate(section.route) {
    launchSingleTop = true
    popUpTo(start.route) { inclusive = false; saveState = true }
    restoreState = true
  }
}

@Composable
private fun Rail(
  username: String,
  current: Section,
  expanded: Boolean,
  requesters: Map<Section, FocusRequester>,
  contentRequester: () -> FocusRequester,
  onFocusChanged: (Section, Boolean) -> Unit,
  onSelect: (Section) -> Unit,
) {
  val width by animateDpAsState(if (expanded) ExpandedRail else CollapsedRail, label = "railWidth")
  val sections = remember {
    listOf(
      Section.Search to SearchIcon,
      Section.Home to HomeIcon,
      Section.Catalog to CatalogIcon,
      Section.Library to LibraryIcon,
    )
  }

  Column(
    modifier = Modifier
      .fillMaxHeight()
      .width(width)
      .background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg, Color.Transparent)))
      .padding(vertical = Tokens.SafeY, horizontal = 11.dp),
    verticalArrangement = Arrangement.spacedBy(11.dp),
  ) {
    BrandMark(dimension = 32.dp, corner = 9.dp, modifier = Modifier.padding(start = 3.dp, bottom = 17.dp))

    sections.forEach { (section, mark) ->
      RailItem(
        label = stringResource(section.labelRes),
        selected = section == current,
        expanded = expanded,
        modifier = Modifier
          .fillMaxWidth()
          .focusRequester(requesters.getValue(section))
          .focusProperties { right = contentRequester() },
        leading = { Icon(mark, contentDescription = null, modifier = Modifier.size(16.dp)) },
        onFocusChanged = { onFocusChanged(section, it) },
        onClick = { onSelect(section) },
      )
    }

    Spacer(Modifier.weight(1f))

    RailItem(
      label = username,
      selected = current == Section.Account,
      expanded = expanded,
      modifier = Modifier
        .fillMaxWidth()
        .focusRequester(requesters.getValue(Section.Account))
        .focusProperties { right = contentRequester() },
      leading = { Avatar(username) },
      onFocusChanged = { onFocusChanged(Section.Account, it) },
      onClick = { onSelect(Section.Account) },
    )
  }
}

@Composable
private fun RailItem(
  label: String,
  selected: Boolean,
  expanded: Boolean,
  leading: @Composable () -> Unit,
  onFocusChanged: (Boolean) -> Unit,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.height(36.dp).clip(shape).onFocusChanged { onFocusChanged(it.isFocused) },
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Color.Transparent,
      contentColor = if (selected) Tokens.Text else Tokens.Muted,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxSize().padding(horizontal = 11.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      leading()
      Spacer(Modifier.width(11.dp))
      Text(
        label,
        modifier = Modifier.alpha(animateFloatAsState(if (expanded) 1f else 0f, label = "railLabel").value),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
      )
    }

    if (selected) {
      Box(
        Modifier
          .align(Alignment.CenterStart)
          .width(2.dp)
          .height(18.dp)
          .background(Tokens.Accent, RoundedCornerShape(2.dp))
      )
    }
  }
}

@Composable
private fun Avatar(username: String) {
  Box(
    modifier = Modifier.size(22.dp).clip(CircleShape).background(Tokens.Panel2).border(1.dp, Tokens.Line, CircleShape),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      username.take(1).uppercase(),
      color = Tokens.Accent2,
      fontSize = 10.sp,
      fontWeight = FontWeight.ExtraBold,
    )
  }
}

@Composable
private fun SectionContent(
  section: Section,
  username: String,
  onSignOut: () -> Unit,
  onAction: () -> Unit,
  focusRequester: FocusRequester,
  autoFocus: Boolean,
  onFocused: () -> Unit,
  modifier: Modifier = Modifier,
) {
  LaunchedEffect(autoFocus) {
    if (autoFocus) {
      focusRequester.requestFocus()
      onFocused()
    }
  }

  Column(
    modifier = Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY),
    verticalArrangement = Arrangement.spacedBy(11.dp),
  ) {
    Text(
      stringResource(section.labelRes).uppercase(),
      color = Tokens.Accent,
      fontSize = 8.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.5.sp,
    )
    Text(
      if (section == Section.Account) stringResource(R.string.auth_signed_in_as, username)
      else stringResource(R.string.tv_placeholder_title),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    if (section == Section.Account) {
      FocusButton(
        text = stringResource(R.string.auth_sign_out),
        onClick = onSignOut,
        modifier = modifier.focusRequester(focusRequester),
        kind = FocusButtonKind.Primary,
      )
    } else {
      FocusButton(
        text = stringResource(R.string.tv_placeholder_action),
        onClick = onAction,
        modifier = modifier.focusRequester(focusRequester),
        kind = FocusButtonKind.Primary,
      )
    }
  }
}

@Composable
private fun ExitHint(modifier: Modifier = Modifier) {
  Row(
    modifier = modifier
      .background(Tokens.Panel2, RoundedCornerShape(999.dp))
      .border(1.dp, Tokens.Line, RoundedCornerShape(999.dp))
      .padding(horizontal = 15.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Box(Modifier.size(5.dp).clip(CircleShape).background(Tokens.Green))
    Text(stringResource(R.string.tv_back_to_exit), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
  }
}

private fun icon(name: String, builder: PathBuilder.() -> Unit): ImageVector =
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


private val SearchIcon = icon("Search") {
  moveTo(4f, 11f)
  arcTo(7f, 7f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 18f, y1 = 11f)
  arcTo(7f, 7f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 4f, y1 = 11f)
  close()
  moveTo(20f, 20f)
  lineTo(16.5f, 16.5f)
}

private val HomeIcon = icon("Home") {
  moveTo(3f, 10.5f)
  lineTo(12f, 3f)
  lineTo(21f, 10.5f)
  moveTo(5f, 9f)
  lineTo(5f, 21f)
  lineTo(10f, 21f)
  lineTo(10f, 15f)
  lineTo(14f, 15f)
  lineTo(14f, 21f)
  lineTo(19f, 21f)
  lineTo(19f, 9f)
}

private val CatalogIcon = icon("Catalog") {
  moveTo(5f, 4f)
  lineTo(5f, 20f)
  moveTo(10f, 4f)
  lineTo(10f, 20f)
  moveTo(15f, 4.5f)
  lineTo(20f, 19.5f)
}

private val LibraryIcon = icon("Library") {
  moveTo(5f, 12f)
  lineTo(19f, 12f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 21f, y1 = 14f)
  lineTo(21f, 18f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 19f, y1 = 20f)
  lineTo(5f, 20f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 3f, y1 = 18f)
  lineTo(3f, 14f)
  arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 5f, y1 = 12f)
  close()
  moveTo(5.5f, 12f)
  lineTo(8f, 5f)
  lineTo(16f, 5f)
  lineTo(18.5f, 12f)
  moveTo(7f, 16f)
  lineTo(7.01f, 16f)
}
