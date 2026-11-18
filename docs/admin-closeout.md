# Admin panel closeout — finalized 2026-11-18

## Approved behavior and scope

REVEAL is the single deliberate publication action for Love similarity. The
admin panel loads operational metadata only and links to
`/seasons/:seasonId/results`. Results-screen implementation and navigation
acceptance belong to the separate results branch. The formula, vote versions,
RLS, vote replay ledger and immutable history remain unchanged.

## Repair plan (recorded before the corrective migration)

- Align the client validator and fixtures with `visible = (state = REVEAL)`
  and `canChange = false`.
- Replace obsolete visibility-toggle tests with real authorization, pre-REVEAL
  secrecy, historical-ledger immutability, lifecycle lock ordering and
  account/season recovery tests.
- Database lint found `admin_members` returning varchar email and bigint
  availability against declared text/integer columns. An additive replacement
  will cast those fields without changing the response shape or grants.
- `set_member_role` uses SQL's reserved `current_role` name for its previous
  role variable. Replace it with an unambiguous name and reject null roles.
  Keep the season lock, same-role no-op, last-admin rejection and atomic audit.
  There are no table changes or data rewrites.
- Verify locally with synthetic data before applying the corrective migration
  to Preview. No production operations or new Git commits are required.

## Results integration handoff

Use `get_love_similarity_results(p_season)` with the member session and
`serializeLoveSimilarityResults`. There is no category-opening action.
Preserve `taste-love-v1`, 75/25 weights and explicit undefined components.
The legacy setter rejects mutations with `result_visibility_control_removed`.
The existing results link currently falls through to Home until the other
branch implements the route; this closeout does not claim the results page is
available.

## Verification and deployment

- Frontend: 228 tests pass; TypeScript, ESLint and Vite build pass using
  the existing bundled Node 22.23.3 runtime. Earlier claims that Node was
  unavailable were incorrect: it exists at `.tools/node/bin/node`.
- All 95 real local SQL/Data API tests pass from a clean synthetic seed.
  An earlier rerun against accumulated fixtures timed out in an importer
  backfill test; resetting only the disposable test project resolved it.
  Coverage includes REVEAL publication with an absent
  or historical hidden setting, pre-REVEAL/admin secrecy, member/season
  isolation, exact output projection, immutable historical events, both
  lifecycle/read lock orderings, commit/rollback and rejected legacy writes.
- The added admin regressions cover member-list response types/counts,
  authorization, role no-ops and audit history, malformed roles and concurrent
  last-admin demotions. No obsolete toggle tests remain skipped or commented.
- Local schema lint reports no issues after the additive repair.
- `tests/browser/reveal-admin.mjs` exercises the actual React UI, local
  PostgREST and PostgreSQL: close voting, confirm LOCKED secrecy, enter REVEAL,
  reload, validate the results link and member access. It checks member-list
  rendering, non-admin denial, no preference reads by the admin panel, and no
  horizontal overflow at 320/390/1280px. The final browser run passes with no
  unexpected HTTP or console errors. Expected importer responses are checked
  by status and error body (`source_not_designated` / `catalog_closed`); the
  missing optional favicon is excluded from application-error checks.
- Results-page navigation itself remains an explicit integration dependency.
  This browser test checks the route contract, not an unimplemented screen.
- Preview deployment: `dpl_9HaJLmXwuwcofyJPpckzXkqDeidv`, built from the
  reviewed working-tree source based on `4d5238c`, not a new Git commit.
  The deployed bundle was checked for the corrected validator and the
  intended Preview Supabase origin. The stable alias is
  `hardstyle-rankings-season-admin-operations-preview-tiloz.vercel.app`.
- Corrective migration `20261117000100` was applied to Preview after a dry run.
  The authenticated integrated-browser check loaded the VOTING admin page,
  member counts and catalog controls without console warnings/errors.
  No Preview lifecycle transitions, role changes or ballot reads were used
  for verification; the destructive lifecycle test ran only on synthetic local
  data. Production was untouched, and no new Git commit was created.

## Reproduce local verification

Use a fresh temporary copy containing `supabase/`, `scripts/`, `tests/`
and the frontend source/configuration, without repository environment files.
Give its Supabase config a unique project ID and free local ports; disable
Google OAuth and Studio for synthetic tests. Run `supabase start`, then
`scripts/test-db.sh` and `supabase db lint --local --level warning`.
The database guard validates all migrations, loopback routing and the five
synthetic identities before permitting tests.

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`
with the bundled Node directory on PATH. Start the temporary frontend with
its disposable local Supabase URL and anon key, then run:

```sh
LOCAL_TEST_ROOT=/absolute/path/to/disposable-copy \
BROWSER_TEST_URL=http://127.0.0.1:57430 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
node tests/browser/reveal-admin.mjs
```

Supply Python dependencies via a virtualenv or PYTHONPATH as documented in
the database guide. Stop only the disposable stack after verification.
Never point these tests at Preview or an existing voting project.
