# Results and Wrapped Product Baseline

Updated 2026-10-25. This records the approved product baseline, the isolated calculation status, and the manual category-opening policy. The [server slice](wrapped-results-server.md) now implements gated pair-evidence access and private category settings locally. The [bounded admin panel](season-admin-panel.md) is now implemented; the results screen is still separate work, and no deployment is included. The owner selected love similarity v1 to move development forward; future changes remain possible through explicit, versioned decisions. Song-scoring formulas and the overall similarity formula remain open.

## Product goal

The main outcome is a group and interpersonal Hardstyle Wrapped: shared favorites, differences, surprises, named stories, and artist insights for the party and later browsing. A weighted top 100–200 is another desired output. Personal summaries are a bonus. There is no fixed cap on insight categories; each implemented category needs its own definition, evidence requirements, and visibility rules.

Planning assumes roughly ten active voters, about eight completing the catalog, and roughly 1,200 tracks with additions during VOTING. These are estimates, not eligibility rules.

## Accepted voting and ranking rules

- PASS primarily means "not enough for LIKE," not necessarily dislike or hatred. LIKE means positive affection; SL expresses a strong favorite intended to have substantial influence.
- A missing vote remains missing. It is never converted to PASS.
- Apply the same song-scoring rule to every voter. Do not increase voting power because someone rated fewer tracks, gave fewer LIKEs, or used fewer SLs.
- The selected working allowance for the official 2026 season is at most 40 SL per member, not a usage target. Keep allowance explicit in season configuration; this does not change an existing season or establish a universal hard-coded default. The accepted audited-increase-only contract during VOTING remains unchanged.
- Closing voting does not require everyone to finish the catalog.
- Every eligible track participates in song rankings without a minimum rater threshold. Use actual current choices without compensating for missing votes. This rule does not authorize similarity awards on insufficient evidence.
- Equal song scores receive equal competition rank: 1, 2, 2, 4. Rank is one plus the number of tracks with a strictly higher score. Display order inside a tie does not break it.
- Include the whole tie group at a top-100/200 boundary. Three tracks tied at rank 100 produce 102 entries, if 99 precede them. Apply this independently to each eventual ranking method.
- Track rater/missing counts are derived. Their display in the results table is provisionally accepted for design review; the data remains available if that column is later hidden.

## Accepted love similarity v1

The owner approved a two-part love-similarity score: **75% overlap in loved tracks plus 25% overlap in SL choices**. LIKE versus SL counts as substantial shared affection; matching SL choices adds emphasis for shared favorites. This is a similarity definition, not a conversion of SL into song-ranking points.

Use a distinct algorithm identifier, suggested `taste-love-v1`; it is unrelated to integer vote versions. The bounded calculation contract below makes the approved overlap model precise without choosing the remaining display or award policies.

### Input and scope

Use one explicitly identified season and its eligible canonical track IDs. For each pair, compare only eligible tracks both members actually rated. Use their latest current raw choices, never the number of audit events. Filter to the selected official season; pilot/dummy seasons must never contribute. Released versions remain separate tracks according to catalog identity rules.

Within those co-rated tracks:

- `A+`, `B+`: tracks each member chose LIKE or SUPER_LIKE.
- `AS`, `BS`: tracks each member chose SUPER_LIKE.
- `loveOverlap = |A+ intersect B+| / |A+ union B+|`.
- `slOverlap = |AS intersect BS| / |AS union BS|`.
- `loveSimilarityV1 = 0.75 * loveOverlap + 0.25 * slOverlap` when both denominators are positive.

Retain the co-rated count and each intersection/union count with the calculation. Percentages describe overlap under this definition, not confidence or a probability that the members have the same taste. There is no completion multiplier or unused-SL redistribution.

### Undefined inputs and remaining product policy

If an overlap denominator is zero, that component is mathematically undefined. The initial calculation slice returns an absent component and absent combined score with the reason; it must not manufacture 0%, 100%, or silently reweight the remaining component. A defined component can still be returned independently.

This is a boundary for the first calculation slice, not a final UI policy. In particular, if neither member used SL on the co-rated tracks, a fallback for the 75/25 score remains open. If only one used SL, the SL union is positive and SL overlap is zero under the ordinary formula.

No minimum evidence threshold or "most similar" award is selected yet. Retain evidence counts; omit automatic awards and confident claims from this first slice. A perfect match on one track does not establish a generally identical taste.

### Synthetic reference examples

All three members rated all 1,200 tracks. Each loved 500 tracks, including 40 SL. Shared-love counts include shared SL.

| Pair/profile | Shared loves | Shared SL | Love overlap | SL overlap | v1 score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Friend A | 400 | 5 | 400/600 | 5/75 | 51.7% |
| Friend B, close love counts | 380 | 20 | 380/620 | 20/60 | 54.3% |
| Friend B, larger love gap | 300 | 20 | 300/700 | 20/60 | 40.5% |

The owner clearly preferred B in the first comparison and tentatively preferred A in the larger-gap comparison. V1 reproduces both. The percentages above are rounded for explanation only. The choice is a practical starting model, not a claim of mathematical optimality.

