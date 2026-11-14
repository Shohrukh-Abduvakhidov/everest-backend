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
- **`total`** exists **only** on `GET /admin/users`, `GET /admin/users/pending` and `GET /groups`. Other lists have `hasMore` only.
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
| GET | `/courses/{courseId}/lessons/{lessonId}/playback` | session | — | — | 200 { playback?: SignedUrl (same URL inside a 6 h window), chapters?: Chapter[], watermark?: { label: string } } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED; 404: LESSON_NOT_FOUND; 409: VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/courses/{courseId}/lessons/{lessonId}/resources/{resourceId}/download` | session | — | — | 200 { download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED; 404: LESSON_NOT_FOUND, RESOURCE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/courses/{courseId}/lessons/{lessonId}/notes` | session | — | — | 200 { notes?: Note[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| POST | `/courses/{courseId}/lessons/{lessonId}/notes` | session + CSRF | — | { body: string, playbackSeconds?: integer? } | 201 { note?: Note } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: NOTE_LIMIT_REACHED |
| PATCH | `/courses/{courseId}/lessons/{lessonId}/notes/{noteId}` | session + CSRF | — | { body?: string, playbackSeconds?: integer? } | 200 { note?: Note } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: NOTE_NOT_FOUND |
| DELETE | `/courses/{courseId}/lessons/{lessonId}/notes/{noteId}` | session + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: NOTE_NOT_FOUND |
| GET | `/courses/{courseId}/lessons/{lessonId}/progress` | session | — | — | 200 { progress?: Progress } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| PUT | `/courses/{courseId}/lessons/{lessonId}/progress` | session + CSRF | — | { revision: integer, playbackSeconds?: integer, watchedRanges?: [start, end][], completed?: boolean } | 200 { progress?: Progress } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: PROGRESS_REVISION_CONFLICT, LESSON_COMPLETES_BY_TEST; 429: PROGRESS_TOO_FREQUENT |

### Offline licenses

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/courses/{courseId}/lessons/{lessonId}/offline-license` | session + CSRF | — | { deviceId?: uuid, deviceLabel?: string } | 200 { license?: OfflineLicense, download?: SignedUrl, encryption?: Encryption } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: MODULE_ACCESS_DENIED, OFFLINE_ACCESS_DENIED, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: OFFLINE_DEVICE_LIMIT, OFFLINE_DEVICE_NOT_REGISTERED; 429: AUTH_RATE_LIMITED (Retry-After header); 503: OFFLINE_KEYS_UNAVAILABLE |
| GET | `/offline-devices` | session | — | — | 200 { devices: OfflineDevice[], maximumDevices: integer } | 401: AUTHENTICATION_REQUIRED |
| POST | `/offline-devices` | session + CSRF | — | { deviceId: uuid, deviceLabel?: string } | 201/200 { device: OfflineDevice, created: boolean, maximumDevices: integer } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: OFFLINE_DEVICE_LIMIT |
| DELETE | `/offline-devices/{deviceId}` | session + CSRF | — | — | 200 { deviceId, status: "removed", revokedLicenses: integer } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: OFFLINE_DEVICE_NOT_FOUND |
| GET | `/offline-licenses` | session | deviceId (uuid) | — | 200 { licenses?: OfflineLicense[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| GET | `/offline-licenses/{licenseId}/download` | session | deviceId (uuid) | — | 200 { license?: OfflineLicense, download?: SignedUrl, encryption?: Encryption } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: OFFLINE_ACCESS_DENIED; 404: OFFLINE_LICENSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/offline-licenses/{licenseId}` | session + CSRF | deviceId (uuid) | — | 200 { license?: OfflineLicense } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: OFFLINE_LICENSE_NOT_FOUND |

### Groups

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/groups` | session | limit, offset, status (active/archived), q (2–100, name) | — | 200 { groups: Group[], pagination: Pagination (with total) } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED |
| GET | `/groups/{groupId}` | session | — | — | 200 Group | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/members` | session | limit, offset | — | 200 { members: GroupMember[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/teachers` | session | limit, offset | — | 200 { teachers: GroupTeacher[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| GET | `/groups/{groupId}/announcements` | session | limit, offset, status (draft/published/archived; drafts/archived only for owner/admin and publishing teachers) | — | 200 { announcements: Announcement[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: GROUP_NOT_FOUND |
| POST | `/groups/{groupId}/announcements` | `groups.announcements.manage` + CSRF | — | { title: string, content: string, isPinned?: boolean, status?: draft/published } | 201 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 409: GROUP_ARCHIVED |
| PATCH | `/groups/{groupId}/announcements/{announcementId}` | `groups.announcements.manage` + CSRF | — | { title?: string, content?: string, isPinned?: boolean, status?: draft/published } | 200 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, ANNOUNCEMENT_NOT_FOUND |
| DELETE | `/groups/{groupId}/announcements/{announcementId}` | `groups.announcements.manage` + CSRF | — | — | 200 Announcement | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, ANNOUNCEMENT_NOT_FOUND |

### Assets

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/assets/uploads` | session + CSRF | — | { courseId: Id, lessonId?: Id, kind: video/material, fileName: string, mimeType: string, sizeBytes: integer } | 201 Upload | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, LESSON_NOT_FOUND; 409: COURSE_ARCHIVED, VIDEO_UPLOAD_LIMIT_REACHED, VIDEO_QUOTA_EXCEEDED; 413: VIDEO_TOO_LARGE; 429: AUTH_RATE_LIMITED (Retry-After header); 503: STORAGE_NOT_CONFIGURED |
| GET | `/assets/uploads/{uploadId}` | session | — | — | 200 { upload?: Upload, uploadedParts?: { partNumber?: integer, size?: integer }[], missingParts?: integer[], uploadedBytes?: integer } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 404: UPLOAD_NOT_FOUND |
| POST | `/assets/uploads/{uploadId}/parts` | session + CSRF | — | { partNumbers: integer[] } | 200 { parts?: { partNumber?: integer, sizeBytes?: integer, url?: string, expiresAt?: string }[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_ABORTED, UPLOAD_EXPIRED |
| POST | `/assets/uploads/{uploadId}/complete` | session + CSRF | — | — | 200 { asset?: Asset, lesson?: { lessonId, attached, errorCode } } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_INCOMPLETE, UPLOAD_ABORTED, UPLOAD_REJECTED, UPLOAD_EXPIRED, UPLOAD_PARTS_MISSING; 422: UNSUPPORTED_MEDIA, VIDEO_NOT_SEEKABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/assets/uploads/{uploadId}/abort` | session + CSRF | — | — | 200 { upload?: Upload } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: UPLOAD_NOT_FOUND; 409: UPLOAD_ALREADY_COMPLETED; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Video upload (lesson videos, resumable, 2026-11-14)

Large lesson videos use the `/assets/uploads` flow above with `kind: "video"`: S3 multipart, the browser `PUT`s each part straight to storage by a presigned URL (not through the API), the server keeps the state. There is no second upload API.

**Who.** Owner and admin (`assets.upload`), and a teacher of this course with `canManageLessons`. Students and read-only teachers get `403 ACTION_FORBIDDEN`.

**Formats.** `.mp4` + `video/mp4` (H.264 or HEVC video, AAC audio, `moov` before `mdat` — "fast start") and `.webm` + `video/webm` (VP8/VP9/AV1, Opus/Vorbis, Cues before clusters). Extension and `mimeType` must match; the stored bytes are checked again on completion (`ftyp` box for mp4, EBML header for webm, codecs, duration). No transcoding: export with "fast start" / "web optimized".

**1. Create.** `POST /assets/uploads`

```json
{ "courseId": "12", "lessonId": "345", "kind": "video", "fileName": "Lesson 1.mp4", "mimeType": "video/mp4", "sizeBytes": 1073741824 }
```

`201`:

```json
{ "data": { "id": "77", "assetId": "901", "courseId": "12", "lessonId": "345", "kind": "video", "fileName": "Lesson 1.mp4",
  "mimeType": "video/mp4", "sizeBytes": 1073741824, "partSizeBytes": 33554432, "partCount": 32, "status": "initiated",
  "rejectionCode": null, "createdAt": "…", "expiresAt": "2026-11-16T10:00:00.000Z", "completedAt": null, "abortedAt": null, "expiredAt": null } }
```

`lessonId` is optional (a `video` or `mixed` lesson of this course); with it, completion puts the video on the lesson. The server picks `partSizeBytes` (32 MiB, raised so there are at most 10,000 parts) and the object key. Part `n` is bytes `[(n-1)·partSizeBytes, min(n·partSizeBytes, sizeBytes))`.

**2. Presign a batch.** `POST /assets/uploads/77/parts` `{ "partNumbers": [1, 2, 3, 4] }` (1–100 numbers) →

```json
{ "data": { "parts": [ { "partNumber": 1, "sizeBytes": 33554432, "url": "https://files…/everest-media/courses/12/videos/…?partNumber=1&uploadId=…&X-Amz-…", "expiresAt": "…" } ] } }
```

URLs live 1 hour. Presign a few at a time (for example the next 4–8 parts) and ask again when they run out or a `PUT` returns 403 (expired signature). After the first presign the status is `uploading`.

**3. Upload.** `PUT url` with exactly `sizeBytes` bytes of that part (`file.slice(start, end)`), no extra headers needed. Use `XMLHttpRequest.upload.onprogress` for progress; 2–4 parts in parallel. You do not need the `ETag`.

**4. Resume after a drop / reload.** `GET /assets/uploads/77` →

```json
{ "data": { "upload": { "id": "77", "status": "uploading", "partCount": 32, … },
  "uploadedParts": [ { "partNumber": 1, "size": 33554432 }, { "partNumber": 2, "size": 1048576 } ],
  "missingParts": [2, 3, 4, …, 32], "uploadedBytes": 33554432 } }
```

The part list comes from storage (ListParts). Upload only `missingParts` (a cut-off part is listed with a smaller size and is missing again). `uploadedBytes / sizeBytes` is the resumed progress. **Keep on the client** (for example in IndexedDB/localStorage, keyed by file name + size + `lastModified`): `uploadId`, `partSizeBytes`, `partCount`, `expiresAt`. After a reload the user re-selects the same file; check name/size/lastModified, then resume. If the state is `expired`, `aborted` or `rejected`, start a new upload.

**5. Complete.** `POST /assets/uploads/77/complete` (no body) →

```json
{ "data": { "asset": { "id": "901", "kind": "video", "mimeType": "video/mp4", "sizeBytes": 1073741824, "durationSeconds": 3600,
    "widthPx": 1920, "heightPx": 1080, "status": "ready", "processingStatus": "not_required", … },
  "lesson": { "lessonId": "345", "attached": true, "errorCode": null } } }
```

The server takes the part list and ETags from storage, assembles the object, checks its size and content, marks the asset `ready` and, with `lessonId`, sets it as the lesson video (the usual lesson rules apply). Calling again is safe and returns the same asset (`attached` then tells whether the lesson still has this video). `lesson.attached: false` with an `errorCode` (for example `CHAPTERS_EXCEED_VIDEO_DURATION`) means the video is ready but was not attached; attach it with `PATCH …/lessons/:lessonId { videoAssetId }` after fixing the cause. Without `lessonId` there is no `lesson` key.

**6. Cancel.** `POST /assets/uploads/77/abort` → `{ upload }` with `status: "aborted"`; stored parts are deleted. Safe to repeat.

**Playback.** Unchanged routes: `GET /courses/:courseId/lessons/:lessonId/playback` (learner) and `GET /admin/courses/:courseId/lessons/:lessonId/playback` → `{ playback: { url, expiresAt, mimeType, durationSeconds }, chapters }`. Put `url` in `<video src>`; seeking uses HTTP Range on the same URL. The URL lives 2 hours; on a 403 from storage, fetch a new one and continue from `currentTime`.

**Removing a video.** Replacing the lesson video or setting `videoAssetId: null` archives the old video and deletes its file when no other lesson uses it; it cannot be attached again.

**States.**

| `status` | Meaning | Client action |
|---|---|---|
| `initiated` | Created, nothing presigned yet | presign and upload |
| `uploading` | Parts are being sent | resume with `missingParts` |
| `completed` | Asset ready | done |
| `aborted` | Cancelled | new upload |
| `rejected` | Content failed the check (`rejectionCode`) | fix the file, new upload |
| `expired` | Not completed before `expiresAt` (48 h); the worker deletes its parts | new upload |

Completion runs in one transaction (no visible `completing` state); a parallel second call waits and gets the same result.

**Errors.**

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Wrong extension/type pair, `.mov`, `lessonId` of a non-video lesson or with `kind: material`, bad part numbers |
| 403 | `ACTION_FORBIDDEN` | Not an editor of this course |
| 404 | `COURSE_NOT_FOUND`, `LESSON_NOT_FOUND`, `UPLOAD_NOT_FOUND` | Unknown course, lesson of another course, someone else's upload |
| 409 | `VIDEO_UPLOAD_LIMIT_REACHED` | Already 3 open video uploads of this user; finish or abort one |
| 409 | `VIDEO_QUOTA_EXCEEDED` | Library full; `details`: `usedBytes`, `quotaBytes` |
| 409 | `UPLOAD_INCOMPLETE` | Complete called with parts missing (`details[0].missingParts`) |
| 409 | `UPLOAD_EXPIRED`, `UPLOAD_ABORTED`, `UPLOAD_REJECTED`, `UPLOAD_ALREADY_COMPLETED`, `UPLOAD_PARTS_MISSING` | See states |
| 413 | `VIDEO_TOO_LARGE` | `sizeBytes` above `VIDEO_MAX_BYTES` (`details[0].message` = limit) |
| 422 | `UNSUPPORTED_MEDIA`, `VIDEO_NOT_SEEKABLE` | Content check failed; the stored object is deleted |
| 503 | `STORAGE_NOT_CONFIGURED` | No S3 settings on the server |

**Server settings** (backend env): `STORAGE_PART_SIZE_BYTES` (32 MiB), `STORAGE_PRESIGN_TTL_SECONDS` (3600), `STORAGE_UPLOAD_TTL_HOURS` (48, below the bucket's 3-day abort rule), `VIDEO_MAX_BYTES` (4 GiB), `VIDEO_TOTAL_QUOTA_BYTES` (15 GiB: ready videos plus open uploads), `VIDEO_MAX_ACTIVE_UPLOADS` (3), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (7200), `UPLOAD_SWEEP_INTERVAL_MS` (10 min, in `worker:attempts`). Storage is any S3 service set by `S3_*`.

### Video player (chapters, progress, cached playback, offline, watermark — 2026-11-15)

Everything below extends the existing lesson routes; there is no second player API. All paths are under `/api/v1`, every mutation needs the session and CSRF as usual.

#### Chapters (timeline)

- Learners get `chapters: [{ id, startSeconds, title, translations, position }]` in `GET /courses/{courseId}/lessons/{lessonId}` (with module access) and in the playback response. Sorted by `startSeconds`; draw them as markers on the seek bar and as a list.
- Editors: `PUT /admin/courses/{courseId}/lessons/{lessonId}/chapters` with the whole list `{ chapters: [{ startSeconds, title, translations? }] }` (`lessons.manage` and a course they may manage; a teacher without `canManageLessons` gets `404 COURSE_NOT_FOUND`, a student `403`). An empty list removes all chapters.
- Rules (`400 VALIDATION_ERROR`, field `chapters`): integer `startSeconds` from 0 and below the video duration, strictly increasing, no duplicate times, `title` 1–120 characters, at most 100 chapters. No video on the lesson: `409 LESSON_HAS_NO_VIDEO`. The duration is read from the file when the upload completes (`video.durationSeconds`).
- Replacing the lesson video clears the chapters (they were times of the old recording); the editor must enter them again. The PATCH response shows `chapters: []`. Removing the video while chapters exist: `409 LESSON_HAS_CHAPTERS` (clear chapters first).

#### Playback with a stable URL and watermark

`GET /courses/{courseId}/lessons/{lessonId}/playback`:

```json
{
  "data": {
    "playback": {
      "url": "https://files.example/everest/courses/12/videos/…mp4?X-Amz-Date=20261115T060000Z&response-cache-control=private%2C%20max-age%3D28800&…",
      "expiresAt": "2026-11-15T14:00:00.000Z",
      "mimeType": "video/mp4",
      "durationSeconds": 1834
    },
    "chapters": [{ "id": "5", "startSeconds": 0, "title": "Intro", "translations": {}, "position": 1 }],
    "watermark": { "label": "Ali +992 *** 45" }
  }
}
```

- The URL is signed at the start of a 6-hour window and lives 8 hours (window + 2 h). Inside one window every call returns the **same URL**, so the browser HTTP cache reuses downloaded ranges; S3 answers with `Cache-Control: private, max-age=28800`. Do not add query parameters to the URL (they break the signature and the cache key).
- Set it as `<video src>` directly. Seeking sends `Range` requests to the same URL (only `host` is signed), and the server answers `206`. Refetch the playback endpoint when `expiresAt` is near or when the video errors with 403; keep `currentTime` and swap `src`.
- Errors: `403 MODULE_ACCESS_DENIED`, `404 LESSON_NOT_FOUND`, `409 VIDEO_NOT_PLAYABLE`, `429` (per-user media limit).
- Watermark: draw `watermark.label` semi-transparent over the video and move it every 20–40 s to a random position (also in fullscreen: put it in the same container that goes fullscreen, not over the page). The label contains only the first name and a masked phone; when neither is known it is `ID <userId>`.

#### Watch progress

- `GET /courses/{courseId}/lessons/{lessonId}/progress` → `{ progress: { status, playbackSeconds, watchedSeconds, watchedRanges, completedAt, revision, updatedAt } }`. Resume from `playbackSeconds`.
- `PUT …/progress` body for video lessons:

```json
{ "revision": 3, "playbackSeconds": 412, "watchedRanges": [[380, 412]] }
```

- `watchedRanges`: `[start, end)` whole seconds actually played since the last successful report (from the `timeupdate` stream, not from the seek target), up to 50 pairs. The server merges them with what it has, so overlaps count once. Send `[]` when only the position changed.
- At most one report per 10 s per lesson (`PROGRESS_MIN_INTERVAL_SECONDS`). Report every 15 s while playing, plus on pause/ended/`visibilitychange`, but never twice within 10 s; on `429 PROGRESS_TOO_FREQUENT` keep the pending ranges and retry after `details[0].retryAfterSeconds`.
- On `409 PROGRESS_REVISION_CONFLICT` take `details[0].revision`, keep the pending ranges and send again with that revision.
- The lesson becomes `completed` when unique watched time reaches 90% of the duration; a seek to the end does not count. The completion feeds course progress (`progress.completedLessons` in `GET /courses`). A lesson with a test still completes only through its test (`409 LESSON_COMPLETES_BY_TEST` for `completed: true`; watching saves). `watchedSeconds` in the body is accepted from old clients and ignored.
- Offline viewing: collect ranges locally and send them in one report when online again.

Staff summary: `GET /admin/courses/{courseId}/lessons/{lessonId}/progress` (`lessons.read`):

```json
{
  "data": {
    "lessonId": "41", "durationSeconds": 1834,
    "totals": { "learners": 25, "started": 18, "completed": 11 },
    "learners": [{ "userId": "77", "name": "Ali Karimov", "hasAccess": true, "status": "completed", "watchedSeconds": 1700, "watchedPercent": 92, "playbackSeconds": 1830, "completedAt": "…", "lastActivityAt": "…" }]
  }
}
```

Every learner with a current enrollment in the course is listed; no phone or other contact data.

#### Offline viewing inside the app only

The video is stored only encrypted in the browser's Origin Private File System (OPFS); there is no file for Files/Gallery and no `Content-Disposition: attachment` save in the UI.

1. **Device id.** On first use generate `crypto.randomUUID()`, keep it in IndexedDB next to the files, and register it: `POST /offline-devices { deviceId, deviceLabel? }` → `201` (new) or `200` (known). Limit 2 devices per user (`OFFLINE_MAX_DEVICES`): `409 OFFLINE_DEVICE_LIMIT` → show `GET /offline-devices` and let the user remove one with `DELETE /offline-devices/{deviceId}` (that revokes its licenses). Clearing site data loses the id and the files; the old device then has to be removed in the list.
2. **License.** `POST /courses/{courseId}/lessons/{lessonId}/offline-license { deviceId }` → `{ license, download, encryption }`:

```json
{
  "license": { "id": "301", "courseId": "12", "lessonId": "41", "status": "active", "leaseExpiresAt": "2026-11-29T10:00:00.000Z", "deviceId": "6f1c2a3b-…", "deviceLabel": "Phone", "revokeReason": null, "grantedAt": "…", "renewedAt": null, "lastCheckedAt": "…" },
  "download": { "url": "https://files…", "expiresAt": "…+15 min", "mimeType": "video/mp4", "sizeBytes": 734003200 },
  "encryption": { "algorithm": "AES-GCM", "keyLength": 256, "keyVersion": 1, "key": "base64url 32 bytes" }
}
```

   The lease is 14 days (`OFFLINE_LICENSE_DAYS`) and never beyond the enrollment/module grant expiry. Calling the same route again online renews it; the license id and the key stay the same, so the stored file is not re-encrypted. The key is derived on the server and never stored there; do not store it in plain `localStorage`. Import it with `crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])` and keep only the non-extractable `CryptoKey` in IndexedDB.
3. **Download and encrypt in chunks.** Download with `Range` requests of a fixed plain-text chunk size (recommended 1 MiB) from `download.url` (15 min; get a fresh one from `GET /offline-licenses/{id}/download?deviceId=`). For chunk `i`: IV = 4 random bytes fixed per file + 8-byte big-endian `i`; `additionalData` = `${license.id}:${i}`; write `ciphertext||tag` (chunk size + 16 bytes) at offset `i * (chunkSize + 16)` in one OPFS file (`createSyncAccessHandle` in a worker). Keep a manifest `{ licenseId, assetSizeBytes, chunkSize, ivPrefix, mimeType, chunks done }` in IndexedDB to resume.
4. **Playback through a Service Worker with Range.** Play `<video src="/offline/{licenseId}">`. The Service Worker answers that URL: parse `Range: bytes=a-b`, compute chunks `floor(a / chunkSize)…floor(b / chunkSize)`, read and decrypt them, slice to `[a, b]`, and respond `206` with `Content-Range: bytes a-b/size`, `Accept-Ranges: bytes`, `Content-Length` and the stored `mimeType`. Without `Range` answer `200` with the first chunks streamed. Never expose a decrypted blob URL or a download link.
5. **Checks.** Before offline playback check `leaseExpiresAt` locally; when online call `GET /offline-licenses/{id}/download?deviceId=` (or renew with POST) at least once a day. `403 OFFLINE_ACCESS_DENIED` with `details[0].reason` in `module_access`, `offline_not_allowed`, `video_unavailable`, `lesson_unavailable`, `license_revoked`, `license_expired` → delete the file, the manifest and the key. An expired lease also means delete (or renew if online and still allowed).
6. **Lists.** `GET /offline-licenses?deviceId=` lists this device's active licenses (any session); `DELETE /offline-licenses/{id}?deviceId=` removes one (idempotent).

Error codes: `400 VALIDATION_ERROR` (`deviceId` must be a UUID), `404 OFFLINE_LICENSE_NOT_FOUND` (license of another device/user or `deviceId` missing), `404 OFFLINE_DEVICE_NOT_FOUND`, `409 OFFLINE_DEVICE_LIMIT`, `409 OFFLINE_DEVICE_NOT_REGISTERED`, `403 OFFLINE_ACCESS_DENIED` (+reason), `403 MODULE_ACCESS_DENIED`, `503 OFFLINE_KEYS_UNAVAILABLE` (server has no `OFFLINE_KEY_SECRET`), `429` media rate limit.

Limits of the protection: the key reaches the browser, so a determined user with devtools can decrypt the file; the scheme keeps the file out of the gallery and makes casual copying useless outside the app. Screen recording is only discouraged by the watermark.

Session-bound licenses (POST without `deviceId`) still work as before (no key, `download` with attachment) for older builds; new code should always send `deviceId`.

### Admin: accounts

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| GET | `/admin/users` | `accounts.pending.read` | limit, offset, status, role, q, sort, notInGroup, notTeacherOfGroup, notEnrolledInCourse | — | 200 { users: AdminAccount[], pagination: Pagination } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ADMIN_ROLE_REQUIRED |
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
| POST | `/admin/courses/{courseId}/modules/{moduleId}/lessons` | `lessons.manage` + CSRF | — | { title: string, lessonType: video/text/test/mixed, content?: RichContent, translations?: TitleTranslations, videoAssetId?: Id or null, testId?: Id or null, allowOffline?: boolean } | 201 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: COURSE_NOT_FOUND, COURSE_MODULE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/modules/{moduleId}/lessons/order` | `lessons.manage` + CSRF | — | { lessonIds: Id[] } | 200 { lessons?: LessonSummary[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: LESSON_ORDER_MISMATCH; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.read` | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: LESSON_NOT_FOUND |
| PATCH | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.manage` + CSRF | — | { title?: string, lessonType?: video/text/test/mixed, content?: RichContent, translations?: TitleTranslations, videoAssetId?: Id or null, testId?: Id or null, allowOffline?: boolean } | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: LESSON_VIDEO_REQUIRED, LESSON_TEST_REQUIRED, TEST_NOT_PUBLISHED, TEST_ARCHIVED, CHAPTERS_EXCEED_VIDEO_DURATION; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/courses/{courseId}/lessons/{lessonId}` | `lessons.manage` + CSRF | — | — | 200 { id: Id, status: "deleted" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: LESSON_NOT_DELETABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/publish` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TEST_REQUIRED, TEST_NOT_PUBLISHED, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/archive` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TEST_REQUIRED, TEST_NOT_PUBLISHED, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/courses/{courseId}/lessons/{lessonId}/restore` | `lessons.manage` + CSRF | — | — | 200 LessonDetail | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: LESSON_NOT_FOUND; 409: INVALID_LESSON_TRANSITION, LESSON_VIDEO_REQUIRED, LESSON_TEST_REQUIRED, TEST_NOT_PUBLISHED, VIDEO_NOT_PLAYABLE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/lessons/{lessonId}/chapters` | `lessons.manage` + CSRF | — | { chapters: { startSeconds: integer, title: string, translations?: TitleTranslations }[] } | 200 { chapters?: Chapter[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: LESSON_HAS_NO_VIDEO; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PUT | `/admin/courses/{courseId}/lessons/{lessonId}/resources` | `lessons.manage` + CSRF | — | { resources: { assetId: Id, title?: string }[] } | 200 { resources?: LessonResource[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}/playback` | `lessons.read` | — | — | 200 { playback?: SignedUrl, chapters?: Chapter[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 409: VIDEO_NOT_PLAYABLE |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}/progress` | `lessons.read` | — | — | 200 { lessonId, durationSeconds, totals: { learners, started, completed }, learners: LessonProgressSummaryRow[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN; 404: COURSE_NOT_FOUND, LESSON_NOT_FOUND |
| GET | `/admin/courses/{courseId}/lessons/{lessonId}/resources/{resourceId}/download` | `lessons.read` | — | — | 200 { download?: SignedUrl } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| GET | `/admin/users/{userId}/offline-licenses` | `lessons.offline.manage` | — | — | 200 { licenses?: OfflineLicense[] } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN |
| POST | `/admin/offline-licenses/{licenseId}/revoke` | `lessons.offline.manage` + CSRF | — | — | 200 { license?: OfflineLicense } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: OFFLINE_LICENSE_NOT_FOUND; 429: AUTH_RATE_LIMITED (Retry-After header) |

### Admin: groups

| Method | Path | Access | Query | Body | Success `data` | Errors |
|---|---|---|---|---|---|---|
| POST | `/admin/groups` | `groups.create` + CSRF | — | { code?: string (generated from name when omitted), name: string, description?: string?, status?: active/archived } | 201 Group (with memberCount, teacherCount; no relationship) | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 409: GROUP_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/groups/{groupId}` | `groups.update` + CSRF | — | { code?: string, name?: string, description?: string?, status?: active/archived } | 200 Group (with memberCount, teacherCount; no relationship) | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 409: GROUP_CODE_CONFLICT; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/groups/{groupId}/members` | `groups.members.manage` + CSRF | — | { userId: Id, isRepresentative?: boolean } | 201 { userId?: Id, status?: string, isRepresentative?: boolean, joinedAt?: string } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 409: GROUP_ARCHIVED, GROUP_MEMBER_INELIGIBLE, GROUP_MEMBER_ALREADY_ACTIVE; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/groups/{groupId}/members/{userId}` | `groups.members.manage` + CSRF | — | — | 200 { userId?: Id, status?: string, leftAt?: string } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_MEMBER_NOT_FOUND; 409: GROUP_ARCHIVED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/groups/{groupId}/members/{userId}` | `groups.members.manage` + CSRF | — | { isRepresentative: boolean } | 200 GroupMember | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_MEMBER_NOT_FOUND; 409: GROUP_ARCHIVED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| POST | `/admin/groups/{groupId}/teachers` | `groups.teachers.manage` + CSRF | — | { userId: Id, canPublishAnnouncements?: boolean, canAssignTests?: boolean, canViewResults?: boolean } | 201 { userId?: Id, assignedAt?: string, permissions?: GroupTeacherPermissions } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND; 409: GROUP_ARCHIVED, GROUP_TEACHER_INELIGIBLE, GROUP_TEACHER_ALREADY_ASSIGNED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| DELETE | `/admin/groups/{groupId}/teachers/{userId}` | `groups.teachers.manage` + CSRF | — | — | 200 { userId?: Id, status?: "removed" } | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_TEACHER_NOT_FOUND; 409: GROUP_ARCHIVED; 429: AUTH_RATE_LIMITED (Retry-After header) |
| PATCH | `/admin/groups/{groupId}/teachers/{userId}` | `groups.teachers.manage` + CSRF | — | { canPublishAnnouncements?: boolean, canAssignTests?: boolean, canViewResults?: boolean } (at least one) | 200 GroupTeacher | 400: VALIDATION_ERROR; 401: AUTHENTICATION_REQUIRED; 403: ACTION_FORBIDDEN, CSRF_TOKEN_INVALID, CSRF_ORIGIN_REJECTED; 404: GROUP_NOT_FOUND, GROUP_TEACHER_NOT_FOUND; 409: GROUP_ARCHIVED; 429: AUTH_RATE_LIMITED (Retry-After header) |

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
- **Enrollment**: GrantWindow + { id?: Id, userId?: Id, courseId?: Id, user?: { firstName?: string?, lastName?: string?, phone?: string? } (lists only) }
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
- **LessonSummary**: { id?: Id, moduleId?: Id, courseId?: Id, title?: string, position?: integer, lessonType?: video/text/test/mixed, translations?: TitleTranslations, videoAssetId?: Id or null, testId?: Id or null, allowOffline?: boolean, status?: draft/published/archived, createdAt?: string, updatedAt?: string }
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

### Learner tests (M11)

Prose rules and error codes: `docs/api.md`, section "Test attempts".

| Method | Path | Purpose |
|---|---|---|
| GET | `/courses/:courseId/test-assignments?lessonId=` | My assignments, window state and attempt state |
| POST | `/tests/assignments/:assignmentId/start` | `201` new, `200` resumed |
| GET | `/tests/assignments/:assignmentId/result` | Result by policy, attempts, remaining attempts |
| GET | `/tests/attempts/:attemptId` | Questions without keys |
| PUT | `/tests/attempts/:attemptId/answers/:attemptQuestionId` | Autosave `{ answer, revision }` |
| POST | `/tests/attempts/:attemptId/submit` | Submit; safe to repeat |
| GET | `/tests/attempts/:attemptId/result` | Result; details follow the reveal policy |

Screens should:

- Run the countdown from `deadlineAt - serverNow`, and resync on each response. `deadlineAt: null` means no time limit.
- Use the `id` of each question (the attempt question) in the autosave path, keep the order as returned, and raise `revision` on every save.
- On `409 ATTEMPT_DEADLINE_PASSED`, open the result: the server has already submitted the attempt.
- Handle `revealed: false` (score only), `revealsAt` and `remainingAttempts`. With `after_submission` the answers appear only after the last attempt or when the window closes.
- A running attempt keeps working after its assignment is revoked; afterwards the assignment shows `state: 'revoked'` with its history.

The learner lesson `test` now has `assignment.id` and `attempts: { status, attemptId, deadlineAt, score, maxScore, submittedAt, remainingAttempts }`, where `status` is `not_started`, `in_progress` or `submitted`, and `remainingAttempts: null` means unlimited.

New fields (2026-11-07, M11 gaps):

- **`passPercent`** in every attempt result (`submit`, `GET /tests/attempts/:attemptId/result`) next to `percent` and `passed`, and in staff attempts (list and detail). It is the threshold stored when the attempt started; `null` means the test has none, and then `passed` is `null` as well. Show "passed / not passed" only when `passed` is not `null`.
- **`state: 'revoked'`** on learner assignments (list, lesson `test.assignment.state`, and `GET /tests/assignments/:assignmentId/result`). The assignment was revoked or came through a group the student left; it is shown only because the student has attempts on it. Hide the start button; results stay readable. Keys stay hidden as long as the reveal policy says so; revocation never reveals them earlier.
- **`testId`** in each item of `GET /courses/:courseId/modules/:moduleId/lessons` (and the locked lesson summary). `null` for a lesson without a test and for every lesson of a module that is not granted.
- **`progress: { completedLessons, totalLessons, percent }`** on every course in `GET /courses` and on `course` in `GET /courses/:courseId/modules`. Only lessons the student can open now count (published lessons of granted published modules). `percent` is rounded down; `0 / 0` is `0`.
- **`passed` in staff attempts** (list and detail), next to `passPercent`: `true`, `false`, or `null` (no threshold, or the attempt is still running). Same rule as the student result.
- **`409 LESSON_COMPLETES_BY_TEST`** from `PUT /courses/:courseId/lessons/:lessonId/progress`: a lesson with `testId` cannot be completed by the player. Hide the "mark as done" button for it. Video progress still saves, but never completes it.
- **Lesson completion by test.** The server marks a lesson with a test as completed when an attempt finishes (submit, deadline, or a later regrade): with `passPercent`, only when `passed` is `true`; without it, on any finished attempt; never for an attempt the timer closed without any saved answer. Once completed, a lesson stays completed (`completedAt` is kept). After a submit, reload the lesson `progress` and the course `progress`; a stale `PUT progress` returns `409 PROGRESS_REVISION_CONFLICT`, as before.

Demo seed: `+992900000004` (Aziza) has a submitted attempt; `+992900000008` (Firuza) has one in progress without a deadline.

### Admin: test results (M11)

Permission `tests.results.read` (regrade: `tests.results.regrade`, owner and admin only). Teachers need `canViewResults` on the course (all attempts) or on a group (only attempts of that group's assignments).

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/tests/:testId/attempts` | Filters `assignmentId`, `userId`, `status` |
| GET | `/admin/tests/:testId/attempts/:attemptId` | Answers, points, revisions; no keys |
| POST | `/admin/tests/:testId/attempts/:attemptId/regrade` | Override points with a reason and an `idempotencyKey` |

Assignments gained an optional `personalWindowMinutes` on create, patch and read.

**Extra attempts (2026-11-07).** Permission `tests.attempts.grant`.

| Role | Can grant |
|---|---|
| owner, admin | any assignment |
| teacher | only assignments made to a group they teach with `canViewResults`; anything else is `404 ASSIGNMENT_NOT_FOUND` |
| student | no (`403`) |

Show the grant button to a teacher only on group assignments of their groups.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/tests/:testId/assignments/:assignmentId/users/:userId/extra-attempts` | Effective limit, used, remaining, grant history |
| POST | same | Grant `{ count: 1..10, reason, idempotencyKey }`; safe to repeat |

- Generate one `idempotencyKey` per dialog submit and reuse it on retry.
- Show the error codes `ATTEMPTS_UNLIMITED`, `ASSIGNMENT_CLOSED`, `ASSIGNMENT_REVOKED` and `STUDENT_NOT_ASSIGNED`.
- A grant cannot be undone, so ask for confirmation before sending.
- Learner screens need no change: `maxAttempts` and `remainingAttempts` already include grants.
- After a grant, the result of an `after_submission` test may hide the answers again (`revealed: false`) until the extra attempts are used.

### NCT trainer (2026-11-10, access and /nct overview 2026-11-11)

A student, an administrator or an owner picks a subject, a difficulty and a count. The server builds a practice test from published NCT questions with verified keys and starts its attempt. Answering, submitting and reading the result use the ordinary attempt routes above (`/tests/attempts/:attemptId...`). Every route needs a signed-in user. `POST` also needs CSRF when the request uses cookies.

**Access.** The trainer is a separate module and does not depend on courses or enrollments. Every student, administrator and owner whose account is `active` may use every subject; teachers may not. Administrators and owners train exactly like students, with their own trainings, overview and history; nobody sees another account's trainings, and staff trainings never reach student statistics or authoring lists. All four trainer routes refuse:

| Status | Code | When |
|---|---|---|
| 403 | `ACCOUNT_NOT_ACTIVE` | The account is pending, blocked or rejected |
| 403 | `TRAINER_STUDENT_ROLE_REQUIRED` | The account lacks the permission `trainer.use` (held by `student`, `admin` and `owner`; a teacher gets this). The code name is historical |

- A running training's attempt routes (`/tests/attempts/:id`, answers, submit) need only an active account. Revoking course enrollments changes nothing; blocking the account returns `403 ACCOUNT_NOT_ACTIVE`.
- There is no `accessible` field and no `TRAINER_ACCESS_DENIED` code any more.
- **Frontend:** decide by the response, not by a role list. A `403 TRAINER_STUDENT_ROLE_REQUIRED` means "no trainer for this account" (teachers); do not hide the page for admin and owner.

| Method | Path | Purpose |
|---|---|---|
| GET | `/trainer/catalog` | Options and the subjects with trainable questions |
| POST | `/trainer/attempts` | Generate and start a training: `201`, or `200` for a repeated `idempotencyKey` |
| GET | `/trainer/attempts` | My trainings, newest first, plus statistics per subject |
| GET | `/trainer/overview` | Everything the /nct page shows: readiness, per subject, weak topics, recent results |

**`GET /trainer/catalog`** returns:

```json
{ "data": {
  "options": {
    "questionCounts": [10, 20, 30, 50],
    "difficulties": ["easy", "medium", "hard", "mixed"],
    "levels": [{ "name": "easy", "minDifficulty": 1, "maxDifficulty": 2 }, { "name": "medium", "minDifficulty": 3, "maxDifficulty": 3 }, { "name": "hard", "minDifficulty": 4, "maxDifficulty": 5 }],
    "mixedShares": { "easy": 30, "medium": 40, "hard": 30 }
  },
  "subjects": [{
    "id": "135", "code": "zaboni-tochiki", "color": "orange", "primaryLanguage": "tg",
    "titles": { "tg": "…", "ru": "…" },
    "languages": [{ "language": "tg", "total": 972, "difficulties": { "easy": 333, "medium": 605, "hard": 34 } }],
    "sections": [{ "code": "syntax", "titles": { "tg": "…" }, "total": 120 }],
    "topics": [{ "code": "verbs", "sectionCode": "morphology", "titles": { "tg": "…" }, "total": 40 }]
  }]
} }
```

- Disable a difficulty and count pair when `difficulties[level] < count`.
- For `mixed`, compare against `total`. Mixed takes about 30/40/30 from the levels and fills any shortfall from the other levels. A question without a difficulty counts only in `total`.
- `sections[].total` counts all languages. Section and topic filters are optional, so a combination can still be too small; the server answers that with `409`.

**`POST /trainer/attempts`** takes this body:

| Field | Required | Value |
|---|---|---|
| `subject` | yes | Subject id (`"135"`) or code (`"zaboni-tochiki"`) |
| `difficulty` | yes | One of `options.difficulties` |
| `count` | yes | One of `options.questionCounts` (number) |
| `language` | no | `tg`, `ru` or `en`; defaults to the subject's `primaryLanguage` |
| `sectionCode` | no | Code from `sections` |
| `topicCode` | no | Topic code |
| `idempotencyKey` | no | 8–100 characters `A-Z a-z 0-9 . _ : -`. Generate one per click and reuse it on retry |

The response is the same `AttemptView` as `GET /tests/attempts/:attemptId`, plus `resumed`. It has no keys, no explanations and no grading data. Image blocks carry `url` and `expiresAt` (5 minutes), like every attempt view, so re-read the attempt to get fresh URLs. Questions come in a random order. Options keep their book order, because their labels (А, Б, …) are part of the content.

| Status | Code | Meaning / UI |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `details[0].field` names the field (`count` outside the allowed set, unknown `difficulty`, an unknown body field, …) |
| 403 | `ACCOUNT_NOT_ACTIVE`, `TRAINER_STUDENT_ROLE_REQUIRED` | See "Access" |
| 404 | `SUBJECT_NOT_FOUND` | Unknown id or code |
| 409 | `TRAINER_NOT_ENOUGH_QUESTIONS` | `details[0].field = "available"`, `details[0].message` = how many questions match (as a string). Offer a smaller count |
| 409 | `TRAINER_ATTEMPT_IN_PROGRESS` | One running training per student. `details[0].message` = the running `attemptId`. Offer "continue" (open it) or "finish" (`POST /tests/attempts/:id/submit`) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The same key was sent with different parameters |

Then use the ordinary attempt routes:

- `PUT /tests/attempts/:attemptId/answers/:attemptQuestionId` with `{ answer, revision }`. The answer formats are the same as for tests.
- `POST /tests/attempts/:attemptId/submit`. A repeat returns the same result.
- `GET /tests/attempts/:attemptId/result`. A training has no timer, one attempt and `answerRevealPolicy: "after_submission"`, so the result is `revealed: true` right after submit. Each question has:
   - `answer`, `awardedPoints`, `points` (1);
   - **`correct`** (boolean, new): full points;
   - `correctAnswer`;
   - `explanation` (blocks; image URLs signed).
- `percent`, `attempt.score` and `attempt.maxScore` are the total.

**`GET /trainer/attempts`** takes the query `subjectId`, `limit` (1–100, default 20) and `offset`. It returns:

```json
{ "data": {
  "attempts": [{ "attemptId": "9", "status": "graded", "subjectId": "135", "subjectCode": "zaboni-tochiki",
    "difficulty": "mixed", "language": "tg", "sectionCode": null, "topicCode": null, "questionCount": 10,
    "startedAt": "…", "submittedAt": "…", "score": "6.00", "maxScore": "10.00", "percent": 60 }],
  "pagination": { "limit": 20, "offset": 0, "hasMore": false },
  "stats": [{ "subjectId": "135", "attempts": 2, "averagePercent": 30, "lastSubmittedAt": "…" }]
} }
```

- `score`, `maxScore` and `percent` are `null` while a training is `in_progress`.
- `stats` counts finished trainings only and does not depend on `subjectId`.
**`GET /trainer/overview`** is computed from my **finished** trainings (`graded` or `expired`; a running one does not count):

```json
{ "data": {
  "empty": false,
  "readinessPercent": 54.55,
  "completedTrainings": 2,
  "readinessWindow": 5,
  "subjects": [{ "subjectId": "135", "subjectCode": "zaboni-tochiki", "titles": { "tg": "…" }, "color": "orange",
    "readinessPercent": 54.55, "trainings": 2, "lastSubmittedAt": "…" }],
  "weakTopics": [{ "subjectId": "135", "subjectCode": "zaboni-tochiki", "topicCode": "spelling", "titles": { "tg": "…" },
    "answered": 4, "correct": 0, "correctPercent": 0 }],
  "recentResults": [{ "attemptId": "9", "subjectId": "135", "subjectCode": "zaboni-tochiki", "difficulty": "mixed",
    "sectionCode": null, "topicCode": null, "questionCount": 10, "percent": 60, "submittedAt": "…" }]
} }
```

- **Readiness of a subject:** points ÷ questions over its last `readinessWindow` finished trainings (`TRAINER_READINESS_WINDOW`, default 5), × 100. Every question is 1 point, so this is the share of correct answers, and longer trainings weigh more.
- **Overall `readinessPercent`:** the average of the subject values, where every trained subject counts equally.
- **`subjects[].trainings`** counts all finished trainings of the subject. **`completedTrainings`** is their sum.
- **Weak topics:** taken from all finished trainings.
   - A topic needs at least `TRAINER_WEAK_TOPIC_MIN_ANSWERS` (5) questions and must be below 100% correct. An unanswered question counts as wrong.
   - Sorted by the lowest share of correct answers, then by the most questions. At most `TRAINER_WEAK_TOPICS_LIMIT` (5).
   - "Repeat" = `POST /trainer/attempts` with `{ subject: subjectId, topicCode, difficulty: "mixed", count }`. Check `catalog.subjects[].topics[].total` first.
- **Recent results:** the last `TRAINER_RECENT_RESULTS_LIMIT` (5) finished trainings, newest first. Build the title on the frontend.
- **No trainings yet:** `200` with `empty: true`, `readinessPercent: null`, `completedTrainings: 0` and empty lists.

- Trainings never appear in course test lists (`/courses/:courseId/test-assignments`) or in admin test screens.

#### Trainer cells questions (digit boxes, 2026-11-12)

The trainer marks answer-sheet cells questions the same way as the mock exam, so one digit-box component serves both.

**Which questions.** The mock exam's rule, nothing new: the subject has a `cells` item in an active blueprint (`nct-a5`: biologiya, khimiya, fizika; 4 digits, 2 points), and the question is `numeric` or `short_text` whose verified key is a whole non-negative number of 1–`maxDigits` digits once spaces are removed. Other numeric questions (fractions, signs, 5+ digits) and every question of other subjects stay plain `numeric` with `{ value }`. The choice is made when the training is created and stored in the attempt; trainings created earlier are unchanged.

**Question payload** (`POST /trainer/attempts`, `GET /tests/attempts/:attemptId` — trainer attempts use the `/tests/attempts` routes). Before:

```json
{ "id": "901", "questionType": "numeric", "points": "1.00", "content": {}, "answer": null, "revision": 0 }
```

After, for a cells question only (other questions have none of these keys):

```json
{ "id": "901", "questionType": "numeric", "points": "2.00", "content": {},
  "kind": "cells", "answerFormat": "digits", "maxDigits": 4, "answer": null, "revision": 0 }
```

The mock exam (`GET /trainer/exams/:attemptId` and its result) now also sends `answerFormat` and `maxDigits` next to its existing `kind: "cells"`. Show digit boxes when `kind === "cells"` (or `answerFormat === "digits"`), `maxDigits` boxes, digits only.

**Answer.** `PUT /tests/attempts/:attemptId/answers/:attemptQuestionId` with `{ "answer": { "digits": "1434" }, "revision": n }`: a string of 1–`maxDigits` digits `0-9`; leading zeros do not matter. Otherwise `400 VALIDATION_ERROR`.
Compatibility: a client that still sends `{ "value": 1434 }` to a trainer cells question is accepted when the value is a whole number of 1–`maxDigits` digits and is stored as `{ "digits": "1434" }`; fractions or negatives give `400`. Trainings created before this change keep `{ value }` and their results are not touched.

**Result** (`GET /tests/attempts/:attemptId/result`, `POST .../submit`): a cells question gets `awardedPoints` `"2.00"` or `"0.00"`, `correctAnswer` as stored in the key (`{ "value": 1434 }`, as in the mock exam), and the mock exam's `sheet`:

```json
{ "kind": "cells", "points": "2.00", "awardedPoints": "2.00", "correct": true, "answer": { "digits": "1434" },
  "correctAnswer": { "value": 1434 },
  "sheet": { "digits": "1434", "correctDigits": "1434", "acceptedDigits": ["1434"], "maxDigits": 4 } }
```

A cells question weighs 2 points, so training `score`/`maxScore` and readiness (points over max points) count it twice.

### NCT mock exam (2026-11-13)

A full exam simulation by an answer-sheet blueprint. It is a separate mode: the trainer (`/trainer/catalog`, `/trainer/attempts`, `/trainer/overview`) is unchanged. Mock exams never count in the trainer overview, readiness or training history, and trainings never count in mock exam history.

**Access** is the trainer's rule: an `active` account (`403 ACCOUNT_NOT_ACTIVE`) and the permission `trainer.use` (student, admin, owner; teachers get `403 TRAINER_STUDENT_ROLE_REQUIRED`). Every route below checks both. Nobody sees another account's exams (`404 MOCK_EXAM_NOT_FOUND`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/trainer/exams/blueprints` | Blueprints: subjects, ranges, eligible question counts, `canAssemble` |
| POST | `/trainer/exams` | Assemble and start an exam: `201`, or `200` for a repeated `idempotencyKey` |
| GET | `/trainer/exams` | My finished exams with points per subject, plus `openAttemptId` |
| GET | `/trainer/exams/:attemptId` | The running exam by subject, without keys; timer |
| PUT | `/trainer/exams/:attemptId/answers/:attemptQuestionId` | Autosave one answer |
| PUT | `/trainer/exams/:attemptId/questions/:attemptQuestionId/flag` | "Review later" mark |
| POST | `/trainer/exams/:attemptId/submit` | Finish and grade; repeating returns the same result |
| GET | `/trainer/exams/:attemptId/result` | Result and answer sheet with keys |

Mutations need CSRF like every cookie-authenticated mutation. `attemptId` is a `test_attempts.id`; the `/tests/attempts/:attemptId` routes also accept it, but use the routes above: only they return subjects, sheet numbers, flags and the answer sheet.

**Blueprint nct-a5** (answer sheet A.5), stored in the database (`exam_blueprints`, `exam_blueprint_sections`, `exam_blueprint_items`), not in code:

| # | Subject code | Single (4 options, 1 point) | Matching (4 × 5, 1 point per right pair, max 4) | Cells (1–4 digits, 2 or 0) | Max |
| --- | --- | --- | --- | --- | --- |
| 1 | `zaboni-tochiki` | 1–20 | 21–25 | — | 40 |
| 2 | `biologiya` | 1–20 | 21–24 | 25–26 | 40 |
| 3 | `khimiya` | 1–18 | 19–20 | 21–27 | 40 |
| 4 | `fizika` | 1–18 | 19–20 | 21–27 | 40 |

105 questions, 220 minutes for all four subjects together, 160 points. Questions are in Tajik (`tg`). Within each range questions go from easy to hard (by `questions.difficulty`).

**Eligible questions.** Published, key `verified`, bank code starting with `nct-`, the section's subject, the blueprint's language, and the form of the kind:

- `single`: `single_choice` with exactly 4 options;
- `matching`: exactly 4 left and 5 right items and a key of 4 pairs;
- `cells`: `numeric` or `short_text` whose key is a whole non-negative number of 1–4 digits once spaces are removed (every accepted answer of a `short_text` must qualify). Fractions, units, letters or 5+ digits are left out of the mock exam; they stay in the trainer.

**`GET /trainer/exams/blueprints`**:

```json
{
  "data": {
    "blueprints": [{
      "code": "nct-a5",
      "titles": { "ru": "Пробный НЦТ — лист ответов A.5", "tg": "ММТ-и озмоишӣ — варақаи ҷавобҳои A.5", "en": "Mock NCT — answer sheet A.5" },
      "language": "tg", "durationMinutes": 220, "questionCount": 105, "maxScore": "160.00",
      "canAssemble": true, "distinctVariants": 12, "shortages": [],
      "sections": [{
        "position": 2, "subjectCode": "biologiya", "subjectId": "3", "titles": { "tg": "Биология" }, "color": "green",
        "questionCount": 26, "maxScore": "40.00",
        "items": [
          { "kind": "single", "firstPosition": 1, "lastPosition": 20, "questionCount": 20, "points": "1.00", "scoring": "all_or_nothing", "maxScore": "20.00", "requirements": { "optionCount": 4 }, "difficulty": { "min": null, "max": null, "order": "ascending" }, "available": 551 },
          { "kind": "matching", "firstPosition": 21, "lastPosition": 24, "questionCount": 4, "points": "4.00", "scoring": "per_pair", "maxScore": "16.00", "requirements": { "leftCount": 4, "rightCount": 5 }, "difficulty": { "min": null, "max": null, "order": "ascending" }, "available": 119 },
          { "kind": "cells", "firstPosition": 25, "lastPosition": 26, "questionCount": 2, "points": "2.00", "scoring": "all_or_nothing", "maxScore": "4.00", "requirements": { "maxDigits": 4, "wholeNumber": true }, "difficulty": { "min": null, "max": null, "order": "ascending" }, "available": 25 }
        ]
      }]
    }]
  }
}
```

- `canAssemble: false` means `POST` would fail now; `shortages[]` lists `{ subjectCode, kind, needed, available }`. A subject code with no subject in the database counts as `available: 0` with `subjectId: null`.
- `distinctVariants`: how many exams could be built with no question repeated across them (the smallest `floor(available / questionCount)` over all ranges).

**`POST /trainer/exams`** body `{ "blueprint": "nct-a5", "idempotencyKey": "mock-2026-11-13-abc123" }`. `idempotencyKey` is optional (8–100 chars of `A-Z a-z 0-9 . _ : -`); repeating it returns the same exam with `200` and `resumed: true`. The response is the exam view below.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Unknown field, bad `blueprint` or `idempotencyKey` |
| 404 | `MOCK_EXAM_BLUEPRINT_NOT_FOUND` | No active blueprint with this code |
| 409 | `MOCK_EXAM_IN_PROGRESS` | An exam is running; `details: [{ "field": "attemptId", "message": "<id>" }]` — open it |
| 409 | `MOCK_EXAM_NOT_ENOUGH_QUESTIONS` | `details` lists every short range: `{ "field": "biologiya.cells", "message": "needed 2, available 1" }` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The key was used for another blueprint |

Assembly takes each range in order, no question twice in one exam, questions this account has not met in an earlier mock exam first, then random; within a range easy to hard. The questions, their points and keys are frozen when the exam is created.

**`GET /trainer/exams/:attemptId`** (also the `POST` response):

```json
{
  "data": {
    "exam": {
      "attemptId": "812", "status": "in_progress", "finished": false, "autoSubmitted": false,
      "blueprintCode": "nct-a5", "titles": { "ru": "Пробный НЦТ — лист ответов A.5" }, "language": "tg",
      "durationMinutes": 220, "questionCount": 105,
      "startedAt": "2026-11-13T08:00:00.000Z", "deadlineAt": "2026-11-13T11:40:00.000Z", "submittedAt": null,
      "remainingSeconds": 13137, "score": null, "maxScore": "160.00", "percent": null
    },
    "sections": [{
      "position": 1, "subjectCode": "zaboni-tochiki", "subjectId": "1", "titles": { "tg": "Забони Точики" }, "color": "orange",
      "questionCount": 25, "maxScore": "40.00", "answered": 3, "flagged": 1,
      "questions": [{
        "attemptQuestionId": "90211", "number": 1, "examPosition": 1, "kind": "single", "questionType": "single_choice",
        "points": "1.00", "flagged": false, "content": { "blocks": [] }, "interactionSettings": {},
        "options": [{ "key": "A", "content": { "blocks": [] } }], "matching": null,
        "answer": { "optionKey": "B" }, "revision": 2, "savedAt": "2026-11-13T08:03:10.000Z"
      }]
    }],
    "serverNow": "2026-11-13T08:21:03.000Z",
    "resumed": false
  }
}
```

- `number` is the sheet number inside the subject (1..N), `examPosition` the number across the exam (1..105).
- Image blocks carry presigned `url`/`expiresAt` like other attempts.
- **Timer:** the server owns it. Show `remainingSeconds` and correct drift with `serverNow`; re-read the exam when the countdown ends. A finished exam (`status` `graded` or `expired`) returns `questions: []` in every section; read the result.
- **Expiry:** at `deadlineAt` the exam finishes by itself (`status: "expired"`, `autoSubmitted: true`, `submittedAt` = `deadlineAt`). Saved answers are graded. This happens on the next request to any exam route and, without any request, by the attempt sweep worker (`npm run worker:attempts`).

**Answers** — `PUT /trainer/exams/:attemptId/answers/:attemptQuestionId` with `{ "answer": ..., "revision": n }`. Same autosave rules as other attempts: send a higher `revision` each time, `answer: null` clears it, answers can be given in any order and changed until the exam ends.

| Kind | `answer` |
| --- | --- |
| `single` | `{ "optionKey": "B" }` |
| `matching` | `{ "pairs": [{ "left": "l1", "right": "r3" }, ...] }` — rows may be left out; a right item at most once |
| `cells` | `{ "digits": "120" }` — a string of 1–4 digits `0-9`, nothing else. Leading zeros do not matter (`"0120"` = `"120"`) |

Response: `{ attemptQuestionId, answer, revision, savedAt, serverNow }`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Wrong shape; for cells anything but 1–4 digits (`"12a"`, `"12345"`, `"1,5"`, `"-1"`, a number) |
| 404 | `MOCK_EXAM_NOT_FOUND` / `ATTEMPT_QUESTION_NOT_FOUND` | Not my exam / not a question of it |
| 409 | `ATTEMPT_DEADLINE_PASSED` | The deadline passed: the answer is not saved and the exam is now finished |
| 409 | `ATTEMPT_NOT_IN_PROGRESS` | The exam is already finished |
| 409 | `ANSWER_REVISION_CONFLICT` | A newer revision is saved; `details[0].message` is the stored revision |

**Flag** — `PUT /trainer/exams/:attemptId/questions/:attemptQuestionId/flag` with `{ "flagged": true }` returns `{ attemptQuestionId, flagged, flaggedAt, serverNow }`. Same `404`/`409` codes as answers. The flag does not affect scoring.

**`POST /trainer/exams/:attemptId/submit`** finishes and grades; repeating it returns the same result. **`GET /trainer/exams/:attemptId/result`** returns the same data; before the end `409 RESULT_NOT_READY`. Keys, explanations and the sheet exist only here, after the end.

```json
{
  "data": {
    "exam": { "attemptId": "812", "status": "graded", "finished": true, "score": "126.00", "maxScore": "160.00", "percent": 78.75, "remainingSeconds": 0 },
    "sections": [{
      "position": 2, "subjectCode": "biologiya", "questionCount": 26, "maxScore": "40.00",
      "score": "32.00", "percent": 80, "answered": 26, "correct": 22,
      "questions": [
        { "number": 1, "kind": "single", "points": "1.00", "awardedPoints": "1.00", "answered": true, "correct": true,
          "answer": { "optionKey": "o2" }, "correctAnswer": { "optionKey": "o2" }, "explanation": { "blocks": [] },
          "sheet": { "selectedOptionKey": "o2", "selectedOptionNumber": 2, "correctOptionKey": "o2", "correctOptionNumber": 2 } },
        { "number": 22, "kind": "matching", "points": "4.00", "awardedPoints": "3.00", "correct": false,
          "sheet": { "correctPairs": 3, "totalPairs": 4, "rows": [
            { "row": "A", "leftKey": "l1", "selectedRightKey": "r2", "selectedColumn": 2, "correctRightKey": "r2", "correctColumn": 2, "correct": true },
            { "row": "D", "leftKey": "l4", "selectedRightKey": "r5", "selectedColumn": 5, "correctRightKey": "r1", "correctColumn": 1, "correct": false }
          ] } },
        { "number": 25, "kind": "cells", "points": "2.00", "awardedPoints": "2.00", "correct": true,
          "sheet": { "digits": "0012", "correctDigits": "12", "acceptedDigits": ["12"], "maxDigits": 4 } }
      ]
    }],
    "serverNow": "2026-11-13T11:02:00.000Z"
  }
}
```

(Abbreviated: every question also carries `attemptQuestionId`, `examPosition`, `questionType`, `flagged`, `content`, `options`, `matching` and `interactionSettings`; every section `subjectId`, `titles`, `color`.)

- **Scoring** (from the blueprint): single 1 or 0; matching 1 point per right pair (4/3/2/1/0); cells 2 for the right number, else 0. Unanswered = 0. `correct` = full points; `answered` = an answer was saved.
- **Drawing the sheet:** single → mark option `selectedOptionNumber` and `correctOptionNumber` (1–4, in the order shown; letters are the frontend's choice). Matching → rows A–D are the left items, columns 1–5 the right items, in the order shown; `selectedColumn` is `null` for an empty row. Cells → `digits` as typed (`null` when empty) and `correctDigits`.

**`GET /trainer/exams`** — query `limit` (1–100, default 20), `offset`. Finished exams only, newest first:

```json
{
  "data": {
    "exams": [{
      "attemptId": "812", "status": "graded", "autoSubmitted": false, "blueprintCode": "nct-a5",
      "titles": { "ru": "Пробный НЦТ — лист ответов A.5" },
      "startedAt": "2026-11-13T08:00:00.000Z", "submittedAt": "2026-11-13T11:02:00.000Z",
      "score": "126.00", "maxScore": "160.00", "percent": 78.75,
      "subjects": [{ "subjectCode": "zaboni-tochiki", "subjectId": "1", "titles": {}, "score": "40.00", "maxScore": "40.00", "percent": 100 }]
    }],
    "pagination": { "limit": 20, "offset": 0, "hasMore": false },
    "openAttemptId": null
  }
}
```

`openAttemptId` is the running exam, if any ("continue" button).

### Student home (M12 PR 1 and PR 2, 2026-11-16)

Three read-only routes for the signed-in student. Any active account may call them (students, and staff for their own data); there is no permission. `403 ACCOUNT_NOT_ACTIVE` for a blocked account.

**`GET /me/home`**: one request for the whole home page.

```json
{
  "data": {
    "continueLesson": {
      "courseId": "12", "courseTitle": "…", "moduleId": "40", "lessonId": "301", "title": "…",
      "playbackSeconds": 412, "durationSeconds": 1800, "updatedAt": "2026-11-16T09:12:00.000Z"
    },
    "courses": [{ "id": "12", "title": "…", "subject": { "id": "3", "color": "green", "title": "…" },
      "moduleCount": 4, "lessonCount": 36, "progress": { "completedLessons": 9, "totalLessons": 36, "percent": 25 },
      "enrollment": { "state": "active", "beginsAt": "…", "expiresAt": null }, "lastActivityAt": "…" }],
    "tests": {
      "open": [{ "id": "88", "testId": "70", "title": "…", "courseId": "12", "courseTitle": "…", "state": "open",
        "opensAt": "…", "closesAt": "…", "deadlineAt": "…", "questionCount": 20, "timeLimitMinutes": 30,
        "maxAttempts": 2, "attempts": { "status": "not_started", "attemptId": null, "remainingAttempts": 2 } }],
      "upcoming": []
    },
    "readiness": {
      "empty": false, "readinessPercent": 54.55, "completedTrainings": 2, "readinessWindow": 5,
      "subjects": [{ "subjectId": "135", "subjectCode": "…", "titles": {}, "color": "orange", "readinessPercent": 54.55, "trainings": 2, "lastSubmittedAt": "…" }],
      "lastMockExam": { "attemptId": "9", "score": "112.00", "maxScore": "160.00", "percent": 70, "submittedAt": "…" }
    },
    "recentResults": [{ "attemptId": "31", "origin": "authored", "title": "…", "testId": "70", "assignmentId": "88",
      "courseId": "12", "subjectId": "3", "attemptNumber": 1, "status": "graded", "score": "16.00", "maxScore": "20.00",
      "percent": 80, "passPercent": 60, "passed": true, "startedAt": "…", "submittedAt": "…" }],
    "week": {
      "timeZone": "Asia/Dushanbe",
      "days": [{ "date": "2026-11-10", "watchSeconds": 1260, "lessonsCompleted": 1, "attemptsFinished": 0 }],
      "totalWatchSeconds": 5400
    },
    "serverNow": "2026-11-16T09:30:00.000Z"
  }
}
```

- **`continueLesson`** is `null` when no unfinished lesson is accessible. Link to `/courses/{courseId}/lessons/{lessonId}` and seek to `playbackSeconds` (`durationSeconds` is `null` for a lesson without a video). Nothing guesses a "next" lesson.
- **`courses`** is the `GET /courses` item plus `lastActivityAt` (`null` until a lesson is opened), most recently active first. Scheduled and expired courses are included with their `enrollment.state`.
- **`tests`**: course tests across every course. `open` = the window is open and the student has a running attempt or attempts left. `upcoming` = not open yet. Each list has at most 10 items. `deadlineAt` is the earliest of the window end, the personal window end and the running attempt deadline; show a countdown from `serverNow`, not from the device clock. Trainer and mock exam tests are never listed.
- **`readiness`**: the NCT trainer figures (same formula as `GET /trainer/overview`) for any account. `empty: true` and `readinessPercent: null` when the student has no finished trainings. `lastMockExam` is separate and is not part of `readinessPercent`.
- **`recentResults`**: the last 5 finished attempts of every kind. For `trainer` and `mock_exam` the `title`, `testId` and `assignmentId` are `null`; build the title from `origin` and `subjectId` (subject names come from `/trainer/catalog`). `passed` is `null` without a pass threshold. No answers or keys are ever included.
- **`week`**: seven local days, oldest first, the last one is today in the profile time zone (`UTC` when the zone is unknown). `watchSeconds` is unique watched time reported by the player. Activity is recorded from this release on (completed lessons and finished attempts from before it are filled in once; watch time before it is 0).

**`GET /me/attempts?origin&subjectId&limit&offset`**: finished attempts of every kind, newest first.

- `origin`: `authored` (course tests), `trainer` or `mock_exam`. `subjectId`: course subject, trainer subject, or any subject inside a mock exam. `limit` 1–100 (default 20), `offset` 0–100000. Anything else is `400 VALIDATION_ERROR`.
- Response: `{ "attempts": [FinishedAttempt], "pagination": { "limit": 20, "offset": 0, "total": 57, "hasMore": true } }`. `FinishedAttempt` is the `recentResults` item above.
- Only `graded` and `expired` attempts are listed (a running attempt is not history). Open a result with `GET /tests/attempts/{attemptId}/result` (course tests and trainings) or `GET /trainer/exams/{attemptId}/result` (mock exam).


**`GET /me/analytics`** (M12 PR 2): profile figures.

```json
{
  "data": {
    "windowDays": 90,
    "since": "2026-08-18T09:30:00.000Z",
    "totals": { "watchSeconds": 18450, "lessonsCompleted": 23, "attemptsFinished": 41 },
    "firstAttempt": { "count": 12, "averagePercent": 71.5, "withPassPercent": 8, "passed": 6, "passRate": 75 },
    "topics": {
      "minQuestions": 5, "weakBelowPercent": 60, "strongFromPercent": 85,
      "strong": [{ "topicId": "51", "topicCode": "algebra", "subjectId": "3", "subjectCode": "math",
        "titles": { "tg": "…", "ru": "…" }, "questions": 18, "points": "17.00", "maxPoints": "18.00", "percent": 94.44 }],
      "weak": [{ "topicId": "54", "topicCode": "spelling", "subjectId": "135", "subjectCode": "…",
        "titles": {}, "questions": 7, "points": "2.00", "maxPoints": "7.00", "percent": 28.57 }]
    }
  }
}
```

- **`totals`** are all-time. `watchSeconds` is the unique watched time of every lesson (merged `watchedRanges`), so rewatching does not add up. `lessonsCompleted` counts completed lessons; `attemptsFinished` counts finished attempts of every kind.
- **`firstAttempt`**: all-time first attempts of course tests (no trainer or mock exam). `averagePercent` is the mean of their percentages (`null` with none). `passRate` = `passed` ÷ `withPassPercent` × 100 and counts only tests with a pass threshold; it is `null` when none had one.
- **`topics`**: finished attempts of every kind (course tests, trainer, mock exam) submitted in the last `windowDays` days (from `since`). Per topic: `points` ÷ `maxPoints`; an unanswered question earns 0. A topic appears only with at least `minQuestions` questions. `weak` is below `weakBelowPercent`, `strong` from `strongFromPercent` (on the rounded `percent`: exactly 60 is not weak, exactly 85 is strong). Topics in between are in neither list. At most 5 per list; weak lists the lowest first, strong the highest first, ties by more questions. Show the thresholds from the response instead of hard-coding them.
- To practise a weak topic, start a training with `POST /trainer/attempts { subject: subjectId, topicCode, difficulty: "mixed", count }` when the topic exists in `/trainer/catalog`.

### Admin: tests (M10)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/admin/tests` | `tests.read` | List in scope; `limit`, `offset`, `courseId`, `status`; `hasMore` |
| POST | `/admin/tests` | `tests.manage` | Create a draft |
| GET | `/admin/tests/:testId` | `tests.read` | Test with questions |
| PATCH | `/admin/tests/:testId` | `tests.manage` | Edit draft settings |
| DELETE | `/admin/tests/:testId` | `tests.manage` | Delete a draft |
| POST | `/admin/tests/:testId/questions` | `tests.manage` | Add up to 100 questions |
| PUT | `/admin/tests/:testId/questions/order` | `tests.manage` | Replace the order (full list) |
| DELETE | `/admin/tests/:testId/questions/:questionId` | `tests.manage` | Remove a question |
| PUT | `/admin/tests/:testId/questions/:questionId/points` | `tests.manage` | Set points |
| POST | `/admin/tests/:testId/publish` | `tests.publish` | Publish a draft |
| POST | `/admin/tests/:testId/archive` | `tests.manage` | Archive a published test |
| POST | `/admin/tests/:testId/copy` | `tests.manage` | Copy as a draft |
| GET | `/admin/tests/:testId/assignments` | `tests.read` | List; `limit`, `offset`, `status`; `hasMore` |
| POST | `/admin/tests/:testId/assignments` | `tests.assign` | Assign to one group or one student |
| PATCH | `/admin/tests/:testId/assignments/:assignmentId` | `tests.assign` | Change `opensAt`, `closesAt` |
| DELETE | `/admin/tests/:testId/assignments/:assignmentId` | `tests.assign` | Revoke (the row stays) |

Exact bodies and error codes are in Swagger and `docs/api.md`.

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
| `tests.read`, `tests.manage`, `tests.assign`, `tests.results.read` | ✓ | ✓ | ✓ scoped | — |
| `tests.results.regrade` | ✓ | ✓ | — | — |
| `tests.publish` | ✓ | ✓ | — | — |
| `progress.read` (no route uses it yet; staff progress views in M12 PR 3) | ✓ | ✓ | ✓ scoped | — |

Notes:

- **Students** hold no permission. They use the learner routes (`/courses`, `/groups`, `/profile`, `/auth/*`), where the scope comes from enrollments, module grants and group memberships. Roles never grant course access.
- **Teacher scoping** (`docs/api.md`):
   - courses, modules and lessons: only courses the teacher is assigned to; editing also needs the assignment flags `canEditCourse` / `canManageLessons`;
   - uploads: an assigned teacher with `canManageLessons`;
   - groups: assigned groups, and announcements only when the assignment allows publishing;
   - question banks: the teacher's own banks for writes; own and staff-visible banks for reads;
   - tests: courses with `canManageTests`; a group assignment also needs `canAssignTests` on the group.
- **Missing permission:** most routes return `403 ACTION_FORBIDDEN`; account-administration routes return `403 ADMIN_ROLE_REQUIRED`. A missing scope (resource not visible to the actor) returns the resource's `404`.

### 3.2 Account actions: who may act on whom

Enforced in `src/services/account-admin-service.js`.

| Actor → target | approve | reject | block | unblock | roles (`PUT /admin/users/:id/roles`) |
|---|---|---|---|---|---|
| owner → owner | ✓ | ✓ | ✓, except the last active owner (`409 LAST_OWNER_PROTECTED`) | ✓ | ✓ while keeping `owner`; removing `owner` from the last active owner returns `409 LAST_OWNER_PROTECTED` |
| owner → admin / teacher / student | ✓ | ✓ | ✓ | ✓ | ✓ grant/remove `admin`, `teacher`; granting `owner` returns `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| admin → owner | ✓ (not owner-protected) | `403 OWNER_ACTION_FORBIDDEN` | `403 OWNER_ACTION_FORBIDDEN` | `403 OWNER_ACTION_FORBIDDEN` | `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| admin → admin (another) | ✓ | ✓ | ✓ | ✓ | `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| admin → teacher / student | ✓ | ✓ | ✓ | ✓ | ✓, but only `teacher`/`student` changes; granting `admin`/`owner` returns `403 ROLE_ASSIGNMENT_FORBIDDEN` |
| anyone → self | (own account is not pending) | `409 SELF_REJECTION_FORBIDDEN` | `409 SELF_BLOCK_FORBIDDEN` | — | `409 SELF_ROLE_CHANGE_FORBIDDEN` |
| teacher / student → anyone | `403 ADMIN_ROLE_REQUIRED` | same | same | same | same |

State rules:

- `approve`/`reject`: `pending` only. `block`: `active` only. `unblock`: `blocked` only. Otherwise `409 INVALID_ACCOUNT_TRANSITION`.
- **Role sets** must be non-empty, distinct, use known codes (`400 INVALID_ROLES`) and include `student` (`422 STUDENT_ROLE_REQUIRED`).
- **Granting `owner`** (adding it to an account that does not hold it) is refused for everyone with `403 ROLE_ASSIGNMENT_FORBIDDEN`; owners exist only through `bootstrap:owner`. Do not offer `owner` as a role to add in the UI.
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
| Attempts (optional) | `ATTEMPT_SWEEP_INTERVAL_MS` (30000), used by `npm run worker:attempts` |
| NCT trainer (optional) | `TRAINER_BANK_CODE_PREFIX` (`nct-`), `TRAINER_QUESTION_COUNTS` (`10,20,30,50`), `TRAINER_MAX_QUESTIONS` (50; upper bound for the counts), `TRAINER_DIFFICULTY_LEVELS` (`easy:1-2,medium:3,hard:4-5`), `TRAINER_MIXED_SHARES` (`30,40,30`, one per level, sum 100), `TRAINER_READINESS_WINDOW` (5), `TRAINER_WEAK_TOPIC_MIN_ANSWERS` (5), `TRAINER_WEAK_TOPICS_LIMIT` (5), `TRAINER_RECENT_RESULTS_LIMIT` (5) |
| Password recovery (optional) | `RECOVERY_CHALLENGE_TTL_SECONDS`, `RECOVERY_RESET_TTL_SECONDS`, `RECOVERY_RESEND_COOLDOWN_SECONDS`, `RECOVERY_MAX_ATTEMPTS`, `RECOVERY_MAX_REQUESTS_PER_HOUR` |
| Telegram (optional; Telegram login, link, recovery) | `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_REDIRECT_URI`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OIDC_STATE_TTL_SECONDS` |
| Storage (optional; otherwise storage routes return `503 STORAGE_NOT_CONFIGURED`) | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `STORAGE_PART_SIZE_BYTES`, `STORAGE_PRESIGN_TTL_SECONDS`, `STORAGE_UPLOAD_TTL_HOURS` |

### 5.2 Steps

```bash
npm install
npm run migrate:up          # applies src/migrations (30 today); never run migrate:down on a real DB
npm run dev                 # or npm start; http://localhost:4000, Swagger at /api/docs
npm run storage:configure   # only with S3/MinIO: bucket CORS/settings
npm run worker:attempts     # optional locally: submits expired attempts in the background
```

### 5.3 Seed and demo accounts

`npm run seed:demo` fills a **disposable** database with demo accounts and content. It goes through the same services as the API, so validation and audit events apply. The migrations themselves seed only roles and permissions.

**Recreate a disposable database and seed it** (the database name must contain `dev`, `test` or `demo`):

```bash
# 1. Drop and create an empty database (psql; the user needs CREATEDB)
psql -U postgres -c "DROP DATABASE IF EXISTS everest_demo WITH (FORCE)"
psql -U postgres -c "CREATE DATABASE everest_demo"

# 2. Point this shell at it. Environment variables override .env, so .env is not edited.
export DB_NAME=everest_demo          # PowerShell: $env:DB_NAME = 'everest_demo'

# 3. Migrate and seed
npm run migrate:up
npm run seed:demo                    # optional: -- --password 'YourPassw0rd123'
npm run dev
```

- **Password:** `--password`, else the `SEED_PASSWORD` variable, else a random one that is printed **once** at the end of the run. It is never written to a file. Existing accounts keep their original password, so a rerun does not change it. The password must have 12 to 128 characters with a letter and a number.
- **Safety:** the script prints the target database first. It refuses to run when `NODE_ENV=production` (even with `--force`) or when `DB_NAME` contains none of `dev`, `test`, `demo` (override with `--force`). It is idempotent: a second run skips what exists and creates nothing.
- **Never** run it against a real or shared database. There is no `--reset` flag; drop and recreate the database instead.

| Phone | Account | Roles in the API | What it shows |
|---|---|---|---|
| `+992900000001` | owner (Farhod) | `owner` | Everything: all admin screens, any course, bank, test or group |
| `+992900000002` | admin (Madina) | `["student","admin"]` | The same admin screens without owner-only actions |
| `+992900000003` | teacher (Jamshed) | `["student","teacher"]` | All five permissions in "Биология 9 класс", content-only in "Химия 9 класс", group A |
| `+992900000021` | teacher (Шоира Кодирова) | `["student","teacher"]` | All permissions in chemistry, assessment permissions in math, group B (can assign tests) |
| `+992900000022` | teacher (Икбол Рахмонов) | `["student","teacher"]` | Assessment permissions in physics, results-only in math, group B and the archived group C |
| `+992900000004` | student Aziza | `["student"]` | **Full access** to "Биология 9 класс" (both published modules); chemistry with one module ending in 3 days |
| `+992900000005` | student Bahrom | `["student"]` | Biology enrollment **scheduled** (starts in 7 days); active math with three modules |
| `+992900000006` | student Dilnoza | `["student"]` | Biology enrollment **expired**; physics with one active and one **revoked** module grant |
| `+992900000007` | student Eraj | `["student"]` | Chemistry enrollment **revoked**; math enrollment **reinstated** after revocation |
| `+992900000008` | student Firuza | `["student"]` | Full physics access; math enrollment scheduled |
| `+992900000009` to `+992900000020` | 12 students | `["student"]` | Rosters of groups B and C, user pickers, search |
| `+992900000023`, `+992900000024` | 2 **pending** accounts | `["student"]` | The approvals screen (approve or reject) |
| `+992900000025` | **blocked** account | `["student"]` | Cannot log in (`403 ACCOUNT_NOT_ACTIVE`) |
| `+992900000026` | **rejected** account | `["student"]` | Cannot log in |

The 22 active accounts have a completed onboarding profile; the original eight use the last name `Demo`, the others have realistic names. The owner is created by the same service as `bootstrap:owner`. If the database already has an owner, the script skips the demo owner, says so, and uses that existing owner to approve and configure everything else. Phones `01` to `08` are unchanged from earlier versions of the seed.

**Content created on a fresh database** (counts are printed at the end of the run; `--verbose` also lists every record):

| Area | What exists |
|---|---|
| Subjects | 5 with colors: Биология (green), Химия (blue), Физика (orange), Математика (purple), Русский язык (neutral); Russian, Tajik and English titles. 15 sections and 50 topics, 12 of them nested (at least 9 topics per subject). |
| Courses | **5 published** and **1 draft**. New: "Биология 9 класс", "Химия 9 класс", "Физика 9 класс", "Математика: подготовка к НЦТ" (Russian text, Tajik title translations). Kept from the earlier seed: "Biology Fundamentals (demo)" and the draft "Chemistry Basics (draft demo)". |
| Modules | 3 per new course. Biology module 3 is **draft** (its lessons are drafts); chemistry module 3 is **archived**; the rest are published. |
| Lessons | 41 new: text lessons of 150 to 400 words with headings, paragraphs, lists, dividers, callouts; 4 `mixed` lessons; 9 `video` lessons left as **draft** (no real storage, so they cannot be published). |
| Course teachers | 7 assignments with different permission sets (see the account table). |
| Question banks | 5, one per subject: 4 `staff`, 1 `private` (`demo-russian-bank`, only the owner sees it). 145 published questions in total (28 to 31 per bank) of all five types, with verified keys and explanations, topic links, difficulty 1 to 5, languages `ru`, `tg` and `en`; 25 drafts without keys; 15 archived. Matching questions have both `requireAllLeft` and `allowRightReuse` set. External ids look like `bio-q-01`. |
| Tests | 4 **published** (10 or 15 questions, varied points, time limits and attempts, modes `practice`, `exam`, `lesson`), 1 **draft**, 1 **archived**, plus the original demo quiz. Assigned to groups and students with windows that are open now, upcoming and closed. |
| Groups | 3: A (`demo-group-a`), B (`demo-group-b`) and the **archived** C (`demo-group-c-2025`), each with a representative, teachers with different permissions and 3 to 4 announcements (draft, published, pinned; one archived in C). |
| Access | 12 enrollments: active, **scheduled**, **expired**, **revoked** and **reinstated**; 22 module grants: active, **scheduled**, **expired** and **revoked**. |

**What the demo is for, screen by screen**

- Users page: every status (`active`, `pending`, `blocked`, `rejected`) and the filters `notInGroup`, `notEnrolledInCourse`.
- Course editor: sort order of modules, a draft module, an archived module, draft video lessons, translations.
- Question bank: filters by type, status, language, topic, key status; read-only versus manage (the private bank).
- Test admin: draft (editable), published and archived (read-only) tests; assignments in three window states; `after_window` reveal needs `closesAt`.
- Access: the enrollment list shows all states; `PATCH`/extend/revoke/regrant flows can be tried on student 4 to 8.

**Rerun behavior and limits.** A rerun creates nothing that exists (matched by phone, code, title or external id). A group that is already archived is left untouched. Past access windows (expired, closed) cannot be created through the public API, so the seed uses the services' own clock parameter for them and moves assignment windows into the past with the update API; this is for demo data only. Running it against an old seed adds the new content next to the old one.

**Manual setup without the script** (the same result through the API): register with `POST /auth/register`, `npm run bootstrap:owner -- --phone +992XXXXXXXXX` (works once per database), then `POST /admin/users/:id/approve`, `PUT /admin/users/:id/roles`, `POST /admin/courses/:id/teachers`, `POST /admin/groups/:id/teachers` and `POST /admin/courses/:id/enrollments` plus module grants.

**Tests:** `npm test` runs the whole suite in a disposable database and never touches your local data. `tests/integration/seed-demo.test.js` creates its own database, runs the seed twice and compares counts per entity and access state.

---

### 5.4 Login fails: check the setup

```bash
node scripts/check-auth-setup.js                        # optional: --phone +992900000001
DB_NAME=everest_demo node scripts/check-auth-setup.js   # PowerShell: $env:DB_NAME = 'everest_demo'
```

The script prints pass or fail for the secrets, `CORS_ORIGINS`, `/health` and `/ready`, the database clock, migrations, the account (status, password row, hash format, roles) and active rate-limit blocks. It never prints secret values, reads the database in a `READ ONLY` transaction, and refuses `NODE_ENV=production`.

- **The script checks the database of its own shell, not the one the running server uses.** `DB_NAME` set in a shell overrides `.env` and stays with that server process until it stops. Read the startup line `EVEREST API listening on port ... (database ...)`.
- **One server on a port.** A second start fails with `EADDRINUSE` and the old server keeps answering from its old database. Stop the old process first.
- **Each `seed:demo` run on a new database generates its own password.** A password printed for one database does not work on another. A phone that exists only in another database always returns `401 INVALID_CREDENTIALS`.
- **`429 AUTH_RATE_LIMITED`:** after `AUTH_LOGIN_MAX_ATTEMPTS` tries for one phone, wait for `Retry-After` (default 900 seconds). To clear it sooner on a local database, run `DELETE FROM auth_security_counters WHERE scope = 'login.account'` in **the database the server uses**.

## 6. Database (short)

87 tables (PostgreSQL, `BIGINT` identity keys, migrations in `src/migrations`). Only the domains listed as having an API in §2 are reachable from the frontend today.

| Domain | Tables | Key relations | API |
|---|---|---|---|
| Identity & auth | `users`, `user_profiles`, `user_phones`, `user_passwords`, `auth_identities`, `auth_sessions`, `auth_refresh_tokens`, `auth_challenges`, `auth_security_counters`, `telegram_oidc_states`, `telegram_connections`, `sms_deliveries`, `user_invitations` | one `users.id` for phone, password and Telegram; sessions → users; refresh tokens → sessions | yes (`user_invitations`, `sms_deliveries` unused) |
| RBAC & audit | `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_events` | user_roles (user, role); audit_events (actor, subject, entity) | via account admin |
| Groups | `groups`, `group_members`, `group_teachers`, `group_announcements`, `announcement_assets` | members and teachers → groups and users; groups **never** grant course access | yes |
| Taxonomy | `subjects`, `subject_translations`, `sections`, `section_translations`, `topics`, `topic_translations` | sections and topics → subject; topic → section/parent (same subject) | yes (admin) |
| Courses & learning | `courses`, `course_teachers`, `course_modules`, `lessons`, `lesson_video_chapters`, `lesson_resources`, `course_enrollments`, `module_access_grants`, `lesson_progress`, `lesson_notes`, `course_favorites`, `learning_activity_events`, `offline_devices`, `offline_downloads` | course → modules → lessons; enrollments and module grants per user (separate, admin-granted) | yes: lessons, progress (watched ranges), notes, favorites, offline devices and licenses; `learning_activity_events` has no API |
| Assets | `assets`, `asset_uploads`, `asset_aliases` | uploads → asset + course; aliases (namespace, externalId) → asset | yes (uploads); aliases via import |
| Question bank | `question_banks`, `questions`, `question_options`, `question_matching_items`, `question_answer_keys`, `question_topics`, `question_assets`, `question_duplicate_links`, `question_imports`, `question_import_errors` | bank → subject, owner; question → bank; options, items, key, topics, assets → question; correctness only in `question_answer_keys` | yes (admin); import via CLI; read-only run API |
| Tests & attempts | `tests`, `test_questions`, `test_assignments`, `test_attempts`, `attempt_questions`, `student_answers`, `attempt_score_revisions` | tests → course; test_questions → test + question | yes: authoring and assignment (M10), attempts, autosave, grading and results (M11), NCT trainer and mock exam |
| AI | `ai_*` (11 tables) | — | **no API** |
| Bonus & achievements | `bonus_*` (5 tables), `achievements`, `user_achievements` | — | **no API** |
| Notifications | `notifications`, `notification_deliveries`, `notification_preferences`, `push_subscriptions`, `broadcast_campaigns` | — | **no API** (only a Telegram test message) |
| Operations | `background_jobs`, `idempotency_keys`, `platform_settings` | — | **no API** |

---

## 7. Known gaps, inconsistencies and TODOs

### API behaviour the UI must handle

1. **Two different 403 codes for a missing permission:** account administration returns `ADMIN_ROLE_REQUIRED`; every other domain returns `ACTION_FORBIDDEN`.
2. **`total` exists only on the two admin user lists and `GET /groups`**; every other list is `hasMore`-only. A "page X of Y" UI is only possible there.
3. **Validation reports only the first error** (`details` has one entry), so forms cannot show all field errors from one response.
4. **Language codes differ by endpoint:**
   - profile uses `preferredLanguage`: `ru|tj|en` (`tj` is stored as `tg`);
   - courses, taxonomy and questions use `tg|ru|en`.
5. **`AccountTransition.user`** (approve/reject/block/unblock) uses the older `PendingUser` shape (no `roles`, `displayName` or `telegramLinked`). Refetch the row from `GET /admin/users` after an action.
6. **`approve` is not owner-protected**, and an admin may block, reject or unblock another admin (only owners are protected). This is intentional per `docs/decisions.md` M17; flag it if the product disagrees.
7. **`LAST_OWNER_PROTECTED` is practically unreachable through the API.** The acting owner is itself an active owner, so the guard only fires in races. The UI may still map it.
8. **`owner` cannot be granted through the API** (`403 ROLE_ASSIGNMENT_FORBIDDEN`), and an owner may still remove `owner` from another owner, so a removed owner cannot be restored without `bootstrap:owner` (which works once). Pending product decision.
9. **Every role set must include `student`**, even for staff (`422 STUDENT_ROLE_REQUIRED`). The database itself does not require it.
10. **Matching questions may have `requireAllLeft`/`allowRightReuse` = `null`** (imported books). Such questions cannot be published (`409 QUESTION_NOT_PUBLISHABLE`, detail `INTERACTION_SETTINGS_INCOMPLETE`) until a reviewer sets booleans with `PATCH /admin/questions/:id`, or the package is imported with `applyMatchingDefaults=true`, which is explicit and reported per question.
11. **Rich content is block-level only:** no inline bold or inline formulas, and no table headers. Imported book text was flattened with warnings (see the run errors API).
12. **Asset uploads require a `courseId`.** There is no single-image HTTP upload for question banks; images arrive inside an import package (CLI or `POST /admin/question-imports/packages`).
13. **No API for duplicate links.** A draft with a duplicate link cannot be deleted (`409 QUESTION_IN_USE`).
14. **Imports over HTTP:** `POST /admin/question-imports/packages` (raw ZIP body, shows the dry-run report), `POST .../:uploadId/confirm` (`202`), then poll `GET .../:uploadId` until `completed` or `failed` and read `runId`. The worker `npm run worker:imports` must be running, otherwise uploads stay `queued`. Details in `docs/api.md`.
14a. **Archived groups are read-only for composition** (`409 GROUP_ARCHIVED` on add/edit/remove of members and teachers and on new announcements). Restore with `PATCH /admin/groups/:id { status: "active" }`. Existing announcements can still be edited or archived.
14b. **Group `code` is optional on create**; omit it and show the generated code from the response. Write responses (`POST`/`PATCH /admin/groups`) carry counts but not `relationship`.
14c. **Candidate pickers:** use `GET /admin/users?role=student&status=active&notInGroup=:id` for members and `role=teacher&status=active&notTeacherOfGroup=:id` for teachers. Eligibility is still enforced on add (`GROUP_MEMBER_INELIGIBLE`, `GROUP_TEACHER_INELIGIBLE`).
14d. **Enrollment picker and re-enrollment:** use `GET /admin/users?role=student&status=active&notEnrolledInCourse=:courseId`; revoked enrollees stay in the list. `POST /admin/courses/:id/enrollments` on a revoked enrollment reinstates it (`201`) but leaves its module grants revoked, so re-grant modules afterwards (`POST .../modules` also reinstates a revoked grant). Expired non-revoked enrollments still return `409 ENROLLMENT_ALREADY_EXISTS`; extend them with `PATCH`. Enrollment list items now include `user.phone` (E.164 or `null`).
14e. **Published tests are fully frozen.** Only archive and copy work; show settings as read-only. Tests have no translations and no per-assignment time or attempt overrides. `moduleId` is optional; lessons link to tests through `testId`, so a published test used by a lesson cannot be archived (`409 TEST_LINKED_TO_LESSON`).
14f. **Points and `totalPoints` are decimal strings** such as `"2.50"`. Do not treat them as numbers for display.
14g. **`DELETE` on an assignment revokes it**, and the row stays in the list with `status: "revoked"`.

### Not implemented (tables exist, no endpoints)

16. Staff progress views (M12 PR 3: group and course reports) and an activity API. The student home (`GET /me/home`), finished-attempt history (`GET /me/attempts`) and profile analytics (`GET /me/analytics`) exist. Notes and favorites have endpoints (see §2).
17. Notifications and inbox, broadcast campaigns, Web Push.
18. AI chat and budgets.
19. Bonuses and achievements.
20. Invitations.
21. Platform settings.

### Environment and verification

22. **Production SMS provider:** none is configured; password recovery by SMS is accepted but not delivered. Telegram recovery needs a linked Telegram identity and a bot connection.
23. **Real storage** is SeaweedFS (locally and on the server). Multipart upload, resume by part list, abort and Range reads pass against it; on the server a signed GET returns `206` with `Accept-Ranges` and `Cache-Control` through nginx. A real lesson video in a browser player is not verified yet.
24. **Demo data:** `npm run seed:demo` (§5.3) seeds a disposable database. `bootstrap:owner` works once per database.
25. **`.env.example`** was reported out of date in earlier handoffs (missing `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` and `SWAGGER_ENABLED`). Rely on §5.1, not on that file.

### Documentation inconsistencies

26. `docs/api.md` §"Session lifecycle" still says CSRF hardening "remains M02F". That is stale: M02F-B implemented the CSRF token and origin check described in §4.3.
27. Lists in `docs/api.md` describe ordering per endpoint, but there is no global sort parameter. Only `GET /admin/users` accepts `sort`.
