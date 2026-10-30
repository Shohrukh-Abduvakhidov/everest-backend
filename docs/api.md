# Implemented API

## Taxonomy APIs (M08)

All routes are under `/api/v1/admin`, need a live session, and are staff-only. Reads need `taxonomy.read` (owner, admin, teacher). Writes need `taxonomy.manage` (owner, admin), the CSRF check and the administrative rate limit, and are audited atomically (`taxonomy.subject|section|topic.created|updated|deleted`).

- `GET /subjects` → `{ subjects: [subject] }`, ordered by code.
- `POST /subjects` → `201 subject`. Body: `{ code, primaryLanguage?: tg|ru|en (default tg), translations }`.
- `PATCH /subjects/:subjectId` → `subject`. Partial body with the same fields. `translations` replaces the whole set.
- `DELETE /subjects/:subjectId` → `{ id, status: 'deleted' }`. A subject that is still referenced (sections, topics, courses, banks, questions) returns `409 SUBJECT_IN_USE`.
- `GET|POST /subjects/:subjectId/sections`, `PATCH|DELETE /sections/:sectionId`: same contract for sections.
- `GET|POST /subjects/:subjectId/topics`, `PATCH|DELETE /topics/:topicId`: same contract for topics, plus `sectionId` and `parentId` (both nullable). The list is flat; build the tree from `parentId`.

Shapes:

- `subject` = `{ id, code, primaryLanguage, title, translations: { tg|ru|en: { title } } }`. `title` is the title in the primary language.
- `section` = `subject` plus `subjectId`.
- `topic` = `section` plus `sectionId` and `parentId`.

Rules:

- `code` matches `^[a-z0-9][a-z0-9_-]{0,49}$`. It is unique globally for subjects and within the subject for sections and topics (`409 SUBJECT|SECTION|TOPIC_CODE_CONFLICT`).
- `translations` must contain the primary language. Titles are 1–200 characters.
- A section or parent from another subject returns `422 TAXONOMY_SUBJECT_MISMATCH`. A parent that would create a cycle (including the topic itself) returns `409 TOPIC_CYCLE`.
- Other errors: `400 INVALID_SUBJECT_ID|INVALID_SECTION_ID|INVALID_TOPIC_ID`, `404 SUBJECT|SECTION|TOPIC_NOT_FOUND`, `409 SECTION_IN_USE|TOPIC_IN_USE`.

## Question bank APIs (M08)

All routes are under `/api/v1/admin` and are staff-only. Students have none of these permissions.

| Permission | Roles | Purpose |
|---|---|---|
| `questions.read` | owner, admin, teacher | List and read readable banks and questions |
| `questions.manage` | owner, admin, teacher | Create banks; author drafts and answer keys in banks the actor manages |
| `questions.review` | owner, admin | Verify answer keys, publish, archive |

Bank scope:

- Readable: administrator (owner/admin role), bank owner, or `visibility = 'staff'`.
- Manageable: administrator or bank owner.
- An unreadable bank or question returns `404 QUESTION_BANK_NOT_FOUND` / `QUESTION_NOT_FOUND`.
- A readable bank the actor cannot manage returns `403 QUESTION_BANK_READ_ONLY` for writes.

Mutations use the CSRF check and the administrative rate limit, and are audited atomically (`question_bank.*`, `question.*`, `question.answer_key.*`). Audit metadata never contains answer data.

Banks:

- `GET /question-banks?subjectId&limit&offset` → `{ banks: [bank], pagination }`.
- `POST /question-banks` → `201 bank`. Body: `{ code, title, subjectId, visibility?: private|staff (default private), sourceMetadata? }`. The creator becomes the owner.
- `GET /question-banks/:bankId` → `bank`.
- `PATCH /question-banks/:bankId` → `bank`. Body: `{ code?, title?, visibility?, sourceMetadata? }`. `subjectId` cannot change.
- `bank` = `{ id, code, title, subjectId, ownerId, visibility, sourceMetadata, questionCount, permissions: { manage }, createdAt }`. A duplicate code returns `409 QUESTION_BANK_CODE_CONFLICT`.

Questions:

- `GET /question-banks/:bankId/questions?status&questionType&languageCode&keyStatus&topicId&limit&offset` → `{ questions: [summary], pagination }`.
   - `summary` = `{ id, externalId, questionType, languageCode, difficulty, difficultySource, status, keyStatus, content, updatedAt }`.
- `POST /question-banks/:bankId/questions` → `201 detail` of a new draft (manage).
- `GET /questions/:questionId` → `detail`.
- `PATCH /questions/:questionId` → `detail`. Drafts only, partial; `questionType` cannot change. `options`, `matching` and `topicIds` replace the whole list.
- `DELETE /questions/:questionId` → drafts only. A draft referenced by a copy, a test or a duplicate link returns `409 QUESTION_IN_USE`.
- `POST /questions/:questionId/copy` → `201 detail` of a new draft in the same bank: `sourceQuestionId` is set, `externalId` is `null`, and the content, items, topics and assets are copied. A copied key becomes `proposed` (or stays `unknown`) and must be verified again.
- Writes to a published or archived question return `409 QUESTION_IMMUTABLE`. Use copy instead.

Question body:

- `questionType`: `single_choice|multiple_choice|matching|numeric|short_text` (create only).
- `languageCode`: `tg|ru|en`, default `tg`.
- `externalId`: optional, unique within the bank (`409 QUESTION_EXTERNAL_ID_CONFLICT`).
- `difficulty` (1–5) and `difficultySource` (`ai|expert|official`): both or neither.
- `content`: rich content (below), at least one block.
- `sourceMetadata`: `{ book?, edition?, page? (positive integer), number?, note? }`.
- `topicIds`: up to 20 distinct topics of the bank's subject (`422 TAXONOMY_SUBJECT_MISMATCH`).
- Choice questions require `options: [{ key, content, sourceLabel? }]` (2–10 items).
- Matching questions require:
   - `matching: { left: [item], right: [item] }` (1–20 items per side);
   - `interactionSettings: { requireAllLeft: boolean, allowRightReuse: boolean }`.
