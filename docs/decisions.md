# Decisions

## 2026-10-31 — Indexed book import (M09)

User decisions (from the M09 brief):

- CLI first: `npm run import:questions`. There is no HTTP package upload in M09.
- Runs are recorded in `question_imports`/`question_import_errors`; the same key with the same hash replays, and the same key with another hash conflicts.
- Dry run and real run share one validation path. A dry run writes nothing.
- Imports create drafts only. They never publish, never guess answers and never verify keys. A package key is at most `proposed`.
- `external_id` is required for imported questions.
- Re-import updates drafts in place. Published and archived questions are skipped with `QUESTION_IMMUTABLE_SKIPPED`, never copied or changed. Taxonomy upserts never delete anything.
- Images are deduplicated by sha256, and `asset_aliases` resolves package-local IDs.
- Duplicate detection is a conservative suggestion only.
- Do not fix in M09: per-question translations, inline markup, table headers/merged cells, grading tolerances, a `ready` status, book page tables.
- Read-only run API with `questions.manage`/`questions.review`.

Follow-up (2026-10-31, real packages `everest-tajik-indexed-v1.zip` and `everest-biology-tg-2026-pilot.zip`). Assumptions made without the user (please review):

- **F1. The real relational format replaces the invented one.** `manifest.json` + `data/<entity>[.partNNN].json` envelopes are read by `utils/question-package-adapter.js` and converted to the internal nested model, which is still accepted for tests and hand-written packages (contract §9.9). Nothing subject-specific is hard-coded.
- **F2. Not silently dropped.**
   - Fields without a column are reported once per entity and field (`SOURCE_FIELD_DROPPED`): bbox, sourceSpans, positions, topic metadata, `difficultyReason`, question `sectionCode`, topic-link classification, and several bank provenance fields.
   - Lossy content mappings are reported once per question and code: inline marks are reduced to the shared marks, `line_group` becomes `verse`, matching `columnHeaders` become a one-row table, inline formulas are split.
   - The package itself remains the full record.
- **F3. `open` questions** with `answerFormat: short_text|numeric` become that type. Their input-cell settings are reported, not stored (M10/M11 grading).
- **F4. `source_metadata` allowlist** = the provenance fields the packages really use: `year` (also from `examYear`), `sourceFile`, `printedPage`, `sequence`, `bookSectionTitle`, `bookRubric`, `isSample`, `reviewRequired`, `examPart`. `page` comes from `page`, then a numeric `printedPage`, then `pageIndex1Based`; `number` comes from `number`, then `sourceNumber`.
- **F5. Unstated matching rules stay `null`.** Both packages use `allowRightReuse: null`. The M08 parser now accepts `null` in drafts. Keys are validated strictly (no reuse; all-left not required), and publication is refused (`INTERACTION_SETTINGS_INCOMPLETE`). The DB trigger already required booleans only at publication, so no migration was needed. The importer never guesses `false`.
- **F6. `question_assets` links without an image block** (biology) become image blocks appended to the question content (`IMAGE_BLOCK_APPENDED`), because EVEREST derives `question_assets` from blocks.
- **F7. Asset provenance** (`extractionMethod`, page, bbox, `embeddedSha256`, …) is kept in `assets.source_metadata.package` (≤16 KiB), which is not exposed to students. Declared `sizeBytes` must match the bytes; declared dimensions are compared with the PNG header (warning only).
- **F8. Declared duplicate links** are imported with the package `reason` and `marked_by` = actor. They are counted separately (`duplicates.declared`) from the importer's own exact-match suggestions.
- **F9. `readyForImport: false`** (biology pilot) is a warning, not a block, because a draft-only import is the review step. **More than one bank** per package is rejected.
- **F10. Test isolation.** `npm test` (`test:auth`) now runs the node:test suite in a freshly migrated disposable database (`scripts/test-disposable-database.js`, the same approach as `test-migration-cycle.js`). The developer database is never read or changed by the suite. This also exposed a latent bug in `password-auth.test.js`: an audit join was not scoped by `entity_type` and passed only because the identity sequences in `everest_db` had drifted apart.

Original assumptions:

1. **Package format.** No package schema existed in the repository, and no sample package was available (`import-packages/` is absent). The implemented format is the camelCase proposal in `docs/import-contract.md` §7, fixed in §9, with three concrete choices:
   - image blocks use `{ "type": "image", "asset": "<package id>" }`, and a raw DB `assetId` is rejected;
   - option and item labels are `label`;
   - a package is a directory or a ZIP with `manifest.json` at the root (or inside one top-level folder).
   A real Tajik/biology package may need a field mapping. Run a dry run first.
2. **One bank per package.** `question_imports.bank_id` is NOT NULL, so a run belongs to one bank. A book with several banks is several packages.
3. **Batches of up to 100 questions** (default 100, `--batch-size 1..100`), each in its own transaction. The **first failing batch stops the run**: it is rolled back and recorded with a single `IMPORT_BATCH_FAILED` (or AppError code) entry covering `questions[a..b]`. Later batches are counted as `notAttempted`, and the run ends as `failed`. Committed batches stay, and a re-run with a new key is idempotent through natural keys. The alternative, continuing after a failure, was rejected because it can cascade errors and makes the run state harder to reason about.
4. **Validation errors write nothing.** A real run whose planner finds any error returns `status: rejected` and records **no** run (exit code 2). Only runs that pass validation are recorded; a run row always has an existing bank, as the NOT NULL `bank_id` requires.
5. **Default idempotency key** = `package-<sha256>`. Re-running the same package without `--idempotency-key` replays the earlier result. To re-import after a failure or a published-question change, pass a new key. Allowed keys match `[A-Za-z0-9._:-]{1,200}`.
6. **A replayed run must be visible to the actor** (bank owner or administrator), otherwise `QUESTION_BANK_READ_ONLY`. A replay of a `failed` run returns that failed result. It does not resume the run.
7. **Taxonomy permissions.** Creating a missing subject, section or topic needs `taxonomy.manage` (teachers do not have it): `TAXONOMY_PERMISSION_REQUIRED`. Translation changes on existing entities are applied only with `taxonomy.manage`, otherwise they are skipped with a warning. Stored structure (primary language, color, section, parent) is never changed by an import (`TAXONOMY_FIELD_MISMATCH` warning). No ordering, description or external-ID columns were added: codes are the keys.
8. **An existing bank is never modified** by an import (title and visibility stay; `BANK_FIELD_MISMATCH` warning). Its subject must match.
9. **Answer key on re-import.** A `proposed` package key replaces the stored key. An `unknown` package key keeps any stored key: an import never erases an answer an author or reviewer entered. The stored explanation is kept in that case too. A verified key on an edited draft returns to `proposed` (the M08 reconcile rule).
10. **Images: bank-bound upload path = the importer service, not an HTTP endpoint.** Imported images are stored by `storage.uploadObject` (new `PutObject` method on the S3 adapter and the memory double) under the content-addressed key `question-imports/sha256/<hash>.png|jpg`. They are inserted as `ready` `material` assets with `processing_status = not_required`, `uploaded_by` = actor and `source_metadata = { importNamespace, bankId }`. They are not linked to a course.
   - Checks: PNG/JPEG only, magic bytes via the M07-A `inspectMedia`, 10 MiB per image, optional declared sha256 verified.
   - An HTTP bank-bound upload endpoint for the admin UI is deferred.
   - Objects are uploaded before the DB transaction. This is idempotent because the key is the hash; a failed transaction leaves at most an unreferenced object.
