---
project: EVEREST Backend
current_milestone: M03
status: planned
branch: feat/m02f-b-auth-protection
base_commit: 1dbce804
updated_at: 2026-10-26
---

# Current handoff

## Completed work

- M00 through M02F-B are Done.
- M02F-B added persistent authentication throttles, password brute-force lockout, and session-bound CSRF/origin protection.
- The completion record is archived at `docs/handoffs/2026-10-26-m02f-b-auth-protection.md`.

## Verification

- `npm test` passed 62 authentication tests plus schema integrity and server lifecycle.
- Catalog verification passed at 85 tables and 16 migrations.
- The optional disposable rollback was unavailable because `everest_app` lacks `CREATEDB`; `everest_db` was never rolled back.

## Current milestone

M03 — user profiles and onboarding — is Planned.

## Next concrete task

Confirm the self-profile fields and avatar/onboarding contracts, then implement ownership-safe read/update APIs without broadening administrator workflows.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Preserve M02F-A permission checks and M02F-B rate/CSRF protections.
- Keep internal IDs as canonical decimal strings and never expose private authentication fields.
- Do not edit the 16 published migrations or select external storage without approval.

## Safe startup commands

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
npm run migrate:up
npm test
```