- Other types must not send `options`, `matching`, or a non-empty `interactionSettings`.
- Item keys match `^[A-Za-z0-9_-]{1,20}$` and are unique per list. Positions follow array order. Options have no correctness field: unknown fields such as `isCorrect` return `400`.

Rich content is `{ blocks: [...] }`, with at most 100 blocks and 64 KB of JSON. Allowed blocks:

- `text{text, marks?: bold|italic|underline|subscript|superscript}`
- `verse{lines}`
- `formula{latex, display?}`
- `chemistry{formula}`
- `table{rows: string[][]}`
- `image{assetId, alt?}`

An image must be a `ready` PNG/JPEG asset that the actor uploaded, that is already used in the same bank, or, for administrators, any such asset. Otherwise the request returns `422 QUESTION_ASSET_NOT_USABLE`. `assetIds` in the detail is kept in sync automatically.

`detail` = `{ id, bankId, subjectId, externalId, questionType, languageCode, difficulty, difficultySource, status, content, interactionSettings, sourceMetadata, sourceQuestionId, importId, createdBy, createdAt, updatedAt, options: [{ key, position, sourceLabel, content }], matching: { left, right }|null, topicIds, assetIds, keyStatus, answerKey? }`. `answerKey` = `{ status, source, answerData, explanation, verifiedBy, verifiedAt }` and is present only for actors who can manage the bank. Read-only staff see `keyStatus` only.

Answer keys and review:

- `PUT /questions/:questionId/answer-key` (manage, drafts only) → `detail`. Body: `{ answerData, source, explanation? }`.
   - `answerData: null` stores `unknown`; `source` must then be omitted or `none`.
   - Otherwise the key becomes `proposed`, and `source` must be `official_key|expert_review|ai_inference`.
   - `answerData` per type references item **keys**:
      - `single_choice`: `{ optionKey }`
      - `multiple_choice`: `{ optionKeys: [...] }` (distinct, non-empty)
      - `matching`: `{ pairs: [{ left, right }] }` (each left item at most once; all left items when `requireAllLeft`; distinct right items unless `allowRightReuse`)
      - `numeric`: `{ value: number }`
      - `short_text`: `{ acceptedAnswers: [...] }` (1–20 distinct)
   - Invalid references return `400 ANSWER_KEY_INVALID`.
- `POST /questions/:questionId/answer-key/verify` (review) → `detail`. Body: `{ source: official_key|expert_review }`. Only a `proposed` key can be verified (`409 ANSWER_KEY_NOT_PROPOSED`). AI inference is never a verified source.
- Any draft `PATCH` returns a `verified` key to `proposed`. If the key no longer matches the items, it is reset to `unknown`. The audit event records `keyChange`.
- `POST /questions/:questionId/publish` (review) → `draft → published`.
   - Fails with `409 QUESTION_NOT_PUBLISHABLE`, where `details[0].message` is one of `ANSWER_KEY_NOT_VERIFIED`, `ANSWER_KEY_INVALID` or `ASSET_NOT_READY`.
   - Database triggers enforce the same guards and immutability independently.
- `POST /questions/:questionId/archive` (review) → `published → archived`, irreversible.
- Other transitions return `409 INVALID_QUESTION_TRANSITION`.

Other errors: `400 INVALID_QUESTION_BANK_ID|INVALID_QUESTION_ID|VALIDATION_ERROR`.

## Lesson authoring APIs (M07-B)

All routes are under `/api/v1/admin/courses/:courseId`. They need a live session plus `lessons.read` (reads) or `lessons.manage` (writes), and the repository limits each actor to their scope:

- Owner/admin: every course.
- Teachers: courses they are assigned to; managing also needs `canManageLessons`.
- A course outside the actor's scope returns the same `404 COURSE_NOT_FOUND` as a missing course.

Mutations use the CSRF check and the administrative mutation rate limit, and are audited atomically (`lesson.*`).

- `GET /modules/:moduleId/lessons` → `{ lessons: [summary] }`, in order.
- `POST /modules/:moduleId/lessons` → `201` detail of a new draft appended at the end.
   - Body: `{ title, lessonType: video|text|test|mixed, content?, translations?, videoAssetId?, allowOffline? }`.
- `PUT /modules/:moduleId/lessons/order` → `{ lessonIds }`. Every lesson of the module must be listed exactly once, otherwise `409 LESSON_ORDER_MISMATCH`.
- `GET /lessons/:lessonId` → detail plus `relationship.canManage`.
- `PATCH /lessons/:lessonId` → partial update in any status (draft, published, archived). Learners see changes to a published lesson immediately.
   - Published lessons must stay publishable: they cannot become `test` lessons (`409 LESSON_TYPE_NOT_PUBLISHABLE`) or lose the video of a `video`/`mixed` lesson (`409 LESSON_VIDEO_REQUIRED`).
   - A new video must be ready, seek-ready and from the same course. If existing chapters would start at or after the new video's end, the request fails with `409 CHAPTERS_EXCEED_VIDEO_DURATION` and nothing changes.
   - Replacing the video revokes active offline licenses for the old video in the same transaction. Their next check returns `403 OFFLINE_ACCESS_DENIED` with reason `video_unavailable`. Progress is kept.
- `POST /lessons/:lessonId/publish`, `/archive`, `/restore` → `draft → published → archived → draft`. Other transitions return `409 INVALID_LESSON_TRANSITION`. Publication can also return `409 LESSON_VIDEO_REQUIRED`, `LESSON_TYPE_NOT_PUBLISHABLE` (test lessons) or `VIDEO_NOT_PLAYABLE`.
- `DELETE /lessons/:lessonId` → empty drafts only (`409 LESSON_NOT_DELETABLE`).
- `PUT /lessons/:lessonId/chapters` → atomically replaces `{ chapters: [{ startSeconds, title, translations? }] }` in any status.
   - `startSeconds` must be strictly increasing and below the video duration. There are at most 100 chapters, and a video is required (`409 LESSON_HAS_NO_VIDEO`).
