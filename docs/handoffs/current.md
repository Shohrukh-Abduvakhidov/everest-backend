---
project: EVEREST Backend
current_milestone: M05
status: planned
branch: feat/m04-b-group-administration
base_commit: efece5a3
updated_at: 2026-10-27
---

# Current handoff

## Completed work

- M00 through M04-B are Done.
- M04-B added group administration, student membership lifecycle, teacher assignment, and text announcements with database-backed permission and resource scope checks.
- The completion record is archived at `docs/handoffs/2026-10-27-m04-b-group-administration.md`.

## Verification

- Focused M04-B integration passed nine subtests; the full suite passed 91 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle.
- Migration up is a no-op. Catalog verification passed at 85 tables, 668 columns, 159 foreign keys, 301 indexes, 17 migrations, and 65 identity columns.
- The disposable migration cycle passed 17/17/16/17 and dropped its generated database. No rollback ran against `everest_db`.

## Current milestone

M05 — course management — is Planned.

## Next concrete task

Confirm the M05 course lifecycle, module ordering, teacher permissions, publication rules, and copy semantics before implementation.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Groups remain independent from courses and never grant course or module access.
- Do not edit the 17 published migrations; add an incremental reversible migration only if M05 requires schema or permission seeds.

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