Further expected calculation cases:

| Synthetic input | Calculation result |
| --- | --- |
| Identical eligible choices, with at least one SL | Both overlaps and v1 are 100%. |
| Identical 500-loved-track sets, disjoint sets of 40 SL | Love overlap 100%, SL overlap 0%, v1 75%. |
| A single co-rated track: LIKE versus SL | Love overlap 100%, SL overlap 0%, v1 75%; evidence is one track. |
| A single co-rated track: SL versus SL | Both overlaps and v1 100%; evidence is one track. |
| A single co-rated track: SL versus PASS | Both overlaps and v1 0%. |
| No co-rated eligible tracks | Both components and combined score undefined. |
| Both give only PASS on co-rated tracks | Both components and combined score undefined. |
| Shared LIKEs, no SL used by either member in the comparison | Love component defined, SL component and v1 undefined pending fallback policy. |
| A track only one member rated, or an ineligible track | No effect on the pair calculation. |

These specify calculation behavior, not titles, visibility, or a UI decision for undefined results.

## Additional similarity outputs remain separate

The requested outputs are love similarity, shared-PASS similarity, and an overall measure. Only the love-similarity formula is now approved. A shared-PASS overlap and any balance between love and PASS remain proposals.

Do not automatically choose 50/50 for the overall score. An earlier synthetic ten-track example demonstrates why: with v1 love scores of 45.0% versus A and 53.1% versus B, the proposed PASS scores of 71.4% and 28.6% produce overall 50/50 scores of 58.2% and 40.8%. That would favor A despite the earlier tentative preference for shared strong favorites. The overall definition requires its own explicit decision.

## Song rankings: positive direction, formulas still proposals

A results-table toggle between fixed points and support-reinforced scoring received a positive response. Its labels, default, official status, and Track of the Year rule remain open. Both eventual views must use the same eligible catalog and final current choices.

For `L` LIKE votes and `S` SL votes, the current candidates are:

| Candidate, not approved | Formula |
| --- | --- |
| Fixed points | `L + 8*S` |
| One support bonus per track | `L + 5*S + min(L + S - 1, 5)` if `S > 0`; otherwise `L` |

Do not ship these as approved formulas. Their SL base values differ, so a movement between them is not solely a support-bonus effect. An earlier per-SL bonus model remains an explored alternative, not the selected direction.

Artist aggregation, collaboration credit, prolific-artist adjustments, and titles remain open. They do not inherit song or similarity formulas automatically.

## Calculation, disclosure, and versioning boundaries

- Final calculations may run after LOCKED. Live group scoring during VOTING is unnecessary. If a formula depends on final group support, that does not require live computation.
- SETUP -> VOTING -> LOCKED -> REVEAL remains mandatory. No group preferences, pair similarities, rankings, or popularity hints are available to members or application admins before REVEAL, including through logs, caches, exports, or errors.
- Named, bounded post-REVEAL insights for season members are desired, including a uniquely named SL supporter when the data supports that claim. This does not authorize opening raw individual vote tables, unrestricted browsing of all personal ballots, exports, or public sharing.
- Love similarity is hidden by default. A same-season admin can manually open it to all same-season members only after REVEAL; entering REVEAL alone does not open it. The visibility control belongs in the planned per-season admin panel alongside season state controls. The existing lifecycle remains forward-only, one step at a time. Admins have no preference preview before REVEAL.
- The [server contract](wrapped-results-server.md) implements category authorization/storage and a narrow pair-evidence path. Other category defaults, evidence display, and detailed presentation remain separate work. Raw-vote access is unchanged; no UI caller is added.
- Preserve current votes, audit history, idempotency, integer vote versions, grants/RLS, lifecycle locking, and catalog eligibility. Calculations are separate derived data.
- Use synthetic data to select and test formulas. Never inspect unrevealed real votes to tune a model. Never mix pilot data into the official season.
- Record explicit future formula revisions with a new algorithm version and synthetic reference examples; do not silently change an algorithm under the same version. No persisted result schema or recalculation service is selected here.

## Next development slice

The [bounded implementation](taste-similarity-v1-implementation.md) is complete: [pure TypeScript calculation](../src/domain/taste-similarity.ts) and [synthetic Vitest tests](../tests/frontend/taste-similarity.test.ts), with explicit season/duplicate validation, comparison counts, unrounded 0–1 values, and undefined reasons. The pure calculation remains independent of data access; its count helper and JSON adapter support the guarded server summary RPC. The broad Wrapped scope remains desired; this slice does not choose display policies or add UI controls.

The [integration brief](wrapped-results-integration-brief.md) records the approved opening policy and how the next results slice should coordinate with the season admin panel, now [implemented within its bounded scope](season-admin-panel.md). It separates server/category contracts, controls in the shared panel, and the first post-REVEAL screen design. Evidence/display rules and remaining formulas are separate decisions. Read [product-spec.md](product-spec.md), [decisions.md](decisions.md), [architecture.md](architecture.md), and [data-model.md](data-model.md) for the existing contracts.