- `PUT /lessons/:lessonId/resources` → atomically replaces `{ resources: [{ assetId, title? }] }` in any status, at most 50. Each item must be a ready material asset of the course.
- `GET /lessons/:lessonId/playback` → staff preview `{ playback, chapters }`, for any status.
- `GET /lessons/:lessonId/resources/:resourceId/download` → staff material URL.
- `GET /api/v1/admin/users/:userId/offline-licenses` and `POST /api/v1/admin/offline-licenses/:licenseId/revoke` (`lessons.offline.manage`, owner/admin) list a user's licenses and revoke one (idempotent, `admin_revoked`).

Field rules:

- `content` = `{ blocks: [...] }`. Allowed blocks: `heading{text,level}`, `paragraph{text}`, `list{items,ordered}`, `quote{text}`, `code{text,language}`, `callout{text,tone}`, `divider`.
- `translations` = `{ tg|ru|en: { title } }`.
- `videoAssetId` is allowed only for `video` and `mixed` lessons. It must be a ready, seek-ready video of the same course; the asset already on the lesson also qualifies.

Detail = `{ id, moduleId, courseId, title, position, lessonType, translations, content, videoAssetId, video: { assetId, mimeType, durationSeconds, widthPx, heightPx, sizeBytes, playable }|null, allowOffline, status, chapters: [{ id, startSeconds, title, translations, position }], resources: [{ id, assetId, title, position, fileName, mimeType, sizeBytes }], createdAt, updatedAt }`.

Course copy (`POST /api/v1/admin/courses/:courseId/copy`) now also copies lessons as drafts with their chapters and materials. The response is `copied: { modules, lessons, chapters, resources }`. Assets are referenced; learner data is never copied.

## Learner lesson APIs (M07-B)

All routes are under `/api/v1/courses`. They need a live session.

Visibility:

- Lessons are visible only within a course where the learner has a non-revoked enrollment, and only when the course, module and lesson are all published. Otherwise the API returns `404 LESSON_NOT_FOUND` / `COURSE_NOT_FOUND`.
- Protected routes call `requireModuleAccessService` on every request and return `403 MODULE_ACCESS_DENIED` without access.

Routes:

- `GET /:courseId/modules/:moduleId/lessons` → `{ lessons: [{ id, moduleId, title, position, lessonType, translations, access: { granted } }] }`.
- `GET /:courseId/lessons/:lessonId`:
   - Without access: summary only.
   - With access: also `content`, `allowOffline`, `video: { durationSeconds, playable }`, `chapters`, `resources: [{ id, title, position, fileName, mimeType, sizeBytes }]` and `progress`.
- `GET /:courseId/lessons/:lessonId/playback` (per-user rate limit) → `{ playback: { url, expiresAt, mimeType, durationSeconds }, chapters }`.
   - The URL is signed for 30 minutes with inline disposition and supports Range requests. Call the endpoint again before `expiresAt` to refresh.
   - Errors: `403 MODULE_ACCESS_DENIED` (audited), `409 VIDEO_NOT_PLAYABLE`, `429`.
- `GET /:courseId/lessons/:lessonId/resources/:resourceId/download` (rate limited) → `{ download: { url, expiresAt, fileName, mimeType } }`, valid 5 minutes, attachment disposition.
- `GET|POST /:courseId/lessons/:lessonId/notes` and `PATCH|DELETE /:courseId/lessons/:lessonId/notes/:noteId` work on the caller's own notes only, with body `{ body, playbackSeconds? }`.
   - Another user's note returns `404 NOTE_NOT_FOUND`. A full lesson returns `409 NOTE_LIMIT_REACHED` (500).
- `GET|PUT /:courseId/lessons/:lessonId/progress`:
   - Video lessons take `{ revision, playbackSeconds, watchedSeconds }`. Values are clamped to the duration, watched time never decreases, and the lesson completes at 90%.
   - Other lessons take `{ revision, completed: true }`.
   - A stale revision returns `409 PROGRESS_REVISION_CONFLICT` with `details[0].revision`.
   - Progress = `{ status, playbackSeconds, watchedSeconds, completedAt, revision, updatedAt }`.
- `GET /favorites`, `PUT /:courseId/favorite` and `DELETE /:courseId/favorite` manage course bookmarks (idempotent). Favorites never grant access.
- `POST /:courseId/lessons/:lessonId/offline-license` (CSRF, rate limited), body `{ deviceLabel? }`, creates or renews the license for the current session. Returns `{ license, download: { url, expiresAt, mimeType, sizeBytes } }`; the download URL is valid 15 minutes with attachment disposition.
   - The lease is at most 3 days and never beyond the enrollment or module grant expiry. A learner can use at most 2 devices (`409 OFFLINE_DEVICE_LIMIT`).
   - When access is gone, the API returns `403 OFFLINE_ACCESS_DENIED` with `details[0].reason` set to `module_access`, `offline_not_allowed`, `video_unavailable`, `lesson_unavailable`, `license_revoked` or `license_expired`. The PWA must then delete its files.

Offline licenses of the current session are under `/api/v1/offline-licenses`:

- `GET /` → the session's active licenses.
- `GET /:licenseId/download` (rate limited) → a new 15-minute URL after re-checking access. On failure the license is revoked with `access_lost` and the API returns `403 OFFLINE_ACCESS_DENIED`.
- `DELETE /:licenseId` → idempotent self-revocation (`user_deleted`).

A license held by another session returns `404 OFFLINE_LICENSE_NOT_FOUND`.

