---
project: EVEREST Backend
current_milestone: M09
status: awaiting_review
branch: feat/m09-book-import
base_commit: b079fd4
updated_at: 2026-10-31
---

# Current handoff

## State

- M-DOCS (PR #22) and the import contract (PR #23) are merged.
- M09 (indexed book import) is implemented on `feat/m09-book-import`. The PR is open for review and must not be merged by the agent.

## Completed work (M09)

- **CLI:** `npm run import:questions -- --package <dir|zip> --actor-phone +992… [--dry-run] [--idempotency-key k] [--batch-size n] [--report file]` (`scripts/import-question-package.js`).
- **Service:** `src/services/question-import-service.js`. It runs one planner (dry run = report only), then a real run: content-addressed image upload → setup transaction (taxonomy, bank, run, assets/aliases, warnings) → batch transactions of ≤100 questions → finish.
- **Repositories:** `src/repositories/question-import-repository.js` (new); `taxonomy-repository` (`findEntityByCode`, `upsertTranslations`); `question-bank-repository.createQuestion` (`import_id`).
- **Utilities:** `utils/question-package.js`, `utils/zip-reader.js`; `question-content.js` adds `chapter`, `variant` and `year` to `source_metadata`.
- **Storage:** `uploadObject` on `providers/storage/s3-storage-provider.js` and on the memory double.
- **Read API:** `GET /api/v1/admin/question-imports`, `/:importId` and `/:importId/errors`, with `readQuestionImportsAuthorizationMiddleware` (manage or review). Documented in the OpenAPI spec and `docs/api.md`.
- **Migration:** `20261031030000000_add-question-import-support.js` (partial unique `assets_sha256_key`; `question_import_errors (import_id, id)`). It is applied to `everest_db`.
- **Docs:** `import-contract.md` (§9 format, §10 gap status), `import-runbook.md` (new), `decisions.md` (M09 with 18 assumptions), `api.md`, `architecture.md`, `progress.md`, `ROADMAP.md`.

## Verification (2026-10-31)

- `node --test tests/integration/question-import.test.js`: 15/15 passed.
- `npm test`: 207 tests, 203 passed, 3 failed, 1 skipped. The 3 failures come from local `everest_db` data, not from M09:
   - an owner account now exists (`account-admin.test.js` requires none);
   - a manual group "Тестовая группа (шапка)" exists (`groups.test.js`).
   The agent did not delete user data.
- `npm run test:migrations`: 25/25/24/25.
- `node scripts/verify-database.js`: valid (312 indexes, 25 migrations).
- A CLI dry run of `tests/fixtures/question-import/sample` with a temporary admin user (deleted afterwards) reported `valid`.
- **Not verified:** real MinIO/S3 import, a real book package (`import-packages/` absent), very large packages.

## Next concrete tasks

1. The user places the Tajik package under `import-packages/` and runs a dry run (`docs/import-runbook.md` §1). Then adjust the field mapping if the real format differs from `import-contract.md` §9.
2. Decide whether the integration tests should tolerate an existing owner or groups, or whether the local `everest_db` test data should be cleaned by the user.
3. Later milestones:
   - an HTTP bank-bound image upload and a duplicate-link review API for the admin UI;
   - real-storage verification once Docker or MinIO is available.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 25 applied migrations. Never merge, force-push, or push to `main`.
- Never commit real packages, book pages or images. `import-packages/` is git-ignored.
- When editing docs with scripts, do not pass literal text as a `String.replace` replacement (`$` patterns); use the Edit tool or a replacer function.
