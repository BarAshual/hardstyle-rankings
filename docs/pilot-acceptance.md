# UI pilot acceptance — 2026-10-15

**Status: accepted by the owner for PR review.** This records the owner's manual test report for the isolated Preview UI. Production release and official voting are separate decisions; their remaining backup/recovery work is tracked in [official release blockers](official-release-blockers.md).

## Environment and implementation

- Branch: `preview/mobile-pilot-readiness`; latest UI implementation commit: `426048e032d3ab54de2e95a02a97b683c5ca7672`.
- Preview: <https://hardstyle-rankings-git-preview-mobile-pilot-readiness-tiloz.vercel.app/>. Temporary access tokens and invitation links are excluded from Git.
- Supabase: `tiloz-ranking-2k26-preview` (`mrcbzuuglyjjshrdlqdl`), separate from production.
- Human test season: `PREVIEW TEST — Mobile pilot`, `b4603c94-629e-446d-b0c1-0a389d035911`, 20 test tracks and 2 Super Likes per member.

## Manual acceptance reported by the owner

| Check | Result | Evidence and scope |
| --- | --- | --- |
| Complete the human pilot catalog | PASS | Owner reports completing all 20 tracks. This supersedes the owner's partial progress in the earlier audit snapshot. |
| Previously discussed phone checks | PASS | Owner reports verifying the phone checks discussed during the pilot, following the final UI revisions. The [phone checklist](pilot-preview.md#owner-phone-checklist) remains the reference for those flows. |
| Offline/recovery test | PASS | Owner explicitly reports that the offline/recovery test passed. |
| Investigate a participant's 14/20 completion | RESOLVED — intentional | Owner reports Oran confirmed that stopping at 14 tracks was intentional. It is not an outstanding lost-vote discrepancy. |

These are owner-reported real-phone results, not a new agent-run phone or database test. Exact device models, browser/OS versions, network timings and a per-step trace were not supplied. This record does not claim that every browser/device combination or a new negative Google-account test was exercised.

### Subsequent feedback revision

After this acceptance, the owner and a participant reported that routine pending/success notices caused layout jumps. The owner requested error-only vote feedback in Rating and My Picks. That follow-up is recorded in [pilot-preview.md](pilot-preview.md#error-only-voting-feedback-2026-10-15) with its automated/browser evidence. The manual passes above remain historical evidence for UI commit `426048e`; they do not imply a new physical-phone acceptance of the later feedback change. Refresh/recheck the Preview on a phone before closing that revision.

## Supporting automated and server evidence

- [Quality gate for the UI implementation](https://github.com/BarAshual/hardstyle-rankings/actions/runs/38738106795) passed: 126 frontend tests, TypeScript, ESLint, build and whitespace checks, plus the disposable database rebuild/lint, database/API and importer checks.
- Earlier browser checks covered compact/large phones, desktop, long text, closed-season read-only controls and direct Rating/My Picks navigation. The detailed chronological evidence is in [pilot-preview.md](pilot-preview.md).
- A read-only audit of the human Preview season on 2026-10-15 at 13:38 UTC found no duplicate votes/action IDs, orphan rows, broken version/event chains, current-vote/audit mismatches or quota overruns. Authenticated-role progress, personal metadata reads and next-track results matched the stored votes; member/admin vote and event reads remained restricted to the caller. This snapshot predates the owner's later 20/20 acceptance and is not a live progress report.
- The manual offline result complements the existing exact-action retry, receipt, duplicate-event, quota and stale-edit regressions. It does not establish catastrophic database recovery readiness.

## Closeout boundary

The UI pilot is ready for review without requiring further code changes from the reported partial-completion case. Preserve unrelated local Cloud-importer/documentation work when preparing the PR. No production deployment, official-season transition, merge or data mutation is authorized by this acceptance record. Merging `main` automatically deploys production and requires a separate decision.

Remaining backup/recovery prerequisites are tracked separately in [official-release-blockers.md](official-release-blockers.md), with the existing deployment gates retained.
