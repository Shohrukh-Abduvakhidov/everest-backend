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
- Questions with `answerKey.status = proposed` still need `POST /admin/questions/:id/answer-key/verify` by a reviewer before they can be published (in bulk: section 7).
- `counters.duplicates.suggested` counts possible duplicates recorded in `question_duplicate_links`. They are suggestions only; nothing was merged.

## 6. Answer keys from a sidecar file

A book package may come without keys (the Tajik package `everest-tajik-indexed-v1` has none). The official keys can then be attached later from a sidecar JSON file (`everest.answer-key-import.v1`, format: `docs/import-contract.md` §11). The package itself stays unchanged.

- **Before you start:**
   - import the questions first (`npm run import:questions`, sections 1–2);
   - put the key file under `import-packages/` (git-ignored). Never commit the key PDF or the JSON;
   - the actor rule is the same as for `import:questions`: an active account with `questions.manage` that owns the bank, or an owner/admin.
- **What it does:**
   - sets `proposed` keys on draft questions through the same service as `PUT /admin/questions/:id/answer-key` (validation, draft-only rule, audit);
   - never verifies, never publishes, never overwrites a different proposed key;
   - with `--set-matching-rules`, also sets `null` matching rules that the keys support (below).

### 6.1 Dry run

```bash
npm run import:answer-keys -- --keys import-packages/answer-keys-nct-tg-2026.json --actor-phone +992XXXXXXXXX --bank nct-tg-2026 --dry-run --report import-packages/tajik-keys.dry-run.json
```

- It validates the whole file, then classifies every record against the stored questions. It writes nothing.
- stdout prints counts and codes only: `counters.outcomes`, `counters.matchingRules`, `topOutcomeCodes` and the first 20 file errors.
- `--report` writes the full per-record list (`outcomes`, `matchingRules`). It includes **both keys** of each `KEY_CONFLICT`, so keep it in `import-packages/`, never in git.
- Exit code `0` = valid, `2` = file rejected, `1` = could not run.

### 6.2 Real run

```bash
npm run import:answer-keys -- --keys import-packages/answer-keys-nct-tg-2026.json --actor-phone +992XXXXXXXXX --bank nct-tg-2026 --report import-packages/tajik-keys.run.json
```

- The default idempotency key is `answer-keys-<sha256 of the file>`; with `--set-matching-rules` it is `answer-keys-<sha256>-matching-rules`.
- Each batch of up to 100 records (`--batch-size 1-100`) is one transaction. A failing batch rolls back, is reported as an `error`, and later batches are not attempted (`status: failed`).
- The run is stored in `question_imports` with the file sha256 and `keySource`. You can read it with the import API (section 4).

### 6.3 Matching rules (`--set-matching-rules`)

Publication of a matching question needs both `requireAllLeft` and `allowRightReuse` to be booleans. Books often state neither, so they are imported as `null`. The flag (alias `--set-allow-right-reuse-false`) is off by default. It touches only draft matching questions whose key was `APPLIED` or `UNCHANGED` in this run, and decides each field independently:

| Stored value | The key | Result | Counter |
|---|---|---|---|
| `requireAllLeft` is `null` | pairs every left item | set `true` | `requireAllLeft.set` |
| `requireAllLeft` is `null` | misses a left item | stays `null` | `requireAllLeft.skippedNotCovered` (`REQUIRE_ALL_LEFT_SKIPPED_NOT_COVERED`) |
| `allowRightReuse` is `null` | uses distinct right items | set `false` (never `true`) | `allowRightReuse.set` |
| `allowRightReuse` is `null` | reuses a right item | stays `null` | `allowRightReuse.skippedNotDistinct` (`RIGHT_REUSE_SKIPPED_NOT_DISTINCT`) |
| a boolean | — | never changed | `….skippedAlreadySet` |

- `stillNull` per field and `publishableBySettings` (both booleans) count every draft matching question of the bank after the run. In a dry run they are projected.
- The change goes through the normal draft edit (`question.updated` audit with `fields: ['interactionSettings']`). Only these two settings change.

```bash
npm run import:answer-keys -- --keys import-packages/answer-keys-nct-tg-2026.json --actor-phone +992XXXXXXXXX --bank nct-tg-2026 --set-matching-rules --dry-run
npm run import:answer-keys -- --keys import-packages/answer-keys-nct-tg-2026.json --actor-phone +992XXXXXXXXX --bank nct-tg-2026 --set-matching-rules --report import-packages/tajik-keys.rules.json
```

### 6.4 Re-run

| Situation | Result |
|---|---|
| Same file, same key | the stored run is returned (`"replayed": true`), nothing is written |
| Same key, other file | `IMPORT_IDEMPOTENCY_CONFLICT`; use a new `--idempotency-key` |
| After a `failed` run | replaying the same key returns the failed run; re-run with a **new** `--idempotency-key`. Keys already set report `UNCHANGED`. |
| Same file with `--set-matching-rules` after a plain run | a separate run (different default key): keys report `UNCHANGED`, rules are set |

### 6.5 Outcome codes

| Code | Meaning | Action |
|---|---|---|
| `APPLIED` | draft with an `unknown` key → `proposed` with the file's source and answer | a reviewer verifies it (`POST /admin/questions/:id/answer-key/verify`) |
| `UNCHANGED` | the same proposed key and source are already stored | none |
| `KEY_CONFLICT` | another proposed key, or another source, is stored; it was **kept** | compare `stored` and `file` in the `--report` file, then fix it with `PUT /admin/questions/:id/answer-key` |
| `KEY_VERIFIED_SKIPPED` | a verified key is stored; it is never changed | none |
| `QUESTION_NOT_DRAFT` | the question is published or archived | correct it via a copy if needed |
| `QUESTION_NOT_FOUND` | no question with this `questionExternalId` in the bank | check the ID, or import the question first |
| `ANSWER_KEY_INVALID` | the answer does not fit the question's option/item keys or type (unknown key, wrong pair keys, reused right item while the rule is not `true`, a left item twice, numeric tolerance) | fix the record |
| `NO_KEY_FOR_QUESTION` | a question of the bank has no record in the file; it was not changed | none, or add a record |

