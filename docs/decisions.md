# Decision Record

## How to Use This Record

Accepted decisions below come from the product brief. Implementation details marked open are not approved choices. If a task conflicts with an accepted decision, call out the conflict and propose an explicit change before implementing it. Record approved changes here with rationale and update related documents; do not silently replace established architecture.

## Accepted Product and Architecture Decisions

| ID | Type | Decision | Rationale |
| --- | --- | --- | --- |
| D01 | Product | Private annual seasons for approximately 15 friends; Google authentication and a nickname per season. | Match the group's yearly ranking workflow. |
| D02 | Product | Mobile-first responsive web POC; no native app requirement. | Keep delivery manageable by one developer. |
| D03 | Architecture | Supabase/Postgres and Supabase Auth; GitHub is the source of truth and migrations are versioned. | Keep infrastructure simple and integrity changes reviewable. |
| D04 | Product | Lifecycle is `SETUP -> VOTING -> LOCKED -> REVEAL`; reveal is deliberate at the party. | Closing voting must not expose results. |
| D05 | Product | No group preference data or inferred popularity before `REVEAL`, including for application admins. Only permitted personal and operational progress is visible. | Preserve the end-of-year surprise. |
| D06 | Architecture | One current vote per `(season_id, user_id, track_id)`, stored as `PASS`, `LIKE`, or `SUPER_LIKE`. | Preserve raw intent and prevent duplicate current votes. |
| D07 | Architecture | Transactional, idempotent voting using client action UUIDs, with audit history of changes. | Prevent lost votes and duplicate effects under retries. |
| D08 | Architecture | Database constraints/RLS are the security boundary where practical; clients cannot bypass voting rules. | Frontend assumptions cannot protect data integrity. |
| D09 | Architecture | Derive next tracks from missing votes and eventually use deterministic pseudo-random order per user. | Resume reliably while varying listening order. |
| D10 | Architecture | Derive Super Like usage from current votes; no mutable usage counter. | Avoid counter drift. |
| D11 | Product | Import the yearly Spotify playlist; eventually enrich tracks with Apple Music links and metadata. | Provide the season catalog and listening references. |
| D12 | Product | Separate scoring from raw voting and defer the final ranking algorithm. | Keep future reveal calculations flexible. |
| D13 | Architecture | Integrity precedes UI polish; avoid unnecessary services. | Keep the system reliable and maintainable. |
| D14 | Product | Invite users by email for a specific season; authenticate with the invited Google identity. A forwarded link alone grants nothing. | Keep membership private. |
| D15 | Architecture | Distinguish pre-authentication invitations from validated memberships; validate identity server/database-side. | Do not trust frontend identity claims. |
| D16 | Product | Catalog additions are allowed during `VOTING`, preserve votes, and can reduce completion percentages. | Include late-year releases. |
| D17 | Architecture | Derive completion from the current active catalog and votes; never persist permanent finished status. | Keep progress correct as the catalog grows. |
| D18 | Product | Admins may increase the season-wide per-member allowance during `VOTING`; decreases are not approved initially. | Grant additional Super Likes without losing usage history. |
| D19 | Architecture | Authorize and record allowance changes, including actor, time, reason, and old/new values; derive usage from votes. | Keep configuration changes understandable and usage consistent. |
| D20 | Architecture | Owner direct database access is an accepted trust boundary; initial encrypted voting or cryptographic sealing is unnecessary. | Keep operations simple while restricting application admins. |
| D21 | Product | Eventually let admins control visible result/insight categories after `REVEAL`; individual raw votes are not automatically public. | Preserve deliberate presentation and privacy. |
| D22 | Architecture | First database foundation collects and protects source data only; defer result calculations and reveal implementation. | Establish trustworthy data before results. |

## Accepted Foundation Decisions (2026-10-01)

