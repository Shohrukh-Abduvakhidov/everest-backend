---
project: EVEREST Backend
current_milestone: M09 follow-up (bulk verify and publish)
status: awaiting_review
branch: feat/bulk-verify-publish
base_commit: 359d98d
updated_at: 2026-11-08
---

# Current handoff

## Done

- `npm run verify:keys` moves `proposed` keys of one bank's drafts to `verified` through `verifyAnswerKeyService` (the admin "verify" button), with `--exclude`, `--only-source`, `--dry-run`, `--report`, `--batch-size`.
- `npm run publish:questions` publishes verified drafts through `publishQuestionService`; refused questions are reported with a reason code (`INTERACTION_SETTINGS_INCOMPLETE`, …) and stay draft.
- The verify/publish checks are shared functions in `question-bank-service` (`answerKeyVerificationBlocker`, `questionPublicationBlocker`); the HTTP endpoints behave as before.
- Actor: active, `questions.review` (owner/admin). Audit carries `{ origin: 'bulk', runId, keySource }`; nothing is written when nothing changes.
- No migration, no new SQL. Docs: runbook §7, decisions, api (also fixed the missing `INTERACTION_SETTINGS_INCOMPLETE` in the publish reasons), architecture, progress, ROADMAP.

## Verification (2026-11-08)

- `npm test` on a fresh migrated disposable database: exit 0; 371 tests, 371 passed, 0 failed, 0 skipped.
- New: `tests/integration/question-bulk-review.test.js` (6 subtests), `tests/unit/question-bulk-review.test.js` (5 tests).
- `everest_db` was not touched.

## Not verified

- The real run on `nct-tg-2026` (972 drafts). Run time not measured.
- How many Tajik matching questions will be `NOT_PUBLISHABLE` until their rules are set.

## Next concrete task

1. Review and merge `feat/bulk-verify-publish`.
2. Locally: `verify:keys --dry-run`, read the report, prepare the `--exclude` file, real run; then `publish:questions --dry-run` and the real run (runbook §7).
3. Resolve `NOT_PUBLISHABLE` matching questions (rules), then verify and publish them again.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/` (book content, key PDF, key JSON, reports).