License = `{ id, courseId, lessonId, status: active|expired|revoked, grantedAt, renewedAt, lastCheckedAt, leaseExpiresAt, deviceLabel, revokeReason }`.

## Asset upload APIs (M07-A)

Resumable direct-to-storage multipart uploads. The browser sends file bytes straight to the S3-compatible server through presigned part URLs. The API handles only metadata, authorization and verification. Every route needs a live session for an active account. Mutations need CSRF/origin protection when the client authenticates with cookies. Returns `503 STORAGE_NOT_CONFIGURED` when the `S3_*` settings are missing.

Who can upload: users with `assets.upload` (owner/admin) for any non-archived course, and users with the `teacher` role who are assigned to that course with `canManageLessons`. Existing uploads are visible only to `assets.manage` holders and to their creator while the creator still has upload rights. Everyone else gets `404 UPLOAD_NOT_FOUND`.

- `POST /api/v1/assets/uploads` — body `{ courseId, kind: 'video'|'material', fileName, mimeType, sizeBytes }`. Video types are `.mp4` `video/mp4` and `.webm` `video/webm`; QuickTime `.mov` is refused (M07-B). Material types are `.pdf`, `.docx`, `.pptx`, `.jpg`/`.jpeg` and `.png` with their standard MIME types. The maximum size is 20 GiB (21474836480 bytes). Returns `201 { data: upload }`, where the server chooses `partSizeBytes` and `partCount`. Errors: `400 VALIDATION_ERROR` (field detail), `403 ACTION_FORBIDDEN`, `404 COURSE_NOT_FOUND` (only for actors with `assets.upload`), `409 COURSE_ARCHIVED`.
- `GET /api/v1/assets/uploads/:uploadId` — returns `{ upload, uploadedParts: [{ partNumber, size }] }`. The part list comes from the storage server, so a client resumes by uploading only the missing parts.
- `POST /api/v1/assets/uploads/:uploadId/parts` — body `{ partNumbers: [1..partCount] }` (1–100 unique numbers). Returns `{ parts: [{ partNumber, sizeBytes, url, expiresAt }] }`. The client sends `PUT` with exactly `sizeBytes` bytes to `url`. It does not need to keep the returned ETags.
- `POST /api/v1/assets/uploads/:uploadId/complete` — idempotent. It assembles the object from the storage server's own part list, checks part count and sizes, and then checks the real content (magic bytes; for video also container, codecs, duration and dimensions). Returns `{ asset }`. Repeated or concurrent calls return the same asset. Errors:
   - `409 UPLOAD_INCOMPLETE` with `details[0]` = `{ missingParts, wrongSizeParts, extraParts }`.
   - `409 UPLOAD_ABORTED`, `UPLOAD_REJECTED`, `UPLOAD_EXPIRED`, `UPLOAD_PARTS_MISSING`.
   - `422 UNSUPPORTED_MEDIA` with `details[0].code` set to one of `MEDIA_TYPE_MISMATCH`, `MEDIA_UNSUPPORTED_CODEC`, `MEDIA_NO_VIDEO_TRACK`, `MEDIA_MALFORMED`, `MEDIA_SIZE_MISMATCH` or `MEDIA_EMPTY`. A rejected object is deleted, and the upload cannot be retried.
- `POST /api/v1/assets/uploads/:uploadId/abort` — idempotent. Returns `{ upload }` with status `aborted`. Returns `409 UPLOAD_ALREADY_COMPLETED` for a completed upload.

`upload` = `{ id, assetId, courseId, kind, fileName, mimeType, sizeBytes, partSizeBytes, partCount, status: initiated|completed|aborted|rejected|expired, rejectionCode, createdAt, expiresAt, completedAt, abortedAt }`.

`asset` = `{ id, kind, mimeType, fileName, sizeBytes, widthPx, heightPx, durationSeconds, status, processingStatus: none|not_required|pending|processing|completed|failed, processingError, createdAt }`.

Storage keys and storage upload IDs are never returned. Since M07-B only seek-ready video is stored: an MP4 must have `moov` before `mdat`, and a WebM must have `Cues` before its clusters. Anything else is rejected with `422 VIDEO_NOT_SEEKABLE` ("Export as MP4 with fast start (web optimized)"), and the object is deleted. New videos get `processingStatus: 'not_required'`; materials keep `'none'`. No remux jobs are created.

## Course administration APIs

All course-administration routes require a live active-account session and current database permissions.

- `GET /api/v1/admin/courses` returns a deterministic `limit`/`offset` page. Owner/admin see all courses; teachers see only assigned courses.
- `GET /api/v1/admin/courses/:courseId` returns safe catalog metadata and the actor's administrative/teacher edit relationship.
- `POST /api/v1/admin/courses` creates a draft course. Supported fields are `subjectId`, `title`, `description`, `languageCode`, `translations`, and `coverAssetId`.
- `PATCH /api/v1/admin/courses/:courseId` partially updates those same catalog fields. It never accepts creator or lifecycle status.
- `POST /api/v1/admin/courses/:courseId/publish` performs the locked `draft → published` transition; publication requires a non-empty title and subject.
- `POST /api/v1/admin/courses/:courseId/unpublish` performs the locked `published → draft` transition.
- `GET /api/v1/admin/courses/:courseId/teachers` returns safe assigned-teacher profiles and course-scoped permission flags.
- `POST /api/v1/admin/courses/:courseId/teachers`, `PATCH /api/v1/admin/courses/:courseId/teachers/:userId`, and `DELETE` on that assignment add, update, and remove eligible teachers.

Course text is trimmed. Primary languages and translation keys are `tg`, `ru`, and `en`; each translation supports only `title` and nullable `description`. Nullable subject, description, and cover values distinguish explicit `null` from omission. Missing and inaccessible assigned-teacher resources return the same `404 COURSE_NOT_FOUND`. Mutations require cookie CSRF/origin protection when cookie-authenticated and write audit events atomically.

