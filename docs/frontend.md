# Frontend: authentication and season entry

## Stack and scope

Vite 8, React 19, TypeScript, React Router, and supabase-js. Vitest and Testing Library exercise application behavior with mocked external authentication. Dependencies are pinned in package.json/package-lock.json; `npm ci` installs the reproducible dependency tree. Fonts are packaged locally, with no third-party font requests. The first voting UI is described below. There is no admin dashboard, result calculation, email delivery, or music-provider integration.

The app routes are `/`, `/auth/callback`, `/invite/:invitationId`, `/seasons/:seasonId`, and `/seasons/:seasonId/rate`. BrowserRouter requires a production host to serve index.html for these paths; hosting is not selected yet. The dev server already provides that fallback.

## Run locally

Prerequisites: Node.js 22.12+ (tested with 22.23.3), npm, Docker, and Supabase CLI. Use the repository root:

```sh
npm ci
# Create root .env with Google credentials as described below.
supabase start
supabase db reset --local
# Create .env.local with the two VITE_ values from .env.example.
npm run dev
```

Open `http://127.0.0.1:3000`. Use this origin consistently, including during OAuth: localhost is a different origin and does not share the PKCE verifier or session storage. Port 3000 is strict; the server will not silently switch callback origins when the port is occupied.

`db reset --local` is for a disposable local database. It rebuilds all migrations and synthetic fixtures, and removes real local users/memberships. Run database tests before adding real Google users; the test safety guard deliberately rejects non-synthetic Auth data. To add the new migration to an existing local database without resetting it, use `supabase migration up --local`.

Browser environment variables in ignored `.env.local`:

| Variable | Local value |
| --- | --- |
| `VITE_SUPABASE_URL` | `http://127.0.0.1:54321` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The **publishable key** or legacy **anon key** from `supabase status`. Never the secret/service-role key. |

Restart Vite after changing environment variables. VITE_ values are public build-time browser configuration. Google client secrets must never use a VITE_ prefix. `.env.example` contains only placeholders. The app refuses missing/placeholder configuration and recognizable privileged keys instead of attempting an unsafe connection. A local public-only `.env.local` was prepared during development; it is ignored by Git.

For the current machine, an ignored Node runtime is also available in `.tools/node/bin`; if Node is not on PATH, run `export PATH="$PWD/.tools/node/bin:$PATH"` first. The system's Xcode license prompt blocked system Python/Git during verification; bundled executables and a repository-local `.venv` were used instead. No license was accepted or system installation changed.

## Exact Google OAuth configuration

Follow the [official Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google). There are two different callback URLs:

1. In Google Cloud / Google Auth Platform, configure the OAuth consent screen and audience. If the application is in Testing, add the Google accounts that will test it to the test-user list. Create an OAuth client of type **Web application**.
2. Add the frontend origin `http://127.0.0.1:3000` to **Authorized JavaScript origins**.
3. Add **Google's authorized redirect URI**: `http://127.0.0.1:54321/auth/v1/callback`. This is Supabase Auth's endpoint, not the React route.
4. Put the real client ID and client secret in **`.env` at the repository root** (not `supabase/.env` or `.env.local`). Supabase CLI loads this file for `env(...)` references in config.toml; see [config and secrets](https://supabase.com/docs/guides/local-development/managing-config). Both local environment files are ignored by Git. Keep only the public `VITE_` entries in `.env.local`.

   ```dotenv
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=YOUR_GOOGLE_WEB_CLIENT_SECRET
   ```

5. `[auth.external.google]` is enabled in `supabase/config.toml`; both credential fields reference the variables above. Keep `skip_nonce_check = false`; do not enable email signup, anonymous sign-in, or manual account linking.
6. The application callback allowlist is already configured: `[auth].site_url` is `http://127.0.0.1:3000` and `additional_redirect_urls` includes **`http://127.0.0.1:3000/auth/callback`**. The frontend sends that exact callback as `redirectTo`.
7. Restart from the repository root after changing provider configuration or credentials, preserving local data:

   ```sh
   SUPABASE_TELEMETRY_DISABLED=1 supabase stop
   SUPABASE_TELEMETRY_DISABLED=1 supabase start
   ```

   The telemetry flag avoids CLI 2.119.0 writing telemetry state outside the repository. No database reset is needed. Restart the frontend if its public environment changed.

For a future hosted Supabase project, Google’s redirect URI becomes `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`; enable Google in that project's Auth provider settings, set its Site URL to the frontend origin, and allowlist the frontend `/auth/callback`. Do not use a wildcard redirect when an exact URL will do.

PKCE uses the browser that initiated sign-in. The app explicitly exchanges the returned code once, persists the Supabase session, subscribes to auth changes, and restores the session after refresh. The invitation UUID stays in sessionStorage across the same-tab redirect and is validated again by the database. No arbitrary external return URL is accepted. Opening concurrent OAuth flows in multiple tabs or clearing browser storage during sign-in can invalidate a PKCE verifier; retry sign-in in the intended tab. OAuth errors are rendered generically without echoing provider details or tokens.

## Provisioning a real local test invitation

No admin frontend is included. First sign in through the app using the season creator's real Google account. Seeing “Find your crew” at this point is expected: authentication alone does not create membership.

The project owner can then provision a season and invitation using the existing RPCs from the local database. This intentionally uses the accepted owner trust boundary. Substitute the two email placeholders before running; the creator must already exist from a real Google sign-in:

```sh
docker exec -i supabase_db_hardstyle-rankings psql -U postgres -d postgres <<'SQL'
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select id from auth.users
          where private.normalize_email(email) = private.normalize_email('CREATOR_GOOGLE_EMAIL')),
  'role', 'authenticated'
)::text, true);
set local role authenticated;
select public.create_season('Hardstyle 2026', 2026, 30, 'Season admin') as season_id \gset
select public.transition_season(:'season_id', 'VOTING');
select 'http://127.0.0.1:3000/invite/' ||
       public.invite_member(:'season_id', 'INVITED_GOOGLE_EMAIL')::text as invitation_url;
commit;
SQL
```

The example allowance of 30 is a local example, not a new product default. An empty catalog is valid; the home shows zero tracks. Use the existing `add_track` RPC under the admin identity if test tracks are wanted. For another invitation to an existing season, reuse its UUID and `invite_member`; do not create another season unintentionally.

Open the returned invitation URL in the intended browser. Verify: correct Google account → nickname → home; refresh restores home; reopening the accepted invitation skips nickname; signing out and choosing the wrong account yields a generic invitation denial. The URL is a locator, not a bearer membership credential.

## Database contract compatibility

The original `accept_invitation(p_invitation, p_nickname)` correctly creates membership and acceptance together; it cannot validate an invitation before nickname submission without also mutating membership. Invitations are admin-readable only, so the browser also cannot resolve an already accepted invitation to its season.

The additive migration `20261003000100_invitation_preview.sql` supplies a narrow **read-only** `inspect_invitation(p_invitation)` RPC. It reuses `private.google_email()`, matches the normalized invited email, rejects acceptance bound to another user, and returns only `{season_id, season_name, year, nickname}` for the verified invited identity. Nickname is null for a new member. It reveals no invited email, membership list, votes, or aggregates. Anonymous execution is revoked. Existing RLS, mutation grants, voting locks, and the first three migrations are unchanged. Acceptance still revalidates the identity and invitation at submission time.

For an existing member, inspection returns their saved nickname and the app goes directly home. For a new member, nickname selection happens before the membership-creating RPC. Nicknames currently allow duplicates; no uniqueness rule was invented. The UI also safely handles a 23505 rejection should a future reviewed constraint introduce conflicts. Unknown invitations and wrong-account invitations deliberately share `invitation_not_available`, so the UI does not claim to distinguish them.

## Home, errors, and privacy

Home reads `seasons`, the caller's own `season_members` row, and `my_progress`. Membership reads explicitly filter by the authenticated user even for admins. It displays season name/status, nickname, active/rated/unrated counts, and own Super Like usage/availability. No group preferences, results, raw votes, or admin-progress query is requested. Root entry without an invitation opens the most recently joined membership; explicit season links open that season.

Loading, missing session, OAuth failure, malformed/unknown/wrong-account invitation, uninvited account, nickname validation, RPC failure, unavailable season, and sign-out failure have user-facing states. Raw database/provider error details are not printed in the UI or logged with sensitive payloads. Session restoration cannot overwrite a newer callback or auth-state event. Pending network requests are ignored after route/account changes where data is loaded; membership creation remains idempotent through the database contract if a response is lost.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
scripts/test-db.sh
supabase db lint --local --level warning
```

The database command uses the existing guarded, non-parallel runner. Frontend tests mock OAuth and the API boundary; database tests retain real grants/RLS and add inspection coverage. Browser smoke verification used a synthetic signed session against the real local Supabase Data API, not a Google account. Google OAuth requires the configuration above. Provider settings and the initial browser redirect can be verified locally; completing Google consent and the callback requires a real Google account.


Verified for this slice: **20 frontend tests passed**, TypeScript typecheck and ESLint passed, and the production build succeeded. A clean local Supabase rebuild applied all four migrations; database lint reported no schema errors and **35 database/HTTP integration tests passed**. A headless Chrome run at mobile and desktop sizes verified real browser-to-local-Supabase inspection, nickname acceptance, home progress, session restoration on refresh, accepted-invite bypass, and sign-out using a synthetic signed identity; no browser runtime errors or mobile horizontal overflow were observed. Real Google OAuth was not claimed as tested.

Local Google provider verification: after loading credentials from root `.env` and restarting without resetting the database, `/auth/v1/settings` returned HTTP 200 with `external.google = true`. Clicking the frontend’s “Continue with Google” button returned HTTP 302 from `/auth/v1/authorize` to `accounts.google.com`. The browser check stopped before Google login; account consent and the completed callback still require manual verification. The 20 frontend tests, typecheck, lint, and build passed again.

## Voting (first usable flow)

Home links to `/seasons/:seasonId/rate`. During VOTING it says Start/Continue rating; otherwise View rating status also allows an outstanding accepted action to be reconciled after locking. The screen displays artwork (a local CSS placeholder when absent), ordered artists, and external HTTPS Spotify/Apple Music links when present. Missing links are explicitly unavailable. Music URLs are restricted to their provider hosts; no playback API or OAuth music scope is used.

`next_unrated_track(p_season)` selects one active season track absent from the authenticated member’s votes. Ordering is ascending `md5(user_uuid || ':' || season_uuid || ':' || track_uuid)`, then track UUID. This is a stable distribution key, not a security primitive. Different users can receive different orders. Catalog additions enter this ordering naturally; existing votes are never reset. Null means caught up with the current catalog, including an empty catalog. There is no cursor/index or permanent completion flag.

PASS / LIKE / SUPER LIKE all use the unchanged `cast_vote` contract: expected version 0, a new client UUID, and a version-1 receipt. Buttons block while pending. The next track is loaded only after a matching accepted receipt; progress and remaining Super Likes come from `my_progress` via the existing home API, never a client counter. Home reloads persisted progress when revisited.

Before sending a vote, the browser writes its full action payload and display metadata to localStorage under a versioned user/season/action key. Separate action keys avoid overwriting another tab’s uncertain action. Reload/reopen discovers outstanding actions before asking for a new choice. Retry uses the same UUID, choice, track, season, and expected version; it can recover an accepted vote after locking. The request uses the captured user’s token and refuses a different current account. A 30-second request timeout is treated as uncertain, not rejected. No access token is stored in the retry journal. Pending choices remain locally across sign-out so the same account can recover; another account does not load them. Browser storage must be enabled. Clearing site storage discards pending retry metadata, but committed votes remain in Postgres and are excluded from the next-track queue.

Network/unknown errors retain the pending action and show Retry pending vote. Definitive version/action conflicts, allowance errors, inactive tracks, closed voting, and lost membership show friendly messages and refresh authoritative state. The screen never upgrades expected_version to edit an existing vote. A different-device first vote is preserved. If receipt reconciliation succeeds but the next read fails, retry reloads the queue without sending another vote. Corrupt/unavailable local storage blocks new submissions rather than silently dropping an uncertain action. Cross-device and simultaneous-tab races are ultimately resolved by the database version/idempotency contract; no browser lock is treated as authority.

No existing vote edits, gestures, results, scores, provider import, or admin UI are included.

### Local development catalog

The optional script adds 12 fictional tracks with `[DEV]` titles and artist names to an existing local season. It calls `add_track` and optionally the audited `transition_season` RPC. Re-running skips the same development titles in that season. It never deletes tracks/votes or runs automatically in migrations, production, or the frontend. It only connects to the existing local CLI project on loopback port 54322 and refuses libpq routing overrides, non-admin users, or closed seasons. Fictional tracks have no invented provider URLs; the normal placeholder and missing-link UI apply.

With Docker/Supabase running, from the repository root:

```sh
SUPABASE_TELEMETRY_DISABLED=1 supabase migration up --local
.venv/bin/python scripts/seed-dev-catalog.py \
  --season YOUR_EXISTING_SEASON_UUID \
  --admin-email YOUR_SIGNED_IN_ADMIN_GOOGLE_EMAIL \
  --open-voting
npm run dev
```

`--open-voting` explicitly advances SETUP to VOTING; omit it to leave the season in SETUP. Existing VOTING seasons stay open. The script uses the existing Python/psycopg environment from database setup. No real Google account is created by this script. Open the season, press Start rating, submit each choice, reload, and check Home. To exercise missing-response recovery, interrupt connectivity during a request and use Retry pending vote. Previously accepted actions reconcile safely.

For destructive migration reset/integration tests, use a disposable stack with the five synthetic Auth users. Do not reset a local project containing real accounts merely to run tests. The first voting verification used an ignored copy of config/migrations/seed/tests under `.tools/voting-verification`, project ID `hardstyle-rankings-voting-check`, API port 55421, database port 55422, shadow port 55420, and Google disabled. The copied tests derive their CLI root there, keeping the existing non-local/non-synthetic guards intact. No credentials or real data were copied. A separate frontend on port 3001 exercised that stack. Apply migrations to the ordinary local project using `migration up --local`, preserving its accounts and data.

Voting verification: **37 frontend tests** passed, with typecheck, ESLint, and production build passing. The isolated clean reset applied all five migrations; database lint found no schema errors; **39 database/API tests** passed (34 direct-database tests and 5 real PostgREST HTTP tests). A real Chrome/browser-to-Data-API run verified all three choices, an accepted response deliberately lost before delivery, reload plus same-action retry, persisted completion after refresh, updated Home progress, and mobile layout without horizontal overflow or runtime errors. Three choices produced exactly three current votes and three audit events, all at version 1. The development catalog loader added 12 tracks to the ordinary local season and zero on rerun. Existing local Google accounts/membership were preserved; the season was opened via the audited transition RPC.

## Core voting milestone verification (2026-10-06)

Before tagging `v0.1.0-core-voting`, all 37 frontend tests and 39 database/API tests passed again. TypeScript, ESLint, production build, database lint, documentation links, Python/shell syntax, and whitespace checks passed. The isolated local stack was cleanly rebuilt from all five migrations, with Studio on port 55423 and Google disabled for synthetic tests; the ordinary local database was not reset. Local credential files, Studio snippets, runtimes, and test artifacts remain ignored. No new product features were added during milestone preparation.
