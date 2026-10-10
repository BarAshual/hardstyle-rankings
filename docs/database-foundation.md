# Database Foundation

## Status and boundaries

Implemented source-data foundation using Supabase/Postgres 17. Scoring, results, email delivery, and reveal presentation remain deferred. The [first local Spotify importer](spotify-importer.md) is implemented separately, with bounded local live-provider verification recorded in its operating guide. The first frontend slice is documented in [frontend.md](frontend.md). The source migrations are authoritative for schema and function signatures. Accepted product/architecture decisions are in [decisions.md](decisions.md).

The implementation uses one season row lock to serialize writes for a season. This intentionally favors simple correctness over throughput for approximately 15 friends. No mutable Super Like usage counter, permanent completion flag, synchronization service, or result snapshot exists.

## Local setup and verification

Prerequisites: Docker running, Supabase CLI 2.119.0 (the version used for verification), and Python 3.9+ with pip/venv. Run commands from the repository root:

```sh
supabase start
supabase db reset --local
python3 -m venv .venv
mkdir -p .tools/tmp
TMPDIR="$PWD/.tools/tmp" .venv/bin/python -m pip install --no-cache-dir -r tests/requirements.txt
scripts/test-db.sh
supabase db lint --local --level warning
```

`db reset --local` destroys and rebuilds this project's disposable local database, reapplies all migrations, then loads `supabase/seed.sql`. Do not use a linked/remote database for these tests. The runner validates its database against this repository’s local Supabase CLI status, pins the connection to loopback, rejects routing/service overrides, and checks migration versions and the five synthetic Auth identities before tests can mutate data. `TEST_DATABASE_URL` must still match that local project’s database, port, and user. HTTP tests use the local CLI status and Data API. `SUPABASE_CLI` can select a specific executable. An ignored `.tools/supabase` installation is also supported by HTTP tests; use that path for CLI commands if necessary.

The seed creates five synthetic Auth users with `example.invalid` emails, provider identities, and one demo season with two tracks. One identity is unverified, and deliberately misleading user metadata tests that admission ignores it. Fixtures are not real Google accounts and cannot prove an OAuth handshake. Never apply this seed to production. Tests create additional isolated seasons; reset to return to the clean demo. Run the suite sequentially: a process-wide database advisory lock rejects overlapping runs while allowing the intentional concurrent-session tests. Temporary Auth changes and fault-injection DDL are never committed; they execute on rollback-only connections with savepoints for expected errors. Assertion failures, KeyboardInterrupt, and connection loss roll back that temporary state. HTTP fixture JWT timestamps use the local stack’s database clock to avoid host/Docker clock skew.

Python dependencies are pinned in `tests/requirements.txt`. A normal `.venv` is preferred; the test runner also supports the ignored `.tools/python` directory used during development. Local tools, logs, generated Supabase files, and credentials are ignored. No privileged key belongs in browser code. Stop the local stack with `supabase stop` when no longer needed.

## Migration structure

| Migration | Contents |
| --- | --- |
| `20261007000100_catalog_import.sql` | Private provider identities, audited source configuration, plans/review decisions/item receipts, additive artwork curation flag, and authenticated season-admin import RPCs. |
| `20261008000100_import_evidence.sql` | Additive retained ISRC evidence/backfill, optional baseline initialization, consistent indexed collision predicates, and material match/peer binding for importer reviews. |
| `20261008000200_import_artist_evidence.sql` | Additive material artist-collision evidence and exact reviewed same-plan artist-peer validation; preserves mappings and history. |
| `20261001000100_core.sql` | Seasons, membership, invitations, tracks, artists/credits, catalog, current votes, immutable vote/configuration/lifecycle events, keys/checks/indexes, deferred audit consistency, initial deny-by-default grants/RLS. |
| `20261001000200_api.sql` | Trusted identity helpers and secured transactional mutation and progress RPCs. |
| `20261001000300_security.sql` | Explicit select policies and execute grants/revocations for named application objects; unrelated public objects/default privileges are untouched. |
| `20261003000200_next_unrated_track.sql` | Additive read-only member queue, excluding own votes and returning track metadata in deterministic per-user order. |
| `20261003000100_invitation_preview.sql` | Additive read-only invitation inspection, authorized for the matching verified Google identity only; supports existing-member bypass and nickname onboarding. |
| `20261006000100_unique_season_nicknames.sql` | Case-insensitive per-season nickname index; preserves display casing and narrows invitation conflict handling with a sanitized duplicate-name error. |