Permissions are `courses.read`, `courses.create`, `courses.update`, `courses.publish`, and `courses.teachers.manage`. Owner/admin receive all five. Teachers receive read/update actions, but repository scope restricts reads to assignments and updates additionally require `canEditCourse`. Teacher assignment never implies publication, enrollment, module access, or group access. Student course access is described in the enrollment section below.

## Course module, preview and copy APIs

All routes require a live active-account session and current database permissions. Mutations require cookie CSRF/origin protection when cookie-authenticated, lock the course row, and write audit events in the same transaction.

- `GET /api/v1/admin/courses/:courseId/preview` (`courses.read`) is read-only and returns `{ course: { id, title, status }, modules: [{ id, title, description, position, status, lessonsCount, testsCount }] }` ordered by position. It includes draft, published, and archived modules. `lessonsCount` counts `lessons` rows in the module; `testsCount` counts distinct tests assigned through `test_assignments.lesson_id` to those lessons. It grants no access and exposes no progress or lock state.
- `POST /api/v1/admin/courses/:courseId/modules` creates a `draft` module at `max(position) + 1`. Fields: required `title`, optional nullable `description`, optional `translations`.
- `PATCH /api/v1/admin/courses/:courseId/modules/:moduleId` partially updates those same fields. Status and position are not accepted.
- `POST .../modules/:moduleId/publish` (`draft → published`), `POST .../archive` (`published → archived`), and `POST .../restore` (`archived → draft`). Any other transition returns `409 INVALID_MODULE_TRANSITION`. Archived modules keep their position.
- `DELETE .../modules/:moduleId` deletes only a `draft` module with no `lessons` rows. Otherwise it returns `409 COURSE_MODULE_NOT_DELETABLE`. The response is `{ id, status: 'deleted' }`.
- `PUT /api/v1/admin/courses/:courseId/modules/order` takes `{ moduleIds: [...] }`. Malformed or duplicate IDs return `400 VALIDATION_ERROR`. A list that is not exactly the course's current module set returns `409 COURSE_MODULE_ORDER_MISMATCH`. On success it returns all modules renumbered `1..n`.
- `POST /api/v1/admin/courses/:courseId/copy` (`courses.copy`) takes an optional `{ title }`. It creates a new `draft` course with the source's subject, description, language, translations, and cover reference. The default title is `<source title> (copy)`. All modules are copied as `draft` with their titles, descriptions, translations, and positions. Teachers, enrollments, module grants, and progress are not copied. Responds `201` with `{ course, sourceCourseId, copied: { modules } }`.

Module DTO: `id`, `courseId`, `title`, `description`, `translations`, `position`, `status`, `createdAt`. Module translations follow the course rules (`tg`/`ru`/`en`, `title` and nullable `description`).

Permissions: `courses.modules.manage` is granted to owner/admin/teacher, and teachers are additionally scoped to assignments with `canEditCourse`. Otherwise they receive the same `404 COURSE_NOT_FOUND` as a missing course. `courses.copy` is owner/admin only. A module from another course returns `404 COURSE_MODULE_NOT_FOUND`. A malformed module ID returns `400 INVALID_MODULE_ID`.

## Course enrollment and module access APIs

Administrative routes require a live active-account session and the permissions `courses.access.read` (reads) or `courses.access.manage` (mutations), both granted to owner/admin only. Mutations require cookie CSRF/origin protection when cookie-authenticated, the admin mutation rate limit, and write audit events in the same transaction. Dates are ISO 8601 timestamps with an offset (`2026-12-01T00:00:00Z`). `expiresAt` is required on every grant and extension; `null` means no expiry. Rules and reasons are in [decisions](decisions.md).

- `GET /api/v1/admin/courses/:courseId/enrollments?state=&limit=&offset=` returns `{ enrollments, pagination }`, newest grant first. `state` is `active`, `scheduled`, `expired` or `revoked`.
- `POST /api/v1/admin/courses/:courseId/enrollments` takes `{ userId, beginsAt?, expiresAt }` and responds `201` with the enrollment. The course must be `published` and the user an `active` student. A revoked enrollment is reset in place (audit `course.enrollment.regranted`).
- `PATCH .../enrollments/:userId` takes `{ expiresAt }` and extends, shortens or removes the expiry. An expired enrollment is renewed this way; a revoked one returns `409 ENROLLMENT_REVOKED`.
- `POST .../enrollments/:userId/revoke` revokes the enrollment and, in the same transaction, all of its module grants.
- `GET .../enrollments/:userId/modules` returns `{ moduleGrants }` for that user and course.
- `POST .../enrollments/:userId/modules` takes `{ moduleId, beginsAt?, expiresAt }` and responds `201`. The module must be `published` and belong to the course, and the enrollment must be `active` or `scheduled`.
- `PATCH .../enrollments/:userId/modules/:moduleId` takes `{ expiresAt }`; `POST .../modules/:moduleId/revoke` revokes one module grant.

Enrollment DTO: `id`, `userId`, `courseId`, `state`, `grantedBy`, `grantedAt`, `beginsAt`, `expiresAt`, `revokedAt`, `revokedBy`, plus `user: { firstName, lastName }` in lists. Module grant DTO adds `moduleId` (and `moduleTitle` in lists). IDs are decimal strings.

Stable errors: `400 VALIDATION_ERROR`, `400 INVALID_COURSE_ID`/`INVALID_USER_ID`/`INVALID_MODULE_ID`, `403 ACTION_FORBIDDEN`, `404 COURSE_NOT_FOUND`, `USER_NOT_FOUND`, `COURSE_MODULE_NOT_FOUND`, `ENROLLMENT_NOT_FOUND`, `MODULE_ACCESS_NOT_FOUND`, and `409` `COURSE_NOT_PUBLISHED`, `MODULE_NOT_PUBLISHED`, `ENROLLMENT_USER_INELIGIBLE`, `ENROLLMENT_ALREADY_EXISTS`, `ENROLLMENT_NOT_ACTIVE`, `ENROLLMENT_REVOKED`, `ENROLLMENT_ALREADY_REVOKED`, `MODULE_ACCESS_ALREADY_EXISTS`, `MODULE_ACCESS_REVOKED`, `MODULE_ACCESS_ALREADY_REVOKED`.

