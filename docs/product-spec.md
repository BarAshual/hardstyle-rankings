# Product Specification

## Accepted Product Baseline

A private annual Hardstyle music ranking application for approximately 15 friends. A season represents a year, for example **Hardstyle 2026**. The first release is a mobile-first responsive web application. Native apps are not required for the POC.

Users authenticate with Google through Supabase Auth and select a nickname for each season. Nicknames are unique case-insensitively within a season, with surrounding ordinary spaces ignored for comparison; display casing is preserved. The same nickname may be used in another season. Admission is invite-only for a specific season and email address. An admin sends an invitation such as “You have been invited to rank the tracks of 2026. Follow this link to join.” A season invitation may predate authentication; membership is created only after Google authentication and server/database validation of the invited identity. A forwarded link alone must never grant membership. Email delivery and provider selection are deferred. Email comparison trims whitespace and lowercases, without provider-specific alias folding. Acceptance is bound to the authenticated auth.users.id. Expiry, revocation, resend, and changing the Google account remain deferred.

## Track Library and Voting

Tracks are imported from a large yearly Spotify playlist. Each track should eventually include its name, artists, artwork, Spotify and Apple Music links, and relevant metadata. Apple Music matching and missing-link handling remain open design questions.

The main interaction is Tinder-like voting:

| Gesture | Stored vote |
| --- | --- |
| Swipe left | `PASS` |
| Swipe right | `LIKE` |
| Swipe up | `SUPER_LIKE` |

Super Likes are limited per user per season; the initial allowance is not yet defined. During `VOTING`, an admin may increase the season-wide per-member allowance (for example, 30 to 35). Changes must be authorized and recorded with when and why they occurred. Decreases during `VOTING` are not approved for the initial scope. Usage remains derived from current votes, with no mutable used/remaining counter. Store raw choices, with scoring calculated separately later. There is at most one current vote for each user, track, and season; an unvoted track has no vote row.

Reliability is essential: acknowledged votes must survive reloads, retries, and device changes. Users must not be forced to rerate completed tracks. Derive the next track from the user's unvoted season tracks, never a mutable current-track index. Eventually give each user deterministic pseudo-random ordering. Maintain an audit history of accepted vote actions. Users may replace an existing choice during VOTING using an expected integer vote version. Undo/removing a vote back to unrated is deferred. My Picks displays only the caller’s past choices, supports title/artist search and choice filters, and permits deliberate edits while VOTING. Choosing the current choice is a UI no-op. Stale edits reload the latest choice without overwriting it.

## Growing Catalog and Completion

The catalog is not frozen when voting opens: voting may begin in October while November and December releases are added later. New tracks become unvoted tracks for every member without changing existing votes.

Completion is derived from the current active season catalog and persisted votes. A member with no remaining tracks can receive new tracks later, and their completion percentage can decrease. “Finished” is a current derived observation, never a permanent boolean. Deletion, replacement, merging, and deduplication of tracks with votes require a separate explicit policy; none is approved here.

## Season Lifecycle

`SETUP -> VOTING -> LOCKED -> REVEAL`

| State | Meaning |
| --- | --- |
| `SETUP` | Prepare membership and the season track catalog. Results remain secret. |
| `VOTING` | Members submit votes. Results remain secret. |
| `LOCKED` | Voting is finished. Results remain secret. |
| `REVEAL` | Deliberately activated at the end-of-year party; results may be presented. |

No automatic date-based reveal is implied. Season-scoped admins may advance one step at a time; backward transitions are not supported. The season creator/provisioner is its first admin. Roles are only member and admin; exceptional corrections remain deferred.

## Secrecy and Visibility

**Results must remain completely secret until the end-of-year party.** During `SETUP`, `VOTING`, and `LOCKED`, expose no leaderboard, track/artist popularity, aggregate preference statistics, or signals that imply group voting choices. This applies to application admins as well as members.

Members may see their own votes, completion progress, and remaining Super Likes. Admins may see operational counts of registered users and tracks, completion percentage per user, and which users currently have no remaining tracks. Admin access must not include others' preference breakdowns or aggregate preferences before `REVEAL`.

The project owner's direct database access is an accepted trust boundary; cryptographic sealing or encrypted voting is not required initially. This does not grant application admins access to preferences.

## Future Party Experience

A dedicated reveal presentation may show Track of the Year, Artist of the Year, controversial tracks, taste similarity, and other rankings and insights. Scoring formulas, tie-breaking, and post-reveal visibility of individual votes are undecided. Do not implement a final ranking algorithm prematurely.

After `REVEAL`, admins should eventually control which result and insight categories become visible. Toggles, defaults, sequence, and detailed behavior remain open. `REVEAL` is necessary for group preference exposure, not blanket authorization to publish individual raw votes. Future controls cannot bypass pre-reveal secrecy. The first database foundation must defer all scoring, result aggregation APIs, leaderboards, artist rankings, similarity, party presentation, reveal-category implementation, and persisted result snapshots.
