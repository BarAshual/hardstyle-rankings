# Architecture

## Accepted Architecture Baseline

This baseline is implemented by the database foundation; see [database-foundation.md](database-foundation.md) for contracts and verification. Use a mobile-first responsive web client, Supabase Auth with Google, and Supabase/Postgres for persistent data. GitHub is the source of truth; database migrations belong in source control. The web framework, hosting provider, and import tooling are not selected.

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

Treat the database as authoritative. Retain the action UUID and payload across retries and reconcile uncertain outcomes before reporting a durable success. Distinguish pending actions from confirmed votes and recover from lost responses without asking users to rerate.

Select the next track by excluding current votes from the current active season catalog, including tracks added after voting began. Eventually apply stable pseudo-random ordering per user/season with a deterministic tie-breaker. The seed and algorithm remain to be selected. Derive completion and Super Like usage from persisted data; do not store mutable progress indexes or usage counters.

## Verification Priorities

The database suite tests duplicate requests, UUID/payload conflicts, concurrent Super Likes, transaction rollback, audit atomicity, lost-response recovery, and locking races. It exercises both SQL roles and the actual local Data API, including admin secrecy and audit access. Browser reconnect/reload UX remains future frontend work. See database-foundation.md for test commands and results.

## Recovery Planning

Reliable recovery is a priority alongside durable writes. The database foundation documents a repeatable local rebuild from migrations and synthetic fixtures and verifies transactional recovery from failed writes and lost responses. A local reset does not recover real voting history. Production backup retention and restore procedures remain open and must be settled and verified before collecting real season votes; no advanced recovery infrastructure is selected here.

## Deferred Results Architecture

`REVEAL` is a prerequisite, not automatic authorization for every result category or individual raw vote. Admin-controlled category visibility is an accepted future product direction; its mechanism and defaults remain open. The database foundation collects and protects source data only: no scoring, leaderboards, result aggregation APIs, artist rankings, similarity, party presentation, reveal-category implementation, or persisted result snapshots.
