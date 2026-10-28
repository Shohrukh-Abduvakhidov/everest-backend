---
project: EVEREST Backend
current_milestone: M07
status: planned
branch: feat/m06-course-access
base_commit: b630bea
updated_at: 2026-10-29
---

# Current handoff

## Completed work

- M00 through M06 are Done. M05-B is merged into `main` (PR #16, `b630bea`).
- M06 is on `feat/m06-course-access`, which branches from `b630bea` and waits for a PR into `main`. It adds:
   - administrative course enrollments and module access grants (grant, list, extend, revoke, re-grant) under `/api/v1/admin/courses/:courseId/enrollments`;
   - learner reads `GET /api/v1/courses` and `GET /api/v1/courses/:courseId/modules` with locked-module metadata;
   - the reusable guard `requireModuleAccessService(userId, moduleId)` for protected content.
- New files:
   - `src/migrations/20261029010000000_add-course-access-permissions.js`
   - `src/repositories/course-access-repository.js`
   - `src/services/course-access-service.js`, `src/services/learner-course-service.js`
   - `src/controllers/course-access-controller.js`, `src/controllers/learner-course-controller.js`
   - `src/routes/courses.js`
   - `tests/integration/course-access.test.js`
- Changed files: `src/routes/admin.js`, `src/routes/index.js`, `src/middleware/course-admin-middleware.js`, `tests/all.test.js`, `scripts/verify-database.js`, `scripts/test-migration-cycle.js`, and the documentation.
- No table was added or altered; the schema and `can_access_module` already covered M06.
- The completion record is archived at `docs/handoffs/2026-10-29-m06-course-access.md`.

## Decisions made without the user (please review)

The user was unavailable, so 15 ambiguities were resolved deny-by-default and recorded in `docs/decisions.md` under "Course enrollments and module access grants (M06)". The ones most worth a second look:

- Only owner/admin can read or manage grants; course teachers cannot.
- Only `active` accounts with the `student` role can be enrolled, and only in a `published` course; module grants need a `published` module and a current enrollment.
- `expiresAt` is required on every grant (`null` = no expiry), so unlimited access is explicit.
- Revoking an enrollment also revokes its module grants; re-granting the course does not restore them. Expiry is passive.
- Revoked rows are reset in place on re-grant (one row per user/course and user/module); history is in `audit_events`.
- Learners with a revoked enrollment, or none, get `404 COURSE_NOT_FOUND`; an expired enrollment still lists the course with every module locked.

## Verification (2026-10-29)

- Baseline on `main`: `migrate:up` no-op, `npm test` 113 passed.
- `npm run migrate:up` applied the new migration, which is the 20th. `node scripts/verify-database.js`: `valid: true` (19 permissions, 42 role grants).
- `npm test` passed 130 tests with 0 failures, plus source integrity, schema integrity, and server lifecycle.
- The disposable `npm run test:migrations` cycle passed 20/20/19/20 and dropped its database. No rollback ran against `everest_db`.

## Next concrete task

M07, lessons and protected assets. Requirements carried from M06:

- Every lesson, asset or test content route must call `requireModuleAccessService` (or the same `can_access_module` predicate) before returning content; locked modules stay metadata-only.
- Decide explicitly how teachers and administrators preview or author protected content; M06 grants them no learner access.
- Extend `courseCopySteps` in `src/services/course-module-service.js` for lessons (copied as `draft`, mapped through `moduleIdMap`, assets referenced not duplicated, no progress/notes/favorites/attempts).
- Storage/provider selection still needs user approval.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Groups remain independent from courses; never add `group_courses`.
- Do not edit the 20 published migrations.
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
