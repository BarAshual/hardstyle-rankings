# Deployment and production

## Accepted rollout (2026-10-11)

Use Vercel Hobby and Supabase Cloud Free initially. No paid upgrades, domain purchase, additional backend, or scheduled Spotify sync is approved. GitHub remains the source of truth.

The owner reports creating Supabase project `qlljthzktgrnpsnysnwq`, reaching Vercel's import configuration screen, and creating a Google Cloud project. These are owner-reported setup milestones, not verified deployment or database readiness.

| Target | Configuration |
| --- | --- |
| Supabase production project | `qlljthzktgrnpsnysnwq` |
| Expected Supabase API URL | `https://qlljthzktgrnpsnysnwq.supabase.co` (verify in dashboard) |
| Vercel project name | `hardstyle-rankings` |
| Production origin | `https://tiloz-voting-2k26.vercel.app` (owner-confirmed browser login) |
| First dummy season allowance | 50; this is not the official season allowance |
| Production data | Clean slate; local votes are experiments and are not transferred |

## Environment boundaries

- Keep regular local development on the existing loopback Supabase stack; it may contain real local accounts and experimental votes. Do not reset it.
- Run destructive integration tests only on the documented disposable synthetic stack or CI.
- Use fresh production Google accounts/sessions, invitations, season configuration and target-bound catalog plans. Do not copy local Auth data, votes, seed fixtures, or importer sessions to Cloud.
- Production can host repeated dummy-season pilots. Once official voting starts, a dummy season does not isolate schema changes, global canonical/provider mappings, or whole-database restores. Test destructive changes on an isolated temporary target.
- Keep production public configuration out of Vercel Preview and Development scopes. A preview without configuration displays the existing configuration error; it must not connect to production.
- Review releases against passing GitHub checks. Vercel's automatic deployment is not evidence that the database job passed. Before official voting, configure controlled production promotion or equivalent deployment gating; migrations never run from a frontend build.

## Vercel configuration

The tracked `vercel.json` selects Vite, reproducible dependency installation, the existing build command, `dist`, and SPA rewrites. Deep links including invitations, My Picks and the PKCE callback must load the application directly.

In the Vercel import/project settings:

1. Select the repository and project name above; verify the resulting domain instead of assuming it is available.
2. Select Node.js 22.x (repository/CI baseline: 22.23.3; minimum 22.12).
3. Add only these two variables, scoped to **Production**:

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Verified production API URL above |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Production public publishable key from Supabase; legacy anon key also supported |

These values are intentionally public in the browser. Never use a secret/service-role key. Do not copy a local `.env.local` into the cloud build. Keep Google client secrets exclusively in Supabase Auth settings and protected local development configuration.

Vite embeds public variables at build time: changed values require a new deployment. The Git-connected deployment reads committed GitHub files, not uncommitted local changes. Git commit/push requires the owner's explicit instruction under AGENTS.md.

After deployment, open `/`, `/auth/callback`, an invitation path and both season routes directly and after refresh. Verify static assets load and the browser contacts only the production API. An incomplete callback should render the application's friendly error, not a hosting 404.

## Google OAuth and Cloud settings

Create a separate production Google web OAuth client in the new Google Cloud project. Complete Google Auth Platform Branding/contact details and select External audience for personal Google accounts. Request only basic identity scopes (`openid`, email, profile). Use Testing for the pilot as appropriate and configure pilot accounts; review publishing requirements before the official rollout.

Once the frontend domain is confirmed, configure:

| Setting | Value |
| --- | --- |
| Google Authorized JavaScript origin | Confirmed frontend origin, with no path |
| Google Authorized redirect URI | `https://qlljthzktgrnpsnysnwq.supabase.co/auth/v1/callback`; copy/verify from Supabase Google provider settings |
| Supabase Auth Site URL | Confirmed frontend origin |
| Supabase allowed browser redirect | Confirmed frontend origin + `/auth/callback` |

Enable Google in Supabase and paste the client ID/secret directly there. Keep nonce checking enabled. Disable email/password, phone, anonymous sign-in and manual account linking; keep Google account creation enabled. Authentication alone never grants season membership.

Cloud settings are not automatically established by the local `supabase/config.toml`. Verify the Data API exposes only `public`, not `private`; audit table/function grants, RLS, views and any GraphQL surface. No preference-bearing table may be published to Realtime. Avoid enabling unused Storage, Edge Functions or extra providers.

