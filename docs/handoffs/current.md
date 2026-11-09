---
project: EVEREST Backend
current_milestone: M11 follow-up (NCT trainer)
status: awaiting_review
branch: feat/nct-trainer
base_commit: ff539b9
updated_at: 2026-11-10
---

# Current handoff

## Done

- NCT trainer on the M11 engine: `GET /trainer/catalog`, `POST /trainer/attempts`, `GET /trainer/attempts`. Answers, submit and result use the `/tests/attempts` routes. A training is a generated test (`tests.origin = 'trainer'`) + one-student assignment + attempt in one transaction.
- Migration `20261110010000000_add-nct-trainer`. Config `TRAINER_*` in `env.js`.
- `correct` on reviewed questions of every attempt result.
- Authored-test queries (admin tests, lesson links, grants, staff results, course assignment lists) filter `origin = 'authored'`.
- Docs: frontend-handoff "NCT trainer", api, decisions, architecture, progress, ROADMAP (M11 note).

## Verification (2026-11-10)

- `npm run test:auth` on a disposable database: exit 0; 392 tests, 392 passed, 0 failed, 0 skipped.
- `test:migrations` (35/35/34/35), `test:sources`, `test:integrity`, `test:server`: exit 0.
- `everest_db` only read; no migration run on it.

## Not verified

- Routes over HTTP with cookies/CSRF (services tested directly; route list checked by the OpenAPI test).
- Real S3/MinIO signing (memory storage provider).
- On `everest_db`: only Biology (course 449) has a course with a subject, so other subjects are locked until a course with that `subject_id` exists and students are enrolled.

## Next concrete task

1. Review `feat/nct-trainer`; confirm or change the access rule (enrollment in a course of the subject).
2. Staff view of trainer results; optional daily limit; topics in the catalog.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