11. **Asset reuse across users.** An asset found by sha256 or by alias is reused even when another user uploaded it: presenting identical bytes proves possession of the content. Package images bypass `findUsableImageAssets` only because they can only be referenced through the package's own `assets[]`. The M08 rule still applies to every later API edit.
12. **Migration** `20261031030000000_add-question-import-support.js` (reversible):
   - a partial unique index `assets_sha256_key` on `assets (sha256) WHERE sha256 IS NOT NULL`, for race-safe content dedup. `sha256` was never filled before, so the index cannot conflict with existing rows;
   - an index `question_import_errors (import_id, id)` for paginated reports.
13. **`source_metadata` allowlist** (superseded by follow-up assumption F4 below): the first version added `chapter`, `variant` and `year` without a real package; `chapter` and `variant` were removed again because the real packages do not use them.
14. **Duplicate signature.** Same bank + same type + equal normalized content text (NFKC, lower case, whitespace collapsed; formulas, tables and images included by value) + equal unordered set of normalized option/matching texts. The new question links to the earliest matching question (`reason = 'import: same normalized text and options'`). A link in either direction prevents a second one. Note: a linked draft cannot be deleted through the API (`QUESTION_IN_USE`), and no API exists yet to remove links.
15. **Errors are per question, first error only**, the same as the M08 API. Messages contain codes, field names and identifiers (topic codes, asset IDs), never question text or answers. Plain database errors in a batch are reported as `database error <sqlstate>` without the driver message.
16. **Run scope for the read API:** administrators see all runs; others see runs of banks they own and runs they started. Out-of-scope runs return `404`. Dry runs are not stored, so they never appear in the API.
17. **Run status values used:** `importing` → `completed` | `failed`. `pending`, `validating` and `validated` (in the schema CHECK) are unused, and `is_dry_run` is always `false` for stored runs.
18. **Limits:** 512 MiB per package, 64 MiB per entry, 20,000 questions and 20,000 assets per package. These limits are not tuned against a real book.

## 2026-10-30 — OpenAPI 3.1 and Swagger UI (M-DOCS)

User decisions:

- Swagger UI is served at `/api/docs` and the JSON at `/api/docs/openapi.json`.
- In production it is off by default and enabled with `SWAGGER_ENABLED=true`. In development it is on by default.
- The supported sign-in flow is cookie login from Swagger. CSRF works through `X-CSRF-Token` + `Origin`.

Assumptions made without the user (please review):

1. **The spec is a JavaScript module** (`src/docs/openapi.js`), not hand-written YAML.
   - One `operation()` builder derives path parameters, security, the CSRF header, rate-limit and error responses from flags.
   - Repeated shapes are shared components, so ~133 operations are not duplicated by hand.
   - Paths are kept in Express syntax so the coverage test compares them directly.
2. **`swagger-ui-dist` 5.33.1 (exact pin), not `swagger-ui-express`.**
   - It is static files only, with no Express wrapper or extra transitive code.
   - A small controller serves an allowlist of three files (CSS, bundle, favicon) plus our own page and initializer. The package's demo `index.html`/petstore initializer is never exposed.
   - 5.33.1 was chosen because the newest release (5.34.0) was under two weeks old.
3. **`@seriousme/openapi-schema-validator` 2.11.0 (devDependency, exact pin)** validates against the official OpenAPI 3.1 JSON Schema. It is small (ajv-based) and supports 3.1 strictly.
4. **Drift protection** in `tests/unit/openapi.test.js`:
   - The spec is valid 3.1.
   - Registered Express routes and documented routes must match **both ways**.
   - Every documented error code must exist in `src/` (taxonomy codes built from a template are allowlisted).
   - Every authenticated mutation documents `X-CSRF-Token`.
   - `routes/index.js` exports `routeMounts` because Express 5 layers do not keep mount paths; the router and the test share that one table.
5. **Docs page hardening:**
   - Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, no inline scripts); the initializer is a separate same-origin script.
   - `nosniff` and `no-referrer`; `persistAuthorization: false`.
   - The page copies the readable `everest_csrf` cookie into `X-CSRF-Token` only for mutations on the same origin.
   - CORS, CSRF and rate limits are unchanged: docs routes are read-only GETs outside `/api/v1`.
6. **A disabled Swagger returns the generic `404 ROUTE_NOT_FOUND`**, so production does not reveal that docs exist.
7. **Bearer is documented, but login never returns tokens in JSON.** Bearer stays for non-browser clients; the browser flow is cookie-based. No real token appears in examples.
8. **`scripts/bootstrap-owner.js` was broken.** It imported a removed `accountAdminService` object (SyntaxError at start).
   - It now imports `bootstrapOwnerService`; there is no other change.
   - A unit test guards the import. The script was not run against `everest_db` because it would assign an owner.
9. **Repair:** M07-C had accidentally duplicated the top of `docs/api.md`, because a `$\`` sequence was interpreted by `String.replace`. It is repaired here. Doc edits now avoid `String.replace` with literal text.

## 2026-10-30 — Learner catalog enrichment (M07-C)

User decisions:

- `subjects.color` is a fixed palette key `green|blue|orange|purple|neutral` (CHECK constraint, default `neutral`), not hex. It is managed through the M08 subject API.
- Learner cards carry `subject { id, title, translations, color }`, `moduleCount` and `lessonCount`.
- No `testCount` until M10 and no slugs.
- `GET /profile` gains `telegramLinked`.

Assumptions made without the user (please review):

