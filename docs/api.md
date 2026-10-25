# Implemented API

Internal database identifiers are serialized as canonical positive decimal strings. This preserves PostgreSQL `BIGINT` precision across JSON and JWT claims; clients must not assume identifiers are gapless or safely coerce them to JavaScript `Number`.

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

Successful response `200` requires an active account, creates an auditable server-side session, updates `last_login_at`, and sets the access JWT in the same `HttpOnly`, `SameSite=Lax` `everest_access` cookie used by Telegram login. The token is omitted from JSON:

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
