---
project: EVEREST Backend
current_milestone: M11 follow-up (NCT mock exam)
status: awaiting_review
branch: feat/nct-mock-exam
base_commit: cfaa312
updated_at: 2026-11-13
---

# Current handoff

## Done

- NCT mock exam, separate from the trainer: `GET /trainer/exams/blueprints`, `POST /trainer/exams`, `GET /trainer/exams`, `GET /trainer/exams/:attemptId`, `PUT .../answers/:attemptQuestionId`, `PUT .../questions/:attemptQuestionId/flag`, `POST .../submit`, `GET .../result`. Access: active account plus `trainer.use`.
- Migration `20261113010000000_add-nct-mock-exam`: origin `mock_exam` (no course), tables `exam_blueprints`, `exam_blueprint_sections`, `exam_blueprint_items`, `mock_exam_items`, seed `nct-a5` (105 questions, 220 minutes, 40 per subject, 160 in total).
- Engine (additive): account-only access for `mock_exam`; cells questions get `answerFormat: 'digits'` in the grading snapshot (`{ digits }` of 1–4 digits, 2/0 points, leading zeros ignored).
- Docs: frontend-handoff "NCT mock exam", api, decisions, architecture, progress, ROADMAP.

## Verification (2026-11-13)

- Full suite on a disposable database, skipping only the live S3 round trip: exit 0; 415 tests, 415 passed, 0 failed.
- `test:migrations` (38/38/37/38), `test:sources`, `test:integrity`, `test:server`: exit 0.
- `everest_db`: only read-only counts. `test:integrity` runs inside `BEGIN … ROLLBACK` there, as `npm test` always does.

## Not verified

- HTTP routes with cookies and CSRF (services were called directly).
- Assembly time on `everest_db` volumes.

## Known issue (environment, not this branch)

- S3 storage is configured and reachable here, so `real-storage.test.js` runs. It passes, but the test process then never exits, and plain `npm run test:auth` hangs after its last result. Leftover disposable databases from killed runs: `everest_test_37cf6a4cfb11`, `everest_test_5c106eaff141` (safe to drop).

## Next concrete task

1. Review the PR for `feat/nct-mock-exam`; after the merge run `npm run migrate:up` on `everest_db`.
2. Owner decisions: per-position difficulty distribution for `nct-a5` (now easy to hard within each range, no bounds); leading zeros in cells (now ignored).
3. Make the live S3 test close its client so `npm test` exits.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