### Learner course access

These routes need only a live active-account session and read the caller's own data.

- `GET /api/v1/courses` returns `{ courses: [{ id, title, description, languageCode, translations, coverAssetId, enrollment: { state, beginsAt, expiresAt } }] }` for the caller's non-revoked enrollments in `published` courses. Group membership never adds a course.
- `GET /api/v1/courses/:courseId/modules` returns `{ course, modules }` where each published module is `{ id, position, title, description, translations, access: { granted, lockReason } }`. `lockReason` is `null` when granted, otherwise `onboarding_required`, `not_started`, `expired`, `not_granted` or `unavailable`. Locked modules expose no lessons, assets, tests, counts or grant history. A course without a non-revoked enrollment, or an unpublished or unknown course, returns `404 COURSE_NOT_FOUND`.

Protected content (M07 onward) must call `requireModuleAccessService(userId, moduleId)`, which throws `403 MODULE_ACCESS_DENIED` unless the database predicate `can_access_module` allows it. No protected-content route exists yet.

## Group APIs

All group routes require a valid active-account session and derive the actor exclusively from that session.

- `GET /api/v1/groups` returns only visible group summaries with `limit`/`offset` pagination, deterministic name/ID ordering, counts, and the actor's member/representative/teacher/administrator relationship.
- `GET /api/v1/groups/:groupId` returns safe group metadata and counts without embedding an unlimited roster.
- `GET /api/v1/groups/:groupId/members` returns paginated active members with decimal-string user IDs, names, avatar asset references, member/representative role, membership status, and join time.
- `GET /api/v1/groups/:groupId/teachers` returns paginated assigned teachers with decimal-string IDs, names, avatar references, assignment time, and group-scoped assignment permissions.
- `POST /api/v1/admin/groups` creates a group; `PATCH /api/v1/admin/groups/:groupId` updates its code, name, description, or active/archived status.
- `POST` and `DELETE /api/v1/admin/groups/:groupId/members[/:userId]` activate or remove student membership while retaining membership history.
- `POST` and `DELETE /api/v1/admin/groups/:groupId/teachers[/:userId]` assign or remove eligible teachers and their group-scoped flags.
- `GET /api/v1/groups/:groupId/announcements` returns a paginated text-announcement feed. Students see published announcements in active memberships; assigned teachers and administrators may also see drafts.
- `POST /api/v1/groups/:groupId/announcements`, `PATCH /api/v1/groups/:groupId/announcements/:announcementId`, and `DELETE` on the same resource create, update, and archive text announcements.

Active members may read their groups; assigned teachers may read their groups; current owner/admin roles may read all groups. Missing and inaccessible group resources both return `404 GROUP_NOT_FOUND`. `limit` defaults to 20 and is bounded at 100; `offset` defaults to zero. Group membership never grants course or module access, and these responses contain no course, progress, or ranking data.

All mutations require live authentication, database-backed permission checks, cookie CSRF/origin protection where applicable, and atomic auditing. Owner/admin roles receive all five group permissions. A teacher receives only `groups.announcements.manage`, which is additionally restricted to an assignment with announcement-publishing permission in the target group. Announcement authors come only from the authenticated actor. Attachments are not accepted before M07.

## User profile and onboarding

All profile routes require a valid active-account session. Identity comes only from the authenticated session; request bodies cannot select another user.

- `GET /api/v1/profile` returns the authenticated user's decimal-string ID, names, derived display name, phone, read-only avatar asset reference, status, roles, preferred language, timezone, onboarding state, and timestamps.
- `PATCH /api/v1/profile` partially updates `firstName`, `lastName`, `preferredLanguage`, and `timezone`. Names may be explicitly cleared with `null`; omitted fields remain unchanged. Phone, status, roles, permissions, identifiers, and avatar are read-only.
- `GET /api/v1/profile/onboarding` returns `state`, `completedSteps`, `missingRequiredFields`, `canComplete`, and `completedAt`.
- `PATCH /api/v1/profile/onboarding` updates the same supported profile fields without completing onboarding.
- `POST /api/v1/profile/onboarding/complete` atomically completes onboarding when the active account has both `firstName` and `lastName`. Missing fields return `409 ONBOARDING_INCOMPLETE`; retrying an already completed request returns the existing completed state without another audit event.

Mutation routes use the existing cookie-authentication CSRF/origin protection. Supported API language codes are `ru`, `tj`, and `en`; `tj` maps to the baseline schema's Tajik code `tg`. Time zones must be supported IANA identifiers. No avatar upload, grade/class, educational direction, or learning-goal write is exposed because the current schema/runtime does not safely support those operations.

## Authentication protection

Sensitive public authentication routes and account-administration mutations use PostgreSQL-backed request counters. Exceeded limits return `429 AUTH_RATE_LIMITED` with a whole-second `Retry-After` header. Password login additionally permits five attempts per normalized phone in a 15-minute window and blocks further attempts for 15 minutes; keys are HMAC-derived and no phone, password, OTP, access token, or refresh token is stored in the counter table. Successful password login clears its account counter. Unknown and known accounts retain the same `401 INVALID_CREDENTIALS` response before rate limiting.