All foreign keys that protect voting history restrict deletion. Catalog rows have an `active` flag, but the foundation exposes addition only. No role-promotion, membership-removal, track deactivation/deletion, vote deletion, or audit rewrite API is provided. Provider metadata columns may remain null. Artist names are not assumed globally unique; manual input does not perform deduplication.

## Public API

RPC names and parameters below match SQL/PostgREST. Every caller's user ID comes from `auth.uid()`, not from an RPC parameter.

| RPC | Contract |
| --- | --- |
| `create_season(p_name, p_year, p_allowance, p_nickname)` | Verified Google identity creates a SETUP season and becomes its first admin atomically; returns season UUID. Explicit nonnegative allowance is required. |
| `invite_member(p_season, p_email)` | Season admin creates an invitation with trimmed/lowercase email; returns its UUID. Repeating the same normalized season/email returns the existing invitation. No delivery occurs. |
| `inspect_invitation(p_invitation)` | Verified invited Google identity only; returns season ID/name/year and own existing nickname or null, without creating membership. |
| `accept_invitation(p_invitation, p_nickname)` | Validates trusted verified Google email; creates member and binds acceptance to authenticated user atomically. Same-user retry returns the season UUID without changing nickname. Wrong identity and unknown UUID return the same denial. |
| `next_unrated_track(p_season)` | Member-only; returns one active unvoted track with ordered artists/artwork/provider links, or null. Stable per-user MD5 ordering and UUID tie-breaker; no other users’ votes or mutable queue state. |
| `add_track(p_season, p_title, p_artists)` | Admin adds a new track with ordered artist credits in SETUP/VOTING. Returns track UUID; no import, matching, or deduplication. |
| `add_existing_track(p_season, p_track)` | Admin adds an existing track visible through one of their memberships. Re-adding the same catalog association is harmless. |
| `transition_season(p_season, p_state)` | Admin advances exactly SETUP → VOTING → LOCKED → REVEAL. Records actor, old/new state, and timestamp atomically. |
| `increase_allowance(p_season, p_allowance, p_reason)` | Admin increases the season-wide allowance during VOTING. Requires nonempty reason and strictly higher value; atomically records actor/time/reason/old/new values. |
| `cast_vote(p_season, p_track, p_choice, p_expected_version, p_action)` | Transactional vote contract below; returns JSON with action/season/track IDs, choice, version, and accepted timestamp. |
| `my_progress(p_season)` | Member's active catalog count, rated/unrated count, Super Likes used/available, and completion percentage. Usage counts all current votes. |
| `admin_progress(p_season)` | Admin receives member ID/nickname/role and active track/rated/unrated counts and percentage. No vote choices, preference composition, or per-track breakdowns. |

Nickname must be nonblank and at most 80 characters; `lower(btrim(nickname))` must be unique within its season. Display casing is preserved, and another season can reuse the name. A zero-track catalog returns zero counts and null completion percentage; the rating UI presents this as caught up with the current catalog. Membership presence is the active membership representation; revocation is not implemented.

Invitation ID is a locator, not sufficient authorization. Auth-managed `auth.identities` must contain a Google identity with boolean `email_verified: true`; its normalized email must match confirmed `auth.users.email` and the invitation. User-editable `raw_user_meta_data` is ignored. A shared `private.normalize_email(text)` helper lowercases after stripping only surrounding POSIX whitespace (including spaces, tabs, and newlines); the invitation CHECK constraint uses it too. Internal whitespace, Gmail dots, and plus aliases are preserved. Acceptance stays tied to `auth.users.id`; account switching is deferred. The creator bootstrap is the deliberate exception to invitation-based membership. Any verified Google user can create their own isolated season; that creates no authority over existing seasons.

The config disables email/SMS signup, anonymous accounts, and manual identity linking. Google OAuth is enabled locally; both credentials are loaded through environment references from ignored root `.env`. Before real-user deployment, enable/configure Google and verify provider claim behavior end to end. Never enable a second identity path casually: admission relies on the trusted Auth identity boundary.

## Voting and recovery contract

Every vote action requires a UUID and a logical payload `(season, track, choice, expected_version)`. Accepted UUID uniqueness is scoped to the authenticated actor across all seasons and tracks. It cannot disclose or collide with a different actor's action. Accepted payloads and results are retained in immutable `vote_events` with the voting history.

