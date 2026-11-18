# Bounded season admin panel

Implemented locally on 2026-10-25, revised 2026-11-16 and verified in the [2026-11-17 closeout](admin-closeout.md). REVEAL is the single deliberate publish action; the panel does not contain a separate Love-similarity visibility box. Confirmation copy, routing and recovery journals are engineering choices; no new product permissions, formulas, categories or admin features are introduced.

## Entry and authorization

The Home read now selects `nickname,role` for the authenticated caller's own membership in the selected season. Only `role=admin` displays the **Season admin** link to `/seasons/:seasonId/admin`. The panel independently calls the admin-authorized `get_love_similarity_visibility(p_season)` RPC and reads only that season's name from `seasons`; a hidden link is not the security boundary. A member, outsider, or admin of another season receives no controls.

The panel adds no results fetches, raw ballots, other members' preferences or audit reads. Existing server authorization remains authoritative. Requests use the current user's captured access token, and refuse to start when that session's user differs from the action/read owner. There are no privileged credentials in the client.

## Admin identity and interim database assignment

The authority already lives in `public.season_members`: `(season_id, user_id, role='admin')`. The user ID references the authenticated account in `auth.users`; its Google email is the operator's lookup input, while the stable user ID remains the authorization binding. `private.is_admin` checks the caller's own ID and the exact season. There is no global admin flag. `create_season` automatically makes its verified Google creator the first admin.

The owner requested database-managed assignment by email for now. Use the existing membership role, with this owner-operated procedure:

1. Identify the intended database environment, exact season UUID and Google email. Resolve the email through a confirmed `auth.users` account and its trusted, verified Google identity using the existing normalization rules (trim surrounding whitespace and lowercase; preserve dots and plus aliases).
2. Require that account to already belong to the selected season. If it does not, use the existing invitation/acceptance flow before assigning its role; do not create an unverified membership from an email string.
3. In a transaction, lock the selected season row and set only that account's existing membership role to `admin`. Confirm exactly the intended membership before committing. Preserve other admins and all roles in other seasons; replacement/removal is a separate operation.
4. Refresh the app's season metadata to display the authorized admin entry and controls.

This describes the original owner bootstrap procedure. The expanded panel now uses `set_member_role` for audited role changes, preserving at least one admin. Bootstrap guidance is not a replacement for that API.

## Future season creation flow

Requested future work: let a signed-in user create a season from within the platform. Integrate the existing `create_season(p_name, p_year, p_allowance, p_nickname)` contract: it creates a `SETUP` season and its creator's first admin membership atomically. Collect an explicit allowance rather than hard-coding a universal default. Form design, validation/recovery, navigation to the new season and tests remain to be implemented. Invitation delivery remains separate scope; role controls are now part of the expanded panel. The current bounded panel still manages existing seasons only.

## Lifecycle mutation contract

| Control | Request | Confirmation and recovery |
| --- | --- | --- |
| Results publication | `transition_season(p_season, p_state)` | Only SETUP → VOTING → LOCKED → REVEAL, one deliberate step at a time. Entering REVEAL publishes the approved results categories; success refreshes metadata and the panel links to `/seasons/:seasonId/results`. Failure or an unexpected receipt blocks further actions until a successful state refresh; it never automatically resends or advances another step. |

The UI displays only validated server state. A failed refresh exposes a read retry, not a repeated mutation. Error messages omit raw database/provider details. Server authorization failures remove the controls; retired visibility intents are discarded on authoritative reload.

## Journal and account/season isolation

[pendingAdmin.ts](../src/pendingAdmin.ts) stores one operational intent per key, `hardstyle.admin.v1:<user>:<season>:<action>`, independently of the existing vote journal. Lifecycle records contain kind, user, season, a local marker UUID, and source/target state; the marker UUID is never sent to `transition_season` or treated as server idempotency. Retired visibility records are discarded and never sent.

On reload, authenticate and read current authorized metadata before presenting controls. A saved lifecycle marker triggers only an authoritative read; remove it only when that read succeeds. Retired visibility records are discarded. Per-action keys preserve other tabs' records, and new actions check for pending intent again at confirmation.

Storage failure before journaling prevents the request. Malformed records block controls instead of silently losing intent. Storage is a recovery journal, never an authority for role or state. Browser storage availability remains a prerequisite for new admin writes.

The panel and Home are keyed by authenticated user and season. Navigation/account changes unmount the prior session, clear displayed metadata/confirmation state, and ignore late responses. Persisted intent remains under its original scope, available if that account returns to that season. Other accounts/seasons never replay it. Scoped storage events trigger only a read/inspection, not an automatic write.

## Verification and remaining work

See [admin closeout](admin-closeout.md) for the current test commands, results, Preview status and results-branch handoff. Historical toggle tests have been replaced with unified-publication and lifecycle-recovery coverage. The actual browser regression uses a disposable local Data API and database with synthetic accounts.

The catalog section now supports paired Spotify/Apple source designation, a dry-run payload, evidence summaries, and deliberate distinct/attach/keep/defer/decline review actions before item apply. The operator runner performs read-only Apple matching by ISRC or normalized title/artist and rejects unmatched or ambiguous pairs. Full provider credential management remains intentionally outside the browser; the browser accepts only the bounded candidate payload returned by the operator/provider adapter.

The results screen still needs its design and bounded member read/DTO integration, with pre-REVEAL denial/loading/error/defined/undefined evidence states. Other admin features, new formulas, awards and thresholds remain outside this panel. Before a separately authorized rollout, apply the existing server migration to the intended environment; this panel does not apply it or change any existing season by loading.
