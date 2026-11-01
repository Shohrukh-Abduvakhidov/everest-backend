---
project: EVEREST Backend
current_milestone: M06 follow-up (re-enrollment and enrollment API improvements)
status: awaiting_review
branch: feat/enrollment-reinstate
base_commit: 14217ba
updated_at: 2026-11-01
---

# Current handoff

## State

- PR #28 (group API improvements) is merged into `main`.
- Enrollment improvements are on `feat/enrollment-reinstate`; the PR is open for review and must not be merged by the agent.

## Completed work

- Re-enrollment after revoke (`POST /admin/courses/:courseId/enrollments`) and revoked module-grant reinstatement already existed since M06; now explicitly tested. Module grants stay revoked after enrollment reinstatement. Audit codes remain `course.enrollment.regranted` / `course.module_access.regranted`.
- `GET /admin/courses/:courseId/enrollments`: items carry `user.phone` (primary E.164, as in `GET /admin/users`).
- `GET /admin/users?notEnrolledInCourse=:courseId`: excludes non-revoked enrollments; malformed id returns `400 VALIDATION_ERROR`.
- Docs: OpenAPI, `api.md`, `frontend-handoff.md`, `decisions.md`, `progress.md`, `ROADMAP.md`.

## Verification (2026-11-01)

- `npm test` (disposable database): 245 tests, 244 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). Includes `tests/integration/enrollment-reinstate.test.js` (5 subtests) and the OpenAPI route test.
- No migration was added.

## Decisions needed

1. Audit code: kept existing `course.enrollment.regranted` rather than the requested `enrollment.reinstated`.
2. `notEnrolledInCourse` also excludes expired (non-revoked) enrollees, matching the `409` on POST.

## Next concrete tasks

1. Review and merge the enrollment PR.
2. Frontend consumes `notEnrolledInCourse` and `user.phone`.
3. Real S3/MinIO verification and the first real book import (M09 runbook).

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 25 applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database; never delete data in `everest_db`.