1. Counts cover published lessons in published modules, including modules the learner has not been granted. M07-B already shows locked module and lesson titles, so the count discloses nothing new. The old "locked modules expose no counts" note now means per-module counts only.
2. `subject` is `null` for a course without a subject (draft courses can have none; published courses require one since M05-A, so this covers legacy rows only).
3. `telegramLinked` is a boolean derived from `auth_identities`. No Telegram ID, username or profile data is returned.
4. The favorites list (`GET /courses/favorites`) is unchanged; it was not requested.

## 2026-10-30 — Taxonomy and question bank (M08)

User decisions: the milestone order is M08, then M07-C (learner catalog enrichment); M08 follows ROADMAP exactly.

The baseline schema already had every M08 table and trigger, so M08 adds APIs, validation and permissions. Migration `20261031010000000_add-question-bank-permissions.js` adds the five permissions and one CHECK constraint, and no tables.

### Assumptions made without the user (deny-by-default; please review)

1. **Permissions:**
   - `taxonomy.read` (owner, admin, teacher) and `taxonomy.manage` (owner, admin).
   - `questions.read` and `questions.manage` (owner, admin, teacher).
   - `questions.review` (owner, admin).
   - Students get none. Taxonomy is staff-only until M07-C exposes subjects in the learner catalog.
2. **Bank scope:**
   - Banks are not tied to courses, so `course_teachers.can_manage_questions` is not used yet (it becomes relevant with tests in M10).
   - Readable: administrators, the bank owner, and every staff member when `visibility = 'staff'`. Manageable: administrators and the owner only.
   - An unreadable bank returns `404`, never `403`.
   - `subjectId` of a bank is immutable, because questions reference `(bank_id, subject_id)`.
3. **Key confidentiality among staff:** `answerKey` (answer data and explanation) is returned only to actors who can manage the bank. Read-only staff see `keyStatus`. Audit metadata never contains answer data.
4. **`answer_data` references item keys, not row IDs.** This keeps keys valid across copies and item replacement. Formats per type are in `docs/api.md`. Numeric tolerance, short-text normalization and partial credit are grading policy and are deferred to M10/M11: a numeric key is one exact `value`.
5. **Verification:**
   - Only `questions.review` can verify, and only a `proposed` key.
   - The reviewer must attest `official_key` or `expert_review`. A new CHECK constraint makes `verified` + `ai_inference`/`none` impossible in the database too.
   - An administrator may verify a key they authored themselves. A four-eyes rule would block a small center; `verified_by` records who verified.
6. **Edits invalidate review:** any draft `PATCH` returns a `verified` key to `proposed`. If the edit removes items the key references, the key is reset to `unknown` (the explanation is kept) instead of the edit being blocked.
7. **Publication** (`questions.review`) requires a verified key that still validates against the current items, and every embedded asset still ready.
   - Topics are not required for publication; ROADMAP does not require them.
   - Archive is one-way (`published → archived`). Corrections use `copy`, which creates a draft with `source_question_id`. A copied key must be verified again.
8. **Deletion:** only drafts can be deleted, and only when no copy, test question or duplicate link references them. Taxonomy deletion relies on `RESTRICT` foreign keys and returns `*_IN_USE`.
9. **Rich question content** is a closed set of blocks: `text` with marks, `verse`, `formula` (LaTeX), `chemistry`, `table` and `image`.
   - Every block is rebuilt from an allowlist, so unknown properties are dropped by rejection, not stored.
   - Limits: 100 blocks and 64 KB per content value.
   - This differs from lesson blocks on purpose: question content needs formulas, chemistry, verse lines and images (documentation.md §13).
10. **Question images:** the image must be a ready PNG/JPEG that the author uploaded, that is already used in the same bank, or, for administrators, any such image.
   - Uploads are still course-bound (M07-A). A bank-bound upload path is left to M09, where book pages and assets are imported.
   - `question_assets` is recomputed from all content (question, items, explanation) on every write.
11. **Taxonomy:**
   - Titles live only in `*_translations`, and the primary-language title is mandatory.
   - Topic re-parenting locks the subject's topic rows and walks the ancestor chain in the same transaction (baseline note 18), so concurrent edits cannot create a cycle.
   - A section and a parent must belong to the same subject (`422 TAXONOMY_SUBJECT_MISMATCH`).
12. **Imports and duplicates:** imports, dry runs and duplicate detection stay in M09. `question_imports`, `question_import_errors` and `question_duplicate_links` have no API in M08.

## 2026-10-29 — Lessons, playback and offline licenses (M07-B)

### Seek-ready video policy (supersedes the M07-A remux decision)

User decision. It replaces M07-A items 5 and 7 and the "remux job" bullet below for every new upload:

- Only seek-ready video is accepted:
   - MP4 must have `moov` before `mdat` (fast start).
   - WebM must contain `Cues` before the first cluster.
   - QuickTime (`.mov` / `video/quicktime`) is refused at initiation (`400`). Content with the `qt  ` brand is rejected at completion.
- A non-seek-ready file is rejected with `422 VIDEO_NOT_SEEKABLE`. The message is "Export as MP4 with fast start (web optimized)"; for WebM it is "Export as WebM with cues at the start, or as MP4 with fast start (web optimized)". The object is deleted, and the asset is quarantined with `processing_error = 'VIDEO_NOT_SEEKABLE'`.
- No `asset.video.remux` jobs are created, and `background-job-repository` was removed because nothing uses it. The asset columns stay. New video assets get `processing_status = 'not_required'`; materials keep `'none'`.
- Playback requires `status = 'ready'` **and** `processing_status = 'not_required'`. Anything else returns `409 VIDEO_NOT_PLAYABLE`.
- Staff fix files before upload with `npm run video:faststart -- input [output.mp4]`. It wraps `ffmpeg -c copy -movflags +faststart` (no re-encode) and prints a clear error when ffmpeg is missing. The API server has no ffmpeg dependency.

### Assumptions made without the user (deny-by-default; please review)

