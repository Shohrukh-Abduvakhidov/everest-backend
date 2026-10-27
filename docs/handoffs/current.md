---
project: EVEREST Backend
current_milestone: M05-B
status: planned
branch: feat/m05-a-course-management
base_commit: f5121891
updated_at: 2026-10-27
---

# Current handoff

## Completed work

- M00 through M05-A are Done.
- M05-A added administrative course catalog/lifecycle APIs and course-scoped teacher assignments.
- The completion record is archived at `docs/handoffs/2026-10-27-m05-a-course-management.md`.

## Verification

- Focused M05-A PostgreSQL integration passed ten subtests; the full suite passed 102 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle.
- Migration up is a no-op. Catalog verification passed at 85 tables, 669 columns, 159 foreign keys, 301 indexes, 18 migrations, and 65 identity columns.
- The disposable cycle passed 18/18/17/18 and dropped its generated database. No rollback ran against `everest_db`.

## Current milestone

M05-B — modules, ordering, preview, and course copying — is Planned.

## Next concrete task

Confirm module lifecycle/order, preview exposure, and copy semantics before implementing M05-B.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- M05-B must not issue student enrollments or module access grants; those belong to M06.
- Groups remain independent from courses; never add `group_courses`.
- Do not edit the 18 published migrations.

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
