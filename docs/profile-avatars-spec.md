# Profile pictures and the account menu

Status: **implemented in 0.7.109** on the server, the web and Android TV;
described for administrators in [Profile pictures](users.md#profile-pictures).
Written on 2026-11-16 against `main` at `a0bb6ce7` (0.7.108). It builds on
[Switching profiles](users.md#switching-profiles) and
[Child accounts](users.md#child-accounts).

## Goal

A household member recognises their profile at a glance and reaches the
profile switch from the same place on every screen. Before this, a profile was
a name in the top bar on a computer, an entry in *More* on a phone, and a
letter at the bottom of the television's rail that opened Settings.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where the account lives on the web | A round face in the right corner of the top bar, on every layout, phone included. Other streaming services put the active profile there, so it is where people look. It opens the account menu. |
| 2 | What the account menu holds | The other profiles (one click starts the switch, a PIN or password follows when the profile needs one), *Change picture*, *Settings* and *Sign out*. Switching and signing out leave the phone's *More* sheet and the child's navigation. |
| 3 | Television | The account item at the bottom of the rail shows the face. OK on it opens the profile switcher for every account that may switch; Settings, Change picture (for a child, which has no Settings) and Sign out are actions under the profiles. DOWN from any profile lands on the first action and Sign out is the last, so it is never one accidental OK away. An account that cannot switch keeps going straight to Settings. |
| 4 | What a face is | The initial on a colour derived from the name (the default), one of 96 built-in pictures, or an uploaded picture. |
| 5 | The built-in set | Fluent Emoji, flat style, by Microsoft, under the MIT License: 72 animals and 24 other pictures, as SVG files in `web/public/avatars` with the licence beside them. The list and its order are `server/src/avatar-presets.ts`. |
| 6 | Uploading | On the web and desktop only. The browser crops to a square and scales to 256 pixels before sending; the server accepts PNG, JPEG or WebP up to 200 kB, reads the type from the bytes and stores one file per account under `DATA_DIR/avatars`. No image library on the server. |
| 7 | Who may change a picture | The account its own; an administrator anybody's. A child account may pick from the set and may not upload: a picture is not a setting that changes what the account reaches, and an upload is content nobody reviewed. |
| 8 | Who sees an uploaded picture | The account, an administrator and the profiles that may switch to it. To anybody else the address answers as if it did not exist. The built-in pictures are public files. |
| 9 | "Who is watching?" at start | Not in this version. |

## Server

`avatar` on the account record is `{ preset }` or `{ custom, type }`, absent
for the initial. `GET /api/auth/me`, `GET /api/profiles` and `GET /api/users`
carry it as `{ kind: "preset", id }` or `{ kind: "custom", url }`; the address
carries the upload's version. Clients must request uploaded images from the server
so it can check the current account's access.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/avatar/presets` | any account | the set, in display order |
| `GET /api/avatar/:userId` | see decision 8 | the uploaded picture |
| `PATCH /api/auth/avatar` | any account, a child included | `{ preset }`, or `null` for the initial |
| `PUT /api/auth/avatar/image` | any account but a child | the picture as the request body |
| `PATCH /api/users/:id/avatar`, `PUT /api/users/:id/avatar/image` | administrator | the same for another account |

Choosing a preset or the initial removes the uploaded file; deleting an
account removes it too. Nothing is written unless a picture changes.

## Not in this version

- Cropping by hand, animated pictures, pictures on Jellyfin or Emby accounts.
- Uploading from the television.
- A start screen that asks who is watching.
