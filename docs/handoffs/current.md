---
project: EVEREST Backend
current_milestone: M02D
status: ready
branch: feat/m02c-account-approval
base_commit: 66d1099
updated_at: 2026-10-25
---

# Current handoff

## Completed work

- M00, M01, M01R, M02A, M02B, and M02C are complete.
- M02C added owner/admin-only pending-account listing and approve, reject, block, and unblock APIs.
- State changes lock the target and atomically write audits; block revokes all live sessions, and unblock does not restore them.
- The local `bootstrap:owner` command safely assigns the first owner under an advisory transaction lock.
- Exact migration-source verification now normalizes only CRLF/CR to LF, with `.gitattributes` enforcing LF. Published migration content is unchanged.

## Verification

- Both final `npm run migrate:up` executions were no-ops.
- `npm test` passed migration-source integrity, eight schema-integrity cases, 34 authentication tests, and server lifecycle checks.
- `node scripts/verify-database.js` passed: 82 tables, 650 columns, 157 foreign keys, 293 indexes, 13 migrations, and 64 identity columns.
- The only UUID column remains the opaque `sms_deliveries.idempotency_key`.
- The disposable migration-cycle script could not create its separate database because `everest_app` lacks `CREATEDB`; no rollback ran against `everest_db`.

## Current milestone

M02D — session lifecycle — is Planned and ready after the M02C pull request is reviewed and merged.

## Next concrete task

Define and implement refresh-token creation and rotation, reuse detection, logout, logout-all, session listing/revocation, device-safe metadata, and last-used tracking. Confirm cookie and token lifecycle decisions before implementation.

## Constraints

- Numeric IDs remain canonical positive decimal strings at JavaScript/API/JWT boundaries.
- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Keep generalized RBAC in M02F; do not broaden the M02C role guard implicitly.
- Do not edit the 13 published migrations.
- Never run destructive rollback tests against `everest_db`.

## Safe startup commands

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
npm run migrate:up
npm test
node scripts/verify-database.js
```
