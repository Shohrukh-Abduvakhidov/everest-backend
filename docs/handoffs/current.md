---
project: EVEREST Backend
current_milestone: M06
status: planned
branch: feat/m05-b-course-modules
base_commit: b766277
updated_at: 2026-10-28
---

# Current handoff

## Completed work

- M00 through M05-B are Done. M05-A is merged into `main` (PR #15, `b766277`).
- M05-B is on `feat/m05-b-course-modules`, which branches from `b766277` and waits for a PR into `main`. It adds:
   - module create and update;
   - the lifecycle `draft → published → archived → draft`;
   - deletion of empty draft modules only;
   - full-list reordering in two passes;
   - a read-only preview with lesson and test counts;
   - transactional copying of a course and its modules as drafts.
- New files:
   - `src/migrations/20261028010000000_add-course-module-permissions.js`
   - `src/repositories/course-module-repository.js`
   - `src/services/course-module-service.js`
   - `src/controllers/course-module-controller.js`
   - `tests/integration/course-modules.test.js`
- Changed files:
   - `src/routes/admin.js`
   - `src/middleware/course-admin-middleware.js`
   - `src/services/course-service.js`: helper exports only
   - `scripts/verify-database.js`
   - `scripts/test-migration-cycle.js`
- The completion record is archived at `docs/handoffs/2026-10-28-m05-b-course-modules.md`.

## Verification (2026-10-28)

- `npm run migrate:up` applied the new migration, which is the 19th.
- `node scripts/verify-database.js` passed: 17 permissions, 38 role grants, 4 teacher grants.
- `npm test` passed 113 tests with 0 failures, plus source integrity, schema integrity, and server lifecycle.
- The disposable `npm run test:migrations` cycle passed 19/19/18/19 and dropped its database. No rollback ran against `everest_db`.

## Task carried into M07: extend course copying

`courseCopySteps` in `src/services/course-module-service.js` is an ordered list. Each step receives `{ client, repository, actorId, sourceCourseId, targetCourseId, moduleIdMap }` and returns a summary that is merged into `copied`. When M07 adds lessons, videos, chapters and materials, append steps after `copyModulesStep`. Those steps must:

- map lessons to their copied modules through `moduleIdMap`;
- create copied lessons as `draft`;
- reuse asset references instead of duplicating files;
- never copy progress, notes, favorites, offline downloads, or test attempts.

## Next concrete task

M06, course and module access. Before writing code, confirm with the user:

- the expiry, extension, and reactivation policy;
- what an expired or revoked grant means for existing module grants;
- what the student-facing locked-module DTO contains.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Groups remain independent from courses; never add `group_courses`.
- Do not edit the 19 published migrations.
- Commit and push only on the user's request; never merge or force-push.

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