File errors (nothing is written): `KEY_FILE_SCHEMA_VERSION_UNSUPPORTED`, `KEY_FILE_FIELD_UNKNOWN`, `KEY_FILE_HEADER_INVALID`, `KEY_FILE_BANK_MISMATCH` (`--bank` ≠ `bankCode`), `KEY_FILE_SCHEMA_INVALID`, `KEY_RECORD_BANK_MISMATCH`, `KEY_RECORD_EXTERNAL_ID_INVALID`, `KEY_RECORD_DUPLICATE`, `ANSWER_KEY_STATUS_INVALID`, `ANSWER_KEY_VERIFIED_REJECTED`, `ANSWER_KEY_SOURCE_REJECTED` (`ai_inference` or anything other than `official_key`/`expert_review`), `ANSWER_DATA_REQUIRED`, `EXPLANATION_INVALID`, `QUESTION_BANK_NOT_FOUND`, `QUESTION_BANK_READ_ONLY`.

## 7. After the keys: verify, then publish

Run these after section 6, in this order. Both use the same services and checks as the admin buttons (`POST /admin/questions/:id/answer-key/verify` and `POST /admin/questions/:id/publish`); they write no SQL of their own.

- **Actor:** an active account with `questions.review` (owner/admin), found by phone. A teacher is refused (`BULK_ACTOR_FORBIDDEN`), a blocked account too (`BULK_ACTOR_INACTIVE`).
- **Scope:** one bank (`--bank`). Other banks are not touched.
- **Batches:** up to 100 questions per transaction (`--batch-size 1-100`). A database error rolls the batch back (its questions report `FAILED` / `BATCH_ROLLED_BACK`), later batches are not attempted (`counters.notAttempted`) and the exit code is `1`. Re-running is safe.
- **Output:** stdout prints counts and codes only. `--report` writes `entries`: `{ externalId, questionId, outcome, reason? }` per question. No question text, no key values.
- **Dry run:** `--dry-run` classifies every question and writes nothing; the codes then mean "would" (`VERIFIED` = would be verified).

### 7.1 Verify keys

Optional: list the questions that need a manual check in a JSON file (`["q-12", "q-40"]` or `{ "externalIds": [...] }`) and pass it as `--exclude`. IDs that are not in the bank are listed in `exclude.notFoundInBank`.

```bash
npm run verify:keys -- --bank nct-tg-2026 --actor-phone +992XXXXXXXXX --only-source official_key --exclude import-packages/manual-check.json --dry-run --report import-packages/tajik-verify.dry-run.json
npm run verify:keys -- --bank nct-tg-2026 --actor-phone +992XXXXXXXXX --only-source official_key --exclude import-packages/manual-check.json --report import-packages/tajik-verify.run.json
```

| Outcome | Meaning |
|---|---|
| `VERIFIED` | proposed → verified; the verification source is the key's proposed source |
| `SKIPPED_EXCLUDED` | listed in `--exclude` |
| `SKIPPED_NOT_DRAFT` | published or archived |
| `SKIPPED_NOT_PROPOSED` | no key, `unknown`, or already `verified` (never touched) |
| `SKIPPED_SOURCE_FILTERED` | the key's source differs from `--only-source` |
| `SKIPPED_SOURCE_NOT_VERIFIABLE` | an `ai_inference` proposal; a reviewer chooses the source in the admin UI |
| `FAILED` | refused by the verify check (`reason`, e.g. `ANSWER_KEY_INVALID`), or `BATCH_ROLLED_BACK` |

Audit: one `question.answer_key.verified` event per verified question with `{ origin: 'bulk', runId, keySource, source }`, plus `question_bulk_verify.started` / `.completed` on the bank. A run that verifies nothing writes no audit, so a repeated run adds nothing.

### 7.2 Publish

```bash
npm run publish:questions -- --bank nct-tg-2026 --actor-phone +992XXXXXXXXX --dry-run --report import-packages/tajik-publish.dry-run.json
npm run publish:questions -- --bank nct-tg-2026 --actor-phone +992XXXXXXXXX --report import-packages/tajik-publish.run.json
```

| Outcome | Meaning |
|---|---|
| `PUBLISHED` | draft → published |
| `SKIPPED_NOT_DRAFT` | already published or archived; not touched |
| `SKIPPED_KEY_NOT_VERIFIED` | the key is not verified yet (run 7.1, or verify by hand) |
| `NOT_PUBLISHABLE` | the publish check refused it; `reason` is `INTERACTION_SETTINGS_INCOMPLETE` (matching without `requireAllLeft`/`allowRightReuse`), `ANSWER_KEY_INVALID` or `ASSET_NOT_READY`. Counted in `counters.reasons`. |
| `FAILED` | `BATCH_ROLLED_BACK` or another refusal |

For `NOT_PUBLISHABLE` matching questions: set the rules (section 6.3 or the admin edit). That returns a verified key to proposed, so run 7.1 and 7.2 again.

## HTTP upload

The same importer is reachable over HTTP; see "Package upload (HTTP)" in `docs/api.md`. Run the worker with `npm run worker:imports` on the host that serves the API, because packages wait on its local disk (`QUESTION_IMPORT_UPLOAD_DIR`, default `uploads/question-imports`). Use the CLI for packages above the upload limit. `--apply-matching-defaults` sets missing matching rules explicitly; each affected question gets a warning.
