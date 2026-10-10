# First Spotify importer

Implemented on 2026-10-07 against the accepted [catalog policy](catalog-ingestion.md). This is an explicitly invoked local operator tool; no scheduler, web administration, playback, correction/merge tooling, or remote database writes. Existing frontend projections and voting APIs are unchanged.

## Authorization and schema

`20261007000100_catalog_import.sql` adds private, RLS-enabled tables: `track_providers`, `artist_providers`, `season_sources`, `source_events`, `import_runs`, `import_items`, `import_reviews`, and append-only `import_review_events`. Provider keys map to permanent internal UUIDs; ISRC is nonunique observation evidence. The additive `20261008000100_import_evidence.sql` correction adds retained accepted ISRC evidence, optional-baseline initialization, indexed staging collision checks, and stronger review binding. The subsequent additive `20261008000200_import_artist_evidence.sql` correction binds actual and prospective artist collisions to reviewed evidence. The additive `20261010000100_import_planning_performance.sql` stores derived staging artist-name keys and indexes canonical title matching without changing version-3 evidence. All earlier migration files remain unchanged. No existing migration or voting table changes. One additive canonical metadata flag, `tracks.artwork_curated`, preserves explicit artwork selections even when their URL equals the provider selection; existing frontend projections remain unchanged. The public schema exposes only narrow RPC functions for source designation, context, plan creation/read, exception review, item apply, and finalization; direct table access is revoked for anon/authenticated/service_role. No preference-bearing query exists in the importer.

The operator authenticates independently to Spotify and to the application. `app-login` uses Google through Supabase Auth with PKCE, a nonce-bearing loopback callback path, and protected session storage. `spotify-login` uses Spotify Authorization Code + PKCE, checks OAuth state, and requests only `playlist-read-private playlist-read-collaborative`. The latter scope supports collaborative-source access; no library, account-profile, or playback scope is requested. No client secret is needed. Spotify access never grants application authority.

All application writes use the authenticated operator JWT and public anon/publishable key. PostgreSQL derives the actor from `auth.uid()`, requires trusted verified Google identity via the existing helper, verifies season-admin membership, locks, then rechecks authority. There is no actor UUID parameter or service-role path. Expired sessions refresh using protected refresh tokens; revoked/expired Spotify refresh grants require login again. Tokens are never stored in database records or printed in reports. Callback request logging is suppressed. Both login commands require interactive browser authorization. The closeout record below distinguishes actual local logins and refreshes from mocked coverage.

Transactions require READ COMMITTED. A single transaction advisory catalog lock `(18437,20261007)` precedes the existing season row lock, serializing mappings shared across seasons and ordering admission against season transitions. Network fetches occur before these locks. The small-app design intentionally serializes catalog operations; votes retain their existing locking contract. Each apply call creates catalog/mappings/ordered credits/membership and an immutable logical item receipt atomically. Replaying a received or uncertain receipt returns it even after source replacement or season closure, without a new write. Pending writes require current SETUP/VOTING and the captured source version. Inactive memberships are reported as `already-withdrawn`, never activated.

Source designation is explicit, has a required reason, records actor/time/old/new configuration in append-only events, and increments the version even if the same source is designated again. It is restricted to SETUP/VOTING and never changes admitted tracks.

## Local setup and commands

Python 3.9+ and the standard library suffice. Run from the repository root. Use a disposable local Supabase project; the CLI only accepts `http://127.0.0.1:PORT` with no path, credentials, query, or fragment. An external database needs a separately reviewed operational extension and backup/restore readiness; this implementation deliberately does not offer a remote-write switch.

Apply migrations with `supabase migration up --local` after verifying the local target. Never reset a local project containing real Auth/catalog data to run tests. Follow [database-foundation.md](database-foundation.md) for the synthetic database suite, or use a separate disposable Supabase project/ports.

Create a protected `.importer` directory and a protected session bootstrap file (mode 0600) containing only the local URL and public key:

