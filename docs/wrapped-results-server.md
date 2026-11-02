# Love similarity server contract

2026-10-25. Implemented locally as planned below; no deployment. Concrete engineering plan recorded before the additive migration; implements the approved policy in [the integration brief](wrapped-results-integration-brief.md) and D49–D52 in [decisions.md](decisions.md). Names, storage, and DTOs below are implementation choices, not additional product decisions.

## Approved boundaries

Love similarity is hidden by default. Only a same-season admin can deliberately open it after REVEAL; lifecycle transitions never open it. Only members of that season can read opened results. Preserve `taste-love-v1`, the 75/25 formula, undefined components, raw-vote/audit privacy, and existing voting/lifecycle contracts. Admin-panel controls, result screens, awards, thresholds, other categories and other formulas are outside this slice.

## Schema and RPC plan

- Add private `season_result_categories`, keyed by `(season_id, category)` with only `love_similarity` accepted, `visible` default false. An absent row is hidden. No seeded openings or changes to existing tables, policies, votes, or lifecycle RPCs.
- Add private append-only `season_result_category_events`, retaining actor/action UUID, season/category, old/new visibility, and timestamp. Restrictive foreign keys, RLS, explicit denial of client table privileges, and existing immutable-event triggers protect both tables/history. Neither table is exposed by the Data API.
- `get_love_similarity_visibility(p_season)` returns admin-only `{seasonId, category, visible, state, canChange}`. It is available in every state for the planned panel and contains no preferences or audit history.
- `set_love_similarity_visibility(p_season, p_visible, p_action)` requires same-season admin and REVEAL for either value, validates non-null payload, acquires the actor advisory lock before the existing season row lock, and writes setting/event atomically. Actor/action UUID binds season and desired visibility across seasons within visibility operations (separate from the unchanged vote-action ledger); exact retries return the saved receipt without reapplying even after another toggle. Conflicting payloads fail. Every accepted new action, including same-value actions, records old/new state. Receipt: `{seasonId, category, visible, actionId, changedAt}`. Refresh visibility after a retry because the receipt is historical. Hiding blocks later reads but cannot revoke information already delivered.
- `get_love_similarity_results(p_season)` authenticates, verifies membership, acquires the season row lock shared with visibility/lifecycle operations, then requires REVEAL and explicit opening. It returns one JSON object `{seasonId, algorithm: "taste-love-v1", pairs: [...]}` to avoid Data API row-limit truncation. Each unordered member pair appears once in UUID order, including zero-evidence pairs; fewer than two members yields `[]`.
- Each pair contains `first` and `second` `{memberId, nickname}` plus `coRatedCount`, `loveIntersectionCount`, `loveUnionCount`, `slIntersectionCount`, `slUnionCount`. Count only current votes from exactly that season on active canonical season tracks rated by both members. No choices, track IDs, audit events, emails, or totals from another season are returned. SQL contains no formula coefficients. Reads and setters require READ COMMITTED so waiting transactions observe the committed visibility/lifecycle state.
- Errors are sanitized: existing identity/admin/membership errors; `results_not_available` for either hidden or pre-REVEAL reads; `results_require_reveal` for premature changes; `invalid_result_visibility_payload`, `action_payload_conflict`, and `read_committed_required` for their named contracts. Set result RPC response headers to `Cache-Control: no-store` to prevent public caching; do not log returned preferences.

## Shared calculation and integration

Refactor the existing pure ballot calculator to delegate to a validated count-based helper, preserving its algorithm and results. A pure serializable DTO adapter consumes only the authorized count envelope: retain member identities/evidence, calculate the unrounded 0–1 score once in TypeScript, and encode undefined values as `null` with `empty_union` / `undefined_overlap` reasons. No fallback or reweighting. No new service, snapshot, UI caller, or raw-ballot fetch is needed.

The planned season admin panel uses the visibility read and setter beside the existing `transition_season` RPC. Disable visibility changes until REVEAL; retain the same action UUID/payload after uncertain responses, refresh authoritative visibility after acceptance, and discard season/user-scoped state on navigation/account changes. The future results screen calls only the guarded summary RPC and DTO adapter; it must handle denied/hidden, loading, error, defined and undefined evidence without caching preferences publicly. The later [bounded panel](season-admin-panel.md) now implements these controls and recovery tests. Result-screen presentation and tests remain separate work.

## Verification plan

