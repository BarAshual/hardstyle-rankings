# Wrapped Results: Season Admin Integration Brief

2026-10-25, revised 2026-11-16. REVEAL is the single deliberate publication moment; the subsequent [server slice and integration contract](wrapped-results-server.md) preserves category history for compatibility, provides guarded pair summaries and shared calculation DTOs, and the [bounded panel](season-admin-panel.md) provides lifecycle controls without fetching results. The existing [love calculation](taste-similarity-v1-implementation.md) remains unchanged mathematically.

## Accepted product contract

- The app will have a season-scoped admin panel. It contains season lifecycle controls; the results page owns presentation of approved categories.
- Lifecycle controls reuse SETUP -> VOTING -> LOCKED -> REVEAL, advancing one step at a time. No backward transition, reopening, automatic date-based reveal, or new admin role is approved.
- Love similarity is unavailable before REVEAL. Entering REVEAL is the single deliberate publish action and makes it available on the unified results page.
- There is no separate category-opening control in the admin panel; historical visibility records remain preserved for audit compatibility.
- Before REVEAL, even admins cannot access the results. Results require REVEAL and remain scoped to same-season members.
- Opening the category does not expose raw ballots, audit records, unrestricted exports, other seasons, or public access.

The accepted control is for love similarity. Defaults for other future categories and the party sequence remain open. Read [results-and-wrapped.md](results-and-wrapped.md) and [decisions.md](decisions.md), D51–D52, for the canonical decisions.

## Coordinate with the planned admin panel

The panel uses the admin-only operational metadata read and the existing `transition_season` contract. Entering REVEAL publishes Love similarity; at REVEAL the panel links to `/seasons/:seasonId/results`. The separate results branch implements that route.

The panel can be accessible during earlier season states for authorized operational work and forward transitions. Its existence grants no pre-REVEAL preference preview. Existing administrative progress reads must retain their narrow projections.

This document does not expand the panel's scope to invitations, catalog editing, exports, allowance changes, or other controls. Those features follow their own existing decisions and briefs.

## Implemented engineering boundaries

Inspect AGENTS.md, the existing source migrations/RPCs, the [architecture](architecture.md), [data model](data-model.md), [database contract](database-foundation.md), and the implemented calculation before coding. Preserve unrelated work.

1. Preserve the historical private category settings/events. The retired setter rejects mutations; operational metadata derives visibility from lifecycle and always reports `canChange=false`.
2. Add a narrow result read that authorizes identity, membership, and REVEAL before returning preference-derived data. Keep the raw-vote and vote-event RLS/grant contracts unchanged. Hiding a UI component is insufficient.
3. Prefer returning per-pair evidence counts and authorized season display names, rather than other members' ballots: co-rated count, loved intersection/union, and SL intersection/union. Use current votes and eligible canonical tracks from exactly the selected season.
4. Reuse the approved TypeScript formula through a shared count-based calculation helper if needed; the current ballot calculator can delegate to it. Keep taste-love-v1 and its reference results unchanged. Do not duplicate formula coefficients in SQL or fetch everyone's raw votes into the browser to reuse the ballot function.
5. Define a serializable result DTO. Undefined internal components need an explicit absent/null value and reason over JSON. Do not silently assign 0/100 or reweight 75/25 when a component is undefined.

The implementing chat should record the small concrete API/schema plan before adding migrations. No new service, background job, snapshot system, or live VOTING calculation is required at this scale. No production data inspection or deployment is part of this planning handoff.

## First result screen: design recommendations, not additional approved policy

A first group view can show named member pairs, love-similarity percentages, and the number of co-rated tracks. A member filter can focus the view without making the whole experience personal-only. Expandable overlap counts can explain the score.

Show the defined components and a precise explanation when the combined score is undefined. Distinguish an empty SL union from zero matching SL within a positive union. Evidence thresholds and automatic "most similar" titles are still open; this slice should not invent awards or use low-evidence scores to award them. Detailed raw-choice lists are outside this screen proposal.

The screen's layout, evidence presentation, and undefined-score copy still need design. The newly approved policy does not silently approve all prior screen proposals or the shared-PASS/overall similarity formulas.

## Acceptance and integration checks

- Real local Postgres/Data API tests with synthetic seasons prove member and admin denial in SETUP/VOTING/LOCKED, successful reads in REVEAL regardless of historical category settings, and denial for outsiders and admins of another season.
- Only a same-season admin can advance lifecycle. REVEAL publishes bounded results to same-season members. Existing lifecycle audit, forward-only sequencing and locks remain valid; retired visibility actions never write or alter historical events.
- A two-season/dummy-versus-official fixture proves no cross-season contribution. Neither endpoint nor client exposes raw ballots or audit events.
- Count-based and ballot-based paths agree on the existing synthetic 1,200-track references, missing-vote handling, eligibility, undefined unions, and algorithm ID.
- Results never enter ordinary catalog/progress reads, preference logs, public caches, or sanitized authorization errors.
- When integrated with the panel, UI tests cover allowed lifecycle advances, REVEAL publication and the results link. When a result screen is implemented, test pre-REVEAL denial, loading, error, defined, and undefined states with evidence display.
- Run required database integration checks for the new contract and npm test/typecheck/lint/build for TypeScript/UI changes. Review links/whitespace for docs. Preserve votes, immutable audit history, idempotency, integer versions, current RLS guarantees, and all unrelated edits; do not commit unless asked.

The next implementation chat should integrate the results page with the current server contract and the admin results link; see [closeout and handoff](admin-closeout.md). The broader Wrapped scope remains desired.