| ID | Type | Decision | Rationale |
| --- | --- | --- | --- |
| D23 | Product | Season creator/provisioner is the first admin; roles are member and admin, scoped per season. | Simple authority without an organization system. |
| D24 | Architecture | Compare trusted verified Google email using trim/lowercase only; bind invitation acceptance to auth.users.id. | Reject forwarded invitations and arbitrary frontend identity claims. |
| D25 | Product | Replace votes during VOTING; no deletion back to unrated. | Support corrections while retaining history. |
| D26 | Architecture | Integer expected-version contract: 0 creates version 1; edits match and increment current version. | Reject stale concurrent edits. |
| D27 | Architecture | Exact accepted-action retries return stored outcomes; differing payloads with the same UUID fail explicitly. | Durable lost-response recovery. |

## Foundation Implementation Choices

These are engineering choices for the accepted scope, not additional product features. Secured Postgres RPCs, an actor advisory lock followed by a season row lock, and append-only vote/configuration/lifecycle events implement the contracts. Successful UUIDs are scoped per actor across seasons and retained with audit history. Failed actions reserve no UUID. Same-choice actions increment version and append an event. No timestamp-based voting window was specified; the season state defines the window.

Authenticated, verified Google users may create a season and become its first admin; this grants no access to other seasons. There is no role-promotion API. Invitations have no expiry/deletion API in this foundation. Every catalog row is initially active; destructive operations are unavailable.

There are no remaining product decisions blocking this database foundation. Production identity-provider configuration and recovery validation remain deployment prerequisites.

## Other Open Questions — Not Foundation Blockers

- Full invitation expiry, revocation, resend, and Google-account-change features remain deferred. The accepted minimal identity contract is D24; broader features need not block the foundation.
- Initial Super Like number: the API requires explicit nonnegative season configuration rather than a hard-coded product default. The product value can be chosen when creating a season.
- Destructive catalog edits, merging/deduplication of voted tracks, retention, and account deletion: the foundation exposes no destructive operations and preserves history; final policy is deferred.
- Broader nickname rules, hosting, import/enrichment integrations, and production backup/restore operations. Production recovery is not a blocker to local foundation work, but must be defined and verified before real voting data is collected.
- Scoring, tie-breaking, artist aggregation, result categories/toggles/defaults, party sequence, post-reveal individual vote visibility, and exceptional lifecycle corrections.

## Database Foundation Scope

Implementation is now authorized. See [database-foundation.md](database-foundation.md) for commands, contracts, and verification status.

1. Establish local Supabase development and documented repeatable commands; add version-controlled initial migrations for core entities, relationships, constraints, and indexes.
2. Implement invitation/membership foundations using the accepted trusted identity matching and admin authority contracts. Do not deliver invitation emails or choose a provider.
3. Enforce secrecy with RLS and grants, including audit data, safe personal/operational progress reads, and prevention of direct-write bypasses. Keep others' raw votes restricted even in `REVEAL` until visibility is specified.
4. Implement transactional voting, action UUID idempotency, atomic audit history, concurrency-safe derived Super Like enforcement, and integer expected-version stale-write protection.
5. Implement authorized forward lifecycle transitions coordinated with vote writes, safe additions during `VOTING`, and authorized audited allowance increases.
6. Add synthetic fixtures and meaningful database integration tests, including concurrent sessions. Document the chosen contracts, test commands, and repeatable local database reset. Record production recovery follow-up requirements without selecting advanced infrastructure.

### Concrete Acceptance Criteria