Run a fresh isolated local Supabase project with only repository migrations and synthetic seed identities; never reset or query an existing voting project. Add real SQL-role and Data API tests for all pre-REVEAL states, hidden REVEAL, same-season admin authority, outsider/anonymous denial, cross-season isolation using shared canonical tracks, eligibility/current edits/missing choices, exact output projections, audit immutability/atomicity, idempotent retries and lock races. Retain the full existing database regression suite. Extend TypeScript tests to compare count and ballot paths on the 1,200-track references and undefined cases, then run `npm test`, typecheck, lint, build, database lint, and documentation link/whitespace checks.


## Concrete integration calls and JSON handling

Use authenticated `POST /rest/v1/rpc/<name>` (or `supabase.rpc`) for all three RPCs. They are VOLATILE; result reads take a transaction lock and are not GET endpoints. Supply the existing signed-in user's token, never a service-role key or client-supplied actor. Each request is a short READ COMMITTED transaction. Successful responses specify `Cache-Control: no-store`.

```ts
// Planned panel: operational metadata only, even before REVEAL.
await supabase.rpc("get_love_similarity_visibility", { p_season: seasonId });
// Retain this UUID and payload across transport retries; create a new UUID only
// for a new deliberate action. Re-read visibility after any accepted receipt.
await supabase.rpc("set_love_similarity_visibility", {
  p_season: seasonId, p_visible: true, p_action: actionId,
});
// Planned result screen: only this authorized count response reaches the helper.
const { data, error } = await supabase.rpc("get_love_similarity_results", {
  p_season: seasonId,
});
if (error) throw error;
const result = serializeLoveSimilarityResults(seasonId, data);
```

`serializeLoveSimilarityResults` is exported by [love-similarity-results.ts](../src/domain/love-similarity-results.ts). It validates the expected season, `taste-love-v1`, member pairs and counts and projects away extra fields. The returned `LoveSimilarityResultsDto` keeps `{seasonId, algorithm, pairs}`; each pair contains `first`, `second`, `coRatedCount`, `loveOverlap`, `slOverlap`, and `score`. Each overlap contains `intersectionCount`, `unionCount`, and `value`; score contains `value`. Defined values omit `reason`; undefined overlaps use `{value: null, reason: "empty_union"}`, and an undefined combined score uses `{value: null, reason: "undefined_overlap"}`. No rounding occurs. A zero SL overlap with a positive union is a defined zero and is distinct from an empty union. The adapter supplies no authorization and performs no I/O.

Read failures use SQLSTATE 42501 for missing identity/membership or unavailable results; hidden and pre-REVEAL reads have the same `results_not_available` response without evidence. Admin authorization uses 42501, premature changes/action conflicts P0001, invalid setter payloads 22023, and unsupported isolation 25000. Do not infer category state by treating failed result reads as successful empty results. The current caller's ordinary catalog/progress reads have no new result fields.

The panel must integrate state/visibility loading, disabled pre-REVEAL controls, deliberate open/hide actions, retained retry payloads and authoritative refresh. Its lifecycle UI must still enforce one-step forward transitions with server checks. The result screen still needs layout/copy design and tests for denied/hidden, loading, error, defined/undefined values and evidence; keep returned data scoped to the signed-in user/season and avoid persistent preference caches or logs. This server slice introduced no controls, screen, thresholds, awards or extra formulas. The later [panel implementation](season-admin-panel.md) supplies only the lifecycle/visibility controls and their recovery behavior.


## Local verification (2026-10-25)

The additive migration applied successfully to a newly created disposable local Supabase project, `hardstyle-results-server` (API 56421, database 56422), using only repository migrations and synthetic seed identities. Existing local/Cloud voting projects and real ballots were not queried or modified. The stack was stopped after verification.

- `SUPABASE_CLI=<repository>/.tools/supabase scripts/test-db.sh`: **97 tests passed**, including **17 new SQL/Data API result tests**. Authorization, pre-REVEAL secrecy, hidden REVEAL, cross-season current/eligible evidence, raw-vote/event RLS, audit immutability/rollback, action retries/conflicts and both lock orderings passed alongside all existing foundation/importer regressions.
- `supabase db lint --local --level warning`: no schema errors in public/private/extensions.
- `npm test`: **197 tests passed**, including count/ballot reference equivalence and JSON null/reason handling. `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- Checks ran from a temporary copy without repository environment files, using installed local dependencies; original source and test files matched that copy. Documentation relative links, whitespace and Python syntax checks passed.

No production deployment or Git commit was made. The migration remains to be applied through a separately authorized deployment; no season is opened by applying it. The subsequent [bounded admin panel](season-admin-panel.md) completes control integration and UI recovery tests. Result-screen integration/testing remain as described above.
