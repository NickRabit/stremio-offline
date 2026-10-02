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

## First run and account preferences

A fresh browser install detects a supported language from the browser's
language preferences, falling back to English. You can change it before
creating the first administrator. In a desktop app, a fresh local server page
uses the language picked on the app's welcome screen. A language already
stored by the web page takes precedence over that initial choice.

Creating the first administrator stores the chosen interface language and
seeds that account's preferred audio and subtitle languages. After sign-in,
each account's interface language comes from its own preferences and follows
it to other devices. Change interface, audio and subtitle preferences in
**Settings**; they are independent after setup.

The desktop shell's language controls its welcome and Settings pages, menus,
native dialogs and notifications. It is separate from a signed-in server
account's language. A remote server page receives no desktop locale bridge.

## Content languages

Audio and subtitle preferences are not limited to the ten interface languages.
They select available tracks and addon subtitles; they do not translate a
film. Audio playback prefers the requested language, then English, then an
available default or first track. Embedded subtitle selection prefers a full
track in the preferred language, then English. When the selected audio matches
the preferred audio language, only a matching forced subtitle track is selected
automatically; otherwise subtitles can remain off. See [Playback](playback.md#audio-tracks-and-subtitles).

Addon titles and descriptions depend on what the provider returns. Translating
the interface does not guarantee translated catalogue metadata. Server errors
carry catalogue keys for translation; diagnostic logs remain in English.
