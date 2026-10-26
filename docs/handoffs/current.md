---
project: EVEREST Backend
current_milestone: M02F-B
status: planned
branch: feat/m02f-a-rbac-authorization
base_commit: 015efdd
updated_at: 2026-10-26
---

# Current handoff

## Completed work

- M00 through M02F-A are Done.
- M02F-A adds database-backed permissions and role grants plus service/repository authorization boundaries.
- The five existing account-administration actions are granted only to `owner` and `admin`; behavior and stable denials are preserved.
- One incremental RBAC migration is applied; all 14 earlier published migrations remain unchanged.
- The completed M02F-A handoff is archived at `docs/handoffs/2026-10-26-m02f-a-rbac-authorization.md`.
- Rate limiting, brute-force controls, CSRF, and production SMS delivery remain unimplemented.

## Verification

- Focused authorization unit tests and all eight account-administration integration subtests passed.
- Catalog verification passed: 84 tables, 661 columns, 159 foreign keys, 299 indexes, 15 migrations, and 65 identity columns.
- `npm test` passed 59 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle.
- Both final `npm run migrate:up` executions were no-ops.
- The disposable migration cycle passed up/no-op/down/up and its generated database was confirmed removed. No rollback ran against `everest_db`.

## Current milestone

M02F-B — authentication protection hardening — is Planned.

## Next concrete task

Confirm rate-limit, brute-force, and CSRF policies, then implement M02F-B without broadening unresolved domain permissions or changing approved authentication contracts.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL and canonical decimal-string IDs.
- Keep SMS provider selection outside M02F unless separately approved.
- Do not edit the 14 earlier published migrations or run destructive rollback against `everest_db`.
- Preserve the M02F-A permission boundary and inspect recovery/session tests before changing authentication protections.
- Remove the temporary `CREATEDB` privilege from `everest_app` before M02F-B work.

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