1. Video assets uploaded under M07-A keep `processing_status = 'none'`, so they are not playable. The migration does not reclassify them: WebM Cues were never checked for those uploads. Only pre-production test data was affected.
2. **Superseded on 2026-10-29 (user decision): published lessons are edited directly.** Teachers and administrators should not have to understand statuses, so the earlier "draft-only editing" rule (`LESSON_NOT_EDITABLE`, archive → restore → edit → publish) was removed.
   - `PATCH`, chapters and resources work in draft, published and archived status, with the same `lessons.manage`/`canManageLessons` scope.
   - A published lesson must stay publishable. It cannot become `test` (`LESSON_TYPE_NOT_PUBLISHABLE`) or lose the video of a `video`/`mixed` lesson (`LESSON_VIDEO_REQUIRED`). A new video must be ready, seek-ready and from the same course.
   - Replacing the video is refused, with nothing changed, when existing chapters would start at or after the new video's end (`409 CHAPTERS_EXCEED_VIDEO_DURATION`, which replaces the earlier undocumented `CHAPTERS_OUT_OF_RANGE`).
   - Replacing the video revokes the lesson's active offline licenses for the old video in the same transaction (`access_lost`). The next download check reports the existing reason `video_unavailable`. Learner progress is not reset.
   - There are no version history, revision drafts or new tables. The existing audit events stay; `lesson.updated` also records `previousVideoAssetId` and `revokedLicenses` when the video changes.
   - Deletion is still allowed only for empty drafts. Ordering is allowed in every status.
3. Publication rules:
   - A `video` lesson needs a playable video (`LESSON_VIDEO_REQUIRED` / `VIDEO_NOT_PLAYABLE`).
   - `test` lessons cannot be published until the test engine exists (M10, `LESSON_TYPE_NOT_PUBLISHABLE`).
   - Only `video` and `mixed` lessons may have a video.
   - A lesson can be published inside a draft module, but learners see it only when the course, module and lesson are all published.
4. Content blocks are a closed set of plain-text types: `heading` (`level` 1–3), `paragraph`, `list` (`items`, `ordered`), `quote`, `code` (`language`), `callout` (`tone` info/warning/success), `divider`. The limits are 200 blocks, 20,000 characters per text field and 256 KB of JSON. Blocks cannot contain HTML or asset references; images are materials.
5. Lesson and chapter translations allow only `title` (languages `tg`, `ru`, `en`).
6. "Same course" asset rule: an asset qualifies if it was uploaded for that course, or if the lesson already references it. This second case exists because course copies reference source assets and are never duplicated.
7. Chapters need a lesson video. They are given in strictly increasing `startSeconds`, which also sets their positions. There are at most 100, and each must start before the video duration when the duration is known. Changing the video is refused when existing chapters would fall beyond the new duration. Removing the video is refused while chapters exist.
8. Materials are replaced as a full ordered list (at most 50). Each must be a `ready` material asset; a video cannot be a material.
9. "Empty draft" for deletion means no video, chapters, materials, progress, notes, offline licenses, activity events or test assignments.
10. Staff scope:
    - Owner/admin have `lessons.read` and `lessons.manage` on every course.
    - Teachers have both permissions, limited in the repository: they read lessons of assigned courses and manage only with `can_manage_lessons` (this deliberately differs from modules, which use `can_edit_course`).
    - A read-only teacher who tries to author gets `404 COURSE_NOT_FOUND`, the same as a missing course.
    - Staff preview playback and material URLs come from `/admin/...` routes and work for every lesson status.
11. Learner reads:
    - A learner sees lesson metadata only with a non-revoked enrollment in a published course and a published module and lesson. Otherwise they get `404`.
    - Without module access, the lesson detail is metadata only: no content, chapters, materials, video or progress.
    - Content routes (playback, materials, notes, progress, offline) return `403 MODULE_ACCESS_DENIED` through `requireModuleAccessService`.
12. Notes are owner-only. Reading, writing and deleting a note all need current module access. Each user can have 500 notes per lesson, each up to 10,000 characters. `playbackSeconds` must not exceed the known video duration.
13. Progress:
    - Writes carry `revision`. A stale revision returns `409 PROGRESS_REVISION_CONFLICT` with the current revision.
    - `watchedSeconds` never decreases. Both values are clamped to the video duration.
    - Completion is automatic at `watchedSeconds ≥ ceil(0.9 × duration)` and is never undone. A video whose duration is unknown never auto-completes.
    - Lessons without a video accept only `{ revision, completed: true }`.
    - Reading progress also needs current access, but rows are never deleted on expiry or revocation.
14. Favorites: `PUT`/`DELETE /courses/:courseId/favorite` (idempotent) and `GET /courses/favorites`. Only courses the learner can see (non-revoked enrollment in a published course) can be favorited or listed. Favorites grant nothing. There are no lesson favorites.
15. Signed URL TTLs: playback 30 min (inline), materials 5 min (attachment), offline download 15 min (attachment). The playback response carries `expiresAt`; the client calls the same endpoint again before expiry, and every call re-checks access.
16. A presigned S3 URL necessarily contains the bucket and object path, signed for `S3_PUBLIC_ENDPOINT`. The API never returns `storageKey`, the bucket or `S3_ENDPOINT` as fields. Keys are opaque UUID paths.
17. Signed media issuance (playback, material and offline download) is rate-limited per user: scope `learner.media`, `PLAYBACK_RATE_LIMIT`, default 120 per `AUTH_RATE_WINDOW_SECONDS`. Only denials (`lesson.playback.denied`, `lesson.material.denied`) and offline license events are audited.
18. Offline licenses:
    - A license covers the lesson video only. Materials are downloaded online.
    - The lease is the shortest of 3 days, the enrollment expiry and the module grant expiry.
    - A device is a live (not revoked, not expired) session holding an active license. A learner can have at most 2 devices; a third device gets `409 OFFLINE_DEVICE_LIMIT`.
    - Listing, download and deletion work only from the session that holds the license. Signing a session out frees its device slot.
    - Renewal and download re-run every check. When access is lost, the license is revoked with `access_lost` and the API returns `403 OFFLINE_ACCESS_DENIED` with `details[0].reason` set to one of `module_access`, `offline_not_allowed`, `video_unavailable`, `lesson_unavailable`, `license_revoked` or `license_expired`.
    - A license revoked by an administrator cannot be renewed from the same session. A license the learner deleted can be renewed.
    - Administrators list a user's licenses and revoke one with `lessons.offline.manage` (owner/admin only).
19. Course copy also copies every lesson as a draft (archived ones included, matching modules), with its chapters and materials. Assets are referenced, not duplicated. Progress, notes, offline licenses and favorites are never copied.
20. `.env.example` is still not editable from this session. Add `PLAYBACK_RATE_LIMIT` by hand together with the M07-A variables.

## 2026-10-29 — Media storage and multipart uploads (M07-A)

User decisions (2026-10-29):

