# Bounded season admin panel

Implemented locally on 2026-10-25. This implements the approved D51–D52 controls using the unchanged [server contract](wrapped-results-server.md) and [integration brief](wrapped-results-integration-brief.md). Confirmation copy, routing and recovery journals are engineering choices; no new product permissions, formulas, categories or admin features are introduced. No deployment or Git commit is included.

## Entry and authorization

The Home read now selects `nickname,role` for the authenticated caller's own membership in the selected season. Only `role=admin` displays the **Season admin** link to `/seasons/:seasonId/admin`. The panel independently calls the admin-authorized `get_love_similarity_visibility(p_season)` RPC and reads only that season's name from `seasons`; a hidden link is not the security boundary. A member, outsider, or admin of another season receives no controls.

The panel adds no table writes, migrations, RLS changes, results fetches, raw ballots, other members' preferences, audit reads or admin progress reads. Existing server authorization remains authoritative. Requests use the current user's captured access token, and refuse to start when that session's user differs from the action/read owner. There are no privileged credentials in the client.

## Admin identity and interim database assignment

The authority already lives in `public.season_members`: `(season_id, user_id, role='admin')`. The user ID references the authenticated account in `auth.users`; its Google email is the operator's lookup input, while the stable user ID remains the authorization binding. `private.is_admin` checks the caller's own ID and the exact season. There is no global admin flag. `create_season` automatically makes its verified Google creator the first admin.

The owner requested database-managed assignment by email for now. Use the existing membership role, with this owner-operated procedure:

1. Identify the intended database environment, exact season UUID and Google email. Resolve the email through a confirmed `auth.users` account and its trusted, verified Google identity using the existing normalization rules (trim surrounding whitespace and lowercase; preserve dots and plus aliases).
2. Require that account to already belong to the selected season. If it does not, use the existing invitation/acceptance flow before assigning its role; do not create an unverified membership from an email string.
3. In a transaction, lock the selected season row and set only that account's existing membership role to `admin`. Confirm exactly the intended membership before committing. Preserve other admins and all roles in other seasons; replacement/removal is a separate operation.
4. Refresh the app's season metadata to display the authorized admin entry and controls.

This is owner database maintenance under D20, not a new browser write permission or role-management RPC. Role assignment has no dedicated audit API in the current foundation; it must not rewrite existing votes or audit history. No particular account or database has been changed by this documentation update.

## Future season creation flow

Requested future work: let a signed-in user create a season from within the platform. Integrate the existing `create_season(p_name, p_year, p_allowance, p_nickname)` contract: it creates a `SETUP` season and its creator's first admin membership atomically. Collect an explicit allowance rather than hard-coding a universal default. Form design, validation/recovery, navigation to the new season and tests remain to be implemented. Invitation delivery and a role-management UI remain separate scope. The current bounded panel still manages existing seasons only.

## Two separate mutation contracts

| Control | Request | Confirmation and recovery |
| --- | --- | --- |
| Lifecycle | `transition_season(p_season, p_state)` | Only SETUP → VOTING → LOCKED → REVEAL, one step per deliberate action. Closing warns that voting cannot reopen; revealing explains that love similarity remains hidden. The receipt must equal the requested target. Success refreshes metadata. Failure or an unexpected receipt blocks further actions until a successful state refresh; it never automatically resends or advances another step. |
| Love similarity | `set_love_similarity_visibility(p_season, p_visible, p_action)` | Open/hide are separate deliberate confirmations, disabled before REVEAL. Save the complete action before sending and keep the same UUID and payload after uncertain responses, reloads or retries. Validate season/category/action/visibility/timestamp in the receipt before removing it. Then refresh metadata because the receipt may be historical. Hiding cannot revoke data already delivered. |

The UI displays only validated server state and visibility. It never applies the mutation receipt as current visibility and never opens the category as a side effect of entering REVEAL. A failed refresh exposes a read retry, not a repeated mutation. Error messages omit raw database/provider details. Server authorization failures remove the controls; existing intent stays scoped to its original user/season.

## Journal and account/season isolation

[pendingAdmin.ts](../src/pendingAdmin.ts) stores one operational intent per key, `hardstyle.admin.v1:<user>:<season>:<action>`, independently of the existing vote journal. Visibility records contain only kind, user, season, UUID and desired boolean. Lifecycle records contain kind, user, season, a local marker UUID, and source/target state; the marker UUID is never sent to `transition_season` or treated as server idempotency.

On reload, authenticate and read current authorized metadata before presenting controls. A saved visibility action requires an explicit retry with its exact payload. A saved lifecycle marker triggers only an authoritative read; remove it only when that read succeeds. Per-action keys preserve other tabs' records, and new actions check for pending intent again at confirmation. Explicit server rejection can discard that rejected visibility payload, but controls require a new metadata read before another change.

Storage failure before journaling prevents the request. Malformed records block controls instead of silently losing intent. Cleanup failure preserves the replayable visibility action. Storage is a recovery journal, never an authority for role, state or visibility. Browser storage availability remains a prerequisite for new admin writes.

The panel and Home are keyed by authenticated user and season. Navigation/account changes unmount the prior session, clear displayed metadata/confirmation state, and ignore late responses. Persisted intent remains under its original scope, available if that account returns to that season. Other accounts/seasons never replay it. Scoped storage events trigger only a read/inspection, not an automatic write.

## Verification and remaining work

- `npm test`: **241 tests passed**, including **39 new panel tests** and **5 new API tests**. Covered all states, same-season authorization, confirmation/cancellation, receipt validation, historical receipts, failures/reload recovery, duplicate submission, storage failure and account/season isolation.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed. Source/test verification ran from an environment-free temporary copy using installed dependencies. Documentation links and whitespace checks passed.
- The actual components were exercised in a browser with fictional in-memory metadata: Home entry, one-step close/reveal, hidden-on-REVEAL, explicit open/hide, focus on Cancel and 320/390 px mobile layout. No browser warnings/errors or horizontal overflow were observed; visible controls met the existing 48 px target. This is synthetic browser evidence, not a real Google or production test.
- No database contract changed; the database suite was not rerun for this panel slice. Prior real local SQL/Data API server coverage is recorded in the server contract. Real authenticated end-to-end/device checks remain a release integration step on an explicitly disposable target.

The catalog section now supports paired Spotify/Apple source designation, a dry-run payload, evidence summaries, and deliberate distinct/attach/keep/defer/decline review actions before item apply. The operator runner performs read-only Apple matching by ISRC or normalized title/artist and rejects unmatched or ambiguous pairs. Full provider credential management remains intentionally outside the browser; the browser accepts only the bounded candidate payload returned by the operator/provider adapter.

The results screen still needs its design and bounded member read/DTO integration, with hidden/loading/error/defined/undefined evidence states. Other admin features, new formulas, awards and thresholds remain outside this panel. Before a separately authorized rollout, apply the existing server migration to the intended environment; this panel does not apply it or change any existing season by loading.