```sh
mkdir -m 700 .importer
umask 077
cat > .importer/supabase.json <<'JSON'
{"url":"http://127.0.0.1:54321","anon_key":"PUBLIC_ANON_KEY"}
JSON
python3 scripts/spotify-import.py app-login
python3 scripts/spotify-import.py spotify-login --client-id SPOTIFY_CLIENT_ID
python3 scripts/spotify-import.py designate --season SEASON_UUID --playlist PLAYLIST_URL_OR_ID --reason 'Initial approved primary source'
python3 scripts/spotify-import.py dry-run --season SEASON_UUID --playlist PLAYLIST_URL_OR_ID --output .importer/plan.json
python3 scripts/spotify-import.py apply --plan .importer/plan.json
python3 scripts/spotify-import.py status --plan .importer/plan.json
```

The Google account must already administer the target season. Configure Google OAuth normally and allow `http://127.0.0.1:8889/callback/*` in Supabase's redirect allowlist. Register `http://127.0.0.1:8888/callback` exactly in the Spotify app. Explicit loopback IPs are used, not `localhost`. Alternate ports are available on login commands and require matching provider configuration. Do not add passwords, signing secrets, service-role keys, or browser exports to the bootstrap file.

Default source market is IL. Designation accepts `--market US` and dry-run accepts a one-run `--market US` override. The plan stores the requested market. A different playlist requires a separate `designate` command; replacement preserves every membership. Playlist input accepts a 22-character ID or HTTPS `open.spotify.com/playlist/ID` link, never an arbitrary URL to fetch.

Dry-run performs private bookkeeping only. It records a complete scan, sanitized candidates and exception evidence, then writes a reviewable file. The server checksum binds the source/version/market/snapshot/candidates and original evidence classifications. The authoritative server plan is immutable; editing candidate fields locally does not change apply. A protected run marker is saved before the planning RPC; `status --plan` recovers a plan after a lost planning acknowledgement. If creation never committed, repeat dry-run with `--run RUN_UUID`; reuse with different candidate/source payload fails. Incomplete scans create no database plan or canonical rows. They report observed pages/occurrences and require a fresh full scan.

## Exception file workflow

Clean candidates apply automatically. Inspect `items[].evidence.reasons` and catalog UUID candidates in the plan. Create a protected decisions file bound to its checksum:

```json
{
  "checksum": "COPY_PLAN_CHECKSUM",
  "items": [
    {
      "position": 12,
      "decision": {
        "action": "distinct",
        "reason": "Reviewed release evidence identifies this distinct extended version",
        "include_year": true
      }
    }
  ]
}
```

```sh
python3 scripts/spotify-import.py review --plan .importer/plan.json --decisions .importer/decisions.json
python3 scripts/spotify-import.py apply --plan .importer/plan.json
```

Decisions are `distinct`, `attach`, `keep`, `defer`, or `decline`, with a nonblank reason up to 500 characters. `distinct` admits a separate recording and separate artist UUIDs for unmapped artist IDs, including name collisions. `attach` additionally requires `target` from the plan's candidate UUID list and `same_version: true`; the reviewer must establish the same released musical version. It cannot attach a different display title/version or reassign an existing mapping. `keep` acknowledges a contradiction on a known mapping while preserving the accepted canonical title/credits/identity; it cannot create/repoint a recording. Corrections are outside scope. Year mismatch admission additionally requires `include_year: true`. Invalid/removed entries cannot be admitted without a new usable scan. `defer` remains review-required; `decline` is explicitly reported and does not create membership. Both may be revised before admission, with append-only review events retaining prior decisions.