- A fresh local database can be rebuilt from tracked migrations and synthetic fixtures, with documented setup/test commands and no secrets committed.
- Constraints prevent invalid raw vote values, duplicate current votes, invalid membership/track references, and unauthorized writes. Clients cannot bypass voting operations through table writes or alter audit history.
- Matching trusted Google identity can accept an invitation; uninvited, mismatched, forwarded-link-only, and client-forged identity attempts fail at the database boundary where testable. Admin authority cannot be self-assigned.
- Member and application-admin tests demonstrate no access to other users' preferences or aggregates in `SETUP`, `VOTING`, or `LOCKED`. Own votes and permitted operational progress remain available. `REVEAL` does not automatically publish raw votes.
- Tests cover first vote, an allowed existing-vote change, same-choice requests, failed-action retries, and concurrent actions under the reviewed contract. A lost-response simulation retries the original action and recovers its recorded outcome.
- Identical accepted-action retries produce one logical effect and one audit event; conflicting UUID payloads fail. Rollback leaves neither partial votes nor orphan audit events. Stale and concurrent-device edits cannot overwrite newer accepted state.
- Concurrent Super Like attempts near the allowance never exceed it. An authorized increase preserves existing usage and records actor/time/reason/old/new values; unauthorized changes and in-scope decreases fail.
- Voting-versus-locking race tests demonstrate coherent transaction ordering: no new vote is accepted after closure, and accepted-action replay adds no write. Unauthorized/invalid lifecycle transitions fail.
- Adding tracks during `VOTING` preserves existing votes and audit history, makes additions unvoted for all members, and recalculates completion, including a previously complete member becoming incomplete. Unauthorized catalog additions fail. No destructive catalog operation is introduced without an explicit policy.
- Relevant integration checks pass and their results/limitations are reported. No result calculation or reveal functionality is introduced.

### Explicitly Deferred

UI, actual invitation email delivery/provider selection, Spotify import integration, Apple Music integration, scoring formulas, leaderboards, result aggregation APIs, artist rankings, user similarity, party presentation logic, reveal-category implementation, and persisted result snapshots.

## Implementation Status

Database foundation migrations, configuration, synthetic fixtures, and integration tests are implemented. No UI, results, external music/email integration, or Git commit is included. Verification results and environment limitations are recorded in database-foundation.md.

## Frontend Implementation Note (2026-10-03)

The first browser slice uses Vite/React/TypeScript and the normal Supabase Google OAuth PKCE flow. A read-only `inspect_invitation` RPC bridges private invitation validation and nickname collection without creating membership or exposing the invitation table. `accept_invitation` remains the sole invited-membership write boundary. At that milestone nickname uniqueness was not required; the 2026-10-06 decision below supersedes this. See [frontend.md](frontend.md) for the compatibility details and manual OAuth setup. No results, voting UI, or admin dashboard is introduced.

## First voting implementation (2026-10-03)

The personal queue uses MD5 of colon-separated user/season/track UUIDs and a track UUID tie-breaker. This stable pseudo-random ordering requires no mutable index and naturally includes later catalog additions. Null queue results, including an empty catalog, mean “You’re caught up” with current rated/total and remaining allowance. A localStorage journal stores each pending action before transmission; unknown outcomes replay the same actor-bound UUID and payload. The existing cast_vote, expected-version, locks, RLS, audit, and derived allowance contracts are unchanged. A separate read-only queue RPC and explicitly invoked local fixture script support this slice; no results or scoring is added.

## My Picks and nickname identity (2026-10-06)

**D28 — accepted product change:** Within a season, nicknames must be unique case-insensitively. Preserve chosen display casing and permit reuse in another season. The uniqueness key is `lower(btrim(nickname))`, consistent with existing ordinary-space nickname trimming; no accent folding or extra Unicode normalization is introduced. Existing collisions stop the migration for explicit owner correction; do not rename users automatically.

My Picks uses existing RLS table reads and the existing cast_vote RPC. Search/filter stays in the browser; pagination uses track UUIDs. A same-choice selection is a UI no-op. A stale edit reloads the current vote and waits for a new user decision. The shared pending journal accepts nonnegative integer expected versions and remains compatible with existing version-0 records. Raw votes remain private in LOCKED and REVEAL.

GitHub Actions runs a minimal frontend job and a separate local Supabase integration job on disposable Ubuntu runners, with pinned actions/tool versions and no project/OAuth secrets. No new external service or deployment pipeline is introduced.

## Accepted catalog ingestion decisions (2026-10-07)

These decisions supersede the initial catalog design proposals. See [catalog-ingestion.md](catalog-ingestion.md) for details; no importer or migration is implemented by this record.

