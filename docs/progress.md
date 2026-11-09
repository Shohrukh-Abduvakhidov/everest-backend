# EVEREST backend progress

Updated: 2026-11-09.

## Current increment

NCT trainer on `feat/nct-trainer` (awaiting review). The Tajik subject merge is merged (PR #45).

## 2026-11-10 — NCT trainer (`feat/nct-trainer`)

- **Routes:** `GET /trainer/catalog`, `POST /trainer/attempts`, `GET /trainer/attempts`. Answering, submit and result use the existing `/tests/attempts` routes. Contract: `docs/frontend-handoff.md` "NCT trainer". Decisions: `docs/decisions.md` (2026-11-10).
- **New:** migration `20261110010000000_add-nct-trainer` (`tests.origin`, trainer indexes), `routes/trainer.js`, `trainer-controller`, `trainer-service`, `trainer-repository`, `TRAINER_*` config in `env.js`. `test-attempt-service` exports `startAttemptInTransactionService`, and reviewed questions gained `correct`. Authored-test queries filter `origin = 'authored'`.
- **Tests:** `tests/integration/nct-trainer.test.js` (9 subtests):
   - share split;
   - catalog counts and access flag;
   - validation, access, unknown subject and shortage codes;
   - mixed 3/4/3 with no keys in the view and signed images;
   - idempotent repeat, reused key, running training, foreign attempt, result before submit;
   - submit grading with `correct`, keys, explanations and images, and a repeated submit;
   - unseen questions first;
   - history and stats, and no trainer tests in admin lists;
   - parallel creates start one training.
   `scripts/test-migration-cycle.js` now expects 35 migrations.
- **Checked:** `npm run test:auth` on a fresh migrated disposable database: exit 0; 392 tests, 392 passed, 0 failed, 0 skipped. `test:migrations`, `test:sources`, `test:integrity` and `test:server` exit 0. `everest_db` was only read (question counts per bank, difficulty and type).
- **Not done:** staff view of trainer results; per-day limits; topic list in the catalog; trainer on HTTP-level tests (services were tested directly, routes are covered by the OpenAPI route test only); real S3 signing.

## 2026-11-09 — Merge of duplicate Tajik subjects (`chore/merge-tajik-subjects`)

- **Problem:** `everest_db` had `zaboni-tochiki` (id 135: 3 translations, color orange, nothing else) and `tajik_language` (id 143, from the `nct-tg-2026` import: 1 bank, 972 published questions, 999 question topics, 7 sections, 5 topics, 1 translation, no courses). Tables that reference subjects: `subject_translations`, `sections`, `topics`, `courses`, `question_banks` (FK) and `questions`, `question_topics` (composite FKs).
- **Migration `20261109010000000_merge-tajik-subjects`:** moves everything from `tajik_language` to `zaboni-tochiki`, copies missing translations, deletes `tajik_language`. Found by code; no-op when either is missing. Checks the question count and leftover `subject_id` references before commit. Details and reasons: `docs/decisions.md` (2026-11-09).
- **Importer:** `tajik_language` is an alias of `zaboni-tochiki` (`SUBJECT_CODE_ALIASED` warning, no subject created, canonical titles untouched). Runbook "Subject codes".
- **Tests:** `tests/integration/merge-tajik-subjects.test.js` (4 subtests: everything moved incl. published questions and guards re-enabled; repeat and missing-subject runs change nothing; code conflict aborts; dry run of a `tajik_language` package creates no subject). `scripts/test-migration-cycle.js` now expects 34 migrations.
- **Checked:** `npm run test:auth` on a fresh migrated disposable database: exit 0; 382 tests, 382 passed, 0 failed, 0 skipped. `test:migrations`, `test:sources`, `test:integrity`: exit 0. Rehearsal on a disposable restore of an `everest_db` dump: after `migrate:up` subject 135 has 972 published questions, 999 question topics, 1 bank, 7 sections, 5 topics, 3 translations; 143 is gone; a second `migrate:up` ran nothing. The rehearsal database was dropped.
- **Not done:** `migrate:up` on `everest_db` itself (by request).

## 2026-11-08 — Dry-run publish of image questions (`fix/publish-dry-run`)

- **Bug:** `npm run publish:questions -- --dry-run` stopped with `BULK_FAILED` "Cannot read properties of undefined (reading 'query')" on a bank with an image question. The dry run checks publication without a transaction, and `findUsableImageAssets` (the `ASSET_NOT_READY` check) required a client. The bug dates from PR #42, not PR #43: the earlier tests had no image questions.
- **Fix:** `findUsableImageAssets(..., db = pool)`, a read-only lookup like `findQuestion`. The real run still passes the transaction client.
- **Other dry runs:** `verify:keys --dry-run` and `import:answer-keys --dry-run` read only through repository methods that default to the pool. The new test covers them too.
- **Test:** new subtest in `tests/integration/question-bulk-review.test.js`: a bank with proposed, ready-image and archived-image questions. The bulk verify, bulk publish and answer-key dry runs (services and the three CLIs) succeed, publish reports `ASSET_NOT_READY`, and nothing is written. Without the fix the subtest fails with the reported error.
- **Checked:** `npm test` on a fresh migrated disposable database: exit 0; 377 tests, 377 passed, 0 failed, 0 skipped.

## 2026-11-08 — Question image URLs (`feat/question-image-urls`, merged as PR #43)

- Image blocks in admin question detail and in learner attempt/result responses carry `url` and `expiresAt` (5 minutes) when the asset is ready and linked to the question. Nothing is stored; no migration.
- **New:** `src/services/question-image-service.js`, repository method `listQuestionImageAssets`, OpenAPI `ImageBlock`. Input parser accepts and drops `url`/`expiresAt` on image blocks.
- **Tests:** `tests/integration/question-image-urls.test.js` (4 subtests: admin signing of stem/option/explanation and nothing stored; unready, unlinked foreign asset and failing storage give no URL; content sent back with URL is stored without it; learner own attempt and result signed, another learner refused).
- **Checked:** `npm test` on a fresh migrated disposable database: exit 0; 376 tests, 376 passed, 0 failed, 0 skipped.
- **Not checked:** real MinIO/S3 signing with `S3_PUBLIC_ENDPOINT` for question images (the memory storage provider was used).

## 2026-11-08 — Bulk verify and publish (`feat/bulk-verify-publish`)

- **CLI:** `npm run verify:keys -- --bank <code> --actor-phone +992... [--dry-run] [--only-source] [--exclude <file>] [--report] [--batch-size]` and `npm run publish:questions -- --bank <code> --actor-phone +992... [--dry-run] [--report] [--batch-size]`. Runbook §7.
- **New:** `src/services/question-bulk-review-service.js`, `src/utils/exclude-file.js`, `scripts/verify-answer-keys.js`, `scripts/publish-questions.js`, `scripts/bulk-review-cli.js`. `question-bank-service` exports the shared checks and accepts optional audit metadata. No migration, no new SQL.
- **Tests:** `tests/integration/question-bulk-review.test.js` (6 subtests: actor refusal, dry run, verify with exclude / verified kept / other bank untouched / audit, repeat without audit, publish with matching `INTERACTION_SETTINGS_INCOMPLETE` and repeat, CLI output) and `tests/unit/question-bulk-review.test.js` (5 tests, including batch rollback).
- **Checked:** `npm test` on a fresh migrated disposable database: exit 0; 371 tests, 371 passed, 0 failed, 0 skipped.
- **Not run:** against `nct-tg-2026` in `everest_db`.

## 2026-11-08 — Answer keys from a sidecar file (`feat/import-answer-keys`)

- **CLI:** `npm run import:answer-keys -- --keys <file> --actor-phone +992... [--bank] [--dry-run] [--idempotency-key] [--batch-size] [--report] [--set-matching-rules | --set-allow-right-reuse-false]`.
- **New:** `src/services/answer-key-import-service.js`, `src/utils/answer-key-file.js`, `scripts/import-answer-keys.js`, repository method `listBankQuestionStates`. Exported for reuse: `mapAnswerData`/`convertContent` (adapter), `loadImportActor` (question import).
- Keys are written by `replaceAnswerKeyService` and rules by `updateQuestionService`, inside the batch transaction. Outcomes: `APPLIED`, `UNCHANGED`, `KEY_CONFLICT`, `KEY_VERIFIED_SKIPPED`, `QUESTION_NOT_DRAFT`, `QUESTION_NOT_FOUND`, `ANSWER_KEY_INVALID`, `NO_KEY_FOR_QUESTION`. Matching-rule counters are per field.
- **No migration:** runs are stored in `question_imports` (`schema_version = everest.answer-key-import.v1`). Decisions: `docs/decisions.md` (2026-11-08). Runbook §6, contract §11.
- **Tests:** `tests/integration/answer-key-import.test.js` (11 subtests: actor, file rejections, dry run, real run in batches, replay, re-run, idempotency conflict, rules dry run and real run per field, audit without answer data, batch rollback and retry, CLI) and `tests/unit/answer-key-import.test.js` (4 tests).
- **Verified:** `npm test` on a fresh migrated disposable database: exit 0; 359 tests, 358 passed, 0 failed, 1 skipped (real S3). `everest_db` was not changed; one read-only count showed bank `nct-tg-2026` is not imported there.
- **Not verified:** a run against the real Tajik bank and the real key file (972 records).

## 2026-11-08 — Lesson completion guard and staff `passed` (`fix/lesson-completion-and-staff-passed`)

- The player could complete a lesson with a test (`completed: true`, or 90% watched). It now returns `409 LESSON_COMPLETES_BY_TEST`; watch progress still saves.
- Staff attempt list and detail carry `passed` from the single `attemptPassed`; OpenAPI updated. No migration.
- **Tests:** `tests/integration/lesson-test-completion-guard.test.js` (bypass before and after, staff `passed` for set and null `passPercent`, graded, in progress) and a unit test for `attemptPassed`. The `m11-gaps` replay of `completed: true` now expects the rejection.
- **Verified:** `npm test` with `DB_NAME` on a fresh migrated disposable database: exit 0; 343 tests, 342 passed, 0 failed, 1 skipped. `everest_db` not touched.

Teacher permission `tests.attempts.grant` on `feat/teacher-grant-permission` (awaiting review). Extra attempts are merged (PR #38).

## 2026-11-08 — Teachers may grant extra attempts (`feat/teacher-grant-permission`)

- Migration `20261108010000000_grant-teacher-attempt-grant-permission.js` (one role binding).
- Tests: `extra-attempts.test.js` now uses the seeded teacher role over HTTP (own group, foreign group, same-course teacher, student, idempotency, audit); the temporary permission grant was removed. Updated `tests-authoring` counts, `verify-database.js` (86 bindings, 14 teacher) and `test-migration-cycle.js` (33).
- **Verified:** `npm test` on a disposable database: exit 0; 339 tests, 338 passed, 0 failed, 1 skipped. `test:migrations`: 33 / 33 / 32 / 33. `everest_db` not touched.

M11 extra attempts on `feat/m11-extra-attempts` (awaiting review). M11 and its gaps are merged (PR #35, #36).

## 2026-11-07 — Extra attempts per student (`feat/m11-extra-attempts`)

- **Migrations:**
   - `20261107010000000_add-test-attempt-grants.js`: append-only table.
   - `20261107020000000_add-attempt-grant-permission.js`: `tests.attempts.grant` for owner and admin.
- **API:** `GET|POST /admin/tests/:testId/assignments/:assignmentId/users/:userId/extra-attempts`.
- **Effective limit:** used in starts, learner counts and reveal, through one formula, `effectiveMaxAttempts`.
- **Tests:**
   - New: `tests/integration/extra-attempts.test.js` (8 subtests).
   - Updated: the permission counts in `tests-authoring`, and the catalog numbers in `verify-database.js` and `test-migration-cycle.js`.
- **Verified:**
   - `npm test` with `DB_NAME` on a fresh migrated disposable database: exit 0; 339 tests, 338 passed, 0 failed, 1 skipped.
   - `npm run test:migrations`: 32 / 32 / 31 / 32.
   - `verify-database.js`: valid.
   - `everest_db` was not touched.

## Earlier increment

M11 follow-up gaps on `feat/m11-gaps`, merged in PR #36. Real-storage (MinIO/S3) import is still **not** verified.

## 2026-11-07 — M11 gaps (`feat/m11-gaps`)

- Lesson completion by test from submit, expiry (next access and `worker:attempts`) and regrade, in the same transaction, by the owner's rule (`docs/decisions.md`, 2026-11-07). New `src/services/lesson-completion-service.js`, `learner-lesson-repository.completeTestLessons`, `test-attempt-repository.hasSavedAnswer`.
- `passPercent` from the policy snapshot in learner results and staff attempts.
- Attempt history after a revoked assignment or a left group: list, assignment result and lesson summary show `state: revoked`; no new starts; strangers still get `404`.
- `testId` in learner lesson lists (`null` without module access).
- `progress { completedLessons, totalLessons, percent }` in `GET /courses` and `GET /courses/:courseId/modules`, one statement.
- No migration. OpenAPI, `docs/api.md` and `docs/frontend-handoff.md` updated.
- **Tests:** `tests/unit/m11-gaps.test.js` (7 tests with repository doubles), `tests/integration/m11-gaps.test.js` (6 subtests, including HTTP).
- **Verified:** `npm test` with `DB_NAME` on a freshly created and migrated disposable database: exit 0; sources, integrity and server passed; 330 tests, 329 passed, 0 failed, 1 skipped (real S3 storage). The disposable database was dropped. `everest_db` was not touched.

## 2026-11-05 — M11 attempts, timing and grading (`feat/m11-attempts`)

- Review decisions applied: group-teacher result scope, permission `tests.results.regrade` (migration `20261105040000000`), keys held back while attempts remain, running attempts survive revocation.
- Added: migration `20261105030000000_add-attempt-timing.js`, learner and staff attempt endpoints, grading of all five types, result and reveal policies, score revisions, `npm run worker:attempts`, lesson attempt state, seeded attempts.
- Verified on disposable databases: see the handoff. Real browser flows and the worker as a separate process were not run.

## 2026-11-05 — Login failure diagnosis (`fix/auth-login-diagnosis`)

- Cause: configuration and data, not a login regression. The API on port 4000 used `everest_demo2` while `.env` names `everest_db`; all recorded failures were there, and repeated tries reached the `login.account` block. No auth file changed in PR #33.
- Fixed: `src/server.js` ignored the Express 5 listen error, so `EADDRINUSE` appeared as a `null` port crash. Startup now rejects with `EADDRINUSE` and logs the database name.
- Added `scripts/check-auth-setup.js` (read-only) and frontend handoff section 5.4.
- Verified: fresh migrate and seed login returned 200 on a disposable database; `test:server` failed without the fix and passed with it; `test:auth` 282 tests, 281 passed, 0 failed, 1 skipped; `test:sources` passed. `test:integrity` was not run.

## 2026-11-05 — Lesson-test link and HTTP question import (`feat/lesson-tests-and-import`)

- `test` and `mixed` lessons can link a test of the same course and be published; `tests.module_id` added; learner lessons return a safe test summary; archive and delete of linked tests are refused; course copy reports cleared links; the seed publishes 4 linked test lessons. Migration `20261105010000000_add-lesson-test-links.js`.
- Package upload over HTTP with dry run, confirm, background worker (`npm run worker:imports`) and polling; `applyMatchingDefaults` for HTTP and CLI; total unpacked ZIP limit. Migration `20261105020000000_add-question-import-uploads.js`.
- **Tests:** `tests/integration/lesson-tests.test.js`, `tests/integration/question-import-upload.test.js`. Results and the not-verified list are in `docs/handoffs/current.md`.

## 2026-11-05 — Rich demo content (`feat/demo-content`)

- `npm run seed:demo` now also creates, through the existing services: 5 subjects with colors, sections and nested topics; 4 new published courses (Russian text with Tajik title translations; one draft and one archived module; draft video lessons); 5 question banks (4 staff, 1 private) with 145 published, 25 draft and 15 archived questions of all five types; 4 published tests, 1 draft and 1 archived with group and student assignments in open, upcoming and closed windows; groups B and the archived C with announcements; enrollments and module grants in every state; 18 more accounts including teachers, pending, blocked and rejected users. Phones `01` to `08` and the password handling are unchanged. The earlier English demo content is kept.
- Code: `scripts/seed-demo-content.js` (orchestration), `scripts/seed-demo-data/` (taxonomy, lessons, questions). No SQL, no migration.
- `docs/frontend-handoff.md` §5.3 lists the accounts and the content.
- **Tests:** `tests/integration/seed-demo.test.js` compares counts per entity and per access state across two runs and keeps the guard refusals. Full-suite result and the `test:integrity` caveat are in `docs/handoffs/current.md`.
- **Not verified:** the seeded data through the HTTP API and the frontend (learner screens, test windows as the student sees them); a rerun against a long-lived database that already has the older English seed; the Tajik wording by a native reviewer.

## 2026-11-04 — M10 test authoring and assignment (`feat/m10-tests`)

- 16 admin endpoints, five `tests.*` permissions and migration `20261101010000000_add-test-authoring.js` (`tests.course_id`). Rules and deviations are in `docs/decisions.md`.
- `seed:demo` adds one published test with 5 questions, assigned to the demo group, and gives the demo teacher `canManageTests` on newly created assignments.
- `scripts/verify-database.js` and `scripts/test-migration-cycle.js` were updated for the new catalog.
- **Tests:** `tests/integration/tests-authoring.test.js` (11 subtests). `npm test` (disposable database): 260 tests, 259 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). `verify-database.js` valid on the local database after `migrate:up`.
- **Not verified:** the API through the frontend; a seed rerun on a long-lived database; `migrate:up` on a database that already has `tests` rows, where it stops by design.

## 2026-11-02 — Development seed script (`feat/dev-seed`)

- `npm run seed:demo` (`scripts/seed-demo.js`): 8 active demo accounts (owner, admin, teacher, 5 students; phones `+992900000001` to `08`) and demo content (2 subjects, a published course with 2 modules and 6 text lessons, a draft course, a group with 3 students, a teacher and 2 announcements, a question bank with 5 published questions of every type, and 2 enrollments with module grants). It uses the existing services only.
- Safety guards (production, database name, `--force`), idempotent reruns, and the password rules are in `docs/decisions.md` and `docs/frontend-handoff.md` §5.3.
- **Tests:** `tests/integration/seed-demo.test.js` (own disposable database, two seed runs, count comparison, guard refusals). `npm test` (disposable database): 248 tests, 247 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). No migration was added.
- **Not verified:** a run against a long-lived local development database, the seeded data through the HTTP API and the frontend, and a seed against an existing owner other than the demo owner (the code path exists but has no test).

## 2026-11-01 — Re-enrollment and enrollment API improvements (`feat/enrollment-reinstate`)

- Re-enrollment after revoke and module-grant reinstatement were already implemented (M06); confirmed and covered explicitly. Module grants stay revoked after an enrollment is reinstated.
- `GET /admin/courses/:courseId/enrollments`: `user.phone` (primary E.164, same selection as `GET /admin/users`).
- `GET /admin/users`: `notEnrolledInCourse` (excludes non-revoked enrollments; malformed id `400`).
- **Tests:** `tests/integration/enrollment-reinstate.test.js` (5 subtests). `npm test` (disposable database): 245 tests, 244 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). No migration was added.