Decisions are stored against season/provider ID and the reviewed identity/date/precision/match evidence, including an accepted post-admission evidence entry for identical reruns. Changed year/identity/match evidence triggers fresh review. Version 3 plans bind actual/prospective artist collisions as described below and the full material catalog match set (canonical titles/ordered credits, provider identities and retained ISRCs), and capture the identities/date evidence of same-run peers. A `distinct` decision can accommodate only matching UUIDs created by explicitly reviewed `distinct` peers in that same plan, with durable receipts whose material catalog evidence still matches. A new external match, an unreviewed peer imported elsewhere, or a peer changed materially after admission returns `evidence_changed`; rescan and review the new plan. Safe artwork/availability refreshes do not invalidate peer evidence. Unchanged reruns reuse inclusion and keep-separate decisions. A changed catalog between preview and apply can produce `evidence_changed`; create a fresh dry-run rather than bypassing this hold. Already applied items recover their saved receipt; there is no plan reservation or long-running database transaction.

## Deterministic signals and refresh rules

- Exact provider ID reuses its mapped UUID. Artist IDs reuse artist UUIDs; artist text never merges identities. Initial credits preserve provider order with repeated identical artist IDs represented once in canonical credits; full observed order remains on the provider record.
- For unmapped track IDs, shared retained accepted ISRC, identical full title under the shared case-folded, trimmed, POSIX-whitespace-collapsed collision key, or supplied relinking ID matching an existing mapping signals `suspected_match`. Same-run ISRC/title collisions hold both unmapped sides before admission. These signals never establish equivalence, even for shared ISRC versions. New artist IDs with a case-insensitive trimmed canonical-name collision signal `artist_name_collision`. Review evidence contains catalog UUIDs, never votes, vote-history flags, member choices or group totals.
- Exact mapped IDs with any title punctuation/casing/version change, any ordered provider artist ID change, a changed nonnull ISRC observation, or duration drift over 2,000ms signal `material_identity_conflict`. The threshold only requests review; it is never a matching tolerance. Missing optional duration/ISRC/artwork does not invent metadata. The first validated, admitted ISRC/duration observation fills a previously absent optional baseline; later missing observations never erase it. Existing nonnull baselines never change automatically, including under a `keep` decision. Valid ISRC evidence from every successful admission or explicitly reviewed refresh is retained separately from the latest provider observation; an absent latest ISRC cannot hide a match signal. ISRC retains no uniqueness/equivalence constraint. Changed observed artist names preserve artist identity and canonical display names while updating observations.
- Known provider date year differing from season year signals `release_year`; missing/unusable date signals `unknown_release_date`. Date and precision are retained, not inferred from album context. These are exception gates, not eligibility rejection. Availability false does not block clean admission.
- Allowed refresh updates provider observation/time, availability, album/release context, and the same mapping's Spotify display link. Canonical title and credits never refresh. Artwork updates only when canonical artwork equals the last selected provider artwork; an explicit curated value wins. Owner-operated curation sets `artwork_curated=true`; this importer exposes no curation API. Other provider links and canonical identities remain unchanged. URL validation admits the exact Spotify track link and HTTPS `i.scdn.co/image/…` artwork only.
- Null/removed/malformed entries remain review-required. An explicitly typed episode or typed track flagged as a local file is intentionally skipped. Missing/null/nonstring/empty/unknown type information is invalid and review-required, even if a malformed object also carries a local-file flag. Repeat provider occurrences are reported separately and create at most one membership. No absence from a playlist removes or deactivates anything.

## Recovery, reporting and bounds

Plans are bounded to 5,000 occurrences/100 pages; each page requests at most 50 items. The adapter checks sequential offsets, stable totals, expected Spotify playlist endpoint, pagination cycles, full count, and pre/post snapshot equality. It retries a snapshot-changing full scan at most three times. Snapshot markers cannot guarantee truly atomic pagination; this is the bounded provider-supported detection mechanism.

HTTP uses timeouts, rejects redirects (so bearer headers never follow another host), validates pagination hosts, and limits response size. 429 honors numeric `Retry-After` up to 60 seconds; longer waits stop with a resumable error. Network/5xx retry at most four times with bounded exponential jitter. Authorization errors do not loop. Reports omit provider error bodies, headers, owner details, tokens, and raw responses. A fetch failure reports observed progress; a process killed during apply leaves receipts recoverable through `status`/same-plan `apply`. SIGINT marks interrupted when the database is reachable. SIGKILL or loss of connectivity can leave the last durable run status partial; reconcile rather than assume success.

