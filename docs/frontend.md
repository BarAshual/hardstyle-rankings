# Frontend: authentication and season entry

## Stack and scope

Vite 8, React 19, TypeScript, React Router, and supabase-js. Vitest and Testing Library exercise application behavior with mocked external authentication. Dependencies are pinned in package.json/package-lock.json; `npm ci` installs the reproducible dependency tree. Fonts are packaged locally, with no third-party font requests. The first voting UI is described below. There is no admin dashboard, result calculation, email delivery, or music-provider integration.

The app routes are `/`, `/auth/callback`, `/invite/:invitationId`, `/seasons/:seasonId`, `/seasons/:seasonId/rate`, and `/seasons/:seasonId/my-picks`. BrowserRouter requires a production host to serve index.html for these paths; the tracked vercel.json supplies this fallback on Vercel. See [deployment.md](deployment.md) for the accepted free-tier rollout and exact production configuration. The dev server already provides that fallback.

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

For an existing member, inspection returns their saved nickname and the app goes directly home. For a new member, nickname selection happens before the membership-creating RPC. Nicknames are now unique case-insensitively within a season. The UI handles `nickname_unavailable` / 23505 with a friendly request to choose another name and never displays raw constraint details. Unknown invitations and wrong-account invitations deliberately share `invitation_not_available`, so the UI does not claim to distinguish them.

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

My Picks below adds existing-vote edits. Rating now implements the accepted swipe mapping as documented below. Results, scores, and admin UI remain excluded; the separate operator importer is documented in [spotify-importer.md](spotify-importer.md).

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

## My Picks and editing

Home keeps its rating action and adds **My Picks** at `/seasons/:seasonId/my-picks`. Only the signed-in user’s choices are requested. Cards show artwork, title, ordered artist credits, current choice, and available external music links. Search title/artist and filter All / Likes / Super Likes / Passes locally. The client pages through all own votes rather than silently stopping at the Data API row limit. Empty catalogs/choices and no matching filters have separate states. Inactive rated tracks remain visible but cannot be edited.

The owner-approved My Picks presentation orders edit buttons PASS / SUPER LIKE / LIKE from left to right, matching Rating. The shared three-column vote grid gives equal widths and 48 px minimum touch targets; provider controls also use 48 px height. On widths up to 600 px, both control rows span the card beneath the artwork/details row, with aligned outer edges. Artwork stays a small thumbnail beside the copy on narrow phones. Title-to-artist and artist-to-current-choice gaps are 6 px and 4 px. Selected-choice styling and disabled/edit/recovery behavior are unchanged.

My Picks renders **25 choices per page**, with previous/next controls above and below results and an exact filtered range/count. Search and choice filtering apply to the complete own-pick snapshot, then paginate; changing either resets the page. Page, search and filter are encoded in `page`, `q` and `choice` URL parameters and restore on reload. Invalid page values default to the first page; out-of-range pages clamp to the last available page after filtering/edits. Explicit page navigation focuses and scrolls to the result summary. The existing RLS-protected read still retrieves all personal metadata in 500-row UUID-cursor batches; this revision bounds rendered cards/artwork requests, rather than introducing a server-side 25-row search/count API.

Returning from a listening app triggers a background refresh through focus/visible events. Previously loaded cards remain mounted, preserving normal browser scroll anchoring and the selected page; overlapping return events share the in-flight refresh. New edits and pending retries are disabled during refresh or after a failed read, until authoritative data is loaded. Failed refreshes retain visible personal choices with a retry notice. Account/season session keys still discard the prior view across identity/season changes. Confirmed edits and version conflicts also reload authoritative data without removing the list. No scroll coordinates or vote snapshots are added to persistent browser storage.

During VOTING, choose a different PASS / LIKE / SUPER LIKE to edit. The RPC receives the current vote version and a new action UUID. Same-choice buttons are disabled and the handler is a no-op. After acceptance the client reloads current choices/versions and authoritative personal progress. Changing away from SUPER_LIKE frees allowance through derived usage; invalid promotion shows the existing friendly limit error. A stale version reloads the latest choice and asks the user to review it; it never automatically resubmits using a new version.

