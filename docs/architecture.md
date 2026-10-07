# Architecture

## Accepted Architecture Baseline

This baseline is implemented by the database foundation; see [database-foundation.md](database-foundation.md) for contracts and verification. Use a mobile-first responsive web client, Supabase Auth with Google, and Supabase/Postgres for persistent data. GitHub is the source of truth; database migrations belong in source control. The frontend uses Vite, React, TypeScript, React Router, and supabase-js; hosting and import tooling remain unselected. See [frontend.md](frontend.md) for OAuth and browser recovery behavior.

Keep the system simple enough for one developer. Prefer database constraints and narrowly scoped transactional operations over additional services. AI-authored database and security changes must remain explicit and reviewable.

## Trust Boundaries and Secrecy

The browser is untrusted. Derive the acting user from authenticated identity, not a client-supplied user ID. Use Postgres constraints, grants, and RLS as the security boundary where practical. Application admins do not bypass preference secrecy.

Before `REVEAL`, members can read only their own vote data; application admins have no additional preference access. Entering `REVEAL` alone must not broaden access to individual raw votes. Audit records require equivalent protection. Expose admin completion information through a narrow operational interface that returns no vote choices. Views, functions, realtime subscriptions, exports, errors, logs, and caches must not become alternative channels for group preferences. Hiding UI components is insufficient.

Privileged Supabase credentials must never reach the browser. The project owner’s direct database access is an accepted trust boundary. No cryptographic sealing or encrypted voting is required initially. Infrastructure/database operators may have access outside RLS; the application-admin role must not confer those privileges. Review privileged functions and service access explicitly rather than assuming RLS protects them.

## Accepted Voting Guarantees

Use a constrained transactional write boundary with the following required properties. Secured Postgres functions implement this boundary:

1. Authenticate the caller and validate membership, season track membership, and `VOTING` state.
2. Accept a client-generated action UUID and bind it to the actor and request payload. A retry of an accepted action returns its recorded outcome without reapplying it; reuse with a different payload is rejected.
3. Enforce the Super Like allowance using current votes. Serialize writes on the season row; at this scale one lock coordinates voting, catalog growth, invitations, transitions, and allowance changes.
4. Atomically update the single current vote and append its audit event. Failed requests must not partially modify either.
5. Coordinate with lifecycle transitions so a racing lock operation cannot admit a new vote after voting closes. Replaying an already accepted action must not create a new write after closure.

Clients must not have a direct-write path that bypasses these checks. Function definitions are in versioned migrations; the audit event stores the accepted action payload and outcome. Acquire the actor advisory lock before the season row lock for voting.

## Accepted Admission and Configuration Boundaries

Invitations are season/email scoped and may exist without an authenticated user ID. Create membership only after checking the authenticated Google identity against the invitation server/database-side. Neither a supplied email nor possession of the invitation link is sufficient. Keep invitation data private; email-provider selection and actual delivery are deferred.

Allow authorized additions to the active catalog during `VOTING` without modifying existing votes. Derive completion against that catalog; do not persist a permanent finished flag. Destructive catalog edits need a separate policy.

Allow authorized season-wide per-member allowance increases during `VOTING`, recording actor, timestamp, old/new allowance, and reason. Usage remains derived from votes. Do not support decreases during `VOTING` initially. Coordinate configuration changes and lifecycle transitions safely with vote writes; the season row lock provides a single ordering boundary held through transaction commit.

## Accepted Stale-write Protection

Action UUIDs prevent duplicate effects from retries; integer current-vote versions prevent stale writes. First votes require expected version 0 and create version 1. Edits require the current version and increment it. Accepted-action replay precedes state/version validation and returns the saved result, including after locking. Conflicting UUID payloads fail explicitly. Concurrent distinct edits against the same version allow only one success. Undo/removal remains deferred.

The implementation binds UUIDs to the authenticated actor across seasons, serializing that actor's vote requests before locking the season. Same-choice actions increment the version and record an event; failed actions reserve no UUID. See [database-foundation.md](database-foundation.md) for the complete contract.

## Client Recovery and Ordering

My Picks reads the caller’s own `votes` through existing RLS, joining season track metadata and ordered artist credits. It uses keyset pagination to avoid the Data API row cap, then filters/searches locally. It has no group preference query or result API.