Statuses distinguish complete, partial, failed, interrupted and review-required. Complete means all supported eligible work has durable outcomes or was explicitly declined/skipped, not that every playlist occurrence became a membership. CLI apply exits 2 for a noncomplete status, 130 for interruption, and 1 for configuration/provider errors. Item errors are sanitized identifiers and positions. `status` reads persisted evidence/decisions/receipts without fetching Spotify. Summaries report mutually exclusive occurrence outcomes separately from overlapping dimensions: unique provider IDs, duplicates, known IDs, availability warnings, year warnings, accepted exceptions, new mappings/tracks/artists, added memberships and distinct resolved UUIDs. Apply progress equals applied plus failed plus pending; terminal item errors carry sanitized codes and positions. A later status read reports uncommitted work as pending so it can be retried. Scan reports distinguish rate-limit and transient retries.

## Retention and limitations

Protected local files use atomic replacement, mode 0600, owned regular-file reads without symlink following, and mode 0700 parent directories. `.importer/` is ignored. Keep only the current token/session files; remove them on operator offboarding and revoke provider grants. Do not back up tokens or share local plan/review files. Delete local plan/review copies within 30 days of a reconciled terminal run. Review plans contain private catalog evidence, even though no preferences.

Database plan/evidence/receipts, source events, and review audit are retained for the lifetime of the season and its canonical provider mappings, with no automatic purge. This deliberately prioritizes replay/year-exception recovery. No retention/deletion API exists in this bounded implementation; future controlled archival must preserve receipts and accepted evidence. Full provider dumps are never stored. The database owner remains the existing privileged trust boundary; application admins gain none of that access.

Official documentation checked 2026-10-07: [playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), [Development Mode migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri), [token refresh](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens), [rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits), and [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow). Development Mode requires a Premium app owner, limits authorized operators to five, and restricts contents to owned/collaborative playlists. `linked_from` may be absent; current/legacy `item`/`track` fields are accepted by the adapter. The user-token country takes precedence over the market parameter; without an authoritative response field this importer reports requested market and availability observations, not guaranteed IL playback. Bounded local access and real Google/Spotify handshakes are recorded below; this does not certify general provider access or production readiness.

For a separately authorized small live smoke test, supply a Spotify app/client ID, registered loopback callback, authorized operator with permitted source access, a local Google-authenticated season-admin session, a SETUP/VOTING season, and a small owned/collaborative playlist. Designate explicitly, inspect dry-run, review exceptions, then authorize the local apply. Confirm Spotify attribution/logo and linked artwork display policy before real-data rollout; the importer does not claim existing frontend presentation is policy-certified. Remote smoke tests additionally require a separate target-enabling change and verified backup/restore readiness. No live Spotify calls were made during the initial implementation; the later smoke record below supersedes that limitation. No remote database writes have been performed.

## Validation

