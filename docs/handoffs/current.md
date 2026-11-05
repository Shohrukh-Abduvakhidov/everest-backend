---
project: EVEREST Backend
current_milestone: M10 merged; demo content for manual testing
status: awaiting_review
branch: feat/demo-content
base_commit: 3ec9112
updated_at: 2026-11-05
---

# Current handoff

## State

- M10 (test authoring and assignment, PR #31) is merged into `main`.
- `feat/demo-content` extends `npm run seed:demo` with rich demo content. A PR is open for review; the agent must not merge it.

## Completed work

- `scripts/seed-demo-content.js` plus `scripts/seed-demo-data/`: 5 subjects with sections and 50 topics; 4 new published courses (Russian text, Tajik title translations; a draft and an archived module; draft video lessons); 5 question banks (145 published, 25 draft, 15 archived questions); 4 published, 1 draft and 1 archived test with group and student assignments in open, upcoming and closed windows; groups B and archived C with announcements; enrollments and module grants in every state; 18 more accounts (teachers, students, pending, blocked, rejected).
- Services and repositories only; no SQL, no migration. Safety guards and idempotency are kept; the original English demo content is kept.
- `docs/frontend-handoff.md` §5.3, `docs/progress.md` and `docs/decisions.md` (2026-11-05).

## Verification (2026-11-05)

- `tests/integration/seed-demo.test.js`: two seed runs on a disposable database, counts per entity and per access state compared, guards (production, database name) checked. Passed.
- Full suite: `npm run test:auth` and `npm run test:server` (disposable database): 260 tests, 259 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). `test:integrity` passed against a migrated disposable database.
- `npm test` as one command **stopped at `test:integrity`** because that script uses the configured local database, which lacks the M10 column `tests.course_id` (`migrate:up` was deliberately not run on it). This is environmental and not caused by the seed.

## Not verified

- The seeded data through the HTTP API and the frontend (learner screens, windows as a student sees them).
- A rerun against a long-lived database that already has the older English seed.
- The Tajik wording by a native reviewer.

## Decisions needed

1. Keep the old English demo content next to the new one, or remove it in a follow-up (see `docs/decisions.md`, 2026-11-05)?
2. Module grant at test start (open since M10): require any current grant in the course, or add `tests.module_id`?
3. NCT rules, which stay refused as a mode until decided.

## Next concrete tasks

1. Review and merge the demo-content PR.
2. M11: attempts, autosave and grading. Refuse a start on a test that is not published, and check each group student's access at start.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database except `test:integrity`, which uses the configured database; never delete data in `everest_db`.