## 2026-10-31 — Group API improvements (`feat/groups-api-improvements`)

- `POST /admin/groups`: optional `code`, generated from the name with in-transaction collision retry; explicit duplicates still `409 GROUP_CODE_CONFLICT`.
- `GET /groups`: `status` and `q` filters, unknown params rejected, `pagination.total`.
- New `PATCH /admin/groups/:groupId/members/:userId` and `PATCH /admin/groups/:groupId/teachers/:userId` (audited).
- `GET /admin/users`: `notInGroup` and `notTeacherOfGroup`.
- `POST`/`PATCH /admin/groups` return `memberCount`/`teacherCount`.
- `409 GROUP_ARCHIVED` for composition changes and new announcements in archived groups.
- `GET /groups/:groupId/announcements`: `status` filter for staff.
- **Tests:** `tests/integration/group-improvements.test.js` (11 subtests). `npm test` (disposable database): 238 passed, 0 failed. No migration was added.

## 2026-10-31 — M17 admin accounts slice

- **Endpoints:**
   - `GET /api/v1/admin/users`: status/role/q/sort filters, literal-wildcard search over names and phones, stable order, `pagination.total`;
   - `pagination.total` added to `GET /admin/users/pending` (additive);
   - `PUT /api/v1/admin/users/:userId/roles`: owner/admin rules, no self-change, last-owner protection, `student` mandatory, row and owner-set locks, idempotent no-op, audit `admin.account.roles_changed`, session and refresh-token revocation.