Both screens use the same user/season/action journal and receipt validator. Pending version-0 records remain compatible; edits record a positive expected version. A pending action is shown independently of filters and blocks new edits until reconciled. Unknown failures retain the exact payload; retries reuse it across reload/relogin and navigation between Rating and My Picks. Requests are scoped to the captured actor token. After replay, current state is reloaded even if the receipt is older than another device’s edit. No duplicate local persistence layer or independent allowance counter exists.

My Picks refreshes on window focus and offers Refresh picks. If the season locks while open, the backend rejects a new edit and the screen reloads its read-only state. Own choices remain readable after LOCKED and REVEAL; no group data/results appear. Pending accepted-action retries remain possible after closure.

### Quality gate and local checks

`.github/workflows/quality.yml` runs on pull requests and pushes with read-only repository permissions. The frontend job installs pinned dependencies with `npm ci` under Node 22.23.3, then runs tests, typecheck, lint, build, and whitespace checks. The database job uses Python 3.12 and Supabase CLI 2.119.0 on Ubuntu’s Docker runner: disables Google and Studio only in the disposable checkout, starts Supabase, rebuilds all migrations and synthetic fixtures, lints the database, and runs the guarded direct-database and HTTP suite sequentially. Cleanup runs even on failure. No real credentials or remote Supabase project are required; startup logs stay unuploaded because CLI output can contain local signing material.

