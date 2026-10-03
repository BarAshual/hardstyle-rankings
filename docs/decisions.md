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
- Empty-catalog completion presentation, nickname rules, deterministic ordering algorithm/seed, hosting, import/enrichment integrations, and production backup/restore operations. Production recovery is not a blocker to local foundation work, but must be defined and verified before real voting data is collected.
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

The first browser slice uses Vite/React/TypeScript and the normal Supabase Google OAuth PKCE flow. A read-only `inspect_invitation` RPC bridges private invitation validation and nickname collection without creating membership or exposing the invitation table. `accept_invitation` remains the sole invited-membership write boundary. Nickname uniqueness is not required; no uniqueness constraint was added. See [frontend.md](frontend.md) for the compatibility details and manual OAuth setup. No results, voting UI, or admin dashboard is introduced.
