---
project: EVEREST Backend
current_milestone: M02C
status: ready
branch: refactor/m01r-numeric-identifiers
base_commit: ca7a3ba
updated_at: 2026-10-25
---

# Current handoff

## Completed work

- M00, M01, M02A, M02B, and the blocking M01R numeric identifier foundation are complete in this branch.
- M01R replaced internal UUID entity identifiers with PostgreSQL-generated identity `BIGINT`s across all 13 pre-production migrations and current authentication code.
- Repositories generate IDs through PostgreSQL and `RETURNING`; API/JWT identifiers are validated decimal strings that preserve `BIGINT` precision.
- The only database UUID is the intentionally opaque `sms_deliveries.idempotency_key`.

## Safety and database result

- Before rebuilding, `localhost:5432/everest_db` had no application data beyond four role seeds. A custom-format backup exists at `C:\Temp\everest-m01r-backups\everest_db-before-m01r-20261025-162519.dump`.
- Only the verified local `everest_db` was dropped/recreated. All 13 migrations applied and the second up was a no-op.
- The disposable rollback cycle used a separate generated test database, passed up/no-op/down-one/up, and dropped it. No rollback ran against `everest_db`.
- Catalog: 82 application tables, 650 columns, 157 FKs, 293 indexes, seven functions, 11 triggers, four role seeds, 13 migrations, and 64 identity columns.

## Verification

- `npm test`: passed eight schema-integrity cases, 24 authentication tests, migration-source verification, and server lifecycle checks.
- Password registration/login and Telegram link/login integrations passed against real PostgreSQL with numeric identifiers; Telegram providers remained mocked.
- `node scripts/verify-database.js`: passed all catalog, identifier-type, generated-ID, seed, and forbidden-table checks.
- JavaScript syntax, source digest, SQL-boundary search, UUID/random-generation classification, and `git diff --check` passed in the final audit.

## Current milestone

M02C — account approval — is Planned and ready after the M01R pull request is reviewed and merged.

## Next concrete task

Implement the narrowly scoped administrator guard and account-state API for listing pending users, approving, rejecting, blocking, and unblocking. Lock transitions, audit the administrator decision atomically, and revoke live sessions when blocking. Keep generalized authorization in M02F.

## Constraints

- Numeric IDs are decimal strings at JavaScript/API/JWT boundaries; never coerce them through `Number`, assume gaplessness, or renumber them.
- Keep opaque security/provider values distinct from internal IDs.
- Preserve route → middleware → controller → service → repository → `pg`.
- Do not edit the published numeric migration baseline; future schema changes require incremental migrations.
- Never run destructive rollback tests against `everest_db`.

## Safe startup commands

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
Get-Content docs/architecture.md
Get-Content docs/progress.md
Get-Content docs/decisions.md
npm test
npm run migrate:up
node scripts/verify-database.js
```