Official action sources: [Node setup](https://github.com/actions/setup-node) and [Supabase CLI setup](https://github.com/supabase/setup-cli). Actions are pinned to immutable commits. The workflow is authored and locally linted; an actual hosted GitHub Actions run requires committing/pushing it. No claim is made that hosted CI has already passed. The two job checks should be configured as required PR checks by the repository owner if merge enforcement is desired.

Continue running the local frontend checks and `scripts/test-db.sh` plus `supabase db lint --local --level warning` before merge. Clean reset/testing uses the isolated synthetic stack described above, now with six migrations and Studio disabled like CI. Apply the new migration to an existing real-account local database with `supabase migration up --local`, after checking nickname collisions. Do not reset that database.

### Manual pilot checks

1. Sign in, open Home → My Picks. Search a title and artist, try each filter, and check missing-link placeholders.
2. Change LIKE → PASS → LIKE → SUPER LIKE → LIKE; confirm remaining allowance changes and survives refresh/relogin. Selecting the existing choice does nothing.
3. Load the same pick in two browser sessions, edit it in one, then submit a stale edit in the other. The latter must show the conflict and reload the newer choice. It must not overwrite automatically.
4. Interrupt a submission’s response, reload, and use Retry pending vote. Confirm one version increment and one audit event for that logical action.
5. In a disposable test season, advance VOTING → LOCKED through the existing admin RPC. Own picks remain visible, and edits are rejected/disabled. This transition cannot be undone.

### Two real Google accounts: invitation boundary

Use Account A’s exact invited Google email and Account B that is **not already a member of this test season**. Use separate browser profiles/private windows to keep sessions independent. Google accounts must be permitted by the OAuth consent screen’s testing configuration. These steps require real Google login; synthetic JWT tests do not replace them.

- As season admin, create an invitation for Account A with the existing `invite_member` RPC and copy its URL.
- Account A opens it and signs in with Google. Try an existing nickname using different casing: it must show a friendly conflict and leave the invite unaccepted. Choose an unused nickname, accept, reach Home, and verify refresh/sign-out/sign-in preserves membership and display casing.
- Account B opens the **same forwarded URL**, signs in using its different Google email, and must see invitation unavailable. It must not gain membership.
- In **local Supabase Studio** (`http://127.0.0.1:54323`), use Authentication → Users to identify A/B UUIDs. In Table Editor → `public.season_members`, filter by the test `season_id` and each `user_id`. A should have one row; B should have none. `public.season_invitations` should be accepted by A’s UUID. Avoid editing tables while verifying.
- Alternatively, run this read-only owner query in Studio SQL Editor after replacing the placeholders:

```sql
select u.email, m.user_id is not null as is_member, m.nickname, m.role
from auth.users u
left join public.season_members m
  on m.user_id = u.id and m.season_id = 'TEST_SEASON_UUID'::uuid
where private.normalize_email(u.email) in (
  private.normalize_email('ACCOUNT_A_EMAIL'),
  private.normalize_email('ACCOUNT_B_EMAIL')
);
```

Studio is privileged owner tooling: this confirms stored membership, not client RLS. The actual HTTP tests independently verify that forwarded invitations fail and raw choices remain private. Do not inspect/share other members’ votes as part of this check.

My Picks milestone verification (2026-10-06): **56 frontend tests** and **45 database/API tests** passed (37 direct database tests, 8 real HTTP tests). Typecheck, ESLint, production build, six-migration clean isolated rebuild, database lint, and workflow actionlint passed. The My Picks route is split into a separate chunk; the main bundle stays below Vite’s default warning threshold. Browser verification against synthetic identities and real local PostgREST covered search/filter, Super Like release/limit, lost-response edit retry across reload, two-tab stale conflict, and locked read-only choices, without horizontal overflow or runtime errors. This did not exercise real Google OAuth. The normal local database had zero nickname collision groups; the additive migration and lint succeeded there without resetting accounts/votes.


## Mobile rating interaction (2026-10-11)

Rating and My Picks share `MusicLinks` with locally stored official Apple Music and Spotify icons. Following the owner's approved design revision, the compact Apple button uses the official white icon instead of the original full Listen on badge. A shared visible “Listen on” caption accompanies single-row icon/service-name buttons: red Apple Music with white content, green Spotify with black content. Both have equal-width columns, 52 CSS px height (48 px in compact mobile Rating) and 10 px corner radius. The group fills its content column. Rating aligns the outer edges of the two-provider row and three-vote row, with 12 px gaps on desktop and 8 px gaps on compact mobile layouts. Vote controls appear left to right as PASS, SUPER LIKE, LIKE; their keyboard order matches the visual order. Icons fit a 24 px box without changing aspect ratios; Spotify has at least 12 px clear space. Narrow layouts reduce text/padding and wrap only when two 124 px columns plus the 12 px gap do not fit. The unchanged HTTPS/provider-host validator and `target="_blank" rel="noopener noreferrer"` protect every active link. Missing/invalid URLs render unavailable text, never invented matches. See [asset provenance and brand spacing](../src/assets/README.md). Links, buttons, track text, and navigation are outside the draggable artwork surface. Rating is lazy-loaded at route entry; subsequent votes retain its mounted layout.

Only an unrated Rating card in VOTING accepts new gestures: left PASS, right LIKE, and up SUPER_LIKE when the page fits the visible viewport. Buttons provide the full keyboard/assistive alternative; My Picks has no gestures. The dedicated artwork surface reserves directional gestures with `touch-action: pinch-zoom` while the page fits. When the document exceeds the smaller of the layout and visual viewport heights, `touch-action: pan-y pinch-zoom` permits native vertical scrolling and the handler forbids upward voting. Pinch zoom remains available in both modes. Viewport resize and body ResizeObserver measurements update this mode, including recovery messages and zoom; changing the mode cancels an active gesture. A vertical or ambiguous movement past activation in scroll mode yields the entire gesture, so later sideways drift cannot vote. The visible hint explains when Super Like requires its button. Direct transform updates follow the pointer without easing during supported movement. Text/arrow feedback temporarily replaces the existing instruction below the vote buttons, outside the artwork, with strength increasing with displacement. The artwork fills the square surface with no outer frame, background or padding; the permanent drag caption is removed. Saving and confirmed-receipt labels use the same instruction row without adding space or covering the image. Downward movement keeps the card centered, with no choice feedback or positive vertical offset. Clear horizontal swipes still follow the horizontal displacement when the finger drifts slightly downward. Choice classification uses the original pointer displacement so clamping cannot turn a downward diagonal into a vote. Upward swipes can still return to or past the center to cancel; when upward voting is enabled, the same gesture can reverse from downward to a supported direction before release. Ambiguous diagonals are neutral.

The following are implementation calibration values, not changes to product rules or claims of physical-device validation:

| Parameter | Implemented value |
| --- | --- |
| Activation distance | 12 CSS px |
| Clear direction | Dominant axis must exceed the other by 1.35× |
| Horizontal release threshold | 25% of surface width, clamped to 72–120 CSS px |
| Upward release threshold | 25% of surface height, clamped to 80–130 CSS px |
| Horizontal rotation | At most ±7°; upward intent has no rotation |
| Return to center | 210 ms ease-out |
| Confirmed exit | 220 ms ease-in in the accepted choice's direction |
| Next-card entry | 180 ms ease-out, 14 CSS px upward arrival |
| Reduced motion | No card translation, rotation or CSS animation; no exit wait |

Only final displacement on matching pointer release can submit. Crossing a threshold and returning inside it never votes, and velocity does not bypass distance. Additional touch anywhere on the document, pointer cancellation/lost capture, window blur, hidden document/pagehide, route departure, and account changes cancel before submission. Beginning a drag cancels any ongoing entry animation. At zero authoritative Super Likes, an upward release returns to center with a limit explanation and no request; the server still rejects a concurrent quota change.

Buttons and gestures call the same submission handler, journal the full original action before network, validate the same accepted receipt, and retain the same UUID/payload after uncertainty. A synchronous guard blocks repeated events. Saving/unknown/recovery/next-read states block new choices. Cancellation ends at submission: there is no post-send Undo. Journal schema, receipt validation, RPCs, versioning, RLS, Auth and secrecy are unchanged.

The progress/header, square card slot, track-copy area, provider slots, and buttons remain mounted. Empty recovery/status areas reserve no blank height; visible errors and pending-action controls expand naturally below the voting controls. Saving stays on the current card at the final release position; releasing pointer capture or disabling new gestures does not rewind it. A matching receipt enables the directional exit and starts the existing home/next-track reads. A slow read waits inside the square slot; failed reads expose Try again and never resend an accepted vote. Exit keyframes start from the held displacement and continue beyond the viewport; the application root clips horizontal overflow while the square stage itself allows the card to leave. Cancelled or unconfirmed submissions return to center. Progress/allowance update only from the fresh home read. A brief screen-reader status replaces the repeated large success notice. Errors retain visible explanations. Track text has a fixed-height scrollable area so long titles remain available without shifting controls; artwork failure uses the ordinary placeholder. Closed/caught-up states occupy the same card slot.

### Verification and remaining pilot checks

All 92 frontend tests, TypeScript, ESLint and the production build passed. Focused tests cover gestures, duplicate release/button submission, cancellation, quota races, storage/receipt failure, lost-response retry, read-only retries after acceptance, account changes, keyboard controls and reduced-motion behavior, alongside existing Rating/My Picks recovery tests.

Chrome used emulated touch/mobile mode against the existing guarded synthetic Supabase project (API 55421, database 55422), with no reset or changes to real local/Cloud data. Real API checks covered neutral gestures, multitouch/cancel, scrolling outside the card, slow acceptance, failed next read, identical lost-response replay after reload, all three choices, zero quota, keyboard/button voting, reduced motion, another-session conflict, and accepted replay after LOCKED. A member-RLS audit confirmed exactly eight version-1 votes and eight unique audit events. My Picks remained private/read-only after closure and had no swipe surface. Mobile layouts at 320/390/414 CSS px had no horizontal overflow/runtime errors; a fictional-data browser preview additionally checked 375 px, branded/missing link slot stability, minimum touch targets, and caught-up layout. These are browser simulations, not physical-device or real Google OAuth verification. At this initial implementation checkpoint the full database integration suite had not been rerun; the later pilot-readiness pass below supersedes that limitation.

Before the pilot, test Safari/iOS and Chrome/Android on physical phones: (1) taps/jitter, below threshold, diagonal/down, and crossing then returning; (2) each deliberate direction, a second finger, app switching and screen-edge system gestures; (3) scrolling outside the frame and opening provider links; (4) slow/offline responses, reload and same-action recovery, plus next-read-only retry; (5) zero quota, closed season, keyboard/screen-reader access, missing artwork/links, long titles and the OS Reduce Motion setting. Threshold comfort, native provider handoff and edge-system gestures remain physical-device checks. Existing production recovery/restore readiness in [deployment.md](deployment.md) remains a separate release prerequisite.

## Hosted pilot readiness checkpoint (2026-10-11)

The later readiness pass reran all 80 database tests and database lint in an isolated local stack, verified hosted GitHub CI and nine Cloud durability/secrecy check groups, completed real Google login to a separate Supabase Preview project, and rehearsed a bounded SQL restore on a new isolated local database. See [pilot-preview.md](pilot-preview.md) for the exact Preview/project/season, data provenance, test evidence, phone checklist and remaining official-release recovery gates. Physical phones, a second real Google account and a complete isolated Cloud/Auth restore remain unverified. Production and the official season were not changed.

### Phone feedback and outgoing-motion correction

The owner reported directional swipes and both listening-provider links working on a physical phone. They also identified a visible snap back to center before replacement. The release handler now retains the final pointer offsets while saving and releases capture without invoking pre-submission cancellation. The shared submission handler reports receipt confirmation to the card; unsuccessful/unconfirmed attempts return to center while preserving the existing journal/recovery state. A confirmed exit starts at the release offsets and travels beyond the viewport in the selected direction; the new card still enters only after the 220 ms exit and authoritative reads. Buttons, quota-zero rejection and reduced motion retain their existing behavior. The physical-device outbound motion revision needs another owner check.

The correction passed all **96 frontend tests**, typecheck, ESLint and build. A 390 CSS px browser harness rendered the actual component/CSS with a delayed synthetic receipt: all three exits started at the 135 px release offset, moved monotonically beyond the viewport and kept document width at 390 px. This measures browser motion, not the revised physical-phone experience.


### Compact phone layout and scroll safety (2026-10-11)

After the owner reported an accidental Super Like while trying to scroll, the approved follow-up keeps normal mobile Rating on one screen. At widths up to 600 px the rating-only shell has a 56 px header, a compact season/back row and progress, a square stage sized to the small viewport height (160–320 px bounds), a stable 64 px internally scrollable title/artist area, 48 px provider buttons and three 48 px vote targets in one row. The footer and repeated save note no longer consume visible Rating height on phones. Other routes retain their existing shell. The page is never locked with vertical overflow hidden; short viewports, large text/zoom and error recovery can scroll safely with upward voting disabled. Brand icons, link validation, release thresholds, outgoing motion, journal/receipt semantics and backend contracts are preserved.

All **114 frontend tests**, typecheck, ESLint and build passed. New regressions cover vertical/diagonal scrolling with later horizontal drift, release without a move, deliberate horizontal voting and button-only Super Likes in scroll mode, viewport changes mid-gesture, and a smaller visual viewport. Browser checks rendered the actual App/Rating/SwipeCard/CSS with fictional in-memory data: 320×568, 375×600, 390×640 and 414×700 fitted all vote buttons without page or horizontal overflow. At 390×440 the 540 px document scrolled 100 px over the artwork without voting; upward drag stayed neutral, a horizontal swipe saved once and the Super Like button worked. A 320 px long-title case allowed internal text scrolling with unchanged page progress. A simulated lost response expanded the document to 776 px, disabled upward voting and recovered one logical vote via the existing retry path. These checks used mouse drags/wheel plus synthetic touch PointerEvent tests; native Safari/Chrome touch arbitration, browser bars and phone zoom still require physical-device verification.


### Borderless artwork and directional control order (2026-10-11)

The owner approved removing the artwork's decorative card frame and persistent drag caption, and placing Super Like between Pass and Like. The entire existing square drag surface now displays the artwork. Gesture feedback appears only while moving, in the existing instruction row below the controls, and clears on release/cancellation; busy/receipt labels share that row. The album artwork is never covered by feedback. The three controls use the same visual and keyboard order at every breakpoint: PASS on the left, SUPER LIKE in the middle, LIKE on the right. Buttons, link targets and text remain outside the moving surface.

All **114 frontend tests**, typecheck, ESLint and build passed. Actual-component browser checks confirmed matching art/surface bounds, zero outer padding/border and the button order at 320×568, 375×600, 390×640, 414×700, 390×440 and 1280×900. At 390×640 artwork grew from 176 to 250 CSS px within the same stage and the vote buttons stayed at y=542–590. Gesture feedback increased with displacement outside the image and cleared after a below-threshold release. A delayed synthetic receipt held the -100 px released position and preserved button positions before/after saving. Keyboard navigation followed the visual order; center/right clicks saved Super Like/Like respectively. In the short viewport, upward movement and scrolling over the artwork left progress unchanged, and native page scrolling remained available. These were browser mouse/wheel checks with fictional in-memory data; physical phone touch remains an owner check. The scrolling fallback, thresholds, receipt/UUID recovery and backend contracts are unchanged.
