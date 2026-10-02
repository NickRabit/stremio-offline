# Languages

The web interface and desktop shell support the same ten languages:

| Language | Locale |
| --- | --- |
| English | `en` |
| Czech | `cs` |
| Slovak | `sk` |
| German | `de` |
| Spanish | `es` |
| French | `fr` |
| Italian | `it` |
| Polish | `pl` |
| Brazilian Portuguese | `pt-BR` |
| Russian | `ru` |

Choose a language during setup or in **Settings**. A fresh browser uses its
language preferences, falling back to English. A fresh local desktop server
uses the shell's choice unless the web page already has a saved language.

Setup seeds the first administrator's interface, audio and subtitle preferences.
Afterward, each account's preferences are independent and follow it to other
devices. The desktop shell keeps its own language for menus and dialogs.

Audio/subtitle choices support more languages than the interface. Catalogue
translations depend on the provider; logs remain English. See
[Playback](playback.md#audio-tracks-and-subtitles) for track-selection rules.
