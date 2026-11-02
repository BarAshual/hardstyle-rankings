# Product Specification

## Accepted Product Baseline

A private annual Hardstyle music ranking application for approximately 15 friends. A season represents a year, for example **Hardstyle 2026**. The first release is a mobile-first responsive web application. Native apps are not required for the POC.

Users authenticate with Google through Supabase Auth and select a nickname for each season. Nicknames are unique case-insensitively within a season, with surrounding ordinary spaces ignored for comparison; display casing is preserved. The same nickname may be used in another season. Admission is invite-only for a specific season and email address. An admin sends an invitation such as “You have been invited to rank the tracks of 2026. Follow this link to join.” A season invitation may predate authentication; membership is created only after Google authentication and server/database validation of the invited identity. A forwarded link alone must never grant membership. Email delivery and provider selection are deferred. Email comparison trims whitespace and lowercases, without provider-specific alias folding. Acceptance is bound to the authenticated auth.users.id. Expiry, revocation, resend, and changing the Google account remain deferred.

## Track Library and Voting

Each season may designate one Spotify playlist as its primary initial ingestion source; canonical catalog identity remains provider-neutral for future sources. Each track should eventually include its name, artists, artwork, Spotify and Apple Music links, and relevant metadata. Apple Music matching and missing-link handling remain open design questions.

The main interaction is Tinder-like voting:

| Gesture | Stored vote |
| --- | --- |
| Swipe left | `PASS` |
| Swipe right | `LIKE` |
| Swipe up | `SUPER_LIKE` |

The owner-approved mobile rating layout keeps the artwork, track details, listening links and vote buttons together in the visible viewport where space permits. Upward voting is available only while the page fits the visible viewport. If a short viewport, zoom or a recovery message requires page scrolling, vertical gestures scroll normally and Super Like remains available through its explicit button; left/right voting remains available. A gesture already yielded to scrolling cannot later become a vote through sideways drift. Changing this mode cancels an active gesture before submission.

Super Likes are limited per user per season. The selected working allowance for the official 2026 season is 40 per member, a maximum rather than a usage target; configure it explicitly instead of hard-coding a universal default or changing an existing season. During `VOTING`, an admin may increase the season-wide per-member allowance (for example, 40 to 45). Changes must be authorized and recorded with when and why they occurred. Decreases during `VOTING` are not approved for the initial scope. Usage remains derived from current votes, with no mutable used/remaining counter. Store raw choices, with scoring calculated separately later. There is at most one current vote for each user, track, and season; an unvoted track has no vote row.

Reliability is essential: acknowledged votes must survive reloads, retries, and device changes. Users must not be forced to rerate completed tracks. Derive the next track from the user's unvoted season tracks, never a mutable current-track index. Eventually give each user deterministic pseudo-random ordering. Maintain an audit history of accepted vote actions. Users may replace an existing choice during VOTING using an expected integer vote version. Undo/removing a vote back to unrated is deferred. My Picks displays only the caller’s past choices, supports title/artist search and choice filters, and permits deliberate edits while VOTING. Choosing the current choice is a UI no-op. Stale edits reload the latest choice without overwriting it.

## Growing Catalog and Completion

The catalog is not frozen when voting opens: voting may begin in October while November and December releases are added later. New tracks become unvoted tracks for every member without changing existing votes.

Completion is derived from the current active season catalog and persisted votes. A member with no remaining tracks can receive new tracks later, and their completion percentage can decrease. “Finished” is a current derived observation, never a permanent boolean. If either suspected duplicate has vote history, preserve both canonical tracks, votes, and audit events: no automatic merge/deletion, vote movement, history rewrite, or silent deactivation. Flag it for explicit review; future reconciliation remains deferred.

## Season Lifecycle

`SETUP -> VOTING -> LOCKED -> REVEAL`

| State | Meaning |
| --- | --- |
| `SETUP` | Prepare membership and the season track catalog. Results remain secret. |
| `VOTING` | Members submit votes. Results remain secret. |
| `LOCKED` | Voting is finished. Results remain secret. |
| `REVEAL` | Deliberately activated at the end-of-year party; results may be presented. |

No automatic date-based reveal is implied. Season-scoped admins may advance one step at a time; backward transitions are not supported. The season creator/provisioner is its first admin. Roles are only member and admin; exceptional corrections remain deferred.

The [implemented bounded admin panel](season-admin-panel.md) is scoped to each season. It contains these forward lifecycle controls and the love-similarity category visibility control described below. Closing voting, entering REVEAL, and opening/hiding the category require deliberate confirmation; backward state changes remain forbidden.

Future work requested on 2026-10-25: add a season creation flow within the platform, using the existing server contract that creates a `SETUP` season and makes its verified Google creator the first admin. This flow is not implemented in the bounded panel. Until then, the owner provisions seasons and assigns existing members' season-scoped admin roles through the database, identifying accounts by their verified Google email; see the [admin setup and future flow](season-admin-panel.md#admin-identity-and-interim-database-assignment).

