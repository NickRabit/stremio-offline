package cz.stremiooffline.tv.ui.profiles

import cz.stremiooffline.tv.data.AvatarDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProfileFaceTest {

  @Test
  fun `avatar model resolves presets and relative custom pictures`() {
    assertEquals(
      "https://tv.example/stremio/avatars/fox.svg",
      avatarModel(AvatarDto(kind = "preset", id = "fox"), "https://tv.example/stremio/"),
    )
    assertEquals(
      "https://tv.example/stremio/api/avatar/usr_1?v=1",
      avatarModel(AvatarDto(kind = "custom", url = "/api/avatar/usr_1?v=1"), "https://tv.example/stremio"),
    )
  }

  @Test
  fun `avatar model refuses unknown kinds and blank fields`() {
    assertNull(avatarModel(AvatarDto(kind = "remote", id = "fox"), "https://tv.example"))
    assertNull(avatarModel(AvatarDto(kind = "preset", id = " "), "https://tv.example"))
    assertNull(avatarModel(AvatarDto(kind = "custom", url = ""), "https://tv.example"))
    assertNull(avatarModel(null, "https://tv.example"))
  }
}
