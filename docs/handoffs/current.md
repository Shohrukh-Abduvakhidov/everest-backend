---
project: EVEREST Backend
current_milestone: M09 follow-up (answer keys from a sidecar file)
status: awaiting_review
branch: feat/import-answer-keys
base_commit: cf8a6a6
updated_at: 2026-11-08
---

# Current handoff

## Done

- `npm run import:answer-keys` attaches `proposed` keys from an `everest.answer-key-import.v1` file to imported draft questions. It works through `replaceAnswerKeyService`, and `--set-matching-rules` works through `updateQuestionService`. It never verifies, publishes or overwrites another proposed key.
- No migration: runs are stored in `question_imports` / `question_import_errors`.
- Docs: runbook §6, contract §11, decisions (2026-11-08), api (answer-key runs in the import API), architecture, ROADMAP M09 follow-up.

## Verification (2026-11-08)

- `npm test` on a fresh migrated disposable database: exit 0; 359 tests, 358 passed, 0 failed, 1 skipped (real S3).
- No migration, so `test:migrations` was not run and `verify-database.js` was not changed.
- `everest_db`: one read-only query only. Bank `nct-tg-2026` is not imported there.

## Not verified

- The real run on the Tajik bank with `import-packages/answer-keys-nct-tg-2026.json` (972 records). Its stored matching settings were not read, because the bank does not exist locally yet.
- Run time for 972 records (planning plus per-record service calls). Expected seconds to tens of seconds; not measured.

## Next concrete task

1. Review and merge `feat/import-answer-keys`.
2. Locally: `npm run import:questions` for the Tajik package (if not done), then the answer-key dry run and real run (runbook §6).
3. A reviewer verifies keys; then publication.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/` (book content, key PDF, key JSON, reports).
