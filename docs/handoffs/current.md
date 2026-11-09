---
project: EVEREST Backend
current_milestone: M11 follow-up (NCT trainer access and /nct overview)
status: awaiting_review
branch: feat/nct-trainer-access-overview
base_commit: 31be1f5
updated_at: 2026-11-11
---

# Current handoff

## Done

- Trainer access without courses: an active account (`403 ACCOUNT_NOT_ACTIVE`) and the permission `trainer.use`, granted to students (`403 TRAINER_STUDENT_ROLE_REQUIRED`). `accessible` and `TRAINER_ACCESS_DENIED` are removed.
- Migration `20261111010000000_trainer-access-without-course`: `tests.course_id` is nullable only for `origin = 'trainer'`; adds the `trainer.use` permission for `student`.
- Attempt engine: `requireContentAccess` checks only the account for trainer attempts.
- `GET /trainer/overview` (readiness, subjects, weak topics, recent results, `empty`). The catalog gained `topics[]`. Four new `TRAINER_*` settings.
- Docs: frontend-handoff, api, decisions, architecture, progress, ROADMAP.

## Verification (2026-11-11)

- `npm run test:auth` on a disposable database: exit 0; 396 tests, 396 passed, 0 failed, 0 skipped.
- `test:migrations` (36/36/35/36), `test:sources`, `test:integrity`, `test:server`: exit 0.
- Nothing was run on `everest_db`.

## Not verified

- HTTP routes with cookies and CSRF (services were called directly).
- Overview speed on large histories: the queries aggregate all finished trainings of one student, and there is no dedicated index beyond the trainer test index.

## Next concrete task

1. Review `feat/nct-trainer-access-overview`; run `npm run migrate:up` on `everest_db` after the merge.
2. Separate tasks: mock NCT exam, staff view of trainer results, limits.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
