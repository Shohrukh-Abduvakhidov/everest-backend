---
project: EVEREST Backend
current_milestone: M04
status: planned
branch: feat/m03-user-profiles-onboarding
base_commit: 24b7eb7d
updated_at: 2026-10-26
---

# Current handoff

## Completed work

- M00 through M03 are Done.
- M03 added ownership-safe self-profile and onboarding APIs with no schema change.
- The completion record is archived at `docs/handoffs/2026-10-26-m03-user-profiles-onboarding.md`.

## Verification

- Focused profile integration passed eight tests against PostgreSQL.
- `npm test` passed 70 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle.
- `npm run migrate:up` was a no-op; the catalog remains at 85 tables and 16 migrations.

## Current milestone

M04 — groups — is Planned.

## Next concrete task

Confirm group list/detail, membership, teacher-permission, and announcement contracts before implementing M04. Groups must never grant course access.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Preserve M02F-A authorization, M02F-B rate/CSRF protections, and M03 ownership-safe profile behavior.
- Do not add `group_courses` or infer learning access from group membership.
- Do not edit the 16 published migrations.

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
