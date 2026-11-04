---
project: EVEREST Backend
current_milestone: M10 test authoring and assignment
status: awaiting_review
branch: feat/m10-tests
base_commit: d44821b
updated_at: 2026-11-04
---

# Current handoff

## State

- M10 is on `feat/m10-tests`, with a PR open for review. It must not be merged by the agent.

## Completed work

- 16 endpoints under `/api/v1/admin/tests`, five `tests.*` permissions, migration `20261101010000000_add-test-authoring.js`.
- OpenAPI, `docs/api.md`, `docs/frontend-handoff.md`, decisions, progress and roadmap.
- `seed:demo` creates a published 5-question test assigned to the demo group.

## Verification (2026-11-04)

- `npm test` (disposable database): 260 tests, 259 passed, 0 failed, 1 skipped (real S3 storage, unconfigured).
- `npm run test:migrations` passed. `verify-database.js` valid.

## Not verified

- The API through the frontend, and a seed rerun on a long-lived database.
- `tests.results.read`: seeded, but no endpoint uses it until M11.

## Decisions needed

1. Module grant at test start: tests have no module. Require any current grant in the course, or add `tests.module_id`?
2. Review the deviations in `docs/decisions.md` (2026-11-04), above all the extra `can_assign_tests` rule and the frozen settings of published tests.
3. NCT rules, which stay refused as a mode until decided.

## Next concrete tasks

1. Review and merge the M10 PR.
2. M11: attempts, autosave and grading. Refuse a start on a test that is not published, and check each group student's access at start.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database; never delete data in `everest_db`.
