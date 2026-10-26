---
project: EVEREST Backend
current_milestone: M02F
status: planned
branch: feat/m02e-password-recovery
base_commit: 0bffa211b00195925201b09cad7a04c8eb538a2f
updated_at: 2026-10-25
---

# Current handoff

> Structural refactor note (26 October 2026): PR #8 now uses configured default routers, direct top-level controllers and business services, optional per-call test dependencies, and test-only service adapters. No milestone status, API contract, migration, schema, security rule or product behavior changed.

## Completed work

- M00 through M02E are Done in the current feature branch.
- M02E added secure linked-Telegram password recovery, a disabled production SMS boundary, one-use challenge/reset state, and atomic password/session revocation.
- One incremental migration is applied; all 13 earlier published migrations remain unchanged.
- Production SMS delivery remains unavailable until a provider is explicitly approved.

## Verification

- Both final `npm run migrate:up` executions were no-ops.
- `npm test` passed 55 authentication tests, eight schema-integrity cases, migration-source integrity, and server lifecycle.
- Catalog verification passed: 82 tables, 654 columns, 157 foreign keys, 296 indexes, 14 migrations, and 64 identity columns.
- The disposable migration cycle was attempted but blocked by missing `CREATEDB` (`42501`); it did not alter `everest_db`.

## Current milestone

M02F — authorization and authentication protection — is Planned. Do not treat the narrow M02C administrator guard as generalized RBAC.

## Next concrete task

Confirm action/resource permission semantics and the CSRF/rate-limit strategy, then implement centralized RBAC, authentication abuse controls, and tested CSRF protection without broadening unresolved domain permissions.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL and canonical decimal-string IDs.
- Keep SMS provider selection outside M02F unless separately approved.
- Do not edit the 13 published migrations or run destructive rollback against `everest_db`.
- Inspect the M02E migration and recovery tests before changing authentication protections.

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
