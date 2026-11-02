---
project: EVEREST Backend
current_milestone: Development seed script
status: awaiting_review
branch: feat/dev-seed
base_commit: 7449006
updated_at: 2026-11-02
---

# Current handoff

## State

- PR #29 (enrollment improvements) is merged into `main`.
- The development seed is on `feat/dev-seed`; the PR is open for review and must not be merged by the agent.

## Completed work

- `npm run seed:demo` (`scripts/seed-demo.js`): 8 active demo accounts (`+992900000001` owner, `02` admin, `03` teacher, `04` to `08` students) and demo content through the existing services (2 subjects; a published course with 2 modules and 6 text lessons; a draft course; a group with 3 students, the teacher and 2 announcements; a question bank with 5 published questions, one per type; 2 enrollments with module grants).
- Guards: refuses `NODE_ENV=production`, and a `DB_NAME` without `dev`, `test` or `demo` unless `--force`. Reruns skip what exists.
- Docs: `docs/frontend-handoff.md` §5.3 (how to recreate a disposable database and seed it), `decisions.md`, `progress.md`.

## Verification (2026-11-02)

- `npm test` (disposable database): 248 tests, 247 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). Includes `tests/integration/seed-demo.test.js`, which runs the seed twice in its own database and compares counts.
- No migration was added.

## Not verified

- A run against a long-lived local development database, and the seeded data through the HTTP API and the frontend.
- The path where an owner other than the demo owner already exists (implemented, not tested).

## Decisions needed

1. Passwords: a random password is printed once when none is supplied. A fixed default would be easier to remember but would be committed to the repository.

## Next concrete tasks

1. Review and merge the seed PR.
2. Frontend uses the seeded accounts for local development.
3. Real S3/MinIO verification and the first real book import (M09 runbook).

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database; never delete data in `everest_db`.
