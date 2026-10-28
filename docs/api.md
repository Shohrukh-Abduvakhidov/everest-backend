# Implemented API

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

Permissions are `courses.read`, `courses.create`, `courses.update`, `courses.publish`, and `courses.teachers.manage`. Owner/admin receive all five. Teachers receive read/update actions, but repository scope restricts reads to assignments and updates additionally require `canEditCourse`. Teacher assignment never implies publication, enrollment, module access, or group access. No student course API exists yet.

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