- **Owner protection** on block/reject/unblock: `OWNER_ACTION_FORBIDDEN`, `LAST_OWNER_PROTECTED`.
- **Code:** `account-admin-repository` (list/count/roles/replace/owner count), `account-admin-service`, `account-admin-controller`, `admin-middleware` and `routes/admin.js`. OpenAPI adds `AdminAccount`, `RoleChange` and `Pagination.total`.
- **Tests:** `tests/integration/admin-accounts.test.js` (7 subtests) covers:
   - the permission matrix (anonymous, student, teacher, admin, owner);
   - filters, search, literal wildcards, pagination and `total`, the stable tie-break, and the response key allowlist;
   - the role-change matrix, the audit row and idempotency;
   - session revocation on role change and on block;
   - owner protection on block/reject/unblock;
   - the last-owner guard;
   - concurrent cross-demotion and concurrent identical changes.
- **Results:**
   - `npm test` (disposable database): 228 tests, 227 passed, 0 failed, 1 skipped (real storage);
   - `npm run test:migrations`: 25/25/24/25;
   - `verify-database.js`: valid. No migration was added.

## 2026-10-31 — M09 follow-up: real package format and isolated tests

- **Real format.** Read the real `import-packages/everest-tajik-indexed-v1.zip` and `everest-biology-tg-2026-pilot.zip` (git-ignored, unpacked only into a scratch folder outside the repo). Their relational entity-file format replaces the invented §9 format.
   - Added `src/utils/question-package-adapter.js` and wired it into `question-import-service`. It adds record paths, asset size/dimension checks and provenance, declared duplicate links, and the `MATCHING_RULE_UNSPECIFIED` warning.
   - The `source_metadata` allowlist now holds the real provenance fields (`chapter`/`variant` removed). Matching rules may be `null` in drafts; publication is blocked until a reviewer sets them (`INTERACTION_SETTINGS_INCOMPLETE`).
   - `docs/import-contract.md` §9/§10 and `docs/import-runbook.md` were rewritten.
