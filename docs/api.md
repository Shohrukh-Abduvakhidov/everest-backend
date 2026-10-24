# Implemented API

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
    "user": { "id": "00000000-0000-0000-0000-000000000000" },
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