Password and Telegram login set a readable `everest_csrf` cookie alongside the existing HttpOnly access and refresh cookies. Browser clients must copy its value into `X-CSRF-Token` and send an allowed `Origin` on cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests. The server stores only its SHA-256 hash bound to the session. Missing/invalid/cross-session tokens return `403 CSRF_TOKEN_INVALID`; disallowed or missing origins return `403 CSRF_ORIGIN_REJECTED`. Bearer-authenticated mutations are not vulnerable to ambient-cookie CSRF and do not require the header. Public registration/login, Telegram callback, and password-recovery operations remain CSRF-exempt; refresh and logout require CSRF when a valid refresh cookie identifies a live session.

Internal database identifiers are serialized as canonical positive decimal strings. This preserves PostgreSQL `BIGINT` precision across JSON and JWT claims; clients must not assume identifiers are gapless or safely coerce them to JavaScript `Number`.

## Password recovery

### `POST /api/v1/auth/password-recovery/request`

Accepts `phone` and `channel` (`telegram` or `sms`). Valid phone input is normalized with the registration E.164 rules. Every syntactically valid request returns `202` with the same shape and a random opaque `challengeId`, regardless of account existence, status, linkage, cooldown, limit, provider availability, or delivery outcome:

```json
{"data":{"status":"accepted","challengeId":"opaque-request-identifier"}}
```

Eligible active, pending, or blocked password accounts may receive a Telegram code only when a verified Telegram identity and active bot connection both exist. Rejected accounts are ineligible. Pending/blocked status is never changed by recovery. SMS uses the same internal service boundary but production delivery is disabled until an approved provider is configured. A new eligible request invalidates earlier active recovery challenges. The default limits are a 10-minute code, five attempts, a 60-second resend cooldown, and five created requests per account/channel/hour.

### `POST /api/v1/auth/password-recovery/verify`

Accepts `challengeId` and a six-digit `code`. A valid one-use code returns a 10-minute opaque `resetAuthorization`; invalid, expired, consumed, invalidated, or attempt-exhausted challenges use `401 INVALID_RECOVERY_CHALLENGE`. Concurrent verification permits one success.

### `POST /api/v1/auth/password-recovery/reset`

Accepts `resetAuthorization` and `newPassword`. The existing password policy applies. A successful reset atomically consumes the authorization, replaces the password, revokes every session and refresh token, and writes an audit event. It returns `{"data":{"status":"password_reset"}}`; the client must log in again. Invalid, expired, or consumed authorization uses `401 INVALID_RESET_AUTHORIZATION`, and concurrent reset permits one success. Roles, Telegram identity, and account status remain unchanged.

Codes, code hashes, reset hashes, passwords, and provider details are never returned. The opaque reset authorization is returned only by successful verification and is never stored in plaintext.

## Session lifecycle

Password and Telegram login set two HttpOnly cookies: short-lived `everest_access` at path `/` and opaque `everest_refresh` at path `/api/v1/auth`. Tokens are never returned in JSON. In production both cookies are `Secure`; all environments use `SameSite=Lax` and explicit expiry.

### `POST /api/v1/auth/refresh`

Reads only the refresh cookie, atomically consumes the current token, and sets replacement access and refresh cookies. A refresh token is single-use. Missing, malformed, expired, revoked, inactive-account, or dead-session tokens return `401`; detected reuse returns `401 REFRESH_TOKEN_REUSE_DETECTED`, revokes the whole session family, and clears cookies.

```json
{"data":{"status":"refreshed","expiresAt":"2026-10-25T12:15:00.000Z","refreshExpiresAt":"2026-11-24T12:00:00.000Z","user":{"id":"123"}}}
```

### `POST /api/v1/auth/logout`

Revokes the current session and all its refresh tokens when identified by a valid access token or refresh cookie, clears both cookies, and returns `{"data":{"status":"logged_out"}}`. It is safe to repeat and can discard a session with an expired access token when the refresh cookie remains identifiable.

### `POST /api/v1/auth/logout-all`

Requires live authentication. Revokes all sessions and refresh tokens owned by the current user, including the current session, without affecting other users. Both cookies are cleared.

### `GET /api/v1/auth/sessions`

Requires live authentication. Returns only the actor's sessions ordered newest first. Safe fields are `id`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `current`, and a coarse `device` object containing `browser`, `operatingSystem`, and `deviceType`. Raw User-Agent, IP address, tokens, and hashes are excluded.

### `DELETE /api/v1/auth/sessions/:sessionId`

Requires live authentication and a canonical positive decimal-string session ID. Revokes only an owned session and its refresh tokens. Missing and foreign sessions share `404 SESSION_NOT_FOUND`. Repeating an owned revocation is successful. Revoking the current session also clears both cookies. Invalid IDs return `400 INVALID_SESSION_ID`.

Browser clients must send credentials for cookie-authenticated calls. `SameSite=Lax` narrows cross-site cookie submission, but this milestone does not claim complete CSRF protection; explicit origin/token hardening remains M02F.

## Account administration

All account-administration routes require an authenticated, live session for an active user with the action-specific database permission. The seeded `owner` and `admin` roles have `accounts.pending.read`, `accounts.approve`, `accounts.reject`, `accounts.block`, and `accounts.unblock`; `teacher` and `student` do not. Unauthenticated requests return `401 AUTHENTICATION_REQUIRED`; a missing action permission preserves `403 ADMIN_ROLE_REQUIRED` for this existing API.

### `GET /api/v1/admin/users/pending`

Lists pending accounts ordered by `created_at`, then `id`. Query parameters are `limit` (default 20, range 1–100) and `offset` (default 0). The response contains only the decimal-string ID, account status, profile names, one deterministic phone, creation time, and onboarding state.

```json
{"data":{"users":[{"id":"123","status":"pending","firstName":"Student","lastName":"Example","phone":"+992900000000","createdAt":"2026-10-25T12:00:00.000Z","onboardingCompletedAt":null}],"pagination":{"limit":20,"offset":0,"hasMore":false}}}
```

### Account-state transitions