- Storage is S3-compatible behind the provider-neutral adapter `src/providers/storage/`. Only `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are used; no vendor API. Switching MinIO → Garage or SeaweedFS is an environment change only (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, credentials, `S3_FORCE_PATH_STYLE`). `S3_ENDPOINT` is the backend-to-storage address; `S3_PUBLIC_ENDPOINT` is the host signed into browser URLs, because the host is part of the signature.
- Production storage will be a separate HostBrr server (4 TB RAID-6, Nginx + S3-compatible server). The domain comes later; locally everything runs on localhost.
- Upload is allowed to owner/admin (`assets.upload`) and to course teachers with `canManageLessons` for their own course. Everyone else is denied.
- Limits: 20 GiB per file. Video: mp4, mov, webm. Materials: pdf, docx, pptx, jpg/jpeg, png. The real type is verified from the stored bytes at completion.
- No multi-quality video, no HLS, no `asset_variants`. Videos are delivered in the uploaded quality as one file through a short-lived signed URL with Range support (delivery itself is M07-B). Completion validates container and codecs. `mov` files and `mp4` files without faststart get one `asset.video.remux` background job: remux to MP4 with faststart, no re-encode. M19 handles that job later.

MinIO finding (checked 2026-10-29): MinIO Community Edition went into maintenance mode in December 2025, and its GitHub repository was archived in February 2026. The README says critical security fixes are evaluated case by case and points users to the commercial AIStor. Vulnerabilities disclosed against the final community release (for example CVE-2026-39414 and CVE-2026-34204) are reported as not backported. Official community container images have reportedly been withdrawn from anonymous pulls. Consequences:

- MinIO is used only for local development, bound to `127.0.0.1`. It is never used in production.
- `docker-compose.yml` pins `minio/minio:RELEASE.2025-09-07T16-13-09Z`, reported as the last official container image. `MINIO_IMAGE` can point to a pinned community rebuild if the pull is refused. This tag could not be pulled or verified because Docker is not installed.
- Garage or SeaweedFS is the recommended production server. The choice is left to deployment (M21).

Assumptions made without the user (deny-by-default; please review):

1. Every upload belongs to a course (`courseId` is required). Uploads to archived courses are refused (`409 COURSE_ARCHIVED`). Draft and published courses are allowed.
2. A teacher must hold the `teacher` role **and** a `course_teachers` row with `can_manage_lessons`. When a teacher has no right for the course, the API returns `403` before it checks whether the course exists, so the response does not reveal which courses exist.
3. An existing upload is visible to holders of `assets.manage` (owner/admin) and to its creator. The creator sees it only while they can still upload to that course. Everyone else gets `404 UPLOAD_NOT_FOUND`.
4. The declared MIME type must match the file extension, and the detected type must equal the declared type. For example, a QuickTime file declared as `video/mp4` is rejected. Matroska that is not WebM is rejected.
5. Allowed codecs: video H.264 (`avc1`/`avc3`), HEVC (`hvc1`/`hev1`), AV1 (`av01`) and VP9 (`vp09`) in mp4/mov. Audio AAC (`mp4a`) or Opus. WebM allows VP8, VP9 or AV1 video with Opus or Vorbis audio. At least one video track is required. Tracks other than video and audio are ignored. Inspection is a pure-JS structural parser (ffprobe-style metadata, no decoding). ffmpeg is not required on the API server.
6. A rejected upload is marked `rejected`, its asset becomes `quarantined` with the rejection code, and the stored object is deleted. Rejection is final; the user must start a new upload.
7. Assets are `ready` once validated. `processing_status = 'pending'` marks a remux still owed. M07-B playback must require `status = 'ready'`. It must decide explicitly whether a `pending` remux may play; the deny-by-default proposal is to wait.
8. Server-chosen part size: `STORAGE_PART_SIZE_BYTES` (default 32 MiB), raised in whole MiB when needed so that a file never exceeds 10,000 parts. The part-count check runs again at completion.
9. The upload session expires after `STORAGE_UPLOAD_TTL_HOURS` (default 144 h, maximum 166 h). That is always before the storage server's 7-day abort of incomplete uploads. Expired uploads cannot be presigned or completed; they can only be aborted.
10. Presigned part URLs live for `STORAGE_PRESIGN_TTL_SECONDS` (default 900 s). At most 100 parts can be requested at once.
11. The storage server's part list is the source of truth. The client never sends ETags, and completion verifies the number and size of every part. Completion locks the upload row, so concurrent and repeated calls return the same asset. If storage completed but the database transaction failed, the retry detects the assembled object with HEAD and finishes.
12. Abort is idempotent for `aborted` and `rejected` uploads. A `completed` upload cannot be aborted (`409`). An aborted upload's asset becomes `archived`.
13. The user's file name is stored only in `assets.file_name`, after removing path segments and control characters. Storage keys are `courses/<courseId>/<kind>s/<uuid>.<ext>` and are never returned by the API.
14. MinIO CE has no bucket CORS API, so CORS (including a readable `ETag`) is set server-wide with `MINIO_API_CORS_ALLOW_ORIGIN`. The 7-day cleanup is guaranteed by `MINIO_API_STALE_UPLOADS_EXPIRY=168h`. `npm run storage:configure` also applies a standard lifecycle rule and CORS rule wherever the server supports them (for production Garage or SeaweedFS).
15. Upload, complete and abort reuse the authenticated CSRF check and the administrative mutation rate limit. Part presigning uses CSRF but no rate limit, because a 20 GiB upload makes many presign calls.
16. `.env.example` could not be edited from this session (file access denied). The new variables are documented in `docs/architecture.md` and must be added to `.env.example` by hand.

## 2026-10-29 — Course enrollments and module access grants (M06)

The user was unavailable for M06, so every ambiguity below was settled with the safest, most restrictive option (deny by default) and recorded here. Each item is an assumption the user may overturn; none changes the confirmed rules (groups independent from courses, separate course and module grants, expiry/revocation never deletes progress, locked modules expose only safe published metadata).

1. **Who manages grants.** Two new permissions, `courses.access.read` and `courses.access.manage`, are granted to `owner` and `admin` only. Course teachers, even with `canEditCourse`, receive neither, so a teacher cannot widen a student's access. Both codes are seeded by the reversible migration `20261029010000000_add-course-access-permissions.js`.
2. **Who can be enrolled.** The grantee must be an `active` account holding the `student` role. Pending, rejected, blocked, teacher-only and admin accounts get `409 ENROLLMENT_USER_INELIGIBLE`. Completed onboarding is not required to be granted, but `can_access_module` requires it to read protected content, and the learner view reports `onboarding_required`.
3. **Course and module must be published to be granted.** Enrollment requires a `published` course (`409 COURSE_NOT_PUBLISHED`). A module grant requires a `published` module in that course (`409 MODULE_NOT_PUBLISHED`). Existing grants are untouched when a course or module is later unpublished or archived; `can_access_module` blocks access while it is not published, and access returns when it is published again.
4. **Explicit validity windows.** `expiresAt` is required on every grant and extension. An ISO 8601 timestamp with a UTC offset sets an expiry; an explicit `null` means no expiry, so unlimited access is a deliberate choice and never an omission. `expiresAt` must be in the future and after `beginsAt`, and no later than the year 2100. `beginsAt` defaults to the server clock and may be in the future (state `scheduled`). The database `CHECK (expires_at > begins_at)` remains the last guard.
5. **Grant states.** `state` is computed in PostgreSQL as `revoked`, `scheduled`, `expired` or `active`, in that precedence.
6. **Extension.** `PATCH` changes only `expiresAt`. It works on `active`, `scheduled` and `expired` rows, so an expired grant is renewed by extending it. It is refused with `409 ENROLLMENT_REVOKED` / `409 MODULE_ACCESS_REVOKED` for a revoked row; the administrator must grant again. An extension may also shorten or remove an expiry; a shortened date must still be in the future (use revoke to end access now).
7. **Revocation and re-grant.** Revocation sets `revoked_at`/`revoked_by` and never deletes a row. Revoking twice returns `409 ENROLLMENT_ALREADY_REVOKED` / `MODULE_ACCESS_ALREADY_REVOKED`. A `POST` on a revoked row resets it in place (new grantor, `granted_at`, window, cleared revocation) because `UNIQUE (user_id, course_id)` and `UNIQUE (user_id, module_id)` allow one row; history lives in `audit_events` (`...granted` versus `...regranted`). A `POST` on a non-revoked row, even an expired one, is `409 ENROLLMENT_ALREADY_EXISTS` / `MODULE_ACCESS_ALREADY_EXISTS`; extend it instead.
8. **Revoking an enrollment revokes its module grants.** In the same transaction, all unrevoked module grants of that user and course are revoked, and the count is audited as `revokedModuleGrants`. Re-granting the course therefore never silently restores module access; each module must be granted again. Expiry, in contrast, is passive: an expired enrollment leaves module grant rows untouched, and `can_access_module` denies content while the enrollment is not current. Extending the enrollment makes grants that are still inside their own window effective again.
9. **Module grants require a current enrollment.** A module grant needs an enrollment in state `active` or `scheduled` (`409 ENROLLMENT_NOT_ACTIVE` otherwise). Containment of the module window inside the enrollment window is not enforced, because effective access is the intersection, which `can_access_module` already computes.
10. **Progress is never touched.** No grant operation writes or deletes progress, notes or attempts. The tests assert a `lesson_progress` fixture row survives module expiry, enrollment expiry, revocation and re-grant.
11. **Locked-module learner DTO.** Learners see `{ id, position, title, description, translations, access: { granted, lockReason } }` for the `published` modules of a `published` course in which they hold a non-revoked enrollment. No lessons, assets, tests, counts, grant dates, grantor or revocation facts are included. `lockReason` is one of `onboarding_required`, `not_started`, `expired`, `not_granted`, `unavailable`. A revoked module grant reports `not_granted` so the reason never discloses administrative history. A revoked enrollment, an unenrolled user, an unpublished course and an unknown course are indistinguishable (`404 COURSE_NOT_FOUND`); an expired enrollment still shows the course, with every module locked, so the learner can see why.
12. **Single source of truth.** Whether content is granted comes from the existing database function `can_access_module` (active account, completed onboarding, published course and module, both grants current). The API adds the live-session check through `authMiddleware`. The reusable guard `requireModuleAccessService` calls that function and throws `403 MODULE_ACCESS_DENIED`; M07 must call it before returning any lesson, asset or test content. No lesson, asset or test route is added in M06.
13. **Teachers and administrators.** Teacher or administrator access to protected learner content is not defined by M06. They read grants only through the administrative API and are denied by the learner guard unless they also hold grants; M07 must decide authoring and preview access explicitly.
14. **Concurrency.** Grants lock in a fixed order: course `FOR SHARE` (blocks a concurrent unpublish), module `FOR SHARE`, user `FOR SHARE` (blocks a concurrent block/state change), then the enrollment and grant rows `FOR UPDATE`. Inserts use `ON CONFLICT DO NOTHING`, so two simultaneous grants yield one `201` and one `409`, never a `500`. Audit events are written in the same transaction as every change.
15. **Scope.** No `group_courses`, lessons, videos, progress, tests or AI code was added. The learner endpoints are limited to the learner's own courses and published module structure.

## 2026-10-28 — Course modules, preview and copying (M05-B)

User-approved rules:

- **Module lifecycle.** The only transitions are `draft → published → archived` and `archived → draft`. A module can be published in any course; student visibility is decided later by course status and M06 grants.
- **Deletion.** Only a `draft` module with no `lessons` rows can be deleted. Checking the existing `lessons` table keeps this rule correct after M07. Modules with lessons can only be archived.
- **Ordering.** A new module is appended at `max(position) + 1`. Archived modules keep their position, and deletion may leave gaps. Reordering takes the complete module-ID list and is validated for completeness, duplicates, and foreign IDs. Because `UNIQUE (course_id, position)` is not deferrable, reordering runs in one transaction in two passes: first shift every position above the current maximum, then assign `1..n`.
- **Preview.** Preview is read-only and available to owner/admin and any teacher assigned to the course. It shows structure and counts only: no progress, no locks, and no access grants.
- **Copying.** A copy is a `draft` course whose modules are all `draft`. Translations are copied. Teachers, enrollments, module grants, and progress are not copied. The whole copy runs in one transaction.

Two schema decisions also apply:

- **No course code.** `courses` has no `code` column, so the user chose a title-only copy. The default title is `<title> (copy)`, trimmed to 200 characters, and no schema change was made.
- **Who manages modules.** Module management follows the M05-A edit rule. `courses.modules.manage` is granted to owner/admin/teacher, and the repository scopes teachers to assignments with `can_edit_course`. `courses.copy` is owner/admin only.

The copy is built as an ordered list of copy steps in `course-module-service.js`. The modules step fills a source-to-copy module ID map so that M07 can add lesson, video, chapter, and material steps.

Implementation choice: the copy includes archived modules, as `draft` with their original positions, so the course structure and numbering stay identical.

## 2026-10-27 — Course catalog lifecycle and explicit teacher editing

M05 is split into M05-A catalog/lifecycle/teacher assignments and M05-B modules/order/preview/copying. M05-A exposes only the existing course catalog columns and uses dedicated publish/unpublish commands instead of accepting `status` through general PATCH. Publication requires title and subject; the schema's `archived` state remains documented but has no M05-A route.

The baseline `course_teachers` flags describe downstream lesson, question, test, and result capabilities but do not explicitly authorize editing course metadata. Migration `20261027020000000_add-course-management-permissions.js` therefore adds `can_edit_course BOOLEAN NOT NULL DEFAULT FALSE` plus five action permissions. Teachers receive only `courses.read` and `courses.update`; an assignment scopes reads, and `can_edit_course` independently scopes updates. Publication and teacher management remain owner/admin-only. Assignment removal is destructive because the published table has no lifecycle/history columns; a later assignment is a new row.

## 2026-10-27 — Group administration and text announcements

M04-B adds five database-backed actions: `groups.create`, `groups.update`, `groups.members.manage`, `groups.teachers.manage`, and `groups.announcements.manage`. Owner/admin roles receive all five. Teachers receive only announcement management, and the service additionally requires a current target-group assignment with `can_publish_announcements`; a global role grant alone never authorizes another group's resource.

Student membership removal changes the existing membership status to `removed` and records `left_at`; re-adding reactivates that same unique row. The published teacher-assignment schema has no lifecycle status/history columns, so removal deletes only that assignment. Announcement deletion archives the existing row. Announcement content is text encoded in the existing JSONB block shape; assets remain excluded until M07. Every successful mutation and its audit event share one transaction, and group relationships never create course or module grants.

## 2026-10-26 — Relationship-scoped group reads

M04-A uses current database state for every group read. An active `group_members` row grants that student visibility; a `group_teachers` assignment grants that teacher visibility; current `owner` and `admin` role assignments grant administrative read visibility. No permission-management API or new permission seed is needed for the read-only increment. Missing and inaccessible group IDs intentionally share `404 GROUP_NOT_FOUND` to prevent resource enumeration.

Member counts and rosters include only active memberships. Teacher assignments have no status column, so every existing assignment is current. Roster queries combine access and pagination in one SQL statement to avoid a revocation race. Groups remain organizational only and never create course enrollments or module grants.

## 2026-10-26 — Schema-driven profile onboarding

M03 reuses `users`, `user_profiles`, `user_phones`, `user_roles`, `roles`, and the existing avatar asset FK without a migration. The current schema has no student/teacher profile extension, grade/class, educational direction, learning goal, or display-name column. Those fields are not invented; `displayName` is derived from first and last name, and the avatar asset ID remains read-only until an authorized upload flow exists.

Onboarding requires only non-null `firstName` and `lastName`, matching the baseline's explicit service-level requirement. Completion never changes account status and is allowed only for an active account. The frontend language contract uses `ru`, `tj`, and `en`; API `tj` is translated to the existing database constraint value `tg` so the published baseline remains unchanged.

## 2026-10-26 — Persistent authentication throttles and session-bound CSRF

M02F-B uses one PostgreSQL `auth_security_counters` table for process-independent atomic fixed-window counters. Counter keys are HMAC-SHA-256 values derived from server configuration; plaintext account identifiers and credentials are never stored. Public authentication and administrator mutation routes have IP/action limits, while password login also uses a normalized-phone account counter with five attempts and a 15-minute lockout. Successful login removes that account counter. Stable limit responses are `429 AUTH_RATE_LIMITED` plus `Retry-After`.

Cookie-authenticated mutations use a random 32-byte CSRF token created with the session. Only its SHA-256 hash is stored on `auth_sessions`; the browser receives the token in a readable `everest_csrf` cookie and echoes it in `X-CSRF-Token`. The server also requires an exact configured CORS origin. The token remains stable through refresh rotation because the PostgreSQL session is the security boundary and is invalidated when that session is revoked or expires. Bearer requests and genuinely public authentication/recovery endpoints are exempt.

## 2026-10-26 — Database-backed action permissions

M02F-A adds `permissions` and `role_permissions` as the reusable RBAC foundation. Runtime authorization resolves current database assignments on every protected request through repository-owned SQL; permissions are not embedded in JWTs, so assignment changes take effect without waiting for token expiry. Middleware selects the required action, the service makes the authorization decision, and repositories only answer persistence questions.

Only already-approved account-administration semantics are seeded: `accounts.pending.read`, `accounts.approve`, `accounts.reject`, `accounts.block`, and `accounts.unblock` belong to `owner` and `admin`. Existing routes, authentication ordering, `403 ADMIN_ROLE_REQUIRED`, business transactions, and audit behavior remain unchanged. No owner bypass or implicit role hierarchy exists, and no teacher/student or unresolved domain/resource permission is inferred. Permission-management APIs, rate limiting, brute-force controls, and CSRF remain outside M02F-A.

## 2026-10-25 — Password recovery proof and provider boundary

M02E returns a random opaque challenge identifier for every syntactically valid recovery request, including unknown and ineligible phones. Only its SHA-256 hash is stored for eligible delivery, so the public contract does not expose sequential IDs, account existence, Telegram linkage, throttling, or provider outcomes. Six-digit codes use cryptographic randomness and an HMAC-SHA-256 verifier keyed by `OTP_HMAC_SECRET`; defaults are a 10-minute expiry, five attempts, a 60-second resend cooldown, and five created challenges per account/channel/hour. Creating an eligible challenge invalidates every earlier active password-recovery challenge for that user.

Successful verification consumes the code and installs a separate opaque 32-byte reset authorization with only its SHA-256 hash and 10-minute expiry stored. PostgreSQL row locks serialize verification and reset. Password replacement, reset consumption, all-session/refresh revocation, and audit persistence share one transaction. Recovery is permitted for active, pending, and blocked password accounts but never changes status or roles; rejected accounts are ineligible.

Telegram delivery requires both a verified Telegram login identity and the existing active bot connection. SMS has a narrow provider interface and test double, but the production provider remains deliberately disabled because none is approved. Production SMS delivery is not claimed as implemented. The incremental migration adds Telegram challenge support plus public/reset hashes and reset expiry/consumption fields without changing the 13 published migrations.

## 2026-10-25 — Session lifecycle and refresh-token family

M02D keeps the access JWT at 15 minutes by default and adds a configurable 30-day refresh/session lifetime. Each PostgreSQL `auth_sessions` row is one refresh-token family. Refresh secrets are 32 random bytes encoded as base64url; only SHA-256 hashes are stored. Successful refresh locks the token, session, and user rows, marks the token used, inserts one replacement with the family's original expiry, updates `last_used_at`, and issues a new access JWT. Concurrent use permits at most one rotation.

Presenting a used or revoked refresh token is treated as reuse: the session and every family token are revoked and an audit event is committed before a stable unauthorized response. This also invalidates any descendant issued by a competing request. No replacement-link migration is needed because the session is the family boundary and retained token history provides replay evidence.

Browser authentication uses HttpOnly `everest_access` and `everest_refresh` cookies. The refresh cookie is restricted to `/api/v1/auth`; both cookies use `SameSite=Lax`, explicit expiry, no Domain attribute, and `Secure` in production. Logout clears cookies with matching attributes. SameSite and restricted CORS reduce exposure but do not constitute complete CSRF protection; explicit CSRF/origin hardening remains M02F.

Sessions retain the bounded login User-Agent already captured by the shared issuer and the direct request IP selected by Express without trusting forwarded headers. APIs expose only coarse browser/OS/device labels and no IP. `last_used_at` updates on every successful refresh and at most once per 60 seconds during access authentication.

## 2026-10-25 — Cross-platform migration-source verification

The exact migration-source integrity comparison normalizes only CRLF or CR line endings to LF before comparing and hashing SQL. Indentation, blank lines, tokens, comments, capitalization, and statement order remain exact. Root `.gitattributes` enforces LF for source and documentation files. No published migration content was changed.

## 2026-10-25 — Account approval administration boundary

M02C introduces only the administrator authorization needed by account-state routes: an authenticated active session plus a current `owner` or `admin` assignment queried from `user_roles`. General RBAC remains M02F. Account transitions are non-idempotent state-machine operations serialized with a row lock and audited atomically. Blocking revokes all live sessions in the same transaction; unblocking never restores them.

The initial owner is assigned only through the local `bootstrap:owner` CLI. It selects an already registered phone, takes a transaction-scoped advisory lock, refuses when any owner exists, activates the selected account, assigns the owner role, and audits the operation. It is not an HTTP endpoint or startup action.

## 2026-10-25 — Numeric internal identifier foundation

Before production data existed, M01R explicitly replaced the development migration baseline's UUID entity identifiers. Entity `id` primary keys now use `BIGINT GENERATED BY DEFAULT AS IDENTITY`; internal foreign keys, one-to-one keys, composite relationship columns, function parameters, and polymorphic audit references use `BIGINT`. PostgreSQL generates entity IDs and repositories return them with `RETURNING`; services do not generate database entity IDs.

Node `pg` returns `BIGINT` values as strings. JWT `sub`/`sid` and API identifiers therefore use canonical positive decimal strings bounded to PostgreSQL `BIGINT`, without conversion through JavaScript `Number`. Numeric identifiers are not promised to be sequential or gapless and are never renumbered.

Randomness remains where it is part of a security or external protocol rather than entity identity: OAuth state, nonce, PKCE verifier and encryption IVs, password salts, token hashes, and provider identifiers. `sms_deliveries.idempotency_key` remains the sole UUID database column because it is an opaque retry key. The migration-cycle script also uses a random UUID only to create a collision-resistant disposable database name.

The rewrite was permitted only after confirming the local development database contained no application data beyond role seeds and taking a `pg_dump` backup. `everest_db` was dropped/recreated and migrated from the rewritten baseline; destructive rollback testing ran only against a separately created disposable database.

## 2026-10-24 — Native JavaScript ES Modules

EVEREST uses native JavaScript ES Modules throughout the backend. `package.json` declares `"type": "module"`; local imports include `.js` extensions. This explicit decision replaces the earlier provisional CommonJS fallback for an empty repository.

## 2026-10-24 — Database configuration

Application and migration processes use the same validated `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` settings from `src/configs/env.js`. `DATABASE_URL` is not required. TLS is opt-in through `DB_SSL`; certificate verification is not disabled implicitly.

## 2026-10-24 — Migration rollback safety

Initial migrations have destructive `down` operations and are intended for disposable databases only. The migration runner permits `down` only when the configured database name clearly contains `test`, `tmp`, `temp`, or `disposable`. Down migrations reverse dependencies without `CASCADE`.

## 2026-10-24 — Telegram OIDC identity and session boundary

Telegram login uses the provider's OpenID Connect Authorization Code Flow with PKCE S256 and discovery metadata. The fixed expected issuer is `https://oauth.telegram.org`; ID tokens require a valid signature, audience, expiry, nonce, and non-empty subject. Only the verified `(provider, issuer, subject)` tuple is a login identity. Phone, username, and chat ID are never used to merge users.

