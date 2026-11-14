package cz.stremiooffline.tv.ui.profiles

import cz.stremiooffline.tv.data.ProfileApi
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.data.SwitchOutcome

class FakeProfileApi(
  var profilesValue: List<ProfileDto> = emptyList(),
  var switchOutcome: SwitchOutcome = SwitchOutcome.Switched("jana", "cs"),
) : ProfileApi {
  val switchCalls = mutableListOf<Triple<String, String?, String?>>()
  var switchResults: ArrayDeque<SwitchOutcome> = ArrayDeque()

  override suspend fun profiles(): List<ProfileDto> = profilesValue

  override suspend fun switchProfile(id: String, pin: String?, password: String?): SwitchOutcome {
    switchCalls += Triple(id, pin, password)
    return if (switchResults.isNotEmpty()) switchResults.removeFirst() else switchOutcome
  }
}
