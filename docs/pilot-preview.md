# Pilot Preview readiness — 2026-10-11

This is a testable Preview release, not approval to start official voting. No production deployment, production environment change, production database write, or official-season transition was performed during this readiness pass.

## Release and environment

- Initial UI commit: `a74f99692ed8063cde005e3116fd10397c100abb` on `preview/mobile-pilot-readiness`.
- Stable Preview: <https://hardstyle-rankings-git-preview-mobile-pilot-readiness-tiloz.vercel.app/>. Vercel Authentication remains enabled. The owner received a separate seven-day share link; its bypass token is deliberately excluded from Git.
- First verified hosted deployment: `dpl_4qJZWBTS6offoUM7maauaFByatco`, READY, Preview target. Subsequent documentation-only pushes can update the branch alias without changing the UI implementation.
- Supabase test project: **`tiloz-ranking-2k26-preview`**, reference **`mrcbzuuglyjjshrdlqdl`**, API **`https://mrcbzuuglyjjshrdlqdl.supabase.co`**, eu-central-1, PostgreSQL 17.11. All ten repository migrations were applied on the initially empty test project.
- Only this branch's Vercel Preview variables point at that project. The hosted browser bundle was inspected for the test project URL and public publishable key, absence of the production reference, and absence of actual privileged keys. Operator credentials remain outside browser code and Git.
- Git `main` is Vercel's automatically deployed production branch. It remains at `5e7af8fca41bb1513bc78116a65a60cef3ba452e`. The existing production deployment `dpl_5jE3iVE4eu9uWfbzEVBfYwhJDLGF` remains unchanged. No merge or push to main was made.
- The first verified Preview build used Node 22.x; CI pins 22.23.3. Subsequent Git previews use the existing project settings. Global Vercel project settings were not changed.

## Data and usable test season

**`PREVIEW TEST — Mobile pilot`**, season **`b4603c94-629e-446d-b0c1-0a389d035911`**, is deliberately left **VOTING**, with 20 tracks and allowance **2 Super Likes** per member. Open the Preview, sign in with the owner account used during verification, and choose this season. The owner started with one smoke-test vote; subsequent phone-test choices are expected to change their remaining count.

This is test data with real recording examples: titles, ordered artists, artwork and verified Spotify/Apple listening-link display metadata were read from the existing public dummy catalog, then assigned **new canonical UUIDs in the isolated test project**. No production Auth users, identities, memberships, votes, audit events, private import records or provider mappings were copied. These copies are listening fixtures, not an import/matching audit or an official catalog. The real Google owner signed in normally to this new project; the existing create-season RPC provisioned the owner membership under the documented operator trust boundary.

Automated hosted checks used four ordinary authenticated synthetic test sessions plus an unverified fixture. Their verified Google identities were test fixtures, not completed Google logins. A separate eight-track test season, **`f8bd74b4-fb45-42eb-b772-499f7cc99171`**, was deliberately advanced to **LOCKED** for closure checks. It is separate from the human phone season. An earlier harness attempt's test season was retained rather than reset or deleted.

Google's authorized redirect now includes `https://mrcbzuuglyjjshrdlqdl.supabase.co/auth/v1/callback`; existing redirects were preserved. Supabase's Site URL is the exact branch Preview origin and the frontend callback allowlist contains its exact `/auth/callback`. Google login requests basic identity only. Data API exposure is limited to `public`; unused GraphQL exposure and extra authentication methods are disabled on this test project.

## Brief review

The branded links, deliberate release-only swipe voting, shared durable submission pipeline and stable in-card transitions match the implementation brief. The owner's later design approval replaces the initial full Apple Listen-on badge with its official white icon and service name on red; Spotify uses its official black icon on green. Both provider buttons have equal height (52 CSS px generally, 48 px in compact mobile Rating) and share the voting row’s outer edges. This design revision and official asset provenance are recorded in [frontend.md](frontend.md) and [src/assets/README.md](../src/assets/README.md).