| ID | Type | Accepted decision | Rationale |
| --- | --- | --- | --- |
| D29 | Product | A season may designate one primary Spotify playlist initially; support other sources later without Spotify-coupled canonical storage. | Start simply and preserve provider independence. |
| D30 | Architecture | Permanent internal UUIDs identify canonical tracks and artists; external provider IDs are mappings only. | Metadata/provider changes must not change vote targets. |
| D31 | Product | Different released versions MUST be separate canonical tracks, including remixes, edits, extended/radio mixes, distinct released bootlegs, VIPs, acoustic/live/reworks and other variants. Metadata similarity or shared ISRC cannot collapse them. | Wrong merges are more damaging than duplicate records. |
| D32 | Product | Release-year mismatch is a visible review warning, not automatic exclusion/rejection; admin may explicitly include the item. | Provider dates can describe compilations, re-releases or other contexts. |
| D33 | Product | Default Spotify ingestion market is `IL`, configurable at the season/ingestion boundary. | Predictable availability without coupling identity to market. |
| D34 | Integrity | If either suspected duplicate has vote history, retain both tracks: no automatic merge/delete, vote movement, history/event rewrite, or silent deactivation. Flag for explicit review. | Historical voting integrity takes priority over catalog cleanup. |
| D35 | Architecture | Exact known provider identities reuse accepted mappings and canonical records. New match candidates require review or separate identity; ISRC/title/artists/duration are not automatic equivalence. | Safe idempotency without destructive inference. |
| D36 | Integrity | Reimports create no duplicate records for the same provider identity or season membership. Additions during VOTING preserve every vote/event and naturally reopen derived unrated work. | Reliable growth and retries. |

### Implementation recommendations, not accepted product rules

Use private provider mappings, source configuration, minimal import/run-item persistence, explicit grants, and a bounded local/admin CLI with dry-run/apply. Recommend operator OAuth with PKCE for accessible owned/collaborative playlists, reviewed year-inclusion evidence, conservative metadata refresh, and provider artwork URLs with fallback. Exact table shapes and operational defaults are proposals for implementation review. No integration, migration, CLI, OAuth, UI, scoring, or results is implemented in this design task.

No product-policy questions block the first importer. The actual designated playlist and permitted operator access are run-time configuration prerequisites. Future destructive reconciliation remains deferred and does not block preservation/reporting. No new tag or main merge accompanies this design commit.

## Accepted catalog admission refinement (2026-10-07)

These refine the preceding design; implementation remains deferred.

| ID | Accepted product decision |
| --- | --- |
| D37 | Automatically admit clean, unambiguous designated-playlist candidates after validation/identity checks; no per-track approval. Hold year mismatches, suspected matches, material identity inconsistencies, and insufficient identifying metadata for explicit review. |
| D38 | Admit new season tracks only in SETUP/VOTING, never LOCKED/REVEAL. |
| D39 | Playlist removal is non-destructive: no automatic removal, deactivation, deletion, or vote change. |
| D40 | Future explicit audited admin withdrawal is allowed only in SETUP/VOTING. Preserve canonical tracks, season associations, votes and events; stop new voting, exclude eventual scoring/results, and retain personal history marked withdrawn/ineligible. Exceptional post-lock correction remains future policy. |
| D41 | Suspected duplicates block automatic admission and merging. Review may admit a distinct recording, safely resolve a provider mapping, or defer/decline; it must not expose pre-REVEAL group preferences or weaken existing raw-vote privacy. |
| D42 | IL playback availability is not season eligibility. Flag restrictions; identifiable recordings follow ordinary automatic/review admission rules. |
| D43 | An admin may replace the designated playlist through an audited change in SETUP/VOTING; record the change, affect future imports only, and preserve already-admitted tracks. |
| D44 | Clearly non-identity-changing provider URL/artwork/availability/album/release observations may refresh automatically; material title, artist-credit identity, or version/remix changes require review. Never silently change a voted recording. |

Audited withdrawal is distinct from the automatic deactivation prohibited by D34. It is accepted future behavior, not a new importer feature in this documentation task. No genuine product decision blocks the first importer; storage and workflow details remain engineering recommendations.
