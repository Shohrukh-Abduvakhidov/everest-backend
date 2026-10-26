---
project: EVEREST Backend
current_milestone: M04-B
status: planned
branch: feat/m04-a-group-read-apis
base_commit: b83decb6
updated_at: 2026-10-26
---

# Current handoff

## Completed work

- M00 through M03 and M04-A are Done.
- M04-A added relationship-scoped group list/detail and safe paginated rosters without a migration.
- The completion record is archived at `docs/handoffs/2026-10-26-m04-a-group-read-apis.md`.

## Verification

- Focused group integration passed 11 tests against PostgreSQL.
- `npm test` passed 81 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle.
- `npm run migrate:up` was a no-op; the catalog remains at 85 tables and 16 migrations.

## Current milestone

M04-B — group administration and announcements — is Planned.

## Next concrete task

Confirm group CRUD, membership/teacher assignment, and announcement lifecycle permissions before implementing M04-B.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Groups never grant course/module access; never add `group_courses`.
- Announcement assets depend on M07, progress summaries on M12, and ranking on M13 plus an approved formula.
- Preserve M04-A non-disclosing reads and do not edit the 16 published migrations.

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