- **Dry runs of the real packages** (temporary admin user, deleted afterwards; nothing written):
   - Tajik: valid, 0 errors. 972 questions (789 single choice, 183 matching), 1 subject, 7 sections, 5 topics, 2 assets, 972 unknown keys, 5 declared duplicates. 773 warnings: `CONTENT_INLINE_MARKS_FLATTENED` 564, `MATCHING_RULE_UNSPECIFIED` 183, `SOURCE_FIELD_DROPPED` 23, `SOURCE_REVIEW_NOTES_PRESENT` 3.
   - Biology pilot: valid, 0 errors. 20 questions, 5 sections, 50 topics, 6 assets. 51 warnings: `SOURCE_FIELD_DROPPED` 23, `SOURCE_REVIEW_NOTES_PRESENT` 8, `IMAGE_BLOCK_APPENDED` 6, `MATCHING_RULE_UNSPECIFIED` 4, `QUESTION_TYPE_MAPPED` 3, `INTERACTION_SETTINGS_DROPPED` 3, `MATCHING_COLUMN_HEADERS_AS_TABLE` 2, `PACKAGE_NOT_READY_FOR_IMPORT` 1, `PACKAGE_EXTRACTION_INCOMPLETE` 1.
- **Full real import into a disposable database** (memory storage double; database dropped afterwards):
   - Tajik: `completed` in about 40 s, 10 batches. 972 questions (all draft), 3,156 options, 1,647 matching items, 999 topic links, 2 asset links, 972 keys (0 verified), 7 duplicate links (5 declared + 2 suggested).
   - The same key replayed. A re-import with a new key updated 972 and reused both assets by alias.
   - Biology: `completed`, 20 questions, 52 options, 36 items, 6 asset links.
- **Tests:**
   - `npm test` now runs in a disposable database (`scripts/test-disposable-database.js`), so the existing owner and the manual group in `everest_db` no longer affect it, and no local data was deleted.
   - Fixed a latent audit join in `password-auth.test.js` (scoped by `entity_type`).
   - New `tests/unit/question-package-adapter.test.js` (3 tests), a real-format integration subtest, nullable-rule unit tests, and the synthetic entity-format fixture `tests/fixtures/question-import/sample/`.
- **Results:**
   - `npm test`: 220 tests, 219 passed, 0 failed, 1 skipped (real storage).
   - `node scripts/verify-database.js`: valid. No migration was added in the follow-up.
- **Not verified:** real S3/MinIO upload; an HTTP admin UI flow; the full biology book (only the 20-question pilot exists).

## 2026-10-31 — M09 indexed book import

- **CLI:** `scripts/import-question-package.js` (`npm run import:questions -- --package <dir|zip> --actor-phone … [--dry-run] [--idempotency-key] [--batch-size] [--report]`). It resolves an active actor with `questions.manage`.
- **Package loading:** `utils/question-package.js` (directory or ZIP, package hash) and `utils/zip-reader.js` (stored/deflate, CRC check, path safety).
- **Service:** `services/question-import-service.js`.
   - A single read-only planner validates the manifest, taxonomy, bank, assets and every question through the shared M08 parsers. A dry run returns its report.
   - A real run uploads content-addressed images, then runs one transaction for taxonomy + bank + run + assets/aliases + warnings, then batch transactions of ≤100 questions, then finishes the run.
   - Idempotency is by (`bank_id`, `idempotency_key`) + package hash.
   - Drafts are updated in place; published and archived questions are skipped.
   - Duplicate suggestions are recorded in `question_duplicate_links`.
- **Repositories:**
   - new `question-import-repository.js` (actor, runs, errors, aliases, sha256 assets, duplicate candidates/links);
   - `taxonomy-repository` gains `findEntityByCode` and `upsertTranslations`;
   - `question-bank-repository.createQuestion` writes `import_id`.
- **Storage:** `uploadObject` (PutObject) on the S3 adapter and on the memory double.
- **Content:** `utils/question-content.js` adds `source_metadata` fields `chapter`, `variant` and `year`.
- **Read API:** `GET /admin/question-imports`, `/:importId` and `/:importId/errors` (manage or review; scoped), added to `src/docs/openapi.js` and `docs/api.md`.
- **Migration:** `20261031030000000_add-question-import-support.js` adds the partial unique `assets_sha256_key` and the index `question_import_errors (import_id, id)`. `verify-database.js` expects 312 indexes and 25 migrations; `test-migration-cycle.js` expects 25/25/24/25.
- **Tests:**
   - `tests/integration/question-import.test.js` (15 subtests, real PostgreSQL, memory storage double) covers: the actor/permission checks, the 5-type dry run writing nothing, the committed sample fixture, a real run, replay and conflict, draft update with published/archived skip, sha256 reuse, alias conflict, the malformed/invalid package matrix, teacher taxonomy and foreign-bank denial, batch rollback and an idempotent re-run, duplicate suggestions, ZIP loading and path-escape rejection, the draft-only guarantee, and the read API with scope.
   - `tests/unit/question-content.test.js` covers the new metadata fields.
   - Synthetic fixtures are in `tests/fixtures/question-import/sample/` and `tests/helpers/import-fixtures.js` (generated PNG, ZIP writer).
- **Results:**
   - `node --test tests/integration/question-import.test.js`: 15/15 passed.
   - `npm test`: 207 tests, 203 passed, 3 failed, 1 skipped (real storage). The 3 failures do not come from M09; they are caused by data in local `everest_db`:
      - `account-admin.test.js` asserts "integration database must not have a pre-existing owner", but an owner now exists;
      - `groups.test.js` (one subtest plus its parent) sees an extra manually created group, "Тестовая группа (шапка)".
   - `npm run test:migrations`: 25/25/24/25, disposable database dropped.
   - `node scripts/verify-database.js`: `valid: true`.
   - CLI dry run of the sample fixture with a temporary admin user (deleted afterwards): `valid`, 2 questions.
- **Not verified:** a real S3/MinIO upload (Docker absent); a real Tajik or biology package (`import-packages/` absent); very large packages (the whole package is held in memory, limit 512 MiB).

## 2026-10-30 — M-DOCS (previous increment)

