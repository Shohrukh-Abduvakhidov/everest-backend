# Frontend handoff (backend state after M09 + M17 accounts slice)

Updated: 2026-10-31. This document describes what the backend **implements on `main`**. It is based only on code and the existing docs:

- `src/docs/openapi.js` (kept in two-way sync with the Express routes by `tests/unit/openapi.test.js`);
- `src/configs/*`, `src/utils/auth-cookies.js`, `src/middleware/*`;
- the migrations, and the permission grants as read from a migrated database;
- `docs/api.md` and `docs/decisions.md`.

Where this document and the code disagree, the code wins. Please report the difference.

- **Live, interactive reference:** Swagger UI at `GET /api/docs` and the JSON spec at `GET /api/docs/openapi.json` (not in production unless `SWAGGER_ENABLED=true`).
- **Prose details** per domain: `docs/api.md`.

---

## 1. Conventions

### 1.1 Base URL and identifiers

- **Base URL:** every API path is under `/api/v1` (for example `GET /api/v1/profile`). The tables in §2 omit the `/api/v1` prefix.
- **Identifiers** are canonical positive **decimal strings** (PostgreSQL `BIGINT`), for example `"42"`.
   - Never convert them to `Number`.
   - Do not assume they are gapless.
   - A malformed ID in a path returns `400 INVALID_<ENTITY>_ID` (for example `INVALID_USER_ID`, `INVALID_COURSE_ID`).

### 1.2 Success envelope

```json
{ "data": { "...": "resource or result" } }
```

- `201` is returned for creations.
- Deletions return `data: { id, status: "deleted" }`.

### 1.3 Error envelope (every error, including 404 of unknown routes)

```json
{ "error": { "code": "STABLE_MACHINE_CODE", "message": "Human readable, English", "details": [] } }
```

- Switch on `error.code`, never on `message`.
- Unexpected server errors are always `500` with code `INTERNAL_ERROR` and `details: []`; no internals leak.
- An unknown route returns `404 ROUTE_NOT_FOUND`.
- `429 AUTH_RATE_LIMITED` carries a `Retry-After` header (seconds).

### 1.4 Validation errors

Validation errors are `400` with `code: "VALIDATION_ERROR"` and one entry in `details`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [{ "field": "limit", "message": "limit is invalid" }] } }
```

- Request bodies are **strict**: an unknown field returns `VALIDATION_ERROR` with `details[0].field` = that field and `message` = `"<field> is not allowed"`.
- Validation stops at the first problem, so `details` has one entry.
- Some domains use their own `400` codes instead of `VALIDATION_ERROR`, for example:
   - `ANSWER_KEY_INVALID` (with `details[0].field = "answerData"`);
   - `INVALID_ROLES`.

### 1.5 Pagination

- **Query:** `limit` (integer 1–100, default 20) and `offset` (integer ≥ 0, default 0), both as decimal strings without leading zeros. Out-of-range values return `400 VALIDATION_ERROR`.
- **Response:** `data: { <items>: [...], pagination: { limit, offset, hasMore } }`.
- **`total`** exists **only** on `GET /admin/users` and `GET /admin/users/pending`. Other lists have `hasMore` only.
- **Ordering** is deterministic per endpoint (always with an `id` tie-break); see `docs/api.md`.

---

## 2. Endpoints

**Access column:**

- `public`: no session.
- `session`: any live session of an **active** account.
- A permission name: the database permission that route requires (§3).
- `+ CSRF`: cookie-authenticated calls must send `X-CSRF-Token` and an allowed `Origin` (§4).

**Errors column:** every operation can also return `400 VALIDATION_ERROR`. Authenticated ones can return `401 AUTHENTICATION_REQUIRED`/`SESSION_INVALID`. Teacher-scoped resources outside the teacher's assignment return the same `404` as a missing resource.

**Types:** `X?` = optional or nullable; `Name` = shared schema (listed at the end of this section). Request and response shapes are summarised to two levels; the full schemas are in Swagger.

### Health

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/health` | public | — | — | 200 StatusResult | 400: VALIDATION_ERROR |
| GET | `/ready` | public | — | — | 200 StatusResult | 400: VALIDATION_ERROR; 500: INTERNAL_ERROR |

