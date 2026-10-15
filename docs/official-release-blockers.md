# Official voting — open backup and recovery blockers

**Status: OPEN as of 2026-10-15.** [UI pilot acceptance](pilot-acceptance.md) closes the reported phone/offline acceptance items. It does not close the recovery prerequisites below or authorize a production deployment or official voting.

## Evidence already available

The [pilot recovery rehearsal](pilot-preview.md#backup-inventory-and-isolated-restore) exported the isolated synthetic Preview database and restored it into a new blank local database. Row/content checks for 47 tables, stable identity UUIDs, votes/versions, audit receipts, constraints, grants/RLS and accepted-action replay passed. No existing Cloud database was overwritten or reset.

At the earlier production backup inspection, no operator-accessible downloadable managed backup or enabled PITR was available. A WAL-enabled metadata flag did not establish a usable recovery path. The rehearsal archive was local and unencrypted; it is not an independent production backup. Those observations are historical evidence, not a new platform inspection in this documentation update.

## Remaining work and completion evidence

| Open item | Evidence required to close it |
| --- | --- |
| Recovery policy | Agree acceptable RPO/RTO, backup frequency, retention, responsibility and official-vote retention requirements. |
| Independent backup operation | Implement encrypted independent storage, a reliable scheduler that does not depend on a running laptop, freshness/failure monitoring and a documented operator procedure. Verify that a retained archive can actually be retrieved and decrypted. |
| Populated importer recovery | Restore populated provider mappings, source evidence and import/review audits. The eight private importer/provider/source tables were empty in the completed rehearsal. |
| Complete isolated Cloud recovery | Restore to a separate empty target, verify Auth user/identity UUID continuity, real Google sign-in, application reconnection, personal data reads and accepted-action replay. Recheck privacy and effective application grants/RLS after restore. |
| Configuration and managed-service recovery | Maintain a protected inventory/procedure for project/API/OAuth/signing configuration, required secrets and any relevant Storage or other managed-service data outside the four-schema archive. Do not treat live importer OAuth token files as backup material. |

Every restore rehearsal must use an isolated target. Do not overwrite, reset or restore over existing Cloud data. Access, capacity or infrastructure needed for a Cloud rehearsal must be resolved explicitly; this UI PR provisions none.

The [free-tier recovery and monitoring gates](deployment.md#free-tier-recovery-and-monitoring-gates) remain in force. Official voting stays gated on an approved recoverable backup process and a complete isolated recovery rehearsal. These items are separate follow-up work; this document selects no paid plan, storage provider, scheduler or new infrastructure.