Treat the database as authoritative. Retain the action UUID and payload across retries and reconcile uncertain outcomes before reporting a durable success. Distinguish pending actions from confirmed votes and recover from lost responses without asking users to rerate.

Select the next track by excluding current votes from the current active season catalog, including tracks added after voting began. The read-only `next_unrated_track` RPC orders by MD5 of user/season/track UUIDs with a track UUID tie-breaker. It returns only the caller’s next active unvoted track metadata. Derive completion and Super Like usage from persisted data; do not store mutable progress indexes or usage counters.

## Verification Priorities

The database suite tests duplicate requests, UUID/payload conflicts, concurrent Super Likes, transaction rollback, audit atomicity, lost-response recovery, and locking races. It exercises both SQL roles and the actual local Data API, including admin secrecy and audit access. The browser persists pending actions per user/season/action and replays identical payloads after uncertain responses or reload; frontend and real browser/API tests cover this recovery. See database-foundation.md for test commands and results.

## Recovery Planning

Reliable recovery is a priority alongside durable writes. The database foundation documents a repeatable local rebuild from migrations and synthetic fixtures and verifies transactional recovery from failed writes and lost responses. A local reset does not recover real voting history. Production backup retention and restore procedures remain open and must be settled and verified before collecting real season votes; no advanced recovery infrastructure is selected here.

## Deferred Results Architecture

`REVEAL` is a prerequisite, not automatic authorization for every result category or individual raw vote. Admin-controlled category visibility is an accepted future product direction; its mechanism and defaults remain open. The database foundation collects and protects source data only: no scoring, leaderboards, result aggregation APIs, artist rankings, similarity, party presentation, reveal-category implementation, or persisted result snapshots.

## Editing and nickname identity

The rating and My Picks screens share one localStorage pending-action journal and receipt-validation helper. First votes use version 0; edits use the displayed authoritative version. Both retain the exact payload across uncertain outcomes, including after reload or sign-out. Replayed receipts are followed by fresh current-state reads because a later device may already have edited the vote. On version conflict, refresh current choices and require a new explicit user action. Same-choice buttons do not invoke the RPC. Closed seasons allow own-pick reads and accepted-action retries, but not new edits.

The approved nickname rule is now season-scoped case-insensitive uniqueness, enforced by an expression index. A new migration narrows invitation acceptance’s conflict target to its membership primary key, so nickname conflicts fail atomically with a sanitized message. Existing identity, invitation binding, locks, votes, audits, and RLS remain unchanged.

## Catalog ingestion boundary: accepted rules and recommended implementation

[Catalog ingestion design](catalog-ingestion.md) records accepted permanent internal track/artist UUIDs, provider mappings rather than provider primary keys, one designated primary Spotify playlist per season initially, mandatory separation of distinct released versions, reviewable release-year exceptions, and configurable default market `IL`. Exact known provider IDs are reused; ISRC and metadata similarity propose review, never automatic equivalence. Catalog growth during VOTING preserves votes and history. If either suspected duplicate has vote history, no automatic merge, deletion, vote movement, history rewrite, or silent deactivation is permitted.

The recommended implementation is source adapters → normalized candidates → validation/identity/review → canonical catalog → season membership. Private mappings, source configuration, lightweight import records, and a local admin dry-run/apply CLI remain proposals, not implemented APIs. Existing voting locks, READ COMMITTED requirement, action UUIDs, audit guarantees, and raw-vote privacy are unchanged.

Admission automatically processes clean candidates; only exceptions require admin review. Suspected matches are held without admission or merging, and review must not expose group preferences. Season locking is the ordering boundary for admission, future audited withdrawal, and audited source replacement: permit these only in SETUP/VOTING, never LOCKED/REVEAL. Playlist removal/replacement is non-destructive; source replacement changes future imports only. IL playback availability is independent of eligibility. Automatic provider refresh is restricted to non-identity-changing data; material recording/version changes require review.

Future withdrawal preserves canonical identity, season membership, votes, and events while stopping new voting, excluding the track from eventual results, and labeling personal history withdrawn/ineligible. This is an explicit season-scoped admin operation, not import reconciliation or automatic duplicate cleanup. No withdrawal implementation or new voting/privacy contract is introduced here.
