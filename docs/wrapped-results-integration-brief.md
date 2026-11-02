# Wrapped Results: Season Admin Integration Brief

2026-10-25. Approved product policy with proposed implementation boundaries. This brief originally introduced no implementation. The subsequent [server slice and integration contract](wrapped-results-server.md) implements category storage, audited admin RPCs, guarded pair summaries and shared calculation DTOs; admin-panel controls and result UI remain outside that server slice. The subsequent [bounded panel](season-admin-panel.md) implements lifecycle/visibility controls and recovery without fetching results. The existing [love calculation](taste-similarity-v1-implementation.md) remains unchanged mathematically.

## Accepted product contract

- The app will have a season-scoped admin panel. It will contain season lifecycle controls and the love-similarity category visibility control.
- Lifecycle controls reuse SETUP -> VOTING -> LOCKED -> REVEAL, advancing one step at a time. No backward transition, reopening, automatic date-based reveal, or new admin role is approved.
- Love similarity is hidden by default. Entering REVEAL does not automatically publish it.
- After REVEAL, an admin of that season may manually open the category to all members of that season. This category control belongs in the planned season admin panel.
- Before REVEAL, even admins cannot access the results or use the visibility control to expose them. Results require both REVEAL and explicit category opening.
- Opening the category does not expose raw ballots, audit records, unrestricted exports, other seasons, or public access.

The accepted control is for love similarity. Defaults for other future categories and the party sequence remain open. Read [results-and-wrapped.md](results-and-wrapped.md) and [decisions.md](decisions.md), D51–D52, for the canonical decisions.

## Coordinate with the planned admin panel

The results slice should supply a narrow category-setting/read contract for the shared season admin panel. Implement its controls in that panel's work, alongside the existing transition_season contract. If the panel is not present yet, document the integration point and leave the category hidden until the panel can deliberately open it. Do not create an independent results-only admin panel or auto-enable results as a workaround.

The panel can be accessible during earlier season states for authorized operational work and forward transitions. Its existence grants no pre-REVEAL preference preview. The visibility action should be unavailable before REVEAL in the UI and independently rejected at the server boundary. Existing administrative progress reads must retain their narrow projections.

This document does not expand the panel's scope to invitations, catalog editing, exports, allowance changes, or other controls. Those features follow their own existing decisions and briefs.

## Proposed engineering slice

Inspect AGENTS.md, the existing source migrations/RPCs, the [architecture](architecture.md), [data model](data-model.md), [database contract](database-foundation.md), and the implemented calculation before coding. Preserve unrelated work.

1. Design an additive, season-scoped category visibility setting, hidden when absent, with an admin-only audited change contract coordinated with existing season locking. Exact storage/API names remain engineering proposals. A hide action can be included in the on/off control; do not imply it can revoke information already delivered.
2. Add a narrow result read that authorizes identity, membership, REVEAL, and open category before returning preference-derived data. Keep the raw-vote and vote-event RLS/grant contracts unchanged. Hiding a UI component is insufficient.
3. Prefer returning per-pair evidence counts and authorized season display names, rather than other members' ballots: co-rated count, loved intersection/union, and SL intersection/union. Use current votes and eligible canonical tracks from exactly the selected season.
4. Reuse the approved TypeScript formula through a shared count-based calculation helper if needed; the current ballot calculator can delegate to it. Keep taste-love-v1 and its reference results unchanged. Do not duplicate formula coefficients in SQL or fetch everyone's raw votes into the browser to reuse the ballot function.
5. Define a serializable result DTO. Undefined internal components need an explicit absent/null value and reason over JSON. Do not silently assign 0/100 or reweight 75/25 when a component is undefined.

The implementing chat should record the small concrete API/schema plan before adding migrations. No new service, background job, snapshot system, or live VOTING calculation is required at this scale. No production data inspection or deployment is part of this planning handoff.

## First result screen: design recommendations, not additional approved policy

A first group view can show named member pairs, love-similarity percentages, and the number of co-rated tracks. A member filter can focus the view without making the whole experience personal-only. Expandable overlap counts can explain the score.

Show the defined components and a precise explanation when the combined score is undefined. Distinguish an empty SL union from zero matching SL within a positive union. Evidence thresholds and automatic "most similar" titles are still open; this slice should not invent awards or use low-evidence scores to award them. Detailed raw-choice lists are outside this screen proposal.

The screen's layout, evidence presentation, and undefined-score copy still need design. The newly approved policy does not silently approve all prior screen proposals or the shared-PASS/overall similarity formulas.

## Acceptance and integration checks

- Real local Postgres/Data API tests with synthetic seasons prove member and admin denial in SETUP/VOTING/LOCKED, denial while the category is hidden in REVEAL, and denial for outsiders and admins of another season.
- In REVEAL, only a same-season admin can open the category; a transition to REVEAL alone leaves it hidden. Opening returns only the bounded output to same-season members. Category changes are audited and existing lifecycle sequencing/locks remain valid.
- A two-season/dummy-versus-official fixture proves no cross-season contribution. Neither endpoint nor client exposes raw ballots or audit events.
- Count-based and ballot-based paths agree on the existing synthetic 1,200-track references, missing-vote handling, eligibility, undefined unions, and algorithm ID.
- Results never enter ordinary catalog/progress reads, preference logs, public caches, or sanitized authorization errors.
- When integrated with the planned panel, UI tests cover allowed lifecycle advances and the REVEAL-only visibility control. When a result screen is implemented, test hidden, loading, error, defined, and undefined states with evidence display.
- Run required database integration checks for the new contract and npm test/typecheck/lint/build for TypeScript/UI changes. Review links/whitespace for docs. Preserve votes, immutable audit history, idempotency, integer versions, current RLS guarantees, and all unrelated edits; do not commit unless asked.

The next implementation chat should take an explicitly bounded slice of this brief: server/category contract first, panel controls with the season-admin-panel work, and result presentation after its design is settled. The broader Wrapped scope remains desired.