Importer operator login uses a nonce-bearing loopback callback. The browser callback allowlist alone is insufficient for that workflow. Add a narrowly scoped operator callback rule only as part of the reviewed remote-importer extension; do not allow all preview origins or arbitrary redirects.

## Migration procedure: separate workspace, no seeds

Use the pinned Supabase CLI 2.119.0, matching existing CI. The following procedure is an operator runbook; no Cloud migration has been applied by writing it.

Before any remote command, verify the signed-in Supabase account and dashboard project reference, Postgres compatibility with the repository's PostgreSQL 17 baseline, and the absence of unexpected app data/schema. Stop on unexpected migrations or drift. For an existing database, require a tested recoverable backup before changes. An empty database still needs its initial state recorded.

Run frontend checks and the existing disposable database/importer checks before release. Do not repoint `scripts/test-db.sh` at Cloud.

From the repository root, prepare an ignored, fresh workspace containing migrations only:

```sh
export SUPABASE_TELEMETRY_DISABLED=1
mkdir -p .tools
release_workdir="$(mktemp -d "$PWD/.tools/production-release.XXXXXX")"
mkdir -p "$release_workdir/supabase/migrations"
cp supabase/migrations/*.sql "$release_workdir/supabase/migrations/"
cat > "$release_workdir/supabase/config.toml" <<'TOML'
project_id = "hardstyle-rankings-production-release"

[db.seed]
enabled = false
TOML
```

Authenticate interactively with `.tools/supabase login` if needed. Enter credentials through the CLI's supported secure prompt/credential mechanism; do not paste them into chat, shell command arguments, or committed files. Avoid debug output containing connection details.

Each command specifies the exact project instead of relying on a repository-local link:

```sh
.tools/supabase --workdir "$release_workdir" migration list --project-ref qlljthzktgrnpsnysnwq
.tools/supabase --workdir "$release_workdir" db push --project-ref qlljthzktgrnpsnysnwq --skip-vault --dry-run
```

For the initial empty project, review all ten migration files in timestamp order through `20261010000100_import_planning_performance.sql`. Stop if history differs. Verify copied migrations byte-for-byte against the approved release commit. A dry run inspects pending files; it does not validate every SQL statement against the remote database.

Only after target and migration review, apply:

```sh
.tools/supabase --workdir "$release_workdir" db push --project-ref qlljthzktgrnpsnysnwq --skip-vault
.tools/supabase --workdir "$release_workdir" migration list --project-ref qlljthzktgrnpsnysnwq
```

Never add `--include-seed`, run remote reset, copy `seed.sql`, or run development loaders on Cloud. Never use `--include-all` or migration repair to conceal unexpected history. A partial failure requires inspection of migration history and schema before retry. Preserve existing migrations; use reviewed additive corrections.

Post-apply verification must inspect grants/RLS, public function signatures, audit consistency/immutability triggers, constraints and migration versions. Exercise Google identity admission and authorized RPCs through the actual hosted Data API using dummy-season accounts. Verify direct writes and cross-user preference reads fail, including for an application admin. Preserve READ COMMITTED, existing lock ordering, action UUIDs and vote versions.

For later releases: backup → compatible additive database change → verify → deploy compatible frontend → smoke check. Roll back frontend by promoting the known-good deployment; do not assume this reverses schema changes.

## Catalog and dummy-season pilot

The bounded dummy-pilot extension now requires explicit HTTPS project/season binding, separated protected Google sessions and fresh target-bound plans; local-only operation remains the default. See the Cloud pilot section in [spotify-importer.md](spotify-importer.md). The first hosted Google-admin plan/apply and fresh-plan repeat passed as recorded below; broader multi-user and recovery validation remain pending. Keep Google-admin JWT RPCs and Spotify PKCE; no service-role import path or direct table loading.

After that extension and recovery readiness: designate the production source, create a fresh target-bound plan, review exceptions, apply, reconcile receipts, and repeat to verify no unintended additions. Planning itself writes private import bookkeeping. No local plan or review file is authoritative for new production UUIDs.