M07-C is merged into `main` (PR #21). M-DOCS (OpenAPI 3.1 + Swagger UI) is implemented on `feat/m-docs-swagger`. Real MinIO/S3 and Range-seek verification for M07-A/M07-B are still pending, because Docker is not installed. Production SMS remains unavailable pending provider approval. The next ROADMAP milestone is M09 (indexed book import), which needs approved input formats.

## 2026-10-30 — M-DOCS OpenAPI and Swagger UI

- Added `src/docs/openapi.js`: an OpenAPI 3.1 spec for all 133 `/api/v1` operations (103 paths) with cookie/Bearer security, the CSRF header, shared schemas, error codes and pagination.
- Added `controllers/docs-controller.js` and `routes/docs.js`: `/api/docs` (page, CSP), `/api/docs/openapi.json`, `/api/docs/swagger-initializer.js` (CSRF auto-header) and allowlisted `swagger-ui-dist` assets. They are mounted in `app.js` only when `SWAGGER_ENABLED` (default `NODE_ENV !== 'production'`).
- `routes/index.js` exports `routeMounts`; `configs/env.js` adds `swaggerEnabled`.
- Dependencies: `swagger-ui-dist@5.33.1`; dev `@seriousme/openapi-schema-validator@2.11.0` (exact pins).
- Fixed `scripts/bootstrap-owner.js` (broken import) and repaired the duplicated block at the top of `docs/api.md`.
- `tests/unit/openapi.test.js` (6 tests): 3.1 validity, two-way route coverage, security/error envelope/CSRF parameter, documented codes exist, bootstrap import, served only when enabled with the asset allowlist.
- `npm test`: 199 tests, 198 passed, 0 failed, 1 skipped (real storage). `npm run test:migrations`: 24/24/23/24, no migration added.
- A manual check on a separate server (port 4999) served the page, JSON (103 paths, 133 operations) and CSS with 200, and returned 404 for the package's `index.html`. A browser click-through of the Swagger login was not done: the local `.env` still lacks `JWT_ACCESS_SECRET`/`OTP_HMAC_SECRET`.

## 2026-10-30 — M07-C learner catalog enrichment

- Added the reversible migration `20261031020000000_add-subject-color.js`: `subjects.color` with a palette CHECK and default `neutral`.
- The M08 subject API accepts and returns `color`.
- `course-access-repository` learner reads add `subject`, `module_count` and `lesson_count`. `learner-course-service` exposes `subject`, `moduleCount` and `lessonCount` in `GET /courses` and in the course card of `GET /courses/:courseId/modules`.
- `profile-repository`/`profile-service` add `telegramLinked`.
- Added `tests/integration/learner-catalog.test.js` (3 subtests): palette validation and the DB constraint, counts excluding draft/archived items, a `null` subject, and `telegramLinked` without identity leakage.
- `npm test`: 193 tests, 192 passed, 0 failed, 1 skipped (real storage). `npm run test:migrations`: 24/24/23/24, disposable database dropped. `verify-database.js`: `valid: true` (698 columns).

## 2026-10-30 — M08 taxonomy and question bank

- Added the reversible migration `20261031010000000_add-question-bank-permissions.js`:
   - `taxonomy.read`/`taxonomy.manage` and `questions.read`/`questions.manage`/`questions.review`;
   - CHECK `question_answer_keys_verified_source_check` (a verified key must come from `official_key` or `expert_review`).
   - No tables: the baseline schema and triggers already existed.
- Added `taxonomy-repository`/`service`/`controller`: subjects, sections and topics with translations, a cycle-safe topic hierarchy, subject consistency, and `*_IN_USE` deletion guards.
- Added `question-bank-repository`/`service`/`controller`:
   - banks with owner/staff visibility;
   - draft question CRUD with options, matching items, topics, source metadata and images;
   - answer keys (unknown → proposed → verified);
   - publication, archive and copy.
- Added `utils/question-content.js` (rich content blocks and per-type `answer_data` validation) and `middleware/question-admin-middleware.js`. Routes are under `/api/v1/admin`.
- Tests:
   - `tests/unit/question-content.test.js` (5 tests).
   - `tests/integration/question-bank.test.js` (9 subtests): taxonomy ACL/cycles/mismatch/in-use, bank privacy, structure validation, no `is_correct`, key confidentiality, reviewer-only verification, the verified-source DB constraint, publication guards, API and trigger immutability, audit without answer data, copy/delete-in-use, matching rules and key reset, and image asset rules.
- `npm test`: 189 tests, 188 passed, 0 failed, 1 skipped (real storage). `npm run test:migrations`: 23/23/22/23, disposable database dropped. `verify-database.js`: `valid: true` (29 permissions, 67 role grants).
- Not done (per ROADMAP/decisions): imports, duplicate detection and bank-bound image uploads (M09); grading tolerances (M10/M11).

## 2026-10-29 — M07-B follow-up: direct editing of published lessons

- Removed the draft-only edit rule. `PATCH`, chapters and resources now work in every status, and published lessons stay publishable (`LESSON_VIDEO_REQUIRED`, `LESSON_TYPE_NOT_PUBLISHABLE`).
- Replacing a video is refused when chapters would fall beyond the new video (`409 CHAPTERS_EXCEED_VIDEO_DURATION`). Otherwise the old video's active offline licenses are revoked in the same transaction (the PWA gets `video_unavailable`), and progress is kept.
- Added `offline-license-repository.revokeLessonAssetLicenses`. A download check on a license revoked as `access_lost` now reports the current cause.
- Added a `lessons.test.js` subtest (14 subtests now): direct edit visible to the learner at once, video removal refused, chapters beyond the new video refused with nothing changed, offline licenses revoked on video change, progress kept.
- No migration was added. `npm test`: 174 tests, 173 passed, 0 failed, 1 skipped (real storage). `npm run test:migrations`: 22/22/21/22, disposable database dropped.

## 2026-10-29 — M07-B lessons, playback and offline licenses

- Seek-ready video policy (supersedes the M07-A remux hook):
   - MP4 must be fast start and WebM must have Cues before clusters; QuickTime is refused. Other files get `422 VIDEO_NOT_SEEKABLE` and are deleted.
   - New videos get `processing_status = 'not_required'`, and no remux jobs are created (`background-job-repository` removed).
   - Added `scripts/remux-faststart.js` (`npm run video:faststart`).
- Added the reversible migration `20261030020000000_add-lesson-playback.js`:
   - `lesson_video_chapters`;
   - offline `revoked_by`, `revoke_reason`, `renewed_at` and `device_label`;
   - `not_required` processing status;
   - `lessons.read` and `lessons.manage` (owner/admin/teacher) and `lessons.offline.manage` (owner/admin).
- Added `lesson-repository`, `learner-lesson-repository`, `offline-license-repository` and the matching services, controllers and routes (`/admin/courses/:courseId/...lessons`, `/courses/:courseId/lessons/...`, `/offline-licenses`).
- Added `learnerMediaRateMiddleware` (`PLAYBACK_RATE_LIMIT`) and the attachment/inline disposition for `presignDownload`.
- Course copy now includes lessons, chapters and materials. The M05-B copy test expectations were updated accordingly.
- Updated `verify-database.js` (87 tables, 697 columns, 164 FKs, 310 indexes, 67 identity columns, 22 migrations, 24 permissions, 54 role grants, 6 teacher grants) and `test-migration-cycle.js` (22/22/21/22).
- Decisions: the seek-ready policy plus 20 assumptions made without the user, in [decisions](decisions.md).
- Commands run on 2026-10-29:
   - Baseline on `main` (`68e4fab`): `migrate:up` was a no-op; the test suite reported 156 tests, 155 passed and 1 skipped.
   - `npm run migrate:up` applied the new migration. `node scripts/verify-database.js` reported `valid: true`.
   - `npm test`: 173 tests, 172 passed, 0 failed, 1 skipped (real storage not configured). Source integrity, schema integrity and the server lifecycle check also passed. This includes `tests/integration/lessons.test.js` (13 subtests), the updated `asset-uploads` test (14) and the media inspection tests (14).
   - `npm run test:migrations`: 22/22/21/22, and the disposable database was dropped. No rollback ran against `everest_db`.
   - `node scripts/remux-faststart.js` without ffmpeg installed printed the missing-ffmpeg error and exited with code 3. A real remux was not run, because ffmpeg is not installed.
- Not run:
   - real storage tests, Range seeking through a real signed URL, and browser playback;
   - `.env.example` update (file access denied; add `PLAYBACK_RATE_LIMIT` by hand).

## 2026-10-29 — M07-A media storage and resumable uploads

- Added the provider-neutral S3 adapter `src/providers/storage/` (`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, both approved) with separate `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` settings.
- Added the reversible migration `20261030010000000_add-asset-uploads.js`. It creates the `asset_uploads` table, adds `assets.kind`, `processing_status` and `processing_error`, and grants `assets.upload`/`assets.manage` to owner/admin.
- Added `asset-upload-repository`, `background-job-repository`, `asset-upload-service`, the controller and `routes/assets.js` (`/api/v1/assets/uploads…`), plus the pure-JS inspector `utils/media-inspection.js` (magic bytes, ISO-BMFF and WebM container/codec parsing).
- Added `docker-compose.yml` (local MinIO only, pinned), `scripts/configure-storage-bucket.js` (`npm run storage:configure`) and the optional `tests/integration/real-storage.test.js`, which skips itself when storage is not configured or not reachable.
- MinIO CE status was checked: it was archived upstream in February 2026 and has unpatched CVEs, so it is used for development only. See [decisions](decisions.md), including 16 assumptions made without the user.
- Updated `verify-database.js` (86 tables, 687 columns, 162 FKs, 306 indexes, 66 identity columns, 21 migrations, 21 permissions, 46 role grants) and `test-migration-cycle.js` (21/21/20/21).
- Commands run on 2026-10-29:
   - Baseline on `main` after the pull: `migrate:up` was a no-op; `npm test` passed 130 tests.
   - `npm run migrate:up` applied the new migration. `node scripts/verify-database.js` reported `valid: true`.
   - `npm test`: 156 tests, 155 passed, 0 failed, 1 skipped (the real-storage test, because `S3_*` is not configured). Source integrity, schema integrity and the server lifecycle check also passed.
   - `npm run test:migrations`: the disposable cycle passed 21/21/20/21 and its database was dropped. No rollback ran against `everest_db`.
- Not run: any test against real MinIO/S3, the 3 GB interrupted/resumed upload, `docker compose up` and `npm run storage:configure`, because Docker is not installed. `.env.example` was not updated because file access was denied.

## 2026-10-29 — M06 course enrollments and module access grants

- Added administrative enrollment and module-grant APIs (grant, list, extend, revoke, re-grant) and learner reads of own courses and module lock state. See [API](api.md) and [decisions](decisions.md) (15 assumptions chosen deny-by-default because the user was unavailable).
- Added the reversible migration `20261029010000000_add-course-access-permissions.js` (`courses.access.read`, `courses.access.manage`; owner/admin only). No table changes: the existing tables and `can_access_module` were sufficient.
- Added `course-access-repository`, `course-access-service`, `learner-course-service`, two controllers, `routes/courses.js`, and the reusable `requireModuleAccessService` guard for M07.
- Updated expected values in `verify-database.js` (20 migrations, 19 permissions, 42 role grants) and `test-migration-cycle.js` (20/20/19/20).
- New PostgreSQL integration test `tests/integration/course-access.test.js`: 16 subtests passed (17 reported tests) (permissions, validation, eligibility, concurrency, group non-grant, locked metadata, onboarding, expiry/renewal with progress preserved, revocation cascade and non-restoring re-grant, publish/archive effects, blocked account, listing, audit and rollback).
- Commands run on 2026-10-29:
   - Baseline on `main`: `migrate:up` no-op; `npm test` passed 113 tests.
   - `npm run migrate:up` applied the new migration; `node scripts/verify-database.js`: `valid: true`.
   - `npm test`: 130 tests passed with 0 failures, plus source integrity, schema integrity and server lifecycle.
   - `npm run test:migrations`: disposable cycle passed 20/20/19/20 and its database was dropped. No rollback ran against `everest_db`.

## 2026-10-28 — M05-B course modules, ordering, preview, and copying

- Added module create/update, a `draft → published → archived → draft` lifecycle, and deletion of empty draft modules only.
- Added full-list reordering, done in two passes inside one transaction.
- Added a read-only structure preview with lesson and test counts.
- Added transactional course copying (course and modules as drafts) built from extensible copy steps for M07.
- Added the reversible migration `20261028010000000_add-course-module-permissions.js`. It creates `courses.modules.manage` (owner/admin/teacher; teachers are additionally scoped by `can_edit_course`) and `courses.copy` (owner/admin).
- Updated the expected values in `verify-database.js` (19 migrations, 17 permissions, 38 role grants, 4 teacher grants) and in `test-migration-cycle.js` (19/19/18/19).
- New focused PostgreSQL integration test `tests/integration/course-modules.test.js`: 11/11 passed. It covers append order under concurrency, validation, foreign-module hiding, lifecycle conflicts, reorder validation and renumbering, preview counts and scope, delete rules, teacher edit scope, copy contents, no copied teachers or grants, copy rollback on audit failure, and audit codes.
- Commands run on 2026-10-28:
   - `npm run migrate:up` applied the new migration to `everest_db`.
   - `node scripts/verify-database.js`: `valid: true`.
   - `npm test`: 113 tests passed with 0 failures, plus source integrity, schema integrity, and server lifecycle.
   - `npm run test:migrations`: the disposable cycle passed 19/19/18/19 and its database was dropped. No rollback ran against `everest_db`.
- Baseline before this work, after pulling `main`: `migrate:up` was a no-op and `npm test` passed 102 tests.

## 2026-10-27 — M05-A course catalog, lifecycle, and teacher assignments

- Split M05 into M05-A catalog/lifecycle/teacher assignments and M05-B modules/order/preview/copying.
- Added administrative course list/detail/create/update plus locked publish/unpublish commands and eligible teacher assignment management.
- Added `can_edit_course` and five permission seeds in reversible migration `20261027020000000_add-course-management-permissions.js`. Teacher reads and edits remain target-course scoped; publishing and assignment management remain owner/admin-only.
- Catalog validation supports schema-defined subject, title, description, language, translations, and optional cover reference while rejecting status, creator, unknown fields, invalid references, and unsupported languages.
- Focused PostgreSQL integration passed ten subtests covering authorization, CSRF, lifecycle conflicts, concurrency, scope, safe DTOs, audit rollback, decimal IDs, and proof that no enrollment/module/group access was created. The disposable cycle passed 18/18/17/18 and removed its database.

## 2026-10-27 — M04-B group administration and announcements

- Added group create/update, membership lifecycle, teacher assignment, and text-announcement lifecycle APIs without introducing course access or `group_courses`.
- Added five database-backed group permissions in reversible migration `20261027010000000_add-group-management-permissions.js`; owner/admin receive all, while assigned teachers are scoped to announcement management in their group.
- Mutations use live authentication, permission middleware, cookie CSRF/origin protection, service-owned transactions, repository SQL, and atomic audit events. Membership and announcements retain lifecycle history where the schema supports it.
- Focused PostgreSQL integration covers authorization, CSRF, concurrency, eligibility, safe author derivation, visibility, audit rollback, decimal IDs, and no course/module grants. The disposable 17/17/16/17 migration cycle passed and removed its database.

## 2026-10-26 — M04-A group read APIs

- Split M04 into M04-A reads and M04-B administration/announcements with explicit M07/M12/M13 dependencies.
- Added authenticated visible-group list/detail and paginated active-member/assigned-teacher roster routes.
- Visibility uses live database roles and relationships; missing and inaccessible resources share one stable response.
- Safe DTOs preserve decimal-string IDs and omit contact/authentication data, course access, progress, and ranking.
- Focused PostgreSQL integration passed 11 tests; `npm test` passed 81 tests plus source integrity, eight schema-integrity cases, and server lifecycle. `npm run migrate:up` was a no-op.

## 2026-10-26 — M03 user profiles and onboarding

- Added authenticated own-profile read/update and server-driven onboarding state/update/completion routes.
- Reused the existing schema without a migration. Editable fields are names, language, and timezone; phone, status, roles, identifiers, and avatar reference remain read-only.
- Onboarding requires first and last name, locks profile/account state, requires an active account, is idempotent, and audits updates/completion in the same transaction.
- Focused PostgreSQL integration passed eight tests covering ownership, redaction, validation, CSRF, state calculation, incomplete/successful/repeated completion, inactive accounts, audit, rollback, and decimal-string IDs.
- `npm test` passed 70 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle. `npm run migrate:up` was a no-op.

## 2026-10-26 — M02F-B authentication protection

- Added `20261026020000000_add-auth-protection-state.js`, session-bound CSRF hashes, and persistent atomic authentication counters.
- Added IP/action throttles for public authentication routes and account-administration mutations plus a five-attempt, 15-minute normalized-account password lockout.
- Added stable `429 AUTH_RATE_LIMITED` responses with `Retry-After`; successful login resets account failures and known failures are audited without changing external non-enumeration.
- Added allowed-origin and session-bound CSRF validation for cookie-authenticated mutations. Public auth/recovery and bearer-authenticated calls remain usable.
- `npm test` passed 62 tests plus migration-source integrity, eight schema-integrity cases, and server lifecycle. Catalog verification passed at 85 tables, 668 columns, 301 indexes, and 16 migrations.
- Disposable rollback was not run because `everest_app` no longer has `CREATEDB` (`42501`); no rollback ran against `everest_db`.

## 2026-10-26 — M02F-A RBAC and authorization foundations

- Added the incremental `20261026010000000_add-rbac-permissions.js` migration with `permissions` and `role_permissions`.
- Seeded only five existing account-administration actions for `owner` and `admin`; no unresolved domain/resource permissions or implicit role hierarchy were introduced.
- Added repository-backed permission evaluation, service-owned authorization decisions, and explicit action middleware on every account-administration route.
- Preserved routes, responses, authentication order, `ADMIN_ROLE_REQUIRED`, account-state rules, transactions, session revocation, and audit behavior.
- Focused unit tests, all eight account-administration integration subtests, and the full 59-test authentication regression suite passed. Catalog verification passed at 84 tables, 661 columns, 159 foreign keys, 299 indexes, 15 migrations, and 65 identity columns.
- Both final migration-up runs were no-ops. The disposable cycle passed up/no-op/down/up at 15/15/14/15 migrations and 84/84/82/84 tables, then its generated database was confirmed removed. No rollback ran against `everest_db`.
- M02F-B rate limiting, brute-force controls, CSRF, and the broader authentication security review are next.

## 2026-10-25 — M02E password recovery

- Added generic recovery request, single-use code verification, and password-reset routes without account, status, linkage, throttle, or delivery enumeration.
- Added HMAC-protected expiring codes, hashed opaque challenge/reset identifiers, attempt and resend/hour limits, row-lock concurrency, and active-challenge invalidation.
- Added linked-Telegram delivery through the existing bot abstraction and a production-disabled provider-neutral SMS boundary with test doubles only.
- Password reset atomically replaces the password, consumes authorization, revokes all sessions/refresh tokens, and audits while preserving account status, roles, and Telegram identity.
- Added one incremental migration because the baseline challenge table allowed only SMS and lacked separate reset-authorization state; the 13 published migrations remain unchanged.
- Final verification passed two no-op up migrations, 55 authentication tests, eight schema-integrity cases, server lifecycle, exact baseline-source verification, and the 82-table/654-column/296-index/14-migration catalog.
- The disposable migration cycle was attempted but could not create its isolated database because `everest_app` lacks `CREATEDB` (`42501`); no rollback ran against `everest_db`.

## 2026-10-25 — M02D session lifecycle

- Added shared refresh-token issuance to password and Telegram login, opaque hash-only storage, atomic single-use rotation, and session-family reuse detection.
- Added refresh, current logout, logout-all, session list, and owned-session revocation routes with matching HttpOnly cookie handling.
- Added coarse device summaries, bounded User-Agent storage reuse, throttled access activity updates, and refresh-time `last_used_at` updates.
- Extended M02C blocking so associated refresh rows are explicitly revoked with sessions.
- No migration was required; the existing refresh/session schema supports the session-as-family strategy.
- Added focused unit and real-PostgreSQL integration coverage for issuance, expiry/revocation, rotation, replay races, rollback, ownership, logout, metadata safety, and blocking regression.
- Repeated up migrations were no-ops; the full test suite, catalog verification, exact migration-source verification, syntax, architecture-boundary, secret/ignore, and documentation checks passed. No migration or schema change was needed.

## 2026-10-25 — M02C account approval

- Added authenticated owner/admin account administration for pending-user listing and approve, reject, block, and unblock transitions.
- State decisions lock the target row and share one transaction with audit writes; blocking also revokes every live session, while unblocking leaves revoked sessions invalid.
- Added canonical decimal-string route-ID validation, deterministic bounded pagination, safe DTOs, self-block/reject protection, and stable authorization/transition errors.
- Added a local, advisory-lock-protected initial-owner bootstrap command with no public route.
- Added unit and real-PostgreSQL integration coverage for roles, pagination, invalid IDs, concurrency, transitions, rollback, audits, session revocation, bootstrap concurrency, and password/Telegram account-state enforcement.
- Fixed Windows portability of exact migration-source verification by normalizing only line endings and adding an LF `.gitattributes` policy; published migrations were unchanged.

## Implemented

- Initialized npm with Node.js 22, Express 5, `pg`, `dotenv`, `cors`, and `node-pg-migrate` 8.0.4.
- Selected native JavaScript ES Modules by explicit user decision.
- Added validated environment loading and a bounded PostgreSQL pool using the separate `DB_*` variables.
- Added an ES Module programmatic migration runner with safe target logging, order checks, locking, one-migration down behavior, and a disposable-database guard.
- Added 12 dependency-ordered migrations under `src/migrations/`. Every migration uses `export const up/down` and raw DDL in `pgm.sql()`. The emitted combined up SQL exactly matches the SQL block in `schema_tables.md`; down SQL contains no `CASCADE`.
- Added the route -> controller -> service -> repository flow for `/api/v1/health` and `/api/v1/ready`.
- Added `withTransaction` with one acquired client, `BEGIN`, callback, `COMMIT`/`ROLLBACK`, and release in `finally`.
- Added centralized safe error handling, server startup readiness, and graceful shutdown.
- Added `.env.example` with empty secret placeholders and ignored `.env`, npm cache, dependencies, logs, and uploads.
- Added Telegram OIDC Authorization Code Flow with PKCE S256, discovery, token exchange, local JWKS signature verification, issuer/audience/expiry/nonce/subject validation, and safe provider errors.
- Added one-use expiring OIDC state records. State and nonce are stored as SHA-256 hashes; the PKCE verifier is encrypted with AES-256-GCM.
- Added authenticated Telegram link, unlink, and test-message operations. Login identities use verified issuer/subject in `auth_identities`; bot messaging state remains in `telegram_connections`.
- Added EVEREST session JWT creation and middleware that validates the JWT, live session, and active account. The callback stores the token in an HttpOnly cookie and omits it from JSON.
- Added repository-owned parameterized SQL, service-owned transactions, audit events, stable identity-conflict responses, and mock-based Telegram tests.
- Added `POST /api/v1/auth/register` with strict allowed fields, E.164 normalization, name/password validation, asynchronous salted `scrypt` hashing, and one transaction for the pending user, profile, unverified phone, password, student role, and audit event.
- Added `POST /api/v1/auth/login/password` with generic invalid credentials, constant-work unknown-phone verification, active-account enforcement under a row lock, shared session issuance, HttpOnly cookie transport, `last_login_at`, and an atomic audit event.
- Added a shared session-issuance service used by Telegram and password login without changing the existing session/token contract.
- Added password/input unit tests and real-PostgreSQL integration coverage for validation, role injection, normalization, hashing, duplicate and concurrent phones, rollback, pending/blocked/rejected denial, generic credentials, session creation, auditing, and response secrecy.
- Completed the approved pre-production M01R baseline rewrite: 64 entity `id` columns are PostgreSQL identity `BIGINT`s; all internal foreign, one-to-one, composite, function, and audit references use `BIGINT`.
- Updated authentication repositories to omit entity IDs on inserts and consume `RETURNING id`; services no longer generate UUID entity IDs.
- Added canonical positive decimal-string validation for PostgreSQL `BIGINT` JWT/API identifiers without JavaScript `Number` conversion.
- Retained UUID only for `sms_deliveries.idempotency_key`; retained cryptographic randomness for OAuth state/nonce/PKCE/encryption, password salts, hashes, external-provider identifiers, and disposable database naming.

Implemented foundation files include `src/app.js`, `src/server.js`, `src/configs/{env,db,migrate,error-handler}.js`, the health route/controller/service/repository chain, `src/repositories/transaction-repository.js`, shared utilities, and the verification scripts under `scripts/`.

Migration files, all applied:

- `1761264000000-create-auth-tables.js`
- `1761264000001-create-assets-tables.js`
- `1761264000002-create-group-tables.js`
- `1761264000003-create-taxonomy-tables.js`
- `1761264000004-create-learning-tables.js`
- `1761264000005-create-question-bank-tables.js`
- `1761264000006-create-testing-tables.js`
- `1761264000007-create-ai-tables.js`
- `1761264000008-create-bonus-tables.js`
- `1761264000009-create-notification-tables.js`
- `1761264000010-create-operation-tables.js`
- `1761264000011-create-functions-triggers-indexes.js`
- `20261024010000000_add-telegram-oidc-states.js`

## Development database result

Target inspected before migration: `localhost:5432`, database `everest_db`, PostgreSQL 16.10, zero application tables, no migration history. Credentials were not printed.

The Milestone 1 run applied the 12 baseline migrations. Milestone 2A applied the single incremental OIDC-state migration. A repeated `npm run migrate:up` reported no pending migrations. Catalog verification passed:

- 82 application tables
- 650 columns
- 157 foreign keys
- 293 indexes, including constraint-backed indexes
- 7 functions
- 11 user-defined triggers
- 4 fixed role seed rows
- 13 migration history rows
- no `group_courses` or `question_versions`

For M01R, the same local target was rechecked and contained zero application rows except four role seeds. A custom-format backup was written to `C:\Temp\everest-m01r-backups\everest_db-before-m01r-20261025-162519.dump`. After temporary `CREATEDB` access was confirmed, only `everest_db` was dropped/recreated and the rewritten 13-migration numeric baseline was applied. A second up was a no-op. The verified catalog additionally contains 64 identity columns, no non-`BIGINT` entity `id` or foreign-key columns, and one UUID column (`sms_deliveries.idempotency_key`).

## Checks actually run

- Node syntax checks for all source files: passed.
- ESM/import check for `src/app.js`: passed; importing the app did not listen or migrate.
- Migration source verification: the original 12 migrations still emit the exact reference baseline; 13 migrations exist in total and no down migration uses `CASCADE`: passed.
- `npm run migrate:up` on `everest_db`: applied the incremental OIDC-state migration.
- Repeated `npm run migrate:up`: passed as a no-op.
- Catalog count and exclusion verification: passed.
- Integrity checks, all inside one transaction with a final rollback: wrong-course module grant, multiple assignment audiences, two open attempts, mismatched attempt answer, publication without a verified key, published content mutation, duplicate bonus event, and append-only journal mutation were all rejected.
- Health/readiness and explicit graceful shutdown integration test: passed.
- Dependency installation audit: zero reported vulnerabilities.
- Full source syntax check after the ESM conversion: passed.
- Telegram unit/integration tests: PKCE, state/nonce hashing, encrypted verifier, discovery/JWKS doubles, signature, issuer, audience, expiry, nonce, start, callback, provider denial, replay, expired state, linking, duplicate prevention, login cookie, test message, and unlinking: passed.
- Telegram tests use mock providers and never call the live Telegram OIDC or Bot API.
- `npm test` (`test:sources`, `test:integrity`, `test:telegram`, `test:server`): passed.
- M02B focused password/input unit tests: 3 passed.
- M02B focused PostgreSQL integration tests: 8 subtests passed (9 reported tests including the parent).
- Post-M02B `npm test`: passed all 22 reported auth tests plus migration-source, schema-integrity, and server lifecycle checks.
- Post-M02B `npm run migrate:up`: passed as a no-op; `verify-database.js` confirmed the expected 82-table, 13-migration catalog.
- M01R first `npm run migrate:up`: all 13 rewritten migrations applied to the rebuilt local development database.
- M01R second `npm run migrate:up`: passed as a no-op.
- M01R `npm test`: passed migration-source verification, eight schema-integrity rejection cases, 24 authentication tests, and server lifecycle checks.
- M01R `npm run test:migrations`: passed on a separately created disposable database with states 13/82/7 after up, unchanged after the second up, 12/81/7 after rolling back the OIDC migration, and 13/82/7 after reapply; the disposable database was dropped.
- M01R `verify-database.js`: passed 82 tables, 650 columns, 157 FKs, 293 indexes, seven functions, 11 triggers, four role seeds, 13 migrations, 64 identity columns, generated `BIGINT` ID proof, no invalid entity/FK types, and the one justified UUID idempotency column.
- `npm run migrate:down` with `DB_NAME=everest_db`: rejected before migration execution with exit code 1, as required by the safety guard.

## Migration safety result

The previous `CREATEDB` blocker is resolved for M01R. The rollback lifecycle passed against a generated `everest_migration_test_<random>` database and that database was dropped. No rollback ran against `everest_db`. Temporary database-creation privilege should be removed when no longer needed.

The applied initial migration filenames use a hyphen after their numeric prefix. node-pg-migrate applies them in stable lexical order but emits non-fatal timestamp-prefix warnings because newly generated names use an underscore separator. The applied files and migration history remain unchanged; the new migration follows the underscore convention.

The project is initialized as a Git repository. The primary branch is `main`, Git commits are the implementation history, and each milestone should use a dedicated feature branch. Working-tree state must be verified at each handoff rather than hard-coded here.

## Unresolved product decisions

Production SMS provider selection, whether Telegram-authenticated accounts must later verify a phone, NCT attempt scope, partial scoring and reveal timing, ranking formula, access expiry defaults, and AI credit-package interactions remain open.

## Next concrete milestone

M02F-B: confirm rate-limit, brute-force, and CSRF policies, then implement authentication protection hardening without adding unresolved domain permissions or changing approved authentication contracts.