Temporary authorization records store SHA-256 hashes of state and nonce. The PKCE verifier is encrypted with AES-256-GCM using a key derived from the configured Telegram client secret. Records expire, are atomically consumed exactly once before code exchange, and distinguish login from authenticated account linking.

Telegram login identity remains in `auth_identities`; bot messaging permission remains separately in `telegram_connections`. A verified `telegram:bot_access` grant may create or reactivate the connection. Unlinking is rejected when Telegram is the user's last login method. Link/unlink writes and audit events share one PostgreSQL transaction.

Successful login creates an `auth_sessions` row and an EVEREST HS256 session token. The callback puts the token in an `HttpOnly`, `SameSite=Lax` cookie and does not include it in JSON. Every authenticated request verifies both the token and the live, unrevoked session plus active account status.

## 2026-10-25 — Phone/password registration and login boundary

M02B registration accepts a normalizable E.164 phone, first and last names, and a password. It creates a pending user, profile, unverified non-primary phone, password credential, student role, and audit event atomically. Registration neither verifies phone ownership nor creates a session; phone verification and account approval remain later milestones.

Passwords must be 12–128 Unicode characters and contain at least one letter and one number. They are hashed asynchronously with Node.js `scrypt` using a random 16-byte salt, cost `N=16384`, `r=8`, `p=1`, and a 64-byte derived key. Stored hashes are self-describing. Verification uses `timingSafeEqual`, and unknown-phone login verifies against a valid dummy hash to reduce timing differences.

Password login uses a generic invalid-credentials response for unknown phones and wrong passwords. A correct password still requires an active account. Session creation, `last_login_at`, and a successful-login audit share one transaction; the access token uses the same server-side session and HttpOnly cookie contract as Telegram login.
