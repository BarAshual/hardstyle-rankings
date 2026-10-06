# Data Model

## Status

Versioned migrations implement this baseline. See [database-foundation.md](database-foundation.md) for concrete API contracts and security. Foreign keys restrict deletion; no destructive catalog or account operations are exposed.

## Entities

| Entity | Purpose and expected relationships |
| --- | --- |
| `seasons` | Annual season name/year, lifecycle state, and Super Like allowance configuration. |
| `season_invitations` | Admin-invited email for a season; may exist before authentication and without a user ID. Normalized email is unique per season; acceptance records user ID and timestamp. |
| `season_members` | Membership keyed by season and authenticated user; season-specific nickname. Created only after validating the invited Google identity. Role is member or admin; creator is the first admin. Display nickname casing is preserved; `(season_id, lower(btrim(nickname)))` is unique. |
| `tracks` | Canonical track identity, title, artwork, Spotify/Apple Music references, and metadata. Provider matching rules are undecided. |
| `artists` | Canonical artist identity and metadata. |
| `track_artists` | Many-to-many track/artist association; credit ordering and roles may be needed. |
| `season_tracks` | Tracks included in each season; unique season/track association. Supports catalog growth during `VOTING`; an active flag is stored, with no deactivation API. |
| `votes` | Current raw choice for a season, user, and track, with timestamps as needed. A positive integer version is required. |
| `vote_events` | Append-only audit and replay ledger for accepted vote actions: actor/action UUID, target, expected/result version, prior/new choice, and timestamp. |
| `season_config_events` | Append-only record of allowance increases with actor, reason, timestamp, and old/new values. |
| `season_lifecycle_events` | Append-only record of forward lifecycle transitions with actor, timestamp, and old/new state. |

Supabase Auth provides user identity. A separate application-wide profile table is not yet required; nicknames belong to season membership.

## Required Integrity

- Enforce a primary key or unique constraint on `votes (season_id, user_id, track_id)`. Each rated tuple has exactly one current vote; absence means unvoted.
- Restrict vote values to `PASS`, `LIKE`, and `SUPER_LIKE`. Do not replace raw choices with numeric scores.
- Require votes to reference both valid season membership and a track included in that season, preferably through composite foreign keys.
- Enforce valid lifecycle states. Vote mutations are permitted only during `VOTING` through the controlled transactional interface.
- Derive Super Like usage by counting current `SUPER_LIKE` votes for the member/season. Enforce the allowance safely under concurrency; a client check or an unprotected count-then-write is insufficient.
- Derive progress and unvoted tracks from the current active `season_tracks` catalog and `votes`; no mutable current-track index, permanent finished flag, or Super Like counter. Additions preserve existing votes and can lower completion percentages.
- Allow authorized increases to the season-wide per-member allowance during `VOTING`; record when, why, by whom, and old/new values. Decreases during `VOTING` are outside initial scope.
- Atomically preserve vote changes in `vote_events`. Clients must not rewrite or delete audit history.
- Enforce action UUID uniqueness in a defined scope; scope and retention are implementation-contract decisions, not implied by UUID format. Persist enough request/outcome information to deduplicate retries and detect conflicting payloads. `vote_events` stores payload and outcome, unique by actor/action UUID and by vote/version.

## Data Safety and Visibility

Protect current votes and audit events with the same pre-reveal secrecy boundary. Operational completion queries must omit preference values. Ranking outputs belong to a separately authorized reveal path, not fields exposed with the normal track catalog.

Do not introduce cascading deletion that can erase voting history without an explicit retention decision. Deletion/replacement/merging/deduplication of voted tracks, account deletion, and backup/restore procedures must be resolved before affected features ship. Missing Apple Music matches should not force invented provider identities; enrichment policy remains open.

## Implemented Storage Choices and Open Details

Append-only `season_config_events` records allowance increases; `season_lifecycle_events` records authorized state transitions. `vote_events` is both immutable audit history and the accepted-action replay ledger. Versions are required. Event immutability is enforced by grants and triggers; current vote/event consistency is checked at transaction commit.

Invitations compare trimmed, lowercase email without alias folding. Trusted Google identity data in auth.identities and a confirmed matching auth.users email are required; user-editable metadata is never trusted. Acceptance binds to auth.users.id. Expiry, revocation, resend, and account switching remain deferred.

No result tables, persisted snapshots, scoring fields, aggregation APIs, or reveal-category configuration are included. Entering REVEAL does not broaden raw-vote access.