Only unrated Rating cards in VOTING accept left PASS, right LIKE and up SUPER_LIKE. Cancellation ends before submission. There is no post-send Undo, gesture editing in My Picks, new RPC/migration, group result surface, speculative queue, music OAuth, playback or choice analytics. Authentication contracts, RLS, action UUIDs, integer vote versions, immutable receipts/events and queue ordering are unchanged. Exact gesture calibration and reduced-motion behavior are in [frontend.md](frontend.md#mobile-rating-interaction-2026-10-11).

## Verification results

| Layer | Result and practical scope |
| --- | --- |
| Frontend | **114 tests passed** after the outbound-motion, downward-drag and compact-layout/scroll-safety corrections, typecheck, ESLint and build passed. Gesture cancellation/release, duplicate events, quota races, pending storage, receipt validation, uncertain responses, account changes, read-only retry and accessibility alternatives are covered. Main production bundle is 489.63 kB before compression. Additional regression checks cover holding final release offsets through slow saving/capture loss and continuing all three confirmed exits without a return to center. An initial earlier run stalled and timed out; a clean rerun passed without changing test limits. |
| Local database | **80 tests passed** in the guarded disposable stack `hardstyle-rankings-voting-check` (API 55421 / DB 55422). All ten migrations and database lint passed. Real SQL grants/RLS and HTTP tests include secrecy through SETUP/VOTING/LOCKED, role boundaries, invitations, concurrent voting/last-slot quota, rollback and immutable audits. The regular real-account local database was not reset. |
| GitHub CI | [Run 38124204885](https://github.com/BarAshual/hardstyle-rankings/actions/runs/38124204885) passed for the UI commit: frontend gate, clean database rebuild/lint, **80 database tests** and **10 mocked importer tests**. Existing unrelated Cloud-importer working-tree edits are excluded from this release, so its larger local test count is not attributed to this commit. |
| Simulated mobile browser | Widths 320/375/390/414 CSS px were checked. Real local Data API checks covered neutral/multitouch/cancel gestures, outside-card scroll, slow acceptance, failed next read, reload plus exact lost-response replay, all choices, zero quota, keyboard and reduced motion. No horizontal overflow or runtime errors was observed. These are simulations, not physical-device tests. |
| Hosted Data API | **Nine named groups of checks passed** with normal authenticated role tokens on the isolated Cloud project. Details below. Privileged credentials were used only for fixture/session setup, never the security assertions. |
| Real hosted Google/browser | Normal Google account selection returned through Supabase to the branch Preview, restored a session and showed the invitation-only gate. After test provisioning, Rating saved a vote, advanced to the next track and restored persisted progress after refresh. |

### Hosted durability and backend secrecy

1. Discarding an accepted response before reading its receipt, then replaying the **same UUID and payload**, returned the identical version-1 receipt. Fresh reads showed one vote and one event.
2. Reusing that UUID with a changed payload was rejected. A new action against stale version 0 was rejected.
3. Allowance 1 was enforced from persisted votes; a second Super Like was rejected and remaining allowance read as zero.
4. Two concurrent distinct actions for the same unrated track accepted exactly one.
5. Two concurrent Super Likes competing for the final slot accepted exactly one.
6. During **VOTING**, filtered and broad reads of `votes`/`vote_events` exposed only the caller's own rows. Cross-user reads returned zero rows for ordinary members, an outsider and the **application admin**. Data API preference aggregates were rejected. Admin progress returned only operational completion fields, and members could not invoke it.
7. The same secrecy checks passed after **LOCKED**. This includes backend requests, not just hidden UI controls.
8. LOCKED rejected new votes and edits while still replaying an already accepted action's original receipt.
9. Direct PATCH/DELETE vote writes, anonymous reads and outsider voting were denied.

The restored database also passed direct authenticated SQL cross-user and GROUP BY preference denial, including the application admin. This does not claim isolation from the trusted Supabase/database owner or a service-role operator; those are separate privileged trust boundaries.

## Backup inventory and isolated restore

Read-only inspection of the existing production project's backup metadata returned `backups: null`, `physical_backup_data: {}`, `pitr_enabled: false`, and `walg_enabled: true`. There was **no exposed downloadable managed backup or enabled PITR to use for recovery**. The WAL flag alone is not evidence of an operator-accessible restorable backup. No repository backup scheduler, retention policy or independent encrypted archive exists. Current free-tier limitations are described in the [Supabase production guide](https://supabase.com/docs/guides/deployment/going-into-prod) and [backup documentation](https://supabase.com/docs/guides/platform/backups).

A rehearsal exported **only the new synthetic Preview project** read-only, then restored to a **new blank local database** `pilot_restore_v3`, inside the isolated `hardstyle-rankings-restore-check` Supabase stack at DB 55522. No existing Cloud or normal local database was overwritten, reset, cleaned or restored over. Earlier partial attempts were retained on other new local databases; the final complete pass used a fresh snapshot and target.

The custom PostgreSQL 17 archive explicitly included **`public`, `private`, `auth`, `supabase_migrations`**, with `--no-owner`. Its cutoff precedes the real Google owner and human phone season created above. It contains five synthetic Auth users, two test seasons, 16 tracks, eight current votes and eight immutable events, and all ten migration versions. The 273,702-byte archive's SHA-256 is `0cec2ce77a7290a0cfeb2d6573518c9de62a38833d02a148c7c434f5dca85161`.

**Passed:** exact row counts and ordered-content hashes for all **47 tables**; stable Auth user/identity UUIDs; choices, integer versions and receipt/audit history; RLS policies; effective application role privileges and role attributes; function bodies and security-definer settings; constraints and triggers; identical accepted-action replay after LOCKED; denial of cross-user rows and preference aggregates after restore, including admin. One lifecycle CHECK expression had equivalent associative OR parentheses flattened by PostgreSQL; its predicates and all other constraints matched. Cluster roles were supplied by the fresh Supabase image, and object ownership intentionally changed to the trusted local restore role; this is not an identical managed-cluster owner/role export.

The export took about 12.9 seconds; archive SQL restore about 0.15 seconds. These measurements exclude provisioning, validation, credentials, OAuth and frontend reconnection, and **are not an RTO guarantee**. Protected operator artifacts remain in ignored `.tools/pilot-preview/` with directory/file permissions 700/600. The rehearsal archive is local and unencrypted; it is not an independent production backup.

### Recovery limitations that remain open

- The eight `private` importer/provider/source tables were present but empty in this snapshot. Restoring **populated** mappings, source evidence and import/review audits has not been exercised.
- A full isolated **Cloud** restore and subsequent real Google sign-in, identity continuity and frontend reconnection have not been performed. The local Auth service was disabled for this SQL restore test. There is no unused isolated Cloud project within the current two-project Free setup; paid infrastructure was not provisioned.
- Managed project configuration, OAuth client configuration/secrets, JWT/signing configuration, Storage objects and other managed services are outside the archive's four-schema scope. Configuration/secret recovery needs its own protected inventory; live OAuth/importer token files should not be archived as backups.
- Backup frequency, encrypted independent storage, retention, monitoring, RPO/RTO, and the official-vote retention/recovery procedure remain decisions and implementation work. Do not start official voting until an approved recoverable backup process and complete isolated recovery rehearsal exist.

## Owner phone checklist

Use only `PREVIEW TEST — Mobile pilot` in the linked test project. Leave the official season untouched. Safari/iOS and Chrome/Android should both be tried on real phones:

1. With the page fitting the screen, deliberately swipe left, right and up; verify the intended choice saves once, progress survives refresh and My Picks matches. All three buttons remain usable.
2. Cross each threshold, return to the center **before release**, then release. No vote should save. Also try jitter, down/diagonal motion, a second finger and switching apps mid-drag.
3. Verify the provider links and all three vote buttons are visible without page scrolling in the normal phone viewport. Try a short landscape viewport, browser bars and zoom: whenever page scrolling is needed, scroll over the artwork and verify it never sends Super Like; use its button instead. Check long-text scrolling, screen-edge system gestures and no horizontal overflow.
4. Open Apple Music and Spotify and return. Verify native app/browser handoff, correct recordings and no unintended vote.
5. Use slow/offline networking: the current track must stay pending; refresh then retry the original action. One logical action must produce one vote/version/event. If only the next-track read fails, retry must read only. Check quota 0, OS Reduce Motion and screen-reader/button access.

The owner reported all three swipe directions and both provider links working on a real phone with the initial Preview. Device/browser details, crossing then returning, slow-network recovery and the subsequent outgoing-motion correction remain to be confirmed physically. Invitation acceptance plus wrong-account rejection across **two real Google accounts** also remains unverified. Two test invitations have since been issued as recorded below; synthetic backend admission tests do not replace the invitees’ real Google handshake. Invited test accounts must also be allowed by the Google OAuth testing audience.

**Ready:** reviewable Git branch, isolated hosted Preview, real owner Google sign-in, durable voting/security checks and bounded SQL recovery rehearsal. **Owner checks:** revised outgoing motion and the remaining phone scenarios, plus the second Google account. **Official-release blockers:** the incomplete production backup/recovery process and its populated-data/Cloud-Auth rehearsal; any failures found during those phone/account checks. Preview readiness does not remove these gates in [deployment.md](deployment.md).

## Outgoing-motion correction after owner phone feedback

The branch now includes a correction for the release-to-center jump: submitted cards hold their final displacement, then confirmed exits travel beyond the viewport from that position. The frame no longer clips the card at artwork boundaries; horizontal overflow is clipped at the full-width application root. Cancellation and failed/unconfirmed submissions return to center. This is a visual/submission-result handoff change, not a change to the RPC, pending action identity, acceptance, RLS or secrecy contracts. The owner should reload the same Preview and retest this revised motion.

Motion regression validation passed: all **96 frontend tests**, typecheck, ESLint and build; a 390 CSS px browser QA harness used the actual SwipeCard/styles with a deliberately delayed synthetic receipt. Sampled frames for PASS, LIKE and SUPER_LIKE held exactly 135 px during saving, started the confirmed animation at that same displacement, progressed monotonically beyond the viewport and never returned to center. Maximum document width stayed 390 px. No backend writes occurred in this animation harness. [CI run 38127606594](https://github.com/BarAshual/hardstyle-rankings/actions/runs/38127606594) also passed for the preceding documentation checkpoint.

## Downward-drag and invitation follow-up

The artwork stays centered for downward and downward-diagonal drags. Horizontal swipes tolerate slight downward finger drift while holding their vertical position at zero. Direction/threshold classification still uses the original displacement, so clamping cannot convert a neutral downward diagonal into PASS/LIKE. Returning an upward swipe to or past the center cancels it, and starting downward does not prevent reversing into a supported direction before release. All **104 frontend tests**, typecheck, ESLint and build passed for this correction.

The owner's nickname screen is skipped because provisioning the human test season already created their admin membership with nickname `Bar test`. Nickname selection occurs on first invited membership in each season; reopening an accepted invitation or signing in again retains the chosen name. There is no rename UI in the current scope.

A rollback-only rehearsal in the isolated Preview database exercised the existing RPCs under normal authenticated owner/test-member roles: new invitation inspection returned null nickname, a case-insensitive duplicate was rejected atomically, accepting an unused nickname returned the season and subsequent inspection returned that name, and acceptance replay did not rename it. The rehearsal left no invitation/member rows behind. This checks the backend contract within a transaction, not a second real Google login.

At the owner's request, two email-bound invitations were subsequently committed through `invite_member` for the human Preview season. No memberships were provisioned for those invitees, allowing first-join nickname selection. Personal emails, invitation URLs and temporary Vercel share tokens are excluded from Git; the owner received messages to forward. Actual invitee Google sign-in, nickname selection and refresh remain pilot checks.


## Compact phone layout and scroll safety

The owner's latest phone screenshot showed unused header/status space pushing provider/vote controls below the first screen, and an upward attempt to scroll triggered Super Like. The accepted revision compacts the rating-only shell, sizes the artwork to available height and places the three vote buttons together. Upward voting now requires the whole document to fit the visible viewport. Otherwise the surface allows native vertical scrolling, keeps left/right choices and presents Super Like through its button. Empty status/recovery placeholders no longer create whitespace; visible errors and pending retries remain accessible through scrolling.

All **114 frontend tests**, typecheck, ESLint and build passed. Browser measurements at 320×568, 375×600, 390×640 and 414×700 found every vote button visible and no horizontal/page overflow. At 390×440, scrolling over the card moved the page without changing progress, upward drag did not vote, and deliberate horizontal voting and the Super Like button still worked. Long-text scrolling and a simulated lost-response retry were also checked with the actual React components and fictional in-memory data. The lost-response message triggered the scroll-safe mode and one vote remained after retry. These were browser mouse/wheel checks and unit touch-event simulations, not a claim that native phone gestures or OS text scaling were verified. Recheck the updated Preview physically, especially browser bars, zoom and scrolling over the card. No database, migrations, Cloud data or production deployment were changed in this revision.

## Borderless artwork and vote control order

The subsequent owner-approved revision removes the decorative artwork frame, its padding and the persistent drag caption. The cover fills the square gesture surface; dynamic choice feedback and saving/confirmed labels use the existing hint row below the controls and never cover the album artwork. At every breakpoint the controls run left to right as PASS, SUPER LIKE, LIKE, including keyboard focus order. This is a presentation revision to the brief, with no voting, database or privacy contract changes.

All **114 frontend tests**, typecheck, ESLint and build passed. Actual-component browser checks covered 320/375/390/414 px mobile widths, a short 440 px viewport and desktop: zero outer frame/padding, artwork matching the surface bounds, stable controls and the new order. At 390×640, the cover grew from 176 to 250 CSS px without moving the vote controls. Outside-image feedback, below-threshold cancellation, a delayed synthetic receipt, center/right button choices, keyboard order and short-viewport scrolling safety were checked with fictional data. This revision still needs a physical phone check after refreshing the same Preview. No Cloud votes were submitted during these checks.


## My Picks layout follow-up

The owner reported the revised borderless Rating layout looks good on their phone, then requested matching button order/sizing and tighter copy spacing in My Picks. Edit controls now run PASS / SUPER LIKE / LIKE in equal columns; listening and edit rows have 48 px controls and aligned outer edges. On phones the control rows span the card below the thumbnail/details. Title-to-artist and artist-to-choice gaps are 6 px and 4 px.

All **114 frontend tests**, typecheck, ESLint and build passed. Actual-component browser checks covered widths 320/375/390/414/600/601/1280 px, including long titles/artist credits and unavailable provider links: no horizontal overflow, equal edit widths, consistent 48 px heights, and aligned listening/edit rows. Keyboard focus order, selected-choice disabling, two ordinary edit receipts, search/filter and inactive-track disabling were checked with fictional in-memory data. The hosted phone appearance still needs the owner’s refresh/review. No database contract, production configuration or Cloud votes were changed by this presentation update.

## My Picks return position and pagination

The owner found that returning from a listening app jumped to the top of My Picks. The focus refresh previously set `ready=false`, removing the list and collapsing its scroll height. Refresh now leaves loaded cards mounted and preserves view state. Both focus and visible-return events are handled; overlapping requests coalesce. Edits and pending retries remain disabled while refreshing or after read failure. The owner also requested paging for a season with 1,000+ choices: UI pages now contain 25 cards, with top/bottom navigation, full-snapshot search/filter, URL view state and page clamping after edits. Metadata still uses the existing own-user, RLS-protected 500-row keyset batches; this is display pagination, not a new server-side search/count API.

All **123 frontend tests**, typecheck, ESLint and build passed. New regressions cover retained card DOM through deferred/failed refresh, overlapping return events, blocking stale edits, 1,001-choice pagination and search beyond the current page, URL restoration, invalid page values and a filtered last-page edit. The API cursor test now reads 1,001 choices across three batches. In an actual-component browser fixture at 390×700, a simulated app-return event with a delayed read retained `scrollY=1400` and document height 7,957 px before/during/after refresh. Only 25 cards were mounted from 1,001 picks. Top/bottom page navigation brought the result summary to 16 px from the top; a search from page 3 found the final pick. Widths 320/375/390/414/1280 px had no horizontal overflow and 48 px navigation controls. These checks use fictional data and a synthetic return event; the revised native Apple/Spotify handoff still requires the owner’s real-phone check. No database contract, Cloud vote data or production settings were changed.

## Delayed branded next-track loading indicator

The owner confirmed the My Picks return-position fix works on their phone, then suggested a branded spinner for the brief Rating next-track loading message. That message is now replaced by the existing HS/26 wordmark with a green ring, appearing only after 500 ms in the empty artwork slot. Fast reads advance as soon as the existing confirmed exit permits, without waiting for the indicator. Only the ring rotates; reduced-motion CSS keeps it static. Errors still show the explanation and read-only retry, and clear the stage busy state. Receipt confirmation, authoritative reads and voting contracts are unchanged.

All **124 frontend tests**, typecheck, ESLint and build passed. Focused regressions cover a fast read completing without a loader flash or added wait, delayed loading, stable stage DOM, clearing the indicator/busy state on failure, and read-only retry without a second cast. An actual-component fictional-data browser check at 390×700 delayed the next read by 10 seconds: the wordmark stayed still while the ring animated, vote controls remained disabled during the read, and the next track replaced the indicator. Stage bounds (310 px square) and vote-button bounds (48 px tall) were identical before/during/after; document dimensions remained 390×700. No Cloud votes were written. This spinner revision and the physical OS reduced-motion setting still need the owner's phone review.

## Tall-phone responsive fill (2026-10-15)

The owner's iPhone Pro Max screenshot showed a large unused area below Rating. The mobile Rating shell now fills the dynamic viewport, grows square artwork beyond the old 320 px cap when width/height permit, shares spare space around the artwork and keeps controls near the bottom with safe-area-aware padding. The existing short-screen/zoom/error scrolling fallback remains; active swipes cancel on both layout and visual viewport resize before release. No vote, receipt, database, invitation or environment contract changes.

All **126 frontend tests**, typecheck, ESLint and build passed. New regressions cover resize cancellation while the page still fits and a fresh deliberate vote afterwards. Actual-component fictional browser checks covered eight portrait viewports from 320×568 through 440×956 and 600×1000, plus short 390×440, landscape and desktop. At 430×850 artwork grew 320→394 px and the bottom gap fell 166→16 px. Normal portrait controls were 48 px tall, all visible with no document overflow; a vote preserved their bounds. Long text with a simulated 34 px bottom inset stayed within 320×568. Native page scrolling and simulated lost-response recovery remained usable, with upward voting disabled while overflow existed. No Cloud votes were written. The affected physical iPhone and its browser bars/safe areas still need the owner's refresh/review.

## Approved Home navigation tiles (2026-10-15)

After comparing three standalone mockups, the owner selected “two entrances”: matching side-by-side Rate tracks and My Picks tiles above progress, with concise helper text and a compact Home greeting/status/card. The rating tile remains accessible as Rating status outside VOTING, preserving recovery access; My Picks describes viewing rather than editing while closed. Navigation and authoritative own-user progress/choices use the existing routes/API. No database, invitations, voting rules, production settings or official-season changes.

All **126 frontend tests**, typecheck, ESLint and build passed. Actual-component fictional browser checks covered 320/375/390/430/600/601/1280 px: equal tile dimensions and no horizontal overflow; ordinary phone tiles were visible in the first screen. Long text wrapped and the page could scroll. Both routes, caught-up entry and closed-season status/read-only picks were checked; all six closed edit controls were disabled. These UI checks wrote no Cloud votes. The final hosted appearance still needs the owner's phone refresh/review.


## Compact My Picks and direct navigation (2026-10-15)

The owner approved the combined clean-card/compact-list mockup. My Picks now has subtle bordered cards, 48 px artwork, close track copy, equal listening/edit rows and a compact search/filter/refresh header. Apple Music remains red, Spotify green, and edit buttons remain PASS / SUPER LIKE / LIKE. Shared native Home and Rate tracks/My Picks links give both screens direct access to the other; Rating keeps its season context in the same mobile row.

All **126 frontend tests**, typecheck, lint and build passed. The existing 1001-pick pagination/filter/URL regressions pass with the new filter buttons. A pending-edit test now uses the direct links and confirms exactly one accepted action. Fictional-data browser checks covered narrow/large phones and desktop, long text and a closed season; Rating controls stayed inside the four tested normal phone viewports. Browser testing did not write Cloud votes. On a real phone, review card density, direct links, search/filter/page restoration and the existing return-from-listening scroll position. Database/RLS, invitations, environment settings, official season and production are unchanged.
