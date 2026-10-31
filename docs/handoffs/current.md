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

## Follow-up (2026-10-31): real package format and isolated tests

- `src/utils/question-package-adapter.js` reads the real entity-file packages and maps them to the importer model. Every dropped field and lossy mapping is a run-report warning (contract §9).
- **Shared rules:**
   - `source_metadata` now holds the real provenance fields;
   - matching rules may be `null` in drafts;
   - publication is blocked by `INTERACTION_SETTINGS_INCOMPLETE`.
- **Real packages** (`import-packages/`, git-ignored):
   - Tajik dry run: valid, 972 questions, 773 warnings, 0 errors;
   - biology pilot dry run: valid, 20 questions, 51 warnings, 0 errors;
   - both import fully into a disposable database.
- **Tests:** `npm test` runs in a disposable database (`scripts/test-disposable-database.js`): 220 tests, 219 passed, 1 skipped.

## Completed work (M09)

- **CLI:** `npm run import:questions -- --package <dir|zip> --actor-phone +992… [--dry-run] [--idempotency-key k] [--batch-size n] [--report file]` (`scripts/import-question-package.js`).
- **Service:** `src/services/question-import-service.js`. It runs one planner (dry run = report only), then a real run: content-addressed image upload → setup transaction (taxonomy, bank, run, assets/aliases, warnings) → batch transactions of ≤100 questions → finish.
- **Repositories:** `src/repositories/question-import-repository.js` (new); `taxonomy-repository` (`findEntityByCode`, `upsertTranslations`); `question-bank-repository.createQuestion` (`import_id`).
- **Utilities:** `utils/question-package.js`, `utils/zip-reader.js`, `utils/question-package-adapter.js`; `question-content.js` extends the `source_metadata` allowlist with book provenance fields and allows `null` matching rules in drafts.
- **Storage:** `uploadObject` on `providers/storage/s3-storage-provider.js` and on the memory double.
- **Read API:** `GET /api/v1/admin/question-imports`, `/:importId` and `/:importId/errors`, with `readQuestionImportsAuthorizationMiddleware` (manage or review). Documented in the OpenAPI spec and `docs/api.md`.
- **Migration:** `20261031030000000_add-question-import-support.js` (partial unique `assets_sha256_key`; `question_import_errors (import_id, id)`). It is applied to `everest_db`.
- **Docs:** `import-contract.md` (§9 format, §10 gap status), `import-runbook.md` (new), `decisions.md` (M09 with 18 assumptions), `api.md`, `architecture.md`, `progress.md`, `ROADMAP.md`.

## Verification (2026-10-31)

- `node --test tests/integration/question-import.test.js`: 17/17 passed.
- `npm test` (disposable database): 220 tests, 219 passed, 0 failed, 1 skipped (real storage).
- `npm run test:migrations`: 25/25/24/25. No migration was added in the follow-up.
- `node scripts/verify-database.js`: valid (312 indexes, 25 migrations).
- Real-package dry runs and full disposable-database imports: see `docs/progress.md` (M09 follow-up).
- **Not verified:** real MinIO/S3 import, very large packages.

## Next concrete tasks

1. Configure S3/MinIO, then run the real Tajik import against `everest_db` (`docs/import-runbook.md` §2).
2. Reviewers set `allowRightReuse` for the 183 matching questions before any publication.
3. Later milestones:
   - an HTTP bank-bound image upload and a duplicate-link review API for the admin UI;
   - real-storage verification once Docker or MinIO is available.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 25 applied migrations. Never merge, force-push, or push to `main`.
- Never commit real packages, book pages or images. `import-packages/` is git-ignored.
- When editing docs with scripts, do not pass literal text as a `String.replace` replacement (`$` patterns); use the Edit tool or a replacer function.