### Auth

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/auth/register` | public | — | { phone: string, password: string, firstName: string, lastName: string } | 201 { status?: "pending", user?: PendingUser } | 400: VALIDATION_ERROR; 409: PHONE_ALREADY_REGISTERED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/login/password` | public | — | { phone: string, password: string } | 200 AuthResult | 400: VALIDATION_ERROR; 401: INVALID_CREDENTIALS; 403: ACCOUNT_NOT_ACTIVE; 429: AUTH_RATE_LIMITED (Retry-After header); 503: AUTH_PROTECTION_UNAVAILABLE, AUTH_NOT_CONFIGURED |
| POST | `/auth/password-recovery/request` | public | — | { phone: string, channel: telegram/sms } | 202 { status?: "accepted", challengeId?: string } | 400: VALIDATION_ERROR; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/password-recovery/verify` | public | — | { challengeId: string, code: string } | 200 { status?: "verified", resetAuthorization?: string, expiresAt?: string } | 400: VALIDATION_ERROR; 401: INVALID_RECOVERY_CHALLENGE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/password-recovery/reset` | public | — | { resetAuthorization: string, newPassword: string } | 200 StatusResult | 400: VALIDATION_ERROR; 401: INVALID_RESET_AUTHORIZATION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/refresh` | public + CSRF | — | — | 200 AuthResult | 400: VALIDATION_ERROR; 401: INVALID_REFRESH_TOKEN, REFRESH_TOKEN_REQUIRED, REFRESH_TOKEN_REUSE_DETECTED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/logout` | public + CSRF | — | — | 200 StatusResult | 400: VALIDATION_ERROR; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| POST | `/auth/logout-all` | session + CSRF | — | — | 200 { status?: "logged_out_all", revokedSessions?: integer } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| GET | `/auth/sessions` | session | — | — | 200 { sessions?: Session[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| DELETE | `/auth/sessions/{sessionId}` | session + CSRF | — | — | 200 { status?: "revoked", sessionId?: Id, currentSession?: boolean } | 400: INVALID_SESSION_ID; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SESSION_NOT_FOUND |
| GET | `/auth/telegram/start` | public | — | — | 200 { authorizationUrl?: string, expiresAt?: string } | 400: VALIDATION_ERROR; 429: AUTH_RATE_LIMITED (Retry-After header); 503: TELEGRAM_AUTH_NOT_CONFIGURED |
| GET | `/auth/telegram/callback` | public | code, state, error | — | 200 { status?: authenticated/linking_required/linked, expiresAt?: string, user?: { id?: Id }, messagingConnected?: boolean } | 400: VALIDATION_ERROR, TELEGRAM_CALLBACK_INVALID; 401: TELEGRAM_STATE_INVALID, TELEGRAM_AUTHORIZATION_DENIED, TELEGRAM_CODE_EXCHANGE_FAILED, TELEGRAM_ID_TOKEN_INVALID; 409: TELEGRAM_IDENTITY_ALREADY_LINKED, TELEGRAM_IDENTITY_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/auth/telegram/link` | session + CSRF | — | — | 200 { authorizationUrl?: string, expiresAt?: string } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| DELETE | `/auth/telegram/link` | session + CSRF | — | — | 200 StatusResult | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: LAST_LOGIN_METHOD |
| POST | `/auth/telegram/test-message` | session + CSRF | — | — | 200 StatusResult | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: TELEGRAM_CONNECTION_UNAVAILABLE; 502: TELEGRAM_MESSAGE_FAILED |

### Profile

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/profile` | session | — | — | 200 Profile | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: PROFILE_NOT_FOUND |
| PATCH | `/profile` | session + CSRF | — | { firstName?: string?, lastName?: string?, preferredLanguage?: ru/tj/en, timezone?: string } | 200 Profile | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| GET | `/profile/onboarding` | session | — | — | 200 Onboarding | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| PATCH | `/profile/onboarding` | session + CSRF | — | { firstName?: string?, lastName?: string?, preferredLanguage?: ru/tj/en, timezone?: string } | 200 Onboarding | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| POST | `/profile/onboarding/complete` | session + CSRF | — | — | 200 Onboarding | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: ONBOARDING_INCOMPLETE |

### Learner courses

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/courses` | session | — | — | 200 { courses?: LearnerCourse[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| GET | `/courses/favorites` | session | — | — | 200 { courses?: { id?: Id, title?: string, translations?: CourseTranslations, coverAssetId?: Id or null, favoritedAt?: string }[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| PUT | `/courses/{courseId}/favorite` | session + CSRF | — | — | 200 { courseId?: Id, favorite?: boolean } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND |
| DELETE | `/courses/{courseId}/favorite` | session + CSRF | — | — | 200 { courseId?: Id, favorite?: boolean } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED |
| GET | `/courses/{courseId}/modules` | session | — | — | 200 { course?: { id?: Id, title?: string, subject?: SubjectCard or null, moduleCount?: integer, lessonCount?: integer, enrollment?: EnrollmentWindow }, modules?: LearnerModule[] } | 400: INVALID_COURSE_ID; 401: AUTHENTICATION_REQUIRED; 404: COURSE_NOT_FOUND |

### Learner lessons

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/courses/{courseId}/modules/{moduleId}/lessons` | session | — | — | 200 { lessons?: LearnerLesson[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: COURSE_NOT_FOUND, COURSE_MODULE_NOT_FOUND |
| GET | `/courses/{courseId}/lessons/{lessonId}` | session | — | — | 200 { lesson?: LearnerLesson } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: LESSON_NOT_FOUND |
| GET | `/courses/{courseId}/lessons/{lessonId}/playback` | session | — | — | 200 { playback?: SignedUrl, chapters?: Chapter[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED; 404: LESSON_NOT_FOUND; 409: VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/courses/{courseId}/lessons/{lessonId}/resources/{resourceId}/download` | session | — | — | 200 { download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED; 404: LESSON_NOT_FOUND, RESOURCE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/courses/{courseId}/lessons/{lessonId}/notes` | session | — | — | 200 { notes?: Note[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| POST | `/courses/{courseId}/lessons/{lessonId}/notes` | session + CSRF | — | { body: string, playbackSeconds?: integer? } | 201 { note?: Note } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: NOTE_LIMIT_REACHED |
| PATCH | `/courses/{courseId}/lessons/{lessonId}/notes/{noteId}` | session + CSRF | — | { body?: string, playbackSeconds?: integer? } | 200 { note?: Note } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: NOTE_NOT_FOUND |
| DELETE | `/courses/{courseId}/lessons/{lessonId}/notes/{noteId}` | session + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: NOTE_NOT_FOUND |
| GET | `/courses/{courseId}/lessons/{lessonId}/progress` | session | — | — | 200 { progress?: Progress } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| PUT | `/courses/{courseId}/lessons/{lessonId}/progress` | session + CSRF | — | { revision: integer, playbackSeconds?: integer, watchedSeconds?: integer, completed?: boolean } | 200 { progress?: Progress } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: PROGRESS_REVISION_CONFLICT |

### Offline licenses

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/courses/{courseId}/lessons/{lessonId}/offline-license` | session + CSRF | — | { deviceLabel?: string } | 200 { license?: OfflineLicense, download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED, OFFLINE_ACCESS_DENIED, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: OFFLINE_DEVICE_LIMIT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/offline-licenses` | session | — | — | 200 { licenses?: OfflineLicense[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| GET | `/offline-licenses/{licenseId}/download` | session | — | — | 200 { license?: OfflineLicense, download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: OFFLINE_ACCESS_DENIED; 404: OFFLINE_LICENSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/offline-licenses/{licenseId}` | session + CSRF | — | — | 200 { license?: OfflineLicense } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: OFFLINE_LICENSE_NOT_FOUND |

### Groups

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/groups` | session | limit, offset | — | 200 { groups: Group[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| GET | `/groups/{groupId}` | session | — | — | 200 Group | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/members` | session | limit, offset | — | 200 { members: GroupMember[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/teachers` | session | limit, offset | — | 200 { teachers: GroupTeacher[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/announcements` | session | limit, offset | — | 200 { announcements: Announcement[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| POST | `/groups/{groupId}/announcements` | `groups.announcements.manage` + CSRF | — | { title: string, content: string, isPinned?: boolean, status?: draft/published } | 201 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND |
| PATCH | `/groups/{groupId}/announcements/{announcementId}` | `groups.announcements.manage` + CSRF | — | { title?: string, content?: string, isPinned?: boolean, status?: draft/published } | 200 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, ANNOUNCEMENT_NOT_FOUND |
| DELETE | `/groups/{groupId}/announcements/{announcementId}` | `groups.announcements.manage` + CSRF | — | — | 200 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, ANNOUNCEMENT_NOT_FOUND |

### Assets

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/assets/uploads` | session + CSRF | — | { courseId: Id, kind: video/material, fileName: string, mimeType: string, sizeBytes: integer } | 201 Upload | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 409: COURSE_ARCHIVED; 429: AUTH_RATE_LIMITED (Retry-After header); 503: STORAGE_NOT_CONFIGURED |
| GET | `/assets/uploads/{uploadId}` | session | — | — | 200 { upload?: Upload, uploadedParts?: { partNumber?: integer, size?: integer }[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: UPLOAD_NOT_FOUND |
| POST | `/assets/uploads/{uploadId}/parts` | session + CSRF | — | { partNumbers: integer[] } | 200 { parts?: { partNumber?: integer, sizeBytes?: integer, url?: string, expiresAt?: string }[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_ABORTED, UPLOAD_EXPIRED |
| POST | `/assets/uploads/{uploadId}/complete` | session + CSRF | — | — | 200 { asset?: Asset } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_INCOMPLETE, UPLOAD_ABORTED, UPLOAD_REJECTED, UPLOAD_EXPIRED, UPLOAD_PARTS_MISSING; 422: UNSUPPORTED_MEDIA, VIDEO_NOT_SEEKABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/assets/uploads/{uploadId}/abort` | session + CSRF | — | — | 200 { upload?: Upload } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_ALREADY_COMPLETED; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: accounts

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/users` | `accounts.pending.read` | limit, offset, status, role, q, sort | — | 200 { users: AdminAccount[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED |
| PUT | `/admin/users/{userId}/roles` | `accounts.approve` + CSRF | — | { roles: owner/admin/teacher/student[] } | 200 RoleChange | 400: VALIDATION_ERROR, INVALID_USER_ID, INVALID_ROLES; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED, ROLE_ASSIGNMENT_FORBIDDEN, OWNER_ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: USER_NOT_FOUND; 409: SELF_ROLE_CHANGE_FORBIDDEN, LAST_OWNER_PROTECTED; 422: STUDENT_ROLE_REQUIRED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/users/pending` | `accounts.pending.read` | limit, offset | — | 200 { users: PendingUser[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED |
| POST | `/admin/users/{userId}/approve` | `accounts.approve` + CSRF | — | — | 200 AccountTransition | 400: INVALID_USER_ID; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: USER_NOT_FOUND; 409: INVALID_ACCOUNT_TRANSITION, SELF_REJECTION_FORBIDDEN, SELF_BLOCK_FORBIDDEN; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/users/{userId}/reject` | `accounts.reject` + CSRF | — | — | 200 AccountTransition | 400: INVALID_USER_ID; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED, OWNER_ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: USER_NOT_FOUND; 409: INVALID_ACCOUNT_TRANSITION, SELF_REJECTION_FORBIDDEN, SELF_BLOCK_FORBIDDEN, LAST_OWNER_PROTECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/users/{userId}/block` | `accounts.block` + CSRF | — | — | 200 AccountTransition | 400: INVALID_USER_ID; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED, OWNER_ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: USER_NOT_FOUND; 409: INVALID_ACCOUNT_TRANSITION, SELF_REJECTION_FORBIDDEN, SELF_BLOCK_FORBIDDEN, LAST_OWNER_PROTECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/users/{userId}/unblock` | `accounts.unblock` + CSRF | — | — | 200 AccountTransition | 400: INVALID_USER_ID; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED, OWNER_ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: USER_NOT_FOUND; 409: INVALID_ACCOUNT_TRANSITION, SELF_REJECTION_FORBIDDEN, SELF_BLOCK_FORBIDDEN; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: courses

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/courses` | `courses.read` | limit, offset | — | 200 { courses: Course[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/courses` | `courses.create` + CSRF | — | { subjectId?: Id or null, title: string, description?: string?, languageCode?: LanguageCode, translations?: CourseTranslations, coverAssetId?: Id or null } | 201 Course | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}` | `courses.read` | — | — | 200 Course | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: COURSE_NOT_FOUND |
| PATCH | `/admin/courses/{courseId}` | `courses.update` + CSRF | — | { subjectId?: Id or null, title?: string, description?: string?, languageCode?: LanguageCode, translations?: CourseTranslations, coverAssetId?: Id or null } | 200 Course | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/publish` | `courses.publish` + CSRF | — | — | 200 Course | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 409: INVALID_COURSE_TRANSITION, COURSE_NOT_READY_FOR_PUBLICATION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/unpublish` | `courses.publish` + CSRF | — | — | 200 Course | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 409: INVALID_COURSE_TRANSITION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/copy` | `courses.copy` + CSRF | — | { title?: string } | 201 { course?: Course, sourceCourseId?: Id, copied?: { modules?: integer, lessons?: integer, chapters?: integer, resources?: integer } } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/preview` | `courses.read` | — | — | 200 { course?: { id?: Id, title?: string, status?: string }, modules?: PreviewModule[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: COURSE_NOT_FOUND |
| GET | `/admin/courses/{courseId}/teachers` | `courses.read` | — | — | 200 { teachers?: CourseTeacher[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: COURSE_NOT_FOUND |
| POST | `/admin/courses/{courseId}/teachers` | `courses.teachers.manage` + CSRF | — | { userId: Id, canEditCourse?: boolean, canManageLessons?: boolean, canManageQuestions?: boolean, canManageTests?: boolean, canViewResults?: boolean } | 201 CourseTeacher | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 409: COURSE_TEACHER_INELIGIBLE, COURSE_TEACHER_ALREADY_ASSIGNED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/courses/{courseId}/teachers/{userId}` | `courses.teachers.manage` + CSRF | — | { canEditCourse?: boolean, canManageLessons?: boolean, canManageQuestions?: boolean, canManageTests?: boolean, canViewResults?: boolean } | 200 CourseTeacher | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, COURSE_TEACHER_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/courses/{courseId}/teachers/{userId}` | `courses.teachers.manage` + CSRF | — | — | 200 { userId?: Id, status?: "removed" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, COURSE_TEACHER_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: modules

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/admin/courses/{courseId}/modules` | `courses.modules.manage` + CSRF | — | { title: string, description?: string?, translations?: CourseTranslations } | 201 CourseModule | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/modules/order` | `courses.modules.manage` + CSRF | — | { moduleIds: Id[] } | 200 { modules?: CourseModule[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND; 409: COURSE_MODULE_ORDER_MISMATCH; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/courses/{courseId}/modules/{moduleId}` | `courses.modules.manage` + CSRF | — | { title?: string, description?: string?, translations?: CourseTranslations } | 200 CourseModule | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_MODULE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/courses/{courseId}/modules/{moduleId}` | `courses.modules.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_MODULE_NOT_FOUND; 409: COURSE_MODULE_NOT_DELETABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/modules/{moduleId}/publish` | `courses.modules.manage` + CSRF | — | — | 200 CourseModule | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_MODULE_NOT_FOUND; 409: INVALID_MODULE_TRANSITION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/modules/{moduleId}/archive` | `courses.modules.manage` + CSRF | — | — | 200 CourseModule | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_MODULE_NOT_FOUND; 409: INVALID_MODULE_TRANSITION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/modules/{moduleId}/restore` | `courses.modules.manage` + CSRF | — | — | 200 CourseModule | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_MODULE_NOT_FOUND; 409: INVALID_MODULE_TRANSITION; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: enrollments

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/courses/{courseId}/enrollments` | `courses.access.read` | limit, offset, state | — | 200 { enrollments: Enrollment[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: COURSE_NOT_FOUND |
| POST | `/admin/courses/{courseId}/enrollments` | `courses.access.manage` + CSRF | — | { userId: Id, beginsAt?: string, expiresAt: string? } | 201 Enrollment | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, USER_NOT_FOUND; 409: COURSE_NOT_PUBLISHED, ENROLLMENT_USER_INELIGIBLE, ENROLLMENT_ALREADY_EXISTS; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/courses/{courseId}/enrollments/{userId}` | `courses.access.manage` + CSRF | — | { expiresAt: string? } | 200 Enrollment | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: ENROLLMENT_NOT_FOUND; 409: ENROLLMENT_REVOKED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/enrollments/{userId}/revoke` | `courses.access.manage` + CSRF | — | — | 200 Enrollment | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: ENROLLMENT_NOT_FOUND; 409: ENROLLMENT_ALREADY_REVOKED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/enrollments/{userId}/modules` | `courses.access.read` | — | — | 200 { moduleGrants?: ModuleGrant[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/courses/{courseId}/enrollments/{userId}/modules` | `courses.access.manage` + CSRF | — | { moduleId: Id, beginsAt?: string, expiresAt: string? } | 201 ModuleGrant | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: ENROLLMENT_NOT_FOUND, COURSE_MODULE_NOT_FOUND; 409: MODULE_NOT_PUBLISHED, ENROLLMENT_NOT_ACTIVE, MODULE_ACCESS_ALREADY_EXISTS; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/courses/{courseId}/enrollments/{userId}/modules/{moduleId}` | `courses.access.manage` + CSRF | — | { expiresAt: string? } | 200 ModuleGrant | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: MODULE_ACCESS_NOT_FOUND; 409: MODULE_ACCESS_REVOKED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/enrollments/{userId}/modules/{moduleId}/revoke` | `courses.access.manage` + CSRF | — | — | 200 ModuleGrant | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: MODULE_ACCESS_NOT_FOUND; 409: MODULE_ACCESS_ALREADY_REVOKED; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: lessons

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/courses/{courseId}/modules/{moduleId}/lessons` | `lessons.read` | — | — | 200 { lessons?: LessonSummary[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/courses/{courseId}/modules/{moduleId}/lessons` | `lessons.manage` + CSRF | — | { title: string, lessonType: video/text/test/mixed, content?: RichContent, translations?: TitleTranslations, videoAssetId?: Id or null, allowOffline?: boolean } | 201 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, COURSE_MODULE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/modules/{moduleId}/lessons/order` | `lessons.manage` + CSRF | — | { lessonIds: Id[] } | 200 { lessons?: LessonSummary[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: LESSON_ORDER_MISMATCH; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.read` | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: LESSON_NOT_FOUND |
| PATCH | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.manage` + CSRF | — | { title?: string, lessonType?: video/text/test/mixed, content?: RichContent, translations?: TitleTranslations, videoAssetId?: Id or null, allowOffline?: boolean } | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: LESSON_VIDEO_REQUIRED, LESSON_TYPE_NOT_PUBLISHABLE, CHAPTERS_EXCEED_VIDEO_DURATION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: LESSON_NOT_DELETABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/publish` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TYPE_NOT_PUBLISHABLE, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/archive` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TYPE_NOT_PUBLISHABLE, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/restore` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TYPE_NOT_PUBLISHABLE, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/lessons/{lessonId}/chapters` | `lessons.manage` + CSRF | — | { chapters: { startSeconds: integer, title: string, translations?: TitleTranslations }[] } | 200 { chapters?: Chapter[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: LESSON_HAS_NO_VIDEO; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/lessons/{lessonId}/resources` | `lessons.manage` + CSRF | — | { resources: { assetId: Id, title?: string }[] } | 200 { resources?: LessonResource[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}/playback` | `lessons.read` | — | — | 200 { playback?: SignedUrl, chapters?: Chapter[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 409: VIDEO_NOT_PLAYABLE |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}/resources/{resourceId}/download` | `lessons.read` | — | — | 200 { download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| GET | `/admin/users/{userId}/offline-licenses` | `lessons.offline.manage` | — | — | 200 { licenses?: OfflineLicense[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/offline-licenses/{licenseId}/revoke` | `lessons.offline.manage` + CSRF | — | — | 200 { license?: OfflineLicense } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: OFFLINE_LICENSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: groups

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/admin/groups` | `groups.create` + CSRF | — | { code: string, name: string, description?: string?, status?: active/archived } | 201 Group | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: GROUP_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/groups/{groupId}` | `groups.update` + CSRF | — | { code?: string, name?: string, description?: string?, status?: active/archived } | 200 Group | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 409: GROUP_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/groups/{groupId}/members` | `groups.members.manage` + CSRF | — | { userId: Id, isRepresentative?: boolean } | 201 { userId?: Id, status?: string, isRepresentative?: boolean, joinedAt?: string } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/groups/{groupId}/members/{userId}` | `groups.members.manage` + CSRF | — | — | 200 { userId?: Id, status?: string, leftAt?: string } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_MEMBER_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/groups/{groupId}/teachers` | `groups.teachers.manage` + CSRF | — | { userId: Id, canPublishAnnouncements?: boolean, canAssignTests?: boolean, canViewResults?: boolean } | 201 { userId?: Id, assignedAt?: string, permissions?: GroupTeacherPermissions } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/groups/{groupId}/teachers/{userId}` | `groups.teachers.manage` + CSRF | — | — | 200 { userId?: Id, status?: "removed" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_TEACHER_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: taxonomy

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/subjects` | `taxonomy.read` | — | — | 200 { subjects?: Subject[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/subjects` | `taxonomy.manage` + CSRF | — | { code: string, primaryLanguage?: LanguageCode, translations: TitleTranslations, color?: green/blue/orange/purple/neutral } | 201 Subject | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: SUBJECT_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/subjects/{subjectId}` | `taxonomy.manage` + CSRF | — | { code?: string, primaryLanguage?: LanguageCode, translations?: TitleTranslations, color?: green/blue/orange/purple/neutral } | 200 Subject | 400: INVALID_SUBJECT_ID; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SUBJECT_NOT_FOUND; 409: SUBJECT_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/subjects/{subjectId}` | `taxonomy.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SUBJECT_NOT_FOUND; 409: SUBJECT_IN_USE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/subjects/{subjectId}/sections` | `taxonomy.read` | — | — | 200 { sections?: Section[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: SUBJECT_NOT_FOUND |
| POST | `/admin/subjects/{subjectId}/sections` | `taxonomy.manage` + CSRF | — | { code: string, primaryLanguage?: LanguageCode, translations: TitleTranslations } | 201 Section | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SUBJECT_NOT_FOUND; 409: SECTION_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/sections/{sectionId}` | `taxonomy.manage` + CSRF | — | { code?: string, primaryLanguage?: LanguageCode, translations?: TitleTranslations } | 200 Section | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SECTION_NOT_FOUND; 409: SECTION_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/sections/{sectionId}` | `taxonomy.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SECTION_NOT_FOUND; 409: SECTION_IN_USE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/subjects/{subjectId}/topics` | `taxonomy.read` | — | — | 200 { topics?: Topic[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: SUBJECT_NOT_FOUND |
| POST | `/admin/subjects/{subjectId}/topics` | `taxonomy.manage` + CSRF | — | { code: string, primaryLanguage?: LanguageCode, translations: TitleTranslations, sectionId?: Id or null, parentId?: Id or null } | 201 Topic | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: SUBJECT_NOT_FOUND; 409: TOPIC_CODE_CONFLICT; 422: TAXONOMY_SUBJECT_MISMATCH; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/topics/{topicId}` | `taxonomy.manage` + CSRF | — | { code?: string, primaryLanguage?: LanguageCode, translations?: TitleTranslations, sectionId?: Id or null, parentId?: Id or null } | 200 Topic | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: TOPIC_NOT_FOUND; 409: TOPIC_CODE_CONFLICT, TOPIC_CYCLE; 422: TAXONOMY_SUBJECT_MISMATCH; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/topics/{topicId}` | `taxonomy.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: TOPIC_NOT_FOUND; 409: TOPIC_IN_USE; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: questions

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/question-banks` | `questions.read` | limit, offset, subjectId | — | 200 { banks: QuestionBank[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/question-banks` | `questions.manage` + CSRF | — | { code: string, title: string, subjectId: Id, visibility?: private/staff, sourceMetadata?: SourceMetadata } | 201 QuestionBank | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: QUESTION_BANK_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/question-banks/{bankId}` | `questions.read` | — | — | 200 QuestionBank | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: QUESTION_BANK_NOT_FOUND |
| PATCH | `/admin/question-banks/{bankId}` | `questions.manage` + CSRF | — | { code?: string, title?: string, visibility?: private/staff, sourceMetadata?: SourceMetadata } | 200 QuestionBank | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, QUESTION_BANK_READ_ONLY, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_BANK_NOT_FOUND; 409: QUESTION_BANK_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/question-banks/{bankId}/questions` | `questions.read` | limit, offset, status, questionType, languageCode, keyStatus, topicId | — | 200 { questions: QuestionSummary[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: QUESTION_BANK_NOT_FOUND |
| POST | `/admin/question-banks/{bankId}/questions` | `questions.manage` + CSRF | — | { questionType: single_choice/multiple_choice/matching/numeric/short_text, externalId?: string?, languageCode?: LanguageCode, difficulty?: integer?, difficultySource?: ai/expert/official, content: RichContent, interactionSettings?: object, sourceMetadata?: SourceMetadata, options?: QuestionItemInput[], matching?: { left: QuestionItemInput[], right: QuestionItemInput[] }, topicIds?: Id[] } | 201 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, QUESTION_BANK_READ_ONLY, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_BANK_NOT_FOUND; 409: QUESTION_EXTERNAL_ID_CONFLICT; 422: TAXONOMY_SUBJECT_MISMATCH, QUESTION_ASSET_NOT_USABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/questions/{questionId}` | `questions.read` | — | — | 200 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: QUESTION_NOT_FOUND |
| PATCH | `/admin/questions/{questionId}` | `questions.manage` + CSRF | — | { externalId?: string?, languageCode?: LanguageCode, difficulty?: integer?, difficultySource?: ai/expert/official, content?: RichContent, interactionSettings?: object, sourceMetadata?: SourceMetadata, options?: QuestionItemInput[], matching?: { left: QuestionItemInput[], right: QuestionItemInput[] }, topicIds?: Id[] } | 200 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, QUESTION_BANK_READ_ONLY, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: QUESTION_IMMUTABLE, QUESTION_EXTERNAL_ID_CONFLICT; 422: TAXONOMY_SUBJECT_MISMATCH, QUESTION_ASSET_NOT_USABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/questions/{questionId}` | `questions.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: QUESTION_IMMUTABLE, QUESTION_IN_USE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/questions/{questionId}/copy` | `questions.manage` + CSRF | — | — | 201 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, QUESTION_BANK_READ_ONLY, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/questions/{questionId}/answer-key` | `questions.manage` + CSRF | — | { answerData: object?, source?: none/official_key/expert_review/ai_inference, explanation?: RichContent } | 200 QuestionDetail | 400: ANSWER_KEY_INVALID; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: QUESTION_IMMUTABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/questions/{questionId}/answer-key/verify` | `questions.review` + CSRF | — | { source: official_key/expert_review } | 200 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: QUESTION_IMMUTABLE, ANSWER_KEY_NOT_PROPOSED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/questions/{questionId}/publish` | `questions.review` + CSRF | — | — | 200 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: INVALID_QUESTION_TRANSITION, QUESTION_NOT_PUBLISHABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/questions/{questionId}/archive` | `questions.review` + CSRF | — | — | 200 QuestionDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: QUESTION_NOT_FOUND; 409: INVALID_QUESTION_TRANSITION; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: question imports

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/question-imports` | `questions.manage` | limit, offset, bankId, status | — | 200 { imports: QuestionImport[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| GET | `/admin/question-imports/{importId}` | `questions.manage` | — | — | 200 QuestionImport | 400: VALIDATION_ERROR, INVALID_IMPORT_ID; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: QUESTION_IMPORT_NOT_FOUND |
| GET | `/admin/question-imports/{importId}/errors` | `questions.manage` | limit, offset, severity | — | 200 { entries: QuestionImportEntry[], pagination: Pagination } | 400: VALIDATION_ERROR, INVALID_IMPORT_ID; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: QUESTION_IMPORT_NOT_FOUND |

### Shared schemas

- **AccountTransition**: { action?: approve/reject/block/unblock, user?: PendingUser, revokedSessions?: integer }
- **AdminAccount**: { id: Id, firstName?: string?, lastName?: string?, displayName?: string?, phone?: string?, status: pending/active/blocked/rejected, roles: admin/owner/student/teacher[], createdAt: string, lastLoginAt?: string?, telegramLinked: boolean }
- **Announcement**: { id?: Id, groupId?: Id, authorId?: Id, title?: string, content?: string, isPinned?: boolean, status?: draft/published/archived, publishedAt?: string?, createdAt?: string, updatedAt?: string }
- **AnswerKey**: { status?: unknown/proposed/verified, source?: none/official_key/expert_review/ai_inference, answerData?: object?, explanation?: RichContent, verifiedBy?: Id or null, verifiedAt?: string? }
- **Asset**: { id?: Id, kind?: string, mimeType?: string, fileName?: string?, sizeBytes?: integer, widthPx?: integer?, heightPx?: integer?, durationSeconds?: integer?, status?: string, processingStatus?: none/not_required/pending/processing/completed/failed, processingError?: string?, createdAt?: string }
- **AuthResult**: { status: authenticated/refreshed, expiresAt: string, refreshExpiresAt?: string, sessionId?: Id, user?: { id: Id } }
- **Chapter**: { id?: Id, startSeconds?: integer, title?: string, translations?: TitleTranslations, position?: integer }
- **Course**: { id?: Id, subjectId?: Id or null, title?: string, description?: string?, languageCode?: LanguageCode, translations?: CourseTranslations, coverAssetId?: Id or null, status?: draft/published/archived, creatorId?: Id, relationship?: { administrator?: boolean, teacher?: boolean, canEdit?: boolean }, createdAt?: string, updatedAt?: string }
- **CourseModule**: { id?: Id, courseId?: Id, title?: string, description?: string?, translations?: CourseTranslations, position?: integer, status?: draft/published/archived, createdAt?: string }
- **CourseTeacher**: { id?: Id, firstName?: string?, lastName?: string?, avatarAssetId?: Id or null, permissions?: { editCourse?: boolean, manageLessons?: boolean, manageQuestions?: boolean, manageTests?: boolean, viewResults?: boolean } }
- **CourseTranslations**: object
- **Enrollment**: any
- **EnrollmentWindow**: { state?: active/scheduled/expired, beginsAt?: string, expiresAt?: string? }
- **ErrorResponse**: { error: { code: string, message: string, details: object[] } }
- **GrantWindow**: { state?: active/scheduled/expired/revoked, grantedBy?: Id, grantedAt?: string, beginsAt?: string, expiresAt?: string?, revokedAt?: string?, revokedBy?: Id or null }
- **Group**: { id?: Id, code?: string, name?: string, description?: string?, status?: active/archived, memberCount?: integer, teacherCount?: integer, relationship?: GroupRelationship, createdAt?: string, updatedAt?: string }
- **GroupMember**: { id?: Id, firstName?: string?, lastName?: string?, avatarAssetId?: Id or null, role?: member/representative, status?: string, joinedAt?: string }
- **GroupRelationship**: { member?: boolean, representative?: boolean, teacher?: boolean, administrator?: boolean }
- **GroupTeacher**: { id?: Id, firstName?: string?, lastName?: string?, avatarAssetId?: Id or null, role?: "teacher", assignedAt?: string, permissions?: GroupTeacherPermissions }
- **GroupTeacherPermissions**: { publishAnnouncements?: boolean, assignTests?: boolean, viewResults?: boolean }
- **Id**: string
- **LanguageCode**: tg/ru/en
- **LearnerCourse**: { id?: Id, title?: string, description?: string?, languageCode?: LanguageCode, translations?: CourseTranslations, coverAssetId?: Id or null, subject?: SubjectCard or null, moduleCount?: integer, lessonCount?: integer, enrollment?: EnrollmentWindow }
- **LearnerLesson**: { id: Id, moduleId?: Id, title?: string, position?: integer, lessonType?: string, translations?: TitleTranslations, access: { granted?: boolean }, content?: RichContent, allowOffline?: boolean, video?: { durationSeconds?: integer?, playable?: boolean }, chapters?: Chapter[], resources?: { id?: Id, title?: string?, position?: integer, fileName?: string?, mimeType?: string, sizeBytes?: integer }[], progress?: Progress }
- **LearnerModule**: { id?: Id, position?: integer, title?: string, description?: string?, translations?: CourseTranslations, access?: { granted?: boolean, lockReason?: onboarding_required/not_started/expired/not_granted/unavailable } }
- **LessonDetail**: any
- **LessonResource**: { id?: Id, assetId?: Id, title?: string?, position?: integer, fileName?: string?, mimeType?: string, sizeBytes?: integer }
- **LessonSummary**: { id?: Id, moduleId?: Id, courseId?: Id, title?: string, position?: integer, lessonType?: video/text/test/mixed, translations?: TitleTranslations, videoAssetId?: Id or null, allowOffline?: boolean, status?: draft/published/archived, createdAt?: string, updatedAt?: string }
- **LessonVideo**: { assetId?: Id, mimeType?: string, durationSeconds?: integer?, widthPx?: integer?, heightPx?: integer?, sizeBytes?: integer, playable?: boolean }
- **ModuleGrant**: any
- **Note**: { id?: Id, lessonId?: Id, body?: string, playbackSeconds?: integer?, createdAt?: string, updatedAt?: string }
- **OfflineLicense**: { id?: Id, courseId?: Id, lessonId?: Id, status?: active/expired/revoked, grantedAt?: string, renewedAt?: string?, lastCheckedAt?: string?, leaseExpiresAt?: string, deviceLabel?: string?, revokeReason?: user_deleted/admin_revoked/access_lost, sessionId?: Id }
- **Onboarding**: { state?: incomplete/completed, completedSteps?: string[], missingRequiredFields?: string[], canComplete?: boolean, completedAt?: string? }
- **Pagination**: { limit: integer, offset: integer, hasMore: boolean, total?: integer }
- **PendingUser**: { id?: Id, status?: string, firstName?: string?, lastName?: string?, phone?: string?, createdAt?: string, onboardingCompletedAt?: string? }
- **PreviewModule**: { id?: Id, title?: string, description?: string?, position?: integer, status?: string, lessonsCount?: integer, testsCount?: integer }
- **Profile**: { id?: Id, firstName?: string?, lastName?: string?, displayName?: string?, phone?: string?, telegramLinked?: boolean, avatarAssetId?: Id or null, status?: string, roles?: string[], preferredLanguage?: ru/tj/en, timezone?: string?, onboarding?: Onboarding, createdAt?: string, updatedAt?: string }
- **Progress**: { status?: string, playbackSeconds?: integer, watchedSeconds?: integer, completedAt?: string?, revision?: integer, updatedAt?: string }
- **QuestionBank**: { id?: Id, code?: string, title?: string, subjectId?: Id, ownerId?: Id, visibility?: private/staff, sourceMetadata?: SourceMetadata, questionCount?: integer, permissions?: { manage?: boolean }, createdAt?: string }
- **QuestionDetail**: any
- **QuestionImport**: { id?: Id, bankId?: Id, bankCode?: string, initiatedBy?: Id, packageSha256?: string, schemaVersion?: "everest.question-import.v1", idempotencyKey?: string, isDryRun?: boolean, status?: pending/validating/validated/importing/completed/failed, manifest?: object, counters?: object, createdAt?: string, finishedAt?: string? }
- **QuestionImportEntry**: { id?: Id, externalId?: string?, recordPath?: string?, severity?: warning/error, code?: string, message?: string, createdAt?: string }
- **QuestionItem**: { key?: string, position?: integer, sourceLabel?: string?, content?: RichContent }
- **QuestionItemInput**: { key: string, content: RichContent, sourceLabel?: string? }
- **QuestionSummary**: { id?: Id, externalId?: string?, questionType?: single_choice/multiple_choice/matching/numeric/short_text, languageCode?: LanguageCode, difficulty?: integer?, difficultySource?: ai/expert/official, status?: draft/published/archived, keyStatus?: unknown/proposed/verified, content?: RichContent, updatedAt?: string }
- **RichContent**: { blocks: { type: string }[] }
- **RoleChange**: { changed: boolean, user: AdminAccount, revokedSessions: integer }
- **Section**: { id?: Id, subjectId?: Id, code?: string, primaryLanguage?: LanguageCode, title?: string?, translations?: TitleTranslations }
- **Session**: { id?: Id, createdAt?: string, lastUsedAt?: string?, expiresAt?: string, revokedAt?: string?, current?: boolean, device?: { browser?: string, operatingSystem?: string, deviceType?: string } }
- **SignedUrl**: { url?: string, expiresAt?: string, fileName?: string, mimeType?: string, sizeBytes?: integer, durationSeconds?: integer? }
- **SourceMetadata**: { book?: string, edition?: string, page?: integer, number?: string, note?: string, year?: integer, sourceFile?: string, printedPage?: string, sequence?: integer, bookSectionTitle?: string, bookRubric?: string, isSample?: boolean, reviewRequired?: boolean, examPart?: string[] }
- **StatusResult**: { status: string }
- **Subject**: { id?: Id, code?: string, primaryLanguage?: LanguageCode, title?: string?, translations?: TitleTranslations, color?: green/blue/orange/purple/neutral }
- **SubjectCard**: { id?: Id, title?: string?, translations?: TitleTranslations, color?: green/blue/orange/purple/neutral }
- **TitleTranslations**: object
- **Topic**: { id?: Id, subjectId?: Id, sectionId?: Id or null, parentId?: Id or null, code?: string, primaryLanguage?: LanguageCode, title?: string?, translations?: TitleTranslations }
- **Upload**: { id?: Id, assetId?: Id, courseId?: Id, kind?: video/material, fileName?: string, mimeType?: string, sizeBytes?: integer, partSizeBytes?: integer, partCount?: integer, status?: initiated/completed/aborted/rejected/expired, rejectionCode?: string?, createdAt?: string, expiresAt?: string, completedAt?: string?, abortedAt?: string? }

---

## 3. Permission matrix

### 3.1 Permission → roles

As seeded by the migrations:

| Permission | owner | admin | teacher | student |
|---|---|---|---|---|
| `accounts.pending.read`, `accounts.approve`, `accounts.reject`, `accounts.block`, `accounts.unblock` | ✓ | ✓ | — | — |
| `assets.upload`, `assets.manage` | ✓ | ✓ | — (see scope) | — |
| `courses.read`, `courses.update` | ✓ | ✓ | ✓ scoped | — |
| `courses.create`, `courses.publish`, `courses.copy`, `courses.teachers.manage`, `courses.access.read`, `courses.access.manage` | ✓ | ✓ | — | — |
| `courses.modules.manage`, `lessons.read`, `lessons.manage` | ✓ | ✓ | ✓ scoped | — |
| `lessons.offline.manage` | ✓ | ✓ | — | — |
| `groups.create`, `groups.update`, `groups.members.manage`, `groups.teachers.manage` | ✓ | ✓ | — | — |
| `groups.announcements.manage` | ✓ | ✓ | ✓ scoped | — |
| `taxonomy.read` | ✓ | ✓ | ✓ | — |
| `taxonomy.manage` | ✓ | ✓ | — | — |
| `questions.read`, `questions.manage` | ✓ | ✓ | ✓ (own banks / staff-visible banks) | — |
| `questions.review` | ✓ | ✓ | — | — |

Notes:

- **Students** hold no permission. They use the learner routes (`/courses`, `/groups`, `/profile`, `/auth/*`), where the scope comes from enrollments, module grants and group memberships. Roles never grant course access.
- **Teacher scoping** (`docs/api.md`):
   - courses, modules and lessons: only courses the teacher is assigned to; editing also needs the assignment flags `canEditCourse` / `canManageLessons`;
   - uploads: an assigned teacher with `canManageLessons`;
   - groups: assigned groups, and announcements only when the assignment allows publishing;
   - question banks: the teacher's own banks for writes; own and staff-visible banks for reads.
- **Missing permission:** most routes return `403 ACTION_FORBIDDEN`; account-administration routes return `403 ADMIN_ROLE_REQUIRED`. A missing scope (resource not visible to the actor) returns the resource's `404`.

### 3.2 Account actions: who may act on whom

Enforced in `src/services/account-admin-service.js`.

| Actor → target | approve | reject | block | unblock | roles (`PUT /admin/users/:id/roles`) |
|---|---|---|---|---|---|
| owner → owner | ✓ | ✓ | ✓, except the last active owner (`409 LAST_OWNER_PROTECTED`) | ✓ | ✓; removing `owner` from the last active owner returns `409 LAST_OWNER_PROTECTED` |
| owner → admin / teacher / student | ✓ | ✓ | ✓ | ✓ | ✓ any role set (must contain `student`) |
| admin → owner | ✓ (not owner-protected) | `403 OWNER_ACTION_FORBIDDEN` | `403 OWNER_ACTION_FORBIDDEN` | `403 OWNER_ACTION_FORBIDDEN` | `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| admin → admin (another) | ✓ | ✓ | ✓ | ✓ | `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| admin → teacher / student | ✓ | ✓ | ✓ | ✓ | ✓, but only `teacher`/`student` changes; granting `admin`/`owner` returns `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| anyone → self | (own account is not pending) | `409 SELF_REJECTION_FORBIDDEN` | `409 SELF_BLOCK_FORBIDDEN` | — | `409 SELF_ROLE_CHANGE_FORBIDDEN` |
| teacher / student → anyone | `403 ADMIN_ROLE_REQUIRED` | same | same | same | same |

State rules:

- `approve`/`reject`: `pending` only. `block`: `active` only. `unblock`: `blocked` only. Otherwise `409 INVALID_ACCOUNT_TRANSITION`.
- **Role sets** must be non-empty, distinct, use known codes (`400 INVALID_ROLES`) and include `student` (`422 STUDENT_ROLE_REQUIRED`).
- **An unchanged role set** returns `changed: false`, with no audit row and no revocation.

---

## 4. Authentication and sessions

### 4.1 Login

- **Password:** `POST /auth/login/password`.
- **Telegram:** `GET /auth/telegram/start` → Telegram → `GET /auth/telegram/callback`.
- Both set the same cookies.
- Only **active** accounts can log in. `pending`, `blocked` and `rejected` get the same `403 ACCOUNT_NOT_ACTIVE`; an unknown phone or wrong password gets `401 INVALID_CREDENTIALS`.
- **Registration** (`POST /auth/register`) creates a `pending` account with the `student` role and **no session**. An admin must approve it.

### 4.2 Cookies vs. Bearer

| Cookie | HttpOnly | Path | Lifetime (default) | Purpose |
|---|---|---|---|---|
| `everest_access` | yes | `/` | `AUTH_SESSION_TTL_SECONDS` = 900 s | access JWT |
| `everest_refresh` | yes | `/api/v1/auth` | `AUTH_REFRESH_TTL_SECONDS` = 30 days | opaque, single-use refresh token |
| `everest_csrf` | **no** (readable) | `/` | refresh lifetime | CSRF token to echo in `X-CSRF-Token` |

- All cookies are `SameSite=Lax`. They are `Secure` only when `NODE_ENV=production`, so plain `http://localhost` works in development.
- **Tokens are never in JSON.** The login, refresh and Telegram responses return only `{ status, expiresAt, refreshExpiresAt, sessionId?, user: { id } }` (`AuthResult`).
- **Bearer:** `Authorization: Bearer <access JWT>` is also accepted and takes precedence over the cookie. Bearer requests need no CSRF header. The browser flow is cookie-based, because login never hands out the token.
- Every request re-checks a **live server-side session**: not revoked, not expired, and the account still `active`. A revoked session fails on the next request with `401`, even if its JWT is not expired yet. Permissions are also read from the database on every request.

### 4.3 CSRF (cookie-authenticated mutations)

- **Applies to** `POST`, `PUT`, `PATCH` and `DELETE` when the request authenticates with the access cookie (no `Authorization` header).
- **What to send:**
   - `X-CSRF-Token: <value of everest_csrf>`;
   - an `Origin` listed in `CORS_ORIGINS` (browsers send it automatically).
- **Errors:** `403 CSRF_TOKEN_INVALID` or `403 CSRF_ORIGIN_REJECTED`.
- **Exempt:** registration, login, Telegram callback and password recovery.
- **`/auth/refresh` and `/auth/logout`** require CSRF when the refresh cookie identifies a live session.

### 4.4 Refresh

- **Call:** `POST /auth/refresh` with credentials and CSRF. It sets new access and refresh cookies; each refresh token is single-use.
- **Errors:**
   - `401 INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_REQUIRED`: send the user to login;
   - `401 REFRESH_TOKEN_REUSE_DETECTED`: the whole session family is revoked and the cookies are cleared.
- **Suggested client flow:** on a `401` from a normal call, try one refresh, then retry once; if the refresh fails, go to login. Serialize concurrent refreshes, because a token is single-use and a parallel second refresh fails.

### 4.5 `revokedSessions`

A count of the subject's **server-side sessions that were live and are now revoked** by this action. Their refresh tokens are revoked too.

| Where | Whose sessions | Revoke reason |
|---|---|---|
| `POST /admin/users/:id/block` | the blocked user | `account_blocked` |
| `PUT /admin/users/:id/roles` (when `changed: true`) | the user whose roles changed | `roles_changed` |
| `POST /auth/logout-all` | the caller (including the current session; cookies cleared) | — |

For the admin UI, `revokedSessions > 0` means "this user was signed out on N devices and must log in again". `0` means the user had no live session.

Other revocations without a counter in the response: password reset revokes every session of the account; `DELETE /auth/sessions/:id` revokes one session.

### 4.6 CORS for local development

- **Allowed origins:** `CORS_ORIGINS` is a comma-separated list. The default is `http://localhost:3000`, and **only** listed origins are allowed, with `credentials: true`.
- **Fetch calls** must use `credentials: 'include'` (or the axios `withCredentials`).
- **Origins must match exactly:** scheme, host and port. Add every dev origin you use (for example `http://localhost:5173`, and `http://localhost:4000` for Swagger).
- **The CSRF origin check uses the same list.**
- **Cookies** are host-scoped, not port-scoped, so a frontend on `localhost:5173` and the API on `localhost:4000` share them.
- **Hosts:** do not mix `localhost` and `127.0.0.1`; they are different sites.
- **Dev proxy:** the refresh cookie path is `/api/v1/auth`, so a proxy must keep the `/api/v1` prefix.

---

## 5. Running the backend locally

- **Requirements:**
   - Node **22** (`engines: >=22 <23`);
   - PostgreSQL;
   - S3-compatible storage only for uploads, playback and imports with images (`docker-compose.yml` provides MinIO on `127.0.0.1:9000`/`9001`; it does not provide PostgreSQL).
- **Port:** `PORT`, default **4000**.

### 5.1 Environment variables

Names only; put values in `.env` (never commit it).

| Group | Variables |
|---|---|
| Database (required) | `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; optional `DB_PORT` (5432), `DB_SSL`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS` |
| Server | `PORT`, `NODE_ENV`, `CORS_ORIGINS`, `SWAGGER_ENABLED`, `SHUTDOWN_TIMEOUT_MS` |
| Auth (needed for any login; each ≥32 characters, different values; without them auth routes return `503`) | `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` |
| Auth tuning (optional) | `AUTH_SESSION_TTL_SECONDS`, `AUTH_REFRESH_TTL_SECONDS`, `AUTH_RATE_WINDOW_SECONDS`, `AUTH_RATE_BLOCK_SECONDS`, `AUTH_LOGIN_MAX_ATTEMPTS`, `AUTH_PUBLIC_RATE_LIMIT`, `AUTH_ADMIN_RATE_LIMIT`, `PLAYBACK_RATE_LIMIT` |
| Password recovery (optional) | `RECOVERY_CHALLENGE_TTL_SECONDS`, `RECOVERY_RESET_TTL_SECONDS`, `RECOVERY_RESEND_COOLDOWN_SECONDS`, `RECOVERY_MAX_ATTEMPTS`, `RECOVERY_MAX_REQUESTS_PER_HOUR` |
| Telegram (optional; Telegram login, link, recovery) | `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_REDIRECT_URI`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OIDC_STATE_TTL_SECONDS` |
| Storage (optional; otherwise storage routes return `503 STORAGE_NOT_CONFIGURED`) | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `STORAGE_PART_SIZE_BYTES`, `STORAGE_PRESIGN_TTL_SECONDS`, `STORAGE_UPLOAD_TTL_HOURS` |

### 5.2 Steps

```bash
npm install
npm run migrate:up          # applies src/migrations (25 today); never run migrate:down on a real DB
npm run dev                 # or npm start; http://localhost:4000, Swagger at /api/docs
npm run storage:configure   # only with S3/MinIO: bucket CORS/settings
```

### 5.3 Seed and demo accounts

- **There is no seed script and there are no built-in demo accounts.** The migrations seed only the roles and permissions.
- **Create demo users per role through the API:**
   1. Register the owner: `POST /auth/register` (`phone`, `password`, `firstName`, `lastName`). The account is `pending`.
   2. `npm run bootstrap:owner -- --phone +992XXXXXXXXX`. This activates that account and grants `owner`. It works **once** per database (`OWNER_ALREADY_CONFIGURED` afterwards).
   3. Register the admin, teacher and student accounts the same way.
   4. As the owner, call `GET /admin/users/pending` and `POST /admin/users/:id/approve` for each.
   5. Set roles with `PUT /admin/users/:id/roles`:
      - admin: `["student","admin"]` (owner only);
      - teacher: `["student","teacher"]`;
      - student: unchanged.
   6. Teachers need course or group assignments to see anything: `POST /admin/courses/:id/teachers`, `POST /admin/groups/:id/teachers`.
   7. Students need `POST /admin/courses/:id/enrollments` plus module grants to open content.
- **Tests:** `npm test` runs the whole suite in a disposable database and never touches your local data.

---

## 6. Database (short)

87 tables (PostgreSQL, `BIGINT` identity keys, migrations in `src/migrations`). Only the domains listed as having an API in §2 are reachable from the frontend today.

| Domain | Tables | Key relations | API |
|---|---|---|---|
| Identity & auth | `users`, `user_profiles`, `user_phones`, `user_passwords`, `auth_identities`, `auth_sessions`, `auth_refresh_tokens`, `auth_challenges`, `auth_security_counters`, `telegram_oidc_states`, `telegram_connections`, `sms_deliveries`, `user_invitations` | one `users.id` for phone, password and Telegram; sessions → users; refresh tokens → sessions | yes (`user_invitations`, `sms_deliveries` unused) |
| RBAC & audit | `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_events` | user_roles (user, role); audit_events (actor, subject, entity) | via account admin |
| Groups | `groups`, `group_members`, `group_teachers`, `group_announcements`, `announcement_assets` | members and teachers → groups and users; groups **never** grant course access | yes |
| Taxonomy | `subjects`, `subject_translations`, `sections`, `section_translations`, `topics`, `topic_translations` | sections and topics → subject; topic → section/parent (same subject) | yes (admin) |
| Courses & learning | `courses`, `course_teachers`, `course_modules`, `lessons`, `lesson_video_chapters`, `lesson_resources`, `course_enrollments`, `module_access_grants`, `lesson_progress`, `lesson_notes`, `course_favorites`, `learning_activity_events`, `offline_downloads` | course → modules → lessons; enrollments and module grants per user (separate, admin-granted) | yes (notes, favorites, activity: schema only) |
| Assets | `assets`, `asset_uploads`, `asset_aliases` | uploads → asset + course; aliases (namespace, externalId) → asset | yes (uploads); aliases via import |
| Question bank | `question_banks`, `questions`, `question_options`, `question_matching_items`, `question_answer_keys`, `question_topics`, `question_assets`, `question_duplicate_links`, `question_imports`, `question_import_errors` | bank → subject, owner; question → bank; options, items, key, topics, assets → question; correctness only in `question_answer_keys` | yes (admin); import via CLI; read-only run API |
| Tests & attempts | `tests`, `test_questions`, `test_assignments`, `test_attempts`, `attempt_questions`, `student_answers`, `attempt_score_revisions` | — | **no API yet** (M10/M11) |
| AI | `ai_*` (11 tables) | — | **no API** |
| Bonus & achievements | `bonus_*` (5 tables), `achievements`, `user_achievements` | — | **no API** |
| Notifications | `notifications`, `notification_deliveries`, `notification_preferences`, `push_subscriptions`, `broadcast_campaigns` | — | **no API** (only a Telegram test message) |
| Operations | `background_jobs`, `idempotency_keys`, `platform_settings` | — | **no API** |

---

## 7. Known gaps, inconsistencies and TODOs

### API behaviour the UI must handle

1. **Two different 403 codes for a missing permission:** account administration returns `ADMIN_ROLE_REQUIRED`; every other domain returns `ACTION_FORBIDDEN`.
2. **`total` exists only on the two admin user lists**; every other list is `hasMore`-only. A "page X of Y" UI is only possible there.
3. **Validation reports only the first error** (`details` has one entry), so forms cannot show all field errors from one response.
4. **Language codes differ by endpoint:**
   - profile uses `preferredLanguage`: `ru|tj|en` (`tj` is stored as `tg`);
   - courses, taxonomy and questions use `tg|ru|en`.
5. **`AccountTransition.user`** (approve/reject/block/unblock) uses the older `PendingUser` shape (no `roles`, `displayName` or `telegramLinked`). Refetch the row from `GET /admin/users` after an action.
6. **`approve` is not owner-protected**, and an admin may block, reject or unblock another admin (only owners are protected). This is intentional per `docs/decisions.md` M17; flag it if the product disagrees.
7. **`LAST_OWNER_PROTECTED` is practically unreachable through the API.** The acting owner is itself an active owner, so the guard only fires in races. The UI may still map it.
8. **Every role set must include `student`**, even for staff (`422 STUDENT_ROLE_REQUIRED`). The database itself does not require it.
9. **Matching questions may have `requireAllLeft`/`allowRightReuse` = `null`** (imported books). Such questions cannot be published (`409 QUESTION_NOT_PUBLISHABLE`, detail `INTERACTION_SETTINGS_INCOMPLETE`) until a reviewer sets booleans with `PATCH /admin/questions/:id`.
10. **Rich content is block-level only:** no inline bold or inline formulas, and no table headers. Imported book text was flattened with warnings (see the run errors API).
11. **Asset uploads require a `courseId`.** There is no HTTP upload for question-bank images; book images arrive only through the CLI importer.
12. **No API for duplicate links.** A draft with a duplicate link cannot be deleted (`409 QUESTION_IN_USE`).
13. **Imports are CLI-only.** The admin UI can only read runs: `GET /admin/question-imports`, `/:id`, `/:id/errors`.

### Not implemented (tables exist, no endpoints)

14. Tests, assignments, attempts and grading (M10/M11).
15. Progress analytics, notes, favorites and activity APIs.
16. Notifications and inbox, broadcast campaigns, Web Push.
17. AI chat and budgets.
18. Bonuses and achievements.
19. Invitations.
20. Platform settings.

### Environment and verification

21. **Production SMS provider:** none is configured; password recovery by SMS is accepted but not delivered. Telegram recovery needs a linked Telegram identity and a bot connection.
22. **Real S3/MinIO** upload, playback and import were **not verified** in the backend environment (only a storage double in tests).
23. **No seed or demo-account script** (§5.3). `bootstrap:owner` works once per database.
24. **`.env.example`** was reported out of date in earlier handoffs (missing `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` and `SWAGGER_ENABLED`). Rely on §5.1, not on that file.

### Documentation inconsistencies

25. `docs/api.md` §"Session lifecycle" still says CSRF hardening "remains M02F". That is stale: M02F-B implemented the CSRF token and origin check described in §4.3.
26. Lists in `docs/api.md` describe ordering per endpoint, but there is no global sort parameter. Only `GET /admin/users` accepts `sort`.