```sh
python3 -B -m unittest discover -s tests/importer -v
scripts/test-db.sh
supabase db lint --local --level warning
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Provider tests use mocked HTTP/playlist data with no credentials. Database/Data API tests use real isolated Supabase/Postgres and synthetic users, including automatic 850 → 850 → 875 imports, authority/privacy, provider/artist reuse, review/year decisions, versions/shared ISRC, availability/market, refresh conflicts, source changes, inactive memberships, concurrent imports, both lock race orderings, interruption and lost receipts. Existing voting/auth suites remain intact. Normal CI also runs the mocked provider suite.

Verified 2026-10-07: **58 real isolated database/Data API tests**, **9 mocked provider/auth/CLI tests**, and **56 frontend tests** passed. Database lint returned no issues; typecheck, ESLint, production build, Python syntax, local documentation links, and whitespace checks passed. The isolated test project used separate ports/project ID because the original local stack contained nonsynthetic Auth data; its existing data was preserved. No live provider or remote write validation was performed.

## Review evidence correction (2026-10-08)

All five independent-review findings reproduced before the fix on a confirmed disposable Supabase/PostgreSQL project. The corrections use a new versioned migration because the original importer migration was confirmed in the repository local persistent database's migration ledger. No persistent/shared database received correction writes during this review task.

Apply `20261008000100_import_evidence.sql` before using the corrected SQL importer. It backfills retained ISRCs from the established identity, latest accepted observation, and successful durable item receipts. Missing optional baselines recover unambiguous receipt evidence, then validated latest accepted observations; established baselines win. Plans, decisions, receipts, canonical IDs, mappings, and voting history are not rewritten. Any evidence already absent from all retained records cannot be reconstructed or invented.

This correction introduced version 2 evidence; the later artist-evidence correction below requires a fresh version 3 plan. Legacy suspected-match approvals lack complete match/peer binding and require fresh review; existing successful receipts remain replayable. A fresh plan can reuse a legacy year/date-only decision when every previously reviewed field is unchanged, with no catalog matches or peers. This compatibility path does not broaden a legacy match approval. New-item receipts include catalog-only material evidence for reviewed-peer verification, never voting history or preferences.

Focused regressions cover missing-ISRC retention, later optional baselines and contradictions, stale external matches, unreviewed/external peer rejection, material peer changes, valid safe peer refresh, whitespace-equivalent same-run distinct admission, malformed type outcomes, and legacy backfill/year-decision compatibility. The 850 → 850 → 875 regression also compares complete current-vote rows and immutable event rows before/after catalog growth, including integer versions.

Review-fix validation on 2026-10-08: all five findings failed focused regressions against the original implementation before correction. After correction, **71 real isolated database/Data API tests**, **10 mocked provider/auth/CLI tests**, and **56 frontend tests** passed. Database lint returned no issues; typecheck, ESLint, build, and exact installed-function/source comparison passed. The original persistent local migration ledger was inspected read-only; correction migrations and test data were written only to the disposable review project on separate ports. Live Spotify/Google handshakes, real source access, and remote database operation remain untested.

## Same-plan artist evidence correction (2026-10-08)

The remaining artist-collision finding reproduced before correction in a separate disposable PostgreSQL project: two explicitly reviewed distinct candidates shared ISRC, had different Spotify artist IDs with identical names, and the second apply returned `evidence_changed` after the first created its artist.

Apply the additive `20261008000200_import_artist_evidence.sql` correction after both earlier importer migrations. The persistent repository-local migration ledger was inspected read-only and contained `20261007000100`; neither earlier migration was edited, and no correction was applied to that persistent database. Remote/shared deployment state was not queried.

Version 3 plans record prospective artist-name peers separately from title/ISRC track peers. Artist names retain the existing case-insensitive, outer-trimmed collision predicate; names never establish equivalence. Actual artist collision evidence binds the incoming provider ID to each canonical artist UUID, canonical name, and complete provider-mapping set. Same-plan review records also bind peer artist IDs/names, ordered recording identity, and release evidence.

Apply can accommodate a newly appearing artist collision only for the exact recorded peer, explicitly approved `distinct` in that plan, with a successful new-track receipt and unchanged material catalog evidence. The colliding artist must be the peer's recorded credit with its unchanged name and sole exact Spotify mapping. Existing collisions remain in the comparison; external artists, additional mappings, unapproved peers, and changed peer evidence require fresh review. Artist-only peers do not authorize removal of unrelated track matches. Exact provider IDs continue to reuse their established mappings.

Rescan exception plans made under earlier evidence versions, then review their current collision evidence. Successful receipts remain replayable. Unchanged legacy/version-2 year/date-only decisions remain reusable on a fresh plan only with empty track and artist collision sets. No plan, receipt, review event, canonical UUID, mapping, vote, or vote event is rewritten by the correction.

The subsequent authorized local smoke and closeout checks are recorded below. Before another smoke test, verify the chosen local target, apply all importer correction migrations, and create a fresh version-3 plan.

Final same-plan artist validation: **79 PostgreSQL/Data API tests** passed from a clean isolated synthetic reset, including 850 → 850 → 875, complete vote/event/version preservation, authorization, both lock-race orderings, and existing track/external-match protections. **10 mocked importer tests** and **56 frontend tests** passed, as did database lint, typecheck, ESLint, production build, Python/shell syntax, local documentation links, whitespace, and exact installed/source comparison of 20 importer functions. A full rerun without resetting accumulated synthetic catalog rows timed out in the existing catalog-match query; the final clean-reset run passed without raising test timeouts. Run the database suite from a clean disposable seed as documented. The disposable artist-review stack was stopped after validation.

## Closeout verification (2026-10-10)

The branch is `feat/spotify-playlist-importer`. Importer code, all three migrations, and tests match the final previously validated copy. No migration history was edited. Protected local evidence was inspected; account/playlist identifiers, tokens, raw responses, and local artifacts are excluded from repository docs and the proposed change set.

| Scenario | Verification |
| --- | --- |
| Import and repeat — live data | Authorized October 8 smoke on an empty disposable local stack (API 58321 / PostgreSQL 58322), with all three importer migrations. User-confirmed owned 23-item source, requested market IL, one page, zero retries. First apply: 23 tracks, 30 artists, 23 track mappings, 30 artist mappings, 23 memberships. Fresh scan/apply: all 23 already present; zero new objects/memberships. Exact UUIDs, ordered credits, canonical rows, mappings, and receipt replay checked; only provider last-seen timestamps refreshed. Saved receipts/snapshots and the database were reinspected at closeout without repeating the import. |
| Review gates — live data and fixtures | All 23 live items had year holds; the user explicitly approved each `distinct` / `include_year: true` exception before apply. Existing passing PostgreSQL year/suspected-match tests additionally verify unreviewed apply stays held, explicit review permits admission, and unchanged review survives a fresh plan. No new live exception was approved at closeout. Plan files hold current state; the smoke report, review audit, pre-admission catalog snapshot, and test evidence document the earlier hold. |
| One clean addition — new isolated fixtures | Separate synthetic-only stack (API 58621 / PostgreSQL 58622), verified by the migration/Auth-fixture guard; three candidates total. 2 → 2 created nothing. 2 → 3 created exactly one membership, track, artist, and each provider mapping. Complete existing vote/event rows—including version 2 and both audit events—remained equal. UUID/mapping identity and new receipt replay passed. No real season or Spotify playlist was modified. |
| OAuth/refresh — live | Google/Supabase and Spotify PKCE handshakes, Google-admin authority, and playlist access passed in the smoke. On October 10 both naturally expired sessions refreshed through the importer code. Refreshed Spotify access read the same confirmed playlist snapshot; the refreshed local Google session read admin import context. Tokens were not logged. |
| Presentation — sampled live local UI | Rating/My Picks views showed admitted title, artist credit, artwork, and Spotify link. All 23 stored links/artwork matched provider metadata. Importer runs left smoke votes/events at zero; a subsequent interactive browser session created one smoke vote/event, preserved at closeout. Original local votes/events/versions matched their read-only baseline. |

Prior required checks remain valid because inputs are unchanged: **79 real isolated PostgreSQL/Data API tests**, database lint, **10 mocked importer tests**, **56 frontend tests**, typecheck, ESLint, build, and exact installed/source comparison. Existing logs were inspected and source/test/config/package files compared with their tested copies. Mocked coverage includes PKCE exchanges, protected storage, pagination/snapshots, retries, hostile redirects, malformed observations, and lost acknowledgements. At closeout, only the missing bounded growth scenario and final syntax/documentation-link/whitespace checks were run; broad suites were not repeated.

Operating prerequisites: confirmed safe local target; all four importer migrations in order; fresh version-3 plans; verified Google season-admin identity; separate permitted Spotify app/user access; registered loopback callbacks; mode-0700 ignored state directory and mode-0600 session files; explicit user review of exceptions. Run the database suite only on clean confirmed disposable fixtures. The earlier accumulated-fixture timeout and initial CI failures are superseded by the performance correction below; keep normal CI runs on a clean disposable seed.

Remaining limitations: no production/remote validation, exhaustive UI or audio-playback audit, controlled live revoked-grant/refresh-token reuse or rotation-failure tests, live rate-limit/outage/permission-denial exercises, or real full-catalog performance test. IL is requested market rather than guaranteed playback availability. Spotify presentation-policy certification and remote target/backup readiness remain outside this closeout. These limit rollout claims, not preparation for PR review. No commit, push, merge, tag, PR creation, remote database write, or full-catalog live import occurred.


## CI planning performance correction (2026-10-10)

Both initial PR #2 database jobs timed out on the first 850-item `create_import_plan` at the unchanged 10-second statement limit. `EXPLAIN ANALYZE` showed a run-ID index scan filtering all 850 staged rows with `import_artist_names`, instead of using the expression GIN index. Repeating JSON expansion/normalization for candidate/peer pairs made planning quadratic in costly helper calls. On an accumulated catalog, the external title/ISRC OR join also scanned and normalized canonical titles repeatedly.

`20261010000100_import_planning_performance.sql` is additive: the three applied importer migrations remain byte-for-byte unchanged. A generated stored artist-name array derives from the existing immutable helper, including existing staging rows, and remains synchronized with candidate changes. Planning caches incoming keys once, uses stored peer names, and performs separate indexed title/ISRC probes. External matching uses an indexed canonical title key plus the existing retained-ISRC/provider indexes, with a distinct union of all matching UUIDs. Catalog evidence is fetched only for those UUIDs. No identity, decision, receipt, match payload, provider mapping, grant, lock, vote, or event contract changes. No evidence-version bump or rescan is needed solely for this optimization.

The added regression compares complete evidence JSON against both previous version-3 helpers, including external title/ISRC/original-ID matches, same-plan track/artist peers, duplicate occurrences, exact provider reuse, case/trim normalization, and nonrecordings. Existing external/changed/unapproved-peer protections, separate artist UUIDs, authorization, vote integrity, and lock races remain asserted. The 850 → 850 → 875 test is unchanged in size and assertions and now prints planning times.

Local performance validation uses a separate confirmed synthetic PostgreSQL 17 project, Supabase CLI 2.119.0, Python 3.12.14, psycopg 3.2.10, CI fixture order, and the unchanged 10-second statement / 5-second lock timeouts. The host is ARM, so it does not reproduce GitHub's hardware exactly; a half-CPU Docker quota provides conservative stress. The pre-fix plan reproduced the same helper timeout at 10.052 seconds under that quota (6.098 seconds with one CPU). Final clean-seed planning measured **0.520 / 0.188 / 0.221 seconds** for first 850, repeat 850, and growth 875. All **80 PostgreSQL/Data API tests passed in 42.858 seconds**. A second full run without reset passed all 80 in 54.325 seconds on accumulated fixtures, with planning times **0.676 / 0.223 / 0.213 seconds**. The isolated peer query fell from 4.578 ms to 0.125 ms even when both plans selected a run-ID scan; the canonical title probe used the new index (0.012 ms). Database lint and all **10 mocked importer tests** passed. Frontend sources are unchanged, so their local checks were not repeated.

These are bounded synthetic planning measurements, not full live-catalog or production performance validation. The earlier live smoke used the previous three migrations; this correction is validated with fixtures and GitHub CI, whose current run results are recorded on PR #2. Normal suite operation still requires a confirmed disposable target; no real-data database was reset or modified.
