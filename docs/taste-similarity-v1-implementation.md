# Love Similarity v1: Bounded Implementation Brief

Prepared and implemented 2026-10-24. The approved product definition is in [results-and-wrapped.md](results-and-wrapped.md). The isolated module and synthetic tests below complete this brief; application integration and deployment remain outside its scope.

## Implemented contract

[calculateTasteSimilarity](../src/domain/taste-similarity.ts) takes an `EligibleTasteTracks` object (`seasonId`, `trackIds`) and two `CurrentTasteBallot` objects (`seasonId`, `choices` of `trackId`/`choice`). Supply one member's current choices per ballot and one season's eligible catalog. Missing choices remain unrated. IDs are opaque canonical identities; repeated eligible IDs have set semantics. Mismatched seasons, duplicate current choices (including identical or ineligible duplicates), invalid choices, and an empty season ID throw rather than producing a score. Validation precedes eligibility filtering; this function does not reconstruct current state or authorize data access.

The result includes `algorithm: "taste-love-v1"`, `seasonId`, `coRatedCount`, `loveOverlap`, `slOverlap`, and `score`. Each overlap includes `intersectionCount`, `unionCount`, and an unrounded 0–1 `value`. A zero union returns `value: undefined` and `reason: "empty_union"`; the combined `score` then has `value: undefined` and `reason: "undefined_overlap"`. Inspect the component reasons to identify the missing overlap. A defined component remains available even when the combined score is undefined. No UI fallback, reweighting, threshold, or award is inferred.

[Synthetic tests](../tests/frontend/taste-similarity.test.ts) use the existing Vitest discovery under `tests/frontend`. The module imports no application, React, Supabase, storage, or network code. It now delegates to `calculateTasteSimilarityFromCounts`; the [server slice](wrapped-results-server.md) supplies guarded pair evidence and a pure JSON DTO adapter. No UI caller is added; hiding a UI component cannot authorize access.

Validation on 2026-10-24: `npm test` passed all 153 tests (27 focused similarity cases); `npm run typecheck`, `npm run lint`, and `npm run build` passed. These commands used a temporary copy of the repository frontend files, excluding environment files and reusing installed dependencies, with a temporary Vite cache. No service access was needed. No database integration run was needed because no database contract changed.

## Outcome

Implement a small deterministic TypeScript module for the approved 75% loved-track overlap plus 25% SL overlap model, with meaningful synthetic tests. Keep it independent of React, Supabase, network access, storage, and the live voting flow. This first step can proceed while song scoring, shared-PASS similarity, overall similarity, and result-screen authorization remain open.

## Read first

Read AGENTS.md and docs/product-spec.md, docs/architecture.md, docs/data-model.md, docs/decisions.md, docs/database-foundation.md, docs/catalog-ingestion.md, docs/results-and-wrapped.md, and this brief. Inspect existing TypeScript/testing conventions. Preserve unrelated local changes, including importer and deployment work. Do not commit unless the user requests it.

## Scope

1. Add a pure module, suggested `src/domain/taste-similarity.ts`, and focused tests using the existing Vitest setup. File placement can follow actual repository conventions.
2. Take explicit single-season eligible track IDs and two current ballots. The input contract must make season separation clear; do not load or reconstruct ballots from audit history. Do not silently accept mismatched seasons or duplicate current choices for a track.
3. Intersect eligible rated track IDs to get the comparison set. Do not treat missing choices as PASS. Distinct recording UUIDs stay separate.
4. Compute both set overlaps and the approved weighted score exactly as defined in the product document, on that same comparison set.
5. Return the algorithm identifier, co-rated count, both intersection/union counts, defined component values, and combined score when defined. Use one documented scale, preferably 0–1, with no presentation rounding inside the algorithm.
6. Represent zero denominators explicitly as undefined/absent with a reason, including an absent combined score when either component is undefined. This keeps the first slice within the defined mathematical domain; it does not settle a future UI fallback.
7. Use `taste-love-v1` or an equally explicit stable identifier. Changing the formula later requires a different algorithm version; vote integer versions remain untouched.

There is no voting-completion multiplier, unused-SL redistribution, minimum-pair award threshold, or song score in this module. Shared SL appears in the base loved-track set and contributes the intended additional favorites component.

## Reference cases and acceptance criteria

Build actual synthetic ballots, not just hard-coded precomputed similarity numbers. For the main reference, use track IDs 0–1199, with every member rating every track. Each member must have exactly 500 positive choices including 40 SL; all other choices are PASS.

A concrete fixture construction is available:

- Reference member: loved IDs 0–499, with SL IDs 0–39.
- A: loved IDs 0–399 and 500–599, with SL IDs 0–4 and 40–74.
- B close: loved IDs 0–379 and 500–619, with SL IDs 0–19 and 40–59.
- B larger gap: loved IDs 0–299 and 500–699, with SL IDs 0–19 and 40–59.

Expected results:

| Pair | Shared loves / love union | Shared SL / SL union | Expected v1 |
| --- | --- | --- | ---: |
| Reference–A | 400/600 | 5/75 | 31/60, approximately 0.5166667 |
| Reference–B close | 380/620 | 20/60 | 101/186, approximately 0.5430108 |
| Reference–B larger gap | 300/700 | 20/60 | 17/42, approximately 0.4047619 |

Thus B close scores above A, and A above B larger gap. Check counts as well as scores. The denominators differ; do not substitute a raw common-track count for overlap.

Additional meaningful checks:

- Symmetry, deterministic results, and independence from input iteration order; defined scores remain in 0–1.
- Identical ballots with at least one eligible co-rated SL give 1.
- Same loved-track set and disjoint SL sets give 0.75 when both SL sets are nonempty.
- LIKE versus SL on a single co-rated track gives 0.75, SL versus SL gives 1, and SL versus PASS gives 0. Evidence remains one track, with no award claim.
- No co-rated tracks, only shared PASS, and shared LIKEs without any co-rated SL follow the documented undefined-component contract. If only one member used SL, a positive SL union produces zero SL overlap normally.
- Adding a track rated by only one member does not change comparison counts or scores. Adding an ineligible track or data from another season cannot contribute.
- Current choices are counted once; edits are represented by the current ballot, not accumulated action history.
- No new I/O, application entry point, dependency, migration, RLS/grant change, client fetch of other users' votes, production data read, or voting behavior change.

Run repository-required `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` for the TypeScript change. Report commands/results and any unrelated baseline failures. Review doc links and whitespace. Database integration tests are needed only if the authorized scope later changes a database contract; this brief requires no database changes.

## Excluded from this slice

- Any access to real votes, pilot votes, production services, or privileged credentials.
- A scoring endpoint, RPC, server job, snapshots, caches, schema, or lifecycle change.
- Result UI, mock production rankings, an overall "most similar" title, or a minimum-evidence threshold.
- Shared-PASS and overall similarity formulas, song-ranking candidates, artist ranking, or award selection.
- New libraries or infrastructure unless justified and separately authorized.

## Completion and follow-up

Complete the pure module, synthetic tests, and small status updates to the relevant docs. Summarize what changed, why, validation, and remaining product boundaries. Keep the module disconnected from the application until a separately reviewed, server-authorized post-REVEAL result path exists. Hiding a client UI component is not an authorization boundary.

The next product/design slice is the result-data boundary and first post-REVEAL Wrapped screen, including category visibility, evidence display, and undefined-score treatment. Do not choose those policies silently in this implementation.
