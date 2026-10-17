# Music-provider artwork provenance

Retrieved on 2026-10-11. These files are official provider artwork, retained byte-for-byte; they are not original project artwork and remain subject to each provider's trademark/brand terms. Do not redraw, recolor, crop, rotate, animate, or add effects to them.

- `apple-music-icon-white.svg`: `AppleMusic_Icon_BlackandWhite/SVG/Small/Apple_Music_Icon_wht_sm_073120.svg` from the official `Apple Music_Icon_2020.zip` archive linked by [Apple's identity guidelines](https://marketing.services.apple/apple-music-identity-guidelines) through [Apple's icon download](https://apple.co/am-icon-2020). The public shared folder resolves to [Apple's Box archive](https://apple.ent.box.com/s/mkdbvi5dwdyq4yk4x8g60kbg1t2cm96q), containing file `717290965219`. SHA-256: `4c7d91cab788a05c22660ee6a2f4c4745f85e6b9bdddb5a7dee8643add2f6c23`.
- `spotify-icon-black.svg`: `Primary_Logo_Black_RGB.svg` from the [official icon archive](https://developer.spotify.com/images/guidelines/design/2024-spotify-logo-icon.zip/), linked by [Spotify's design guidelines](https://developer.spotify.com/documentation/design). SHA-256: `5595afea0e6f009b1dd8529511204d0fd5ca035e49c85409d1697063b3c27a05`.

The owner authorized the compact icon presentation instead of the initial full Apple Listen on badge. Apple's guidelines permit its official icon to link to music within apps when the badge does not fit. `MusicLinks` imports both icons locally; there are no runtime requests to the providers' asset hosts. A visible shared “Listen on” caption and single-row service names complement the full accessible link names.

Both unchanged icons fit a 24 CSS px square using `object-fit: contain`, retaining their intrinsic proportions. Spotify's visible mark exceeds its 21 px minimum and has 12 px separation from text and at least 12 px outer clear space. Apple appears first with its white icon on a red (`#e71935`) button; the red surface is slightly deeper to provide 4.5:1 contrast with the small white text. Spotify uses its official black icon and black text on green (`#1ed760`). Colors apply to the surrounding buttons, never to the artwork.

Both buttons have equal-width columns, 52 CSS px height and 10 px corner radius. Their group fills the content column, aligning the outer edges, column widths and 12 px gap with Rating's voting buttons. They wrap to one column when two 124 px columns plus the 12 px gap do not fit. Missing providers occupy identical non-interactive slots. Provider artwork stays outside the moving swipe card.

Follow [Apple's identity guidelines](https://marketing.services.apple/apple-music-identity-guidelines) and [Spotify's design guidelines](https://developer.spotify.com/documentation/design) when making future changes.