First pilot: clearly named dummy season, allowance 50, 2–3 invited Google accounts, and a small reviewed catalog. Verify login, wrong-account denial, persisted votes/edits, lost-response retry/reload, stale-device protection, derived allowance/progress, and safe catalog growth. Test LOCKED/REVEAL secrecy only on dummy seasons; backward lifecycle transitions are unsupported. Retain dummy audit history instead of deleting it.

## Free-tier recovery and monitoring gates

Free has no included managed backups and may pause after a week of inactivity. Capacity and recovery are separate concerns: transactional vote durability does not guarantee recovery after catastrophic database loss.

Before official votes, agree on acceptable recovery-point loss and downtime, backup frequency/retention, a reliable scheduler independent of a sleeping laptop, and encrypted independent storage. These choices and implementation remain open; free-only does not mean recovery is already solved.

A restorable backup must cover `public` and `private` app data, Auth users/identities with stable UUIDs, canonical/provider mappings, votes/versions, immutable vote events/replay receipts, lifecycle/configuration/import audits, roles/grants and migration history. Verify actual export scope: a default dump must not be assumed to contain every managed schema or migration history. Maintain a separate protected inventory of OAuth configuration, project URLs and secrets; do not archive importer OAuth token files.

Rehearse restore on an isolated Cloud target with synthetic/dummy votes: verify identity continuity after Google sign-in, choices/versions/events, idempotent accepted-action replay, constraints, RLS/secrecy and frontend reconnection. Record timing, export cutoff, success and limitations without exposing votes. Protect any restored official data like production. Do not run a whole-project restore over an official season to test a dummy season.

Start monitoring with platform logs and operational metrics. Never record choices, vote payloads, tokens, provider error bodies or preference-bearing SQL in app/CI logs. Monitor backup freshness/failures, availability, Auth errors, RPC timeouts and incomplete imports. Schema migration, import and backup logs require equivalent privacy review.

## Readiness status

- Prepared locally: Vercel routing/build configuration and this operating guide.
- Owner-reported: empty Cloud project, Vercel import screen, new Google Cloud project.
- Verified on 2026-10-11: correct Cloud project, PostgreSQL 17.11, initial empty state, all ten migration versions, and the schema/security checks below.
- Owner browser evidence: Google login returns to `https://tiloz-voting-2k26.vercel.app` and displays the signed-in membership gate. Verified in Cloud: the creator has a confirmed matching verified Google identity.
- Not yet fully verified: Cloud Auth/API configuration, multi-user admission/secrecy, catalog import, pilot, backup automation and restore.
- Official voting remains gated on these validations and a selected official allowance.