## Secrecy and Visibility

**Results must remain completely secret until the end-of-year party.** During `SETUP`, `VOTING`, and `LOCKED`, expose no leaderboard, track/artist popularity, aggregate preference statistics, or signals that imply group voting choices. This applies to application admins as well as members.

Members may see their own votes, completion progress, and remaining Super Likes. Admins may see operational counts of registered users and tracks, completion percentage per user, and which users currently have no remaining tracks. Admin access must not include others' preference breakdowns or aggregate preferences before `REVEAL`.

The project owner's direct database access is an accepted trust boundary; cryptographic sealing or encrypted voting is not required initially. This does not grant application admins access to preferences.

## Future Party Experience

The primary desired output is a rich group and interpersonal Hardstyle Wrapped, with a top 100–200 as another output and personal summaries as a bonus. Named, bounded insights for season members after REVEAL are desired; they do not authorize unrestricted individual-ballot access or export. A dedicated reveal presentation may show Track of the Year, Artist of the Year, controversial tracks, taste similarity, and other rankings and insights.

The owner approved love similarity v1: 75% loved-track overlap plus 25% SL overlap. Equal song scores use shared competition ranks (1, 2, 2, 4), including the whole tie group at a top-N boundary. There is no minimum rater count for song rankings and no voting-power compensation for incomplete ballots. The song-scoring formulas, overall similarity, artist aggregation, awards, and defaults for other result categories remain open. See [results-and-wrapped.md](results-and-wrapped.md) for exact status, definitions, synthetic examples, and the isolated calculation implementation. Love similarity v1 is implemented as a pure module with synthetic tests. A guarded [server summary path](wrapped-results-server.md) now supplies authorized pair evidence; the [admin-panel controls](season-admin-panel.md) are now implemented while the results screen remains separate work. Do not treat candidate song formulas as approved.

The love-similarity category is hidden by default. After `REVEAL`, an admin of that season may manually open it for all members of that season from the season admin panel. Entering `REVEAL` does not open it automatically, and admins cannot expose or preview the results before `REVEAL`. Read [the integration brief](wrapped-results-integration-brief.md) for the approved policy and separately labeled implementation proposals. Other category defaults, the party sequence, and detailed presentation remain open. `REVEAL` is necessary for group preference exposure, not blanket authorization to publish individual raw votes. The completed database foundation did not include result APIs or reveal controls; implementing this later slice must preserve its secrecy and integrity contracts.

## Accepted ingestion rules (2026-10-07)

Canonical recordings and artists retain permanent internal UUIDs; provider IDs are mappings. Distinct released musical versions MUST be separate canonical tracks, including originals, remixes, edits, extended/radio mixes, distinct released bootlegs, VIPs, live/acoustic/reworks, and other variants. Title/artist/duration/album similarities or shared ISRC cannot automatically establish equivalence. Exact accepted provider mappings are reused on reimport; uncertain matches require review or separate records.

Release-year mismatches are flagged for review, never silently excluded or automatically rejected; an admin can explicitly include them. Spotify market defaults to `IL` and remains configurable at the ingestion/season boundary. Repeat imports preserve votes/events and avoid duplicate known provider identities and memberships. See [catalog-ingestion.md](catalog-ingestion.md) for the separate implementation recommendations; the first local importer is now documented in [its operating guide](spotify-importer.md).

## Accepted catalog admission refinement (2026-10-07)

Clean, unambiguous candidates from the designated playlist are admitted automatically after validation/identity checks. Only exceptions require explicit review: year mismatch, suspected duplicate/match, material identity inconsistency, or insufficient identifying metadata. Suspected duplicates are neither automatically admitted nor merged; an admin may admit a distinct recording, safely resolve its mapping, or defer/decline it without access to group voting preferences.

Admission is allowed only in SETUP/VOTING, never LOCKED/REVEAL. The playlist is additive: disappearance does not remove, deactivate, delete, or alter votes. An admin may replace the designated playlist through an audited change during SETUP/VOTING, affecting future imports only and preserving all admitted tracks. IL playback restrictions are flagged but do not determine eligibility; identifiable recordings follow normal admission/review rules.

Future audited admin withdrawal of an admitted mistake is allowed only in SETUP/VOTING. Preserve canonical identity, season association, votes, and audit history; stop new voting, exclude the track from eventual scoring/results, and retain personal historical views with withdrawn/ineligible status. Normal withdrawal after locking is forbidden; exceptional post-lock correction remains deferred. This behavior is not implemented yet.

Clearly non-identity-changing provider URLs, artwork, availability, and album/release observations may refresh automatically. Material title, artist-credit identity, or version/remix changes require review; refresh never changes the canonical recording referenced by votes.