1. Require authentication and a valid, non-null payload. The transaction must use READ COMMITTED (the PostgREST default); other isolation levels fail explicitly so a stale transaction snapshot cannot undermine count-based limits after waiting for a lock.
2. Acquire a transaction advisory lock derived from the actor UUID. Check the accepted-action ledger before version/state checks. An exact replay returns the original result, even if the vote was subsequently edited or the season locked; there is no new write or event. Different payload with a previously accepted UUID returns `action_payload_conflict`.
3. Require membership; acquire the season row `FOR UPDATE` lock and hold it through transaction commit. Validate VOTING state and active catalog membership. No date-based window was specified; lifecycle state defines whether voting is open.
4. First vote requires expected version 0 and creates version 1. Otherwise expected version must match current version; successful edits increment it. A stale or duplicate first-write attempt with a different UUID returns `vote_version_conflict`.
5. Count current Super Likes for this actor/season while holding the season lock. Converting another choice to SUPER_LIKE requires remaining allowance. Replacing SUPER_LIKE with LIKE/PASS releases allowance by changing source data; a same-choice SUPER_LIKE action consumes no additional allowance.
6. Write current state and append the audit action in the same transaction. Deferred constraint triggers check final current state, timestamp, version, and event count at commit. Same-choice actions increment version and append an event. Failure rolls back both writes and reserves no UUID; a retry of a failed request is evaluated against current state.

Clients retain the original UUID and full payload until an uncertain outcome is reconciled. An accepted replay can return an older version than the current vote; refresh own current state before making a new edit. After `vote_version_conflict`, fetch current state and require a deliberate new edit with a new action UUID; do not silently overwrite. Transactions should be short, one RPC per request. Mixing multiple actors or seasons in a custom long transaction can deadlock; retry an aborted transaction without changing its logical action.

The actor lock precedes the season lock. All season-level writes use the same season row lock. If a vote holds that lock first, the lock transition waits for its commit. If the transition holds it first, the waiting vote observes LOCKED and fails. Allowance increases and catalog additions are coordinated on this same boundary. Existing votes/events are not modified when tracks are added; progress is recomputed from the current active catalog.

Expected errors include `authentication_required`, `verified_google_identity_required`, `season_membership_required`, `season_admin_required`, `invitation_not_available`, `invalid_vote_payload`, `read_committed_required`, `track_not_active`, `vote_version_conflict`, `action_payload_conflict`, `super_like_limit`, `voting_closed`, `catalog_closed`, `invalid_transition`, and `allowance_must_increase`. Authorization failures use SQLSTATE 42501; malformed vote payloads use 22023; isolation rejection uses 25000; domain conflicts use P0001. Ordinary NOT NULL/check/FK errors retain PostgreSQL SQLSTATEs. Errors do not include other users' votes or preference totals.

## Security and visibility

All application tables have RLS. `anon` has no table access or mutation RPC execution. `authenticated` has select access subject to RLS and an explicit list of RPC execute grants, with no INSERT/UPDATE/DELETE/TRUNCATE table privileges. There are no client mutation policies. Revocations name application-owned tables and functions explicitly; they do not sweep unrelated public objects or change schema-wide default privileges. Future application migrations must include explicit grants/revocations. Browser-supplied role/email fields cannot promote membership or change the actor.

Members see their seasons/catalog metadata, their membership, their own current votes and audit events. Admins may also see their season's member list, invitations, and configuration/lifecycle history. They receive only completion counts through the narrowly scoped admin progress function. Every preference-bearing table remains restricted to its owner, in SETUP, VOTING, LOCKED, and REVEAL. No result query or implicit reveal grant exists. Aggregating RLS-filtered tables cannot reveal other members' preferences.

Security-definer functions pin an empty search path and fully qualify table/helper references. Private helpers are outside the exposed API schema; only boolean membership/admin helpers receive authenticated execute privileges for policies. Mutating functions recheck authority. Privileged owner/service access remains an explicit trust boundary; it is not an application admin role. Audit update/delete/truncate triggers add protection against accidental privileged rewrites, but the database owner can intentionally alter schema and bypass them.

The Data API exposes only `public`. Realtime, GraphQL exposure, storage, edge functions, analytics, and SMTP are unnecessary for this foundation and disabled locally. Local Supabase Studio is enabled for owner-operated development inspection; its scratch queries under `supabase/snippets/` are ignored and never deployed as migrations. No preference table is published to Realtime. Future changes to grants, definer functions, logs, exports, or result endpoints require equivalent secrecy review.