Official references: [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Vercel environment variables](https://vercel.com/docs/environment-variables), [Supabase Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [Supabase migration workflow](https://supabase.com/docs/guides/deployment/database-migrations), [backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [backup coverage](https://supabase.com/docs/guides/platform/backups), and [current free limits](https://supabase.com/pricing).

## Cloud schema initialization checkpoint (2026-10-11)

After the owner completed interactive CLI login, the target project was verified ACTIVE_HEALTHY in eu-central-1 with PostgreSQL 17.11. Preflight returned zero public/private app tables and zero Auth users; no migration history existed. GitHub quality gate for commit 5e7af8fca41bb1513bc78116a65a60cef3ba452e passed frontend and disposable database/importer jobs.

A separate migration-only workspace copied all ten SQL files byte-for-byte from that commit, with seed disabled and no credentials or seed file. Explicit-project dry run showed exactly those migrations and no seeds. All ten were applied using --skip-vault; remote migration history then matched every local version. The regular local Supabase project was not reset, linked to Cloud, or modified.

Hosted catalog checks verified 11 public and 8 private application tables, RLS on all 19, no authenticated direct table-write privileges, no anonymous table reads, no anon/authenticated/service-role table access to private importer tables, and empty pinned search paths for security-definer functions. cast_vote is executable by authenticated and not anon. Both deferred vote/audit consistency triggers and all five immutable audit triggers are enabled. Own-vote and own-event policies require auth.uid ownership and membership; neither preference table has a publication. The season nickname unique index and six vote constraints are present. Auth users, seasons and catalog tracks remain zero.

These are structural checks on an empty hosted database, not end-to-end Google admission, hosted multi-user vote/concurrency tests, backup or restore validation. Cloud provider/API settings remain a separate verification step; official voting remains gated.

## First production dummy season (2026-10-11)

The owner authorized provisioning after completing Google login. The operator checked the exact production project and confirmed no existing seasons, then used the documented owner provisioning boundary: a transaction-local authenticated identity context and the existing `create_season` function, without direct table inserts or privileged browser credentials.

Created `DUMMY — Production Pilot 2026` (season UUID `40e56921-f6a2-45c6-a54e-d619600a52de`), year 2026, allowance 50 Super Likes per member, in SETUP. The creator is the first admin with nickname `Tiloz`. Post-commit checks confirmed one member, correct creator/admin linkage, allowance 50 and zero tracks. No lifecycle transition or preference access was performed. Two email-bound pilot invitations were created through `invite_member` for the owner-provided accounts; both await acceptance. Links were returned privately to the owner; no messages were sent. Catalog preparation, hosted pilot and recovery gates remain outstanding.


## Dummy pilot catalog and voting checkpoint (2026-10-11)

The owner supplied a Spotify playlist and explicitly approved its first 20 release-year exceptions for dummy use. The bounded Cloud operator extension passed all 14 mocked importer tests and then completed a fresh Google PKCE login, audited source designation, hosted full scan/plan and exception review. Initial limited apply created 20 canonical tracks, 12 artists, 20 provider mappings and 20 active memberships. Fresh-plan limited repeat returned 20 already-present outcomes with zero additions. The remaining 16 playlist occurrences remain unapplied. Hosted authenticated reads confirmed all 20 active tracks; anonymous season reads and importer context were denied. No operator vote writes or preference reads occurred.

The dummy season is now VOTING, allowance 50, with exactly one attributed SETUP → VOTING lifecycle event verified through the authenticated Data API. The earlier SETUP checkpoint remains historical. The owner and the two invitees can begin the dummy-only browser pilot. This milestone does not establish multi-user vote durability/secrecy, restore readiness or permission to invite everyone for official voting. Code and synchronized documentation remain uncommitted pending explicit owner instruction.


## Manual Apple listening-link enrichment (2026-10-11)

The owner supplied an Apple Music IL playlist and requested manual links for the 20 admitted dummy tracks. All 20 were individually reviewed against provider titles/version labels, ordered artist credits and displayed durations (less than one second difference). Two matching version labels use parentheses on Apple instead of a Spotify title separator; casing differences do not change the reviewed recording. Playlist order alone was not used as identity evidence.

A one-off owner transaction acquired the existing catalog advisory lock and the dummy season row lock, checked VOTING/admin membership, exact Spotify mapping/track/title/membership identity, absence of cross-season scope, and refusal to overwrite or repoint a different existing link/mapping. It added 20 `apple_music` mappings in `private.track_providers`, with retained public source/storefront/artist/duration evidence, reviewer UUID and timestamp, and selected their `tracks.apple_music_url` display projections. Existing canonical metadata excluding that URL was checked equal before commit. No vote or vote-event table was read or written; no artist mapping, membership or identity reassignment occurred.

Post-commit authenticated hosted catalog reads returned all 20 expected Apple song URLs. The frontend already consumes this field, so no frontend release or migration was needed. The protected review manifest and transaction file are operator artifacts, not credentials or committed fixtures. This is bounded manual enrichment under the accepted owner trust boundary, not an Apple API adapter, automated matching system or reusable administration UI. Recovery and multi-user pilot gates remain unchanged.


## Explicit owner test-vote reset (2026-10-11)

The owner explicitly requested direct deletion of their own dummy-season votes and reiterated that this Cloud season is test data. This is a one-off destructive test-data exception, not a product undo/reset feature or a change to official vote durability/retention guarantees. Preflight identified 19 current votes and 21 audit/replay events for only the creator in the first production dummy season.

The owner transaction used the actor advisory lock, NOWAIT exclusive vote/event table locks and a guarded dummy-season lock. It temporarily disabled only the immutable vote-event trigger inside that transaction, deleted the exact season/user event rows then current vote rows, and re-enabled the trigger before commit. Guards checked unchanged out-of-scope row counts and enabled audit protections. Post-commit verification confirmed zero target votes/events, all three vote/audit guards enabled, and all 20 Apple-linked active catalog tracks retained. No choices were printed, no other user's votes were deleted, and no migration or application reset endpoint was introduced. Historical pilot voting observations predate this deliberate reset. Refresh browser views before rating again; old accepted-action replay history for this user's dummy votes was deliberately removed at the owner's request.