- `POST /api/v1/admin/users/:userId/approve`: `pending` → `active`.
- `POST /api/v1/admin/users/:userId/reject`: `pending` → `rejected`.
- `POST /api/v1/admin/users/:userId/block`: `active` → `blocked`; atomically revokes every live session with reason `account_blocked`.
- `POST /api/v1/admin/users/:userId/unblock`: `blocked` → `active`; previously revoked sessions remain revoked.

Each transition locks the target account, changes it once, and appends its administrator audit event in the same transaction. Invalid transitions return `409 INVALID_ACCOUNT_TRANSITION`; missing accounts return `404 USER_NOT_FOUND`. Administrators cannot reject or block themselves (`SELF_REJECTION_FORBIDDEN` and `SELF_BLOCK_FORBIDDEN`). Route IDs must be canonical positive PostgreSQL `BIGINT` decimal strings; malformed, zero, leading-zero, or overflowing values return `400 INVALID_USER_ID`.

## Health

### `GET /api/v1/health`

Process liveness check. It does not query PostgreSQL.

Response `200`:

```json
{"data":{"status":"ok"}}
```

### `GET /api/v1/ready`

Database readiness check. The SQL is owned by `src/repositories/health-repository.js`.

Response `200`:

```json
{"data":{"status":"ready"}}
```

Unexpected errors use the stable response shape below and do not expose SQL, credentials, or stack traces:

```json
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","details":[]}}
```

## Phone and password authentication

### `POST /api/v1/auth/register`

Creates a pending student account. The request accepts only:

```json
{
  "phone": "+992900000000",
  "password": "a secure password 9",
  "firstName": "Student",
  "lastName": "Example"
}
```

Phone input may contain spaces, hyphens, and parentheses but must normalize to an E.164 number with 8–15 digits. Passwords must contain 12–128 Unicode characters, at least one letter, and at least one number. Names are trimmed and must contain 1–100 characters. Unknown fields are rejected; a client cannot select its role or account status.

Response `201`:

```json
{
  "data": {
    "status": "pending",
    "user": {
      "id": "1",
      "status": "pending",
      "firstName": "Student",
      "lastName": "Example",
      "phone": "+992900000000"
    }
  }
}
```

The user, profile, unverified phone, `scrypt` password hash, student role, and audit event are created in one transaction. Registration does not verify the phone and does not issue a session. Duplicate phones return `409 PHONE_ALREADY_REGISTERED`; concurrent registration is protected by the database uniqueness constraint. Validation failures return `400 VALIDATION_ERROR`.

### `POST /api/v1/auth/login/password`

```json
{
  "phone": "+992900000000",
  "password": "a secure password 9"
}
```

Successful response `200` requires an active account, creates an auditable server-side session, updates `last_login_at`, and sets access and refresh HttpOnly cookies shared with Telegram login. Tokens are omitted from JSON:

```json
{
  "data": {
    "status": "authenticated",
    "expiresAt": "2026-10-25T12:15:00.000Z",
    "user": { "id": "1" }
  }
}
```

An unknown phone or incorrect password returns the same `401 INVALID_CREDENTIALS` response and performs a password-hash verification in either case. Pending, blocked, and rejected accounts return the same `403 ACCOUNT_NOT_ACTIVE` response after valid credentials. Password hashes and access tokens never appear in JSON.

## Telegram authentication

Telegram authentication uses OpenID Connect Authorization Code Flow with PKCE. The server obtains provider endpoints from Telegram discovery metadata. Clients must not submit Telegram profile fields as proof of identity.

### `GET /api/v1/auth/telegram/start`

Creates a short-lived, one-use authorization state and returns the Telegram authorization URL:

```json
{
  "data": {
    "authorizationUrl": "https://oauth.telegram.org/auth?...",
    "expiresAt": "2026-10-24T12:10:00.000Z"
  }
}
```

The URL requests `openid profile phone telegram:bot_access` and contains the PKCE S256 challenge. State, nonce, and verifier values must not be logged or persisted by API clients.

### `GET /api/v1/auth/telegram/callback`

Accepts the provider's `code` and `state`, or its error response. The server consumes state once, exchanges the code, and validates the ID-token signature, issuer, audience, expiry, nonce, and subject.

For an already-linked identity, response `200` sets the EVEREST session in an `HttpOnly`, `SameSite=Lax` `everest_access` cookie. The token is not returned in JSON:

```json
{
  "data": {
    "status": "authenticated",
    "expiresAt": "2026-10-24T12:15:00.000Z",
    "user": { "id": "1" },
    "messagingConnected": true
  }
}
```

An unknown verified identity is not matched by phone or username:

```json
{"data":{"status":"linking_required"}}
```

### `POST /api/v1/auth/telegram/link`

Requires an active EVEREST session through the session cookie or `Authorization: Bearer <token>`. Cross-origin browser clients using the cookie must send credentials. Returns an authorization URL in the same shape as `/telegram/start`, bound to the authenticated user. The callback performs the actual link using verified claims only.

Successful callback response:

```json
{"data":{"status":"linked","messagingConnected":true}}
```

Conflicts return `409` with `TELEGRAM_IDENTITY_ALREADY_LINKED` or `TELEGRAM_IDENTITY_CONFLICT`.

### `DELETE /api/v1/auth/telegram/link`

Requires authentication. Removes the Telegram login identity and disconnects Telegram messaging only when another login method remains.

```json
{"data":{"status":"unlinked"}}
```

Removing the last login method returns `409 LAST_LOGIN_METHOD`.

### `POST /api/v1/auth/telegram/test-message`

Requires authentication and an active `telegram_connections` row. Sends a small test message through the configured bot.

```json
{"data":{"status":"sent"}}
```

Missing messaging permission returns `409 TELEGRAM_CONNECTION_UNAVAILABLE`. Telegram delivery failures return a safe `502 TELEGRAM_MESSAGE_FAILED`; a blocked or unavailable chat changes the stored connection status to `blocked`.
