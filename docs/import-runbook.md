# Question import runbook (M09)

This runbook covers importing an `everest.question-import.v1` book package (the ZIP produced by the indexing pipeline: `manifest.json` + `data/*.json` + `assets/`; format and mapping: `docs/import-contract.md` §9) into the question bank. Pass the ZIP itself; there is no need to unzip it. The package's own `scripts/validate_package.py` is never executed by the importer. Imports create **draft** questions only. Review, key verification and publication stay manual in the admin API.

## Before you start

- **Where to keep packages.** Put real packages under `import-packages/`. That folder is git-ignored: book content and images are copyrighted, so never commit them.
- **The actor.** You need an existing **active** account with `questions.manage`.
   - Owner/admin accounts may also create subjects, sections and topics.
   - Teachers can import only into existing taxonomy and into their own banks.
- **Storage.** A package with images needs S3/MinIO configured (`S3_*` in `.env`), otherwise the run stops with `STORAGE_NOT_CONFIGURED` before writing anything. A dry run never needs storage.
- **Migrations.** Run `npm run migrate:up` once after pulling M09.

## 1. Dry run (always first)

```bash
npm run import:questions -- --package import-packages/everest-tajik-indexed-v1.zip --actor-phone +992XXXXXXXXX --dry-run --report import-packages/tajik.dry-run.json
```

- The dry run validates everything:
   - the manifest schema;
   - rich content and the answer data of each question type;
   - taxonomy and topic references;
   - asset files, types and hashes;
   - duplicate `externalId` values;
   - permissions.
- It writes **nothing** to the database or storage.
- stdout prints a summary: planned `counters`, `topErrorCodes`, `topWarningCodes` and the first 20 errors with their `path`. `--report` writes the full list of errors and warnings to a file. Keep that file out of git, because messages may contain identifiers from the book.
- Exit code `0` = valid, `2` = invalid, `1` = could not run (bad arguments, unknown actor, unreadable package).

Fix the package until the dry run reports `"status": "valid"`. Warnings do not block a run, but read them: they list everything that was mapped lossily or not stored.

| Warning | Meaning | Action |
|---|---|---|
| `CONTENT_INLINE_MARKS_FLATTENED` | a paragraph had mixed bold/italic/underline spans; only the marks shared by the whole paragraph are kept | check the question during review if emphasis matters |
| `MATCHING_RULE_UNSPECIFIED` | the book does not say whether right items may be reused (`null` stored) | a reviewer sets `interactionSettings` before publication (publication is blocked until then) |
| `SOURCE_FIELD_DROPPED` | a package field has no database column (bbox, positions, …); one entry per field | none; the package keeps it |
| `SOURCE_REVIEW_NOTES_PRESENT` | the package lists transcription issues or review flags for the question | check `reports/review_required.json` in the package |
| `IMAGE_BLOCK_APPENDED` | an image linked in `question_assets` had no image block; it was appended to the question content | check its position during review |
| `QUESTION_TYPE_MAPPED` / `INTERACTION_SETTINGS_DROPPED` | an `open` question was imported as `short_text`/`numeric`; its input-cell settings are not stored | review the grading rule later (M10/M11) |
| `MATCHING_COLUMN_HEADERS_AS_TABLE` | matching column headers were stored as a one-row table | none |
| `PACKAGE_NOT_READY_FOR_IMPORT` / `PACKAGE_EXTRACTION_INCOMPLETE` | the package itself says it is a pilot or partial | import only if a draft review of a partial book is intended |

## 2. Real run

```bash
npm run import:questions -- --package import-packages/everest-tajik-indexed-v1.zip --actor-phone +992XXXXXXXXX --idempotency-key tajik-2026-11-01
```

- `--idempotency-key` is optional. The default is `package-<sha256 of the package>`.
- `--batch-size` is optional: 1–100, default 100. Each batch is one transaction.
- **Result:** `status` is one of:
   - `completed`;
   - `failed`: a batch was rolled back; earlier batches stay committed and later ones were not attempted;
   - `rejected`: validation errors; nothing was written.
- The summary includes `runId`.

## 3. Re-run

| Situation | What to do | Result |
|---|---|---|
| Same package, same key | run again unchanged | the earlier result is returned (`"replayed": true`), nothing is written |
| Same key, changed package | — | `IMPORT_IDEMPOTENCY_CONFLICT`; use a new key |
| After a `failed` run, or a corrected package | run with a **new** key | drafts are updated in place by `externalId`, missing ones are created, nothing is duplicated |
| Question already published or archived | — | skipped with warning `QUESTION_IMMUTABLE_SKIPPED`; correct it with `POST /admin/questions/:id/copy` |

Re-runs reuse images through `asset_aliases` (`counters.assets.reusedByAlias`). The same bytes from another package are reused by sha256 (`reusedByHash`).

## 4. Read the errors

- **CLI:** the summary and the `--report` file.
- **API** (owner/admin, the bank owner, or the actor who ran the import):
   - `GET /api/v1/admin/question-imports?bankId=<id>` lists runs;
   - `GET /api/v1/admin/question-imports/<runId>` returns one run with its counters;
   - `GET /api/v1/admin/question-imports/<runId>/errors?severity=error&limit=50&offset=0` pages through its errors and warnings.

Common codes:

| Code | Meaning / fix |
|---|---|
| `QUESTION_EXTERNAL_ID_REQUIRED` / `_DUPLICATE` | every question needs a unique `externalId` |
| `VALIDATION_ERROR` (path `…content`, `…options`) | content or structure breaks the M08 rules (unknown block or field, empty text, wrong item count) |
| `ANSWER_KEY_INVALID` | `answerData` does not match the question's keys or type |
| `ANSWER_KEY_VERIFIED_REJECTED` | packages cannot carry `verified`; use `proposed` with a `source` |
| `OPTION_IS_CORRECT_REJECTED` | move correctness into `answerKey` |
| `REFERENCE_UNKNOWN` | a topic, section, subject or asset code is not declared and not in the database |
| `TAXONOMY_PERMISSION_REQUIRED` | taxonomy is missing and the actor is not owner/admin |
| `QUESTION_BANK_READ_ONLY` | the bank code belongs to another user |
| `ASSET_FILE_MISSING` / `ASSET_TYPE_INVALID` / `ASSET_HASH_MISMATCH` / `ASSET_TOO_LARGE` | fix the file entry (PNG/JPEG only, ≤10 MiB) |
| `ASSET_ALIAS_CONFLICT` | the same package asset ID was imported earlier with different bytes; give the new image a new `id` |
| `PACKAGE_FILE_HASH_MISMATCH` / `PACKAGE_FILE_MISSING` | a `data/*.json` file differs from `manifest.files`; rebuild or re-download the package |
| `PACKAGE_BANK_COUNT_UNSUPPORTED` | a package must contain exactly one `question_banks` record |
| `IMPORT_BATCH_FAILED` | a batch hit a database error; see `recordPath` (`questions[a..b]`) and `externalId`, fix, then re-run with a new key |

## 4a. Tests and local data

`npm test` runs the integration suite in a temporary database (`everest_test_<random>`). The suite creates, migrates and drops that database itself, so your local `everest_db` data is never read or changed. Running a single test file directly (`node --test tests/integration/…`) still uses `DB_NAME` from `.env`.

## 5. After the import

- Review the drafts in the admin API.
- Questions with `answerKey.status = proposed` still need `POST /admin/questions/:id/answer-key/verify` by a reviewer before they can be published.
- `counters.duplicates.suggested` counts possible duplicates recorded in `question_duplicate_links`. They are suggestions only; nothing was merged.