## Verification and remaining work

Verified on 2026-10-01 with Supabase CLI 2.119.0 and the local Supabase PostgreSQL 17 stack: `supabase start` succeeded; `supabase db reset --local` rebuilt all three migrations and the synthetic seed; the original baseline had 28 passing tests and database lint reported no schema errors. Documentation links and whitespace checks also passed. The suite tests actual PostgreSQL sessions and actual local PostgREST HTTP requests; it does not substitute an Auth schema mock. It covers authorization, membership/identity checks, all-state secrecy, direct-write denial, constraints, idempotency, conflicting UUIDs, lost-response recovery, stale edits, concurrent duplicate/edit/Super Like actions, atomic rollback, immutable history, both vote-versus-lock transaction orderings, catalog growth, and allowance audit/usage.

Pre-commit cleanup verification: the clean local reset and database lint passed. All **33 integration tests passed** (30 database tests and 3 HTTP tests), both in normal and reversed execution order. Added coverage checks surrounding whitespace/case and conservative alias handling, shared normalization of Auth emails, rollback cleanup on interruption, rejection of unsafe test targets/overlapping runs, and preservation of unrelated public-object privileges. HTTP fixture timestamps were aligned with the local database clock after Docker/host skew caused `JWT issued at future`; authorization assertions were not relaxed. Repository whitespace, shell syntax, Python syntax, and local documentation-link checks passed.

Before frontend integration, confirm real Google OAuth configuration and the local provider handshake, and agree on the client's conflict/pending-state behavior using the contract above. Before collecting real votes, define and test production backups and restore procedures; local migration reset rebuilds schema and synthetic data, not real voting history. Invitation lifecycle UX, destructive catalog/account policies, deterministic ordering, reveal visibility, and production deployment remain deferred. No unresolved product decision prevents use of the foundation APIs.


## Production deployment

The accepted initial deployment uses a clean Supabase Cloud Free project, separate from local accounts and experimental votes. Follow [deployment.md](deployment.md) for the migration-only workspace, explicit target checks, Google Auth configuration and recovery/pilot gates. Never apply synthetic seed data or run the destructive integration runner on Cloud. This operating guide does not claim that remote migrations or recovery have been tested.

## Reference documentation

The implementation follows Supabase's [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security), [Auth identity model](https://supabase.com/docs/guides/auth/identities), and [local CLI configuration](https://supabase.com/docs/guides/local-development/cli/config). Provider credentials and owner/service keys remain deployment concerns, never application-admin privileges.

## Nickname migration and My Picks reads

Before applying the nickname migration to an existing database, check for collisions as its owner:

```sql
select season_id, lower(btrim(nickname)) as nickname_key, count(*)
from public.season_members
group by season_id, lower(btrim(nickname))
having count(*) > 1;
```

Resolve any returned collisions deliberately before `supabase migration up --local`; the migration fails instead of renaming users or discarding membership. Index creation itself prevents concurrent duplicates. Invitation acceptance retains its season lock and email/account checks, now uses `ON CONFLICT (season_id,user_id) DO NOTHING`, and translates only the nickname-index violation to SQLSTATE 23505 / `nickname_unavailable`, without another member’s identity or raw constraint details. Failure rolls back membership and invitation acceptance together; a same-user accepted-invitation retry remains idempotent. No historical migration was edited.

My Picks introduces no new RPC or table grant. The client reads `votes`, explicitly filtered by caller and season, joins `season_tracks → tracks → track_artists → artists`, orders by track UUID, and requests pages of 500 using an exclusive UUID cursor. It includes inactive rated tracks for viewing; new edits still require active catalog membership. RLS enforces ownership even if a caller removes/spoofs client filters. `cast_vote` is unchanged, including its current-version requirement, UUID ledger, audit checks, READ COMMITTED guard, and season-level locking.

## First importer implementation (2026-10-07)

The first bounded local Spotify importer is implemented by `20261007000100_catalog_import.sql` and `scripts/spotify-import.py`. Earlier unimplemented/proposed labels describe the design milestone. See [implemented importer contracts and operating guide](spotify-importer.md) for private provider-neutral mappings, source designation audit, Google/Supabase operator authentication, separate Spotify PKCE, authoritative plans and exception decisions, transactional item receipts, retention, bounds, and validation. The accepted catalog rules and existing voting/privacy contracts remain unchanged.
