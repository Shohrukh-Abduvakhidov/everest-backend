# EVEREST Backend Architecture

Status: current-state audit. Last verified: 25 October 2026 (Asia/Dushanbe).

This document is the single source of truth for the architecture **implemented in this repository today**. `AGENTS.md` remains the source of mandatory engineering rules, while `schema_tables.md` remains the detailed database baseline contract. This document records what exists, what is partial, and what is only planned; a table existing in PostgreSQL is not evidence that its API or business service exists.

Evidence used for this audit: actual source files, all migrations, `package.json`, `package-lock.json`, the database catalog, tests and scripts, `docs/api.md`, `docs/decisions.md`, `docs/progress.md`, `schema_tables.md`, `documentation.md`, project-local skills, and Git state. No secret values were read into this document.

## 1. Project overview

EVEREST is a closed learning platform for one education center. Its intended domains include users, groups, courses, individually granted course/module access, recorded lessons, question banks, tests, progress, notifications, AI assistance, bonuses, and operational jobs.

The current backend is a small layered modular monolith. The foundation, full database schema, health/readiness API, and Telegram OpenID Connect authentication/linking increment are implemented. Most other product domains currently have database schema only.

| Concern | Current implementation |
|---|---|
| Language/runtime | JavaScript on Node.js `>=22 <23` |
| Module format | Native ES modules (`"type": "module"`) |
| HTTP | Express 5.3.0 |
| Database | PostgreSQL 16.10 through `pg` 8.23.1 |
| Migrations | `node-pg-migrate` 8.0.4, JavaScript/raw SQL |
| Security/token library | `jose` 6.2.13 |
| Configuration | `dotenv` 17.4.2 and validated readers in `src/configs/env.js` |
| Tests | Node's built-in test runner plus PostgreSQL integration/verification scripts |
| Current milestone | M02C account approval planned next; M01R numeric identifier foundation complete |

## 2. Repository tree

Generated dependencies, `.git` internals, `.npm-cache`, and `.env` are intentionally omitted.

```text
everest-backend/
├── .agents/skills/everest-backend/       # Codex project skill and rules
├── .claude/skills/everest-backend/       # Identical Claude Code skill copy
├── docs/
│   ├── api.md                             # Implemented HTTP contracts
│   ├── architecture.md                    # This audited architecture source
│   ├── decisions.md                       # Accepted dated decisions
│   └── progress.md                        # Implementation handoff/history
├── scripts/
│   ├── inspect-database.js                # Read-only target/catalog summary
│   ├── test-migration-cycle.js            # Disposable DB up/down/up test
│   ├── test-schema-integrity.js           # Constraint tests rolled back in one transaction
│   ├── test-server.js                     # Health/readiness/shutdown integration test
│   ├── verify-database.js                 # Expected catalog/count verification
│   └── verify-migration-sources.js        # Baseline SQL digest/integrity verification
├── src/
│   ├── configs/                           # Environment, Pool, errors, migration runner
│   ├── controllers/                       # Health and Telegram HTTP adapters
│   ├── middleware/                        # Current session authentication middleware
│   ├── migrations/                        # 12 baseline + 1 incremental migration
│   ├── repositories/                      # All runtime application SQL and transactions
│   ├── routes/                            # `/api/v1` and auth route wiring
│   ├── services/                          # Health and Telegram business/application logic
│   │   └── auth/                          # OIDC, Bot API, and session-token adapters
│   ├── utils/                             # AppError, async handler, Telegram crypto
│   ├── app.js                             # Express application composition
│   └── server.js                          # Listener lifecycle and graceful shutdown
├── tests/
│   ├── integration/telegram-auth.test.js  # HTTP + real PostgreSQL, mocked Telegram
│   ├── unit/telegram-crypto.test.js
│   ├── unit/telegram-oidc-provider.test.js
│   └── all.test.js
├── .env.example                           # Empty configuration template
├── .gitignore                             # Excludes `.env`, dependencies, logs, uploads
├── AGENTS.md                              # Shared mandatory agent rules
├── CLAUDE.md                              # Adapter importing `AGENTS.md`
├── documentation.md                       # Broad design/reference document
├── schema_tables.md                       # Exact 81-table baseline schema contract
├── package.json
└── package-lock.json
```

`src/jobs/`, `src/prompts/`, and `src/uploads/` are approved future architectural locations. They will be created only with the corresponding feature because Git does not preserve empty directories. Their current absence is not an architecture violation; jobs, prompts, and uploads are unimplemented.

## 3. Application entry points

`src/app.js` creates Express, disables `x-powered-by`, enables credentialed CORS for configured origins, installs a 1 MiB JSON parser, mounts `/api/v1`, then installs not-found and global error handlers. Importing it constructs an app and Pool-backed service objects but does not listen, migrate, query the database, or launch work.

`src/server.js` is the executable entry point. `start()` first calls the readiness service, then listens on `env.port`. It optionally registers `SIGTERM` and `SIGINT`. Graceful shutdown stops accepting requests, waits up to `SHUTDOWN_TIMEOUT_MS`, closes all connections on timeout, and calls `pool.end()`. Startup failure also closes the pool. Jobs are not started because no job runtime exists.

Routes under `/api/v1` are:

- `GET /health`: process liveness only; no database access.
- `GET /ready`: repository-owned `SELECT 1` readiness check.
- `POST /auth/register`: transactional pending-student phone/password registration.
- `POST /auth/login/password`: active-account password login and session issuance.
- `/auth/*`: Telegram routes described below.

## 4. Layered architecture

```mermaid
flowchart LR
    Client --> Route
    Route --> Middleware
    Middleware --> Controller
    Controller --> Service
    Service --> Repository
    Repository --> PG[pg Pool/client]
    PG --> PostgreSQL
    Service --> Provider[Telegram/OIDC provider adapters]
    Errors[Thrown errors] -.-> ErrorHandler[Global error handler]
```

| Layer | Owns | Must not own | Audit result |
|---|---|---|---|
| Routes | Endpoint paths, HTTP verbs, middleware/handler order | Business rules, SQL | Conformant |
| Middleware | Bearer/cookie extraction, authenticated actor resolution | Trusting client `user_id`, SQL | Conformant; only authentication exists |
| Controllers | Query/header/request adaptation and response/cookie writing | Persistence or transaction decisions | Conformant |
| Services | Business rules, provider orchestration, transaction scope, safe DTOs | SQL and Pool/client lifecycle | Conformant |
| Repositories | Parameterized runtime SQL, locks, persistence, transaction helper | HTTP/provider behavior | Conformant |
| Migrations | DDL, functions, triggers, indexes, role seeds | Runtime business workflows | Conformant |

`withTransaction()` acquires one client, issues `BEGIN`, invokes the service callback, commits or rolls back, and releases in `finally`. Telegram link/login/unlink services pass that same client to every transaction-only repository method. No runtime application SQL or `.query()` call was found outside repositories; tests and operational scripts are intentional exceptions. No CommonJS usage was found.

Validation is currently lightweight and service-owned: password-auth request shape, E.164/name/password rules, Telegram intent, callback state/code, configuration, verified claims, account state, session state, identity conflicts, and unlink safety are checked in services/providers. There is no general request-schema validator. Authorization currently stops at authenticated active-user resolution; RBAC/action/resource authorization is planned.

Errors propagate through `asyncHandler` or explicit middleware `try/catch` to the global error handler.

## 5. Database connection architecture

`src/configs/db.js` creates one process-wide bounded `pg.Pool` from `env.database`. Current defaults are pool maximum 5, connection timeout 5 seconds, and idle timeout 30 seconds. An idle-client error logs only its error code.

`DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` are mandatory at configuration import. `DB_PORT` defaults to 5432. `DB_SSL=false` uses plaintext PostgreSQL transport; when true, `ssl: { rejectUnauthorized: true }` is used. No certificate-verification bypass is present.

Ordinary one-statement repositories may use the Pool. Atomic multi-statement work uses the single client supplied by `withTransaction`; entity repositories do not release it. `server.js` closes the Pool during graceful shutdown.

Tests do **not** currently use a separately configured integration-test database. Integrity tests use a direct `pg.Client` against the configured development database and roll back their transaction. Authentication integration tests create unique fixtures and delete them in `finally`. Migration rollback verification uses a separately named disposable database that is created, migrated up twice, rolled down once, reapplied, and dropped.

## 6. Migration architecture

Migrations live in `src/migrations/` and use native ESM with raw SQL. Required style:

```js
export const up = pgm => {
  pgm.sql(`
    -- SQL
  `)
}

export const down = pgm => {
  pgm.sql(`
    -- exact reversible SQL
  `)
}
```

The programmatic runner in `src/configs/migrate.js` uses the shared DB configuration, `pgmigrations`, ordering checks, migration locking, and a single transaction. `npm run migrate:up` applies all pending migrations. `npm run migrate:down` is limited to one migration and refuses database names that do not clearly contain `test`, `tmp`, `temp`, or `disposable`.

Internal entity identifiers are PostgreSQL `BIGINT GENERATED BY DEFAULT AS IDENTITY`; repositories omit them on insert and consume `RETURNING id`. Foreign keys, one-to-one identifiers, composite relationship identifiers, database-function parameters, and polymorphic audit identifiers use `BIGINT`. Because `pg` preserves `BIGINT` as strings, API and JWT user/session identifiers are validated positive decimal strings and are never converted through JavaScript `Number`. Sequence gaps are valid. The only UUID column is `sms_deliveries.idempotency_key`, an opaque retry key rather than an entity identifier.

There are 13 applied migrations: 12 baseline files and `20261024010000000_add-telegram-oidc-states.js`. M01R explicitly authorized a one-time pre-production rewrite of all 13 files after proving that the local database held no application data and taking a backup. They now form the numeric-identifier development baseline and must not be edited again after publication. Legacy hyphen separators still cause harmless node-pg-migrate timestamp warnings.

Verified development catalog:

| Object | Count |
|---|---:|
| Application tables | 82 |
| Columns | 650 |
| Foreign keys | 157 |
| Indexes, including constraint-backed | 293 |
| Functions | 7 |
| User triggers | 11 |
| Fixed role seeds | 4 |
| Migration history rows | 13 |
| Identity columns | 64 |

`verify-migration-sources.js` proves that the first 12 migrations emit exactly the 81-table baseline in `schema_tables.md` (SHA-256 match), with 63 identity primary keys, one UUID idempotency column, 7 functions, 11 triggers, 4 role seeds, and no `CASCADE` in down SQL. The incremental Telegram OIDC migration adds the 64th identity column and the 82nd table.

After the verified local-development safety gate and backup, `everest_db` was dropped/recreated and all 13 rewritten migrations applied. A second `migrate:up` was a no-op. The disposable migration test independently passed up/no-op/down-one/up and dropped its temporary database; no rollback ran against `everest_db`.

## 7. Configuration and environment

All values are server-side unless explicitly marked public metadata. Empty values in `.env.example` are placeholders, not usable credentials.

| Variable | Purpose / format | Requirement and module | Frontend-safe? |
|---|---|---|---|
| `NODE_ENV` | Runtime mode string | Optional, default `development`; cookie security in controller | Safe as metadata |
| `PORT` | Integer 1–65535 | Optional, default 4000; `server.js` | Safe |
| `DB_HOST` | PostgreSQL hostname | Required; `env.js`/Pool/migrations | No |
| `DB_PORT` | PostgreSQL port | Optional, default 5432 | No |
| `DB_NAME` | Database name | Required | No |
| `DB_USER` | Database role | Required | No |
| `DB_PASSWORD` | Database password | Required secret | No |
| `DB_POOL_MAX` | Positive integer pool bound | Optional, default 5 | No need to expose |
| `DB_CONNECTION_TIMEOUT_MS` | Positive integer milliseconds | Optional, default 5000 | No need to expose |
| `DB_IDLE_TIMEOUT_MS` | Positive integer milliseconds | Optional, default 30000 | No need to expose |
| `DB_SSL` | `true`/`false` | Optional, default false | No need to expose |
| `CORS_ORIGINS` | Comma-separated origins | Optional, default localhost frontend; `app.js` | Safe configuration metadata |
| `SHUTDOWN_TIMEOUT_MS` | Positive integer milliseconds | Optional, default 10000; `server.js` | No need to expose |
| `JWT_ACCESS_SECRET` | At least 32 characters | Required for implemented authentication; session-token service | **No** |
| `AUTH_SESSION_TTL_SECONDS` | Positive integer seconds | Optional, default 900; Telegram auth service | No need to expose |
| `OTP_HMAC_SECRET` | Future OTP HMAC key | Listed but unused | **No** |
| `SMS_API_KEY` | Future SMS provider credential | Listed but unused | **No** |
| `TELEGRAM_CLIENT_ID` | Telegram OIDC client identifier | Required by Telegram auth | Public protocol identifier |
| `TELEGRAM_CLIENT_SECRET` | OIDC client secret and state-encryption key input | Required secret | **No** |
| `TELEGRAM_REDIRECT_URI` | Absolute callback URL | Required by Telegram auth | Public |
| `TELEGRAM_BOT_USERNAME` | Bot username | Required by configuration guard but otherwise unused | Public |
| `TELEGRAM_BOT_TOKEN` | Bot API token | Required secret; Bot provider | **No** |
| `TELEGRAM_WEBHOOK_SECRET` | Future webhook verification secret | Required by configuration guard but webhook is not implemented | **No** |
| `TELEGRAM_OIDC_STATE_TTL_SECONDS` | Positive integer seconds | Optional, default 600 | No need to expose |
| `AI_API_KEY` | Future AI provider credential | Listed but unused | **No** |
| `VAPID_PRIVATE_KEY` | Future Web Push private key | Listed but unused | **No** |

Local presence was checked without printing values. Telegram variables are populated, but `JWT_ACCESS_SECRET` is currently missing, so live auth endpoints return a configuration error until it is supplied. `.env` is ignored and untracked; `.env.example` is tracked and contains empty placeholders.

## 8. Authentication architecture

```mermaid
erDiagram
    users ||--o| user_profiles : has
    users ||--o{ user_phones : owns
    users ||--o| user_passwords : has
    users ||--o{ auth_identities : links
    users ||--o{ auth_sessions : opens
    auth_sessions ||--o{ auth_refresh_tokens : owns
    users ||--o{ user_roles : receives
    roles ||--o{ user_roles : defines
    users ||--o{ auth_challenges : requests
    users ||--o{ telegram_connections : permits
    users ||--o{ telegram_oidc_states : initiates_link
    users ||--o{ audit_events : acts_or_subject
```

- `users` is the platform identity and account lifecycle (`pending`, `active`, `blocked`, `rejected`). Telegram and password login check `active`; approval APIs do not exist.
- `user_profiles` stores names, language, timezone, and optional avatar relation. Registration creates the initial name record; profile APIs remain planned.
- `user_phones` represents E.164 ownership and verification. M02B creates an unverified phone for registration and resolves password login by its normalized value; verification APIs remain planned.
- `user_passwords` stores one self-describing salted `scrypt` hash per password user. Registration and password verification are implemented.
- `auth_identities` stores verified external login identity. Only Telegram `(provider, issuer, provider_subject)` is permitted and implemented.
- `auth_sessions` stores server-side session state. Creation is shared by Telegram/password login and live-session validation is implemented.
- `auth_refresh_tokens` models hashed refresh history. No refresh service exists.
- `auth_challenges` and `sms_deliveries` model OTP and delivery state. No service/provider exists.
- `telegram_oidc_states` stores short-lived login/link protocol state and is implemented.
- `telegram_connections` is bot messaging permission/destination, separate from login identity; link/test/disconnect behavior is implemented.
- `roles` contains seeded `owner`, `admin`, `teacher`, `student`; `user_roles` links users. No RBAC middleware exists.
- `audit_events` is generic audit storage. Telegram link/unlink and password registration/successful login write events; broader auditing is planned.

## 9. Telegram OIDC architecture

Implemented routes:

- `GET /api/v1/auth/telegram/start`
- `GET /api/v1/auth/telegram/callback`
- `POST /api/v1/auth/telegram/link`
- `DELETE /api/v1/auth/telegram/link`
- `POST /api/v1/auth/telegram/test-message`

Implemented flow, in order:

1. The start endpoint selects login intent; authenticated link selects link intent and binds the user ID.
2. The service generates cryptographically random state.
3. It generates an independent cryptographically random nonce.
4. It generates a PKCE verifier and derives the S256 challenge.
5. It stores state/nonce hashes, encrypted verifier, intent, optional initiating user, and expiry.
6. It builds and returns the authorization URL from Telegram discovery metadata.
7. Telegram redirects the browser to the callback with code/state or an error/state.
8. The callback atomically consumes a matching unexpired state exactly once before further processing.
9. It exchanges code, verifier, redirect URI, and client authentication at the discovered token endpoint.
10. It obtains/caches discovered JWKS and verifies the ID-token signature.
11. It verifies fixed issuer, configured audience, expiry, nonce, and non-empty subject.
12. For an existing identity it validates the active user and starts login.
13. For link intent it links only to the authenticated initiating user and rejects conflicts.
14. Verified bot scope and numeric Telegram ID may create/reactivate `telegram_connections`.
15. Login creates an `auth_sessions` row and EVEREST access token in one transaction.
16. The controller places the token in an HttpOnly cookie and omits it from JSON.
17. Authenticated unlink preserves at least one alternative login and atomically disconnects/audits.
18. Authenticated test-message resolves the stored connection, calls Bot API, and marks blocked access.

```mermaid
sequenceDiagram
    actor Browser
    participant API as EVEREST API
    participant DB as PostgreSQL
    participant TG as Telegram OIDC
    participant Bot as Telegram Bot API

    Browser->>API: GET /telegram/start or authenticated POST /link
    API->>API: Generate state, nonce, verifier; derive S256 challenge
    API->>DB: Store state/nonce hashes + encrypted verifier + intent/expiry
    API->>TG: Discover authorization/token/JWKS endpoints
    API-->>Browser: Authorization URL
    Browser->>TG: Authorize with state, nonce, PKCE challenge
    TG-->>Browser: Redirect callback with code + state
    Browser->>API: GET /telegram/callback
    API->>DB: Atomically consume unexpired state once
    API->>TG: Exchange code + verifier + redirect URI
    API->>TG: Fetch/cache JWKS
    API->>API: Verify signature, issuer, audience, exp, nonce, sub
    alt authenticated link intent
        API->>DB: Transaction: lock/check identity, link, bot connection, audit
        API-->>Browser: linked
    else known login identity
        API->>DB: Transaction: validate active user, update identity/connection, create session
        API-->>Browser: HttpOnly EVEREST session cookie
    else unknown identity
        API-->>Browser: linking_required
    end
    Browser->>API: POST /telegram/test-message
    API->>DB: Read active bot connection
    API->>Bot: sendMessage
    API->>DB: Mark blocked when access is unavailable
```

The start operation creates cryptographically random state and nonce plus a PKCE verifier/challenge. Only state and nonce SHA-256 hashes are stored; the verifier is encrypted with AES-256-GCM using a key derived from the Telegram client secret. Records expire and an atomic conditional update consumes them once before code exchange, including provider-denial callbacks.

The provider is discovered from the fixed Telegram discovery URL. Authorization requests `openid profile phone telegram:bot_access`. Token exchange uses the discovered token endpoint, Basic client authentication, the callback redirect URI, and verifier. `jose` verifies a locally cached discovered JWKS against fixed issuer `https://oauth.telegram.org`, configured audience, advertised allowed algorithms, expiry, nonce, and non-empty subject.

Only verified issuer/subject identifies a login. Phone, username, name, and chat ID never merge accounts. Linking requires an authenticated EVEREST actor and state bound to that actor; uniqueness constraints and stable `409` translation prevent multi-user or replacement conflicts. Bot access is persisted separately only when the token scope includes `telegram:bot_access` and a verified numeric Telegram ID is present.

Known identity login creates `auth_sessions` and an EVEREST JWT. The callback puts it in `everest_access` with `HttpOnly`, `SameSite=Lax`, path `/`, explicit expiry, and `Secure` in production; it removes the token from JSON. Unlinking requires another password/external login method, disconnects messaging, deletes the identity, and audits atomically. Test messaging safely maps Bot API failures and marks unavailable connections blocked.

Secrets, authorization codes, provider tokens, raw state/nonce, and verifiers are not logged by implementation code. The authorization URL necessarily carries protocol state/nonce to Telegram and is returned to the browser.

## 10. Session architecture

| Capability | Status | Evidence |
|---|---|---|
| Access token creation | Implemented | HS256 JWT with `sub`, `sid`, `iat`, `exp` |
| Cookie transport | Implemented | `HttpOnly`, `SameSite=Lax`, production `Secure`, expiry |
| Bearer transport | Implemented | Auth middleware accepts `Authorization: Bearer` |
| Session lookup | Implemented | Session ID/user match, not revoked, unexpired |
| Active account check | Implemented | Joined `users.status === active` |
| Revoked session rejection | Implemented read path | `revoked_at IS NULL`; no revoke endpoint |
| Refresh-token rotation | Planned | Table only |
| Logout/session revocation | Planned | No route/service/repository mutation |
| Session listing | Planned | No API |
| Device management | Planned | User agent/IP stored on Telegram and password login only |

Password and Telegram login share `src/services/auth/session-service.js`, so both create the same `auth_sessions` row and access-token form. Password login also updates `users.last_login_at`; broader last-used/device lifecycle remains M02D.

The current access-token TTL defaults to 15 minutes and matches the database session expiry. `last_used_at` is not updated by authentication.

## 11. Authorization architecture

Authentication resolves the actor from a signed token and a live server-side session; controllers use `request.auth.userId`, not a client body/query `user_id`. This prevents actor spoofing for implemented authenticated endpoints.

The schema seeds four roles and records assignments, but no middleware or service checks roles, action permissions, group scope, course grants, or resource ownership. Telegram link/unlink/test-message need only an active authenticated account. Future protected operations must independently verify: active account, live session, allowed role/action, and effective resource ownership/grant. JWT validity alone is insufficient.

## 12. Functional domain map

| Domain | Principal tables | API / service / repository | Status |
|---|---|---|---|
| Authentication | `users`, profiles/phones/passwords, identities, sessions, refresh tokens, challenges, roles | Telegram OIDC plus phone/password registration/login | Partial |
| Profiles | `user_profiles`, `user_phones`, `assets` | Registration creates the initial private profile/phone; profile APIs absent | Partial |
| Groups | `groups`, `group_members`, `group_teachers`, announcements/assets | None | Planned (schema only) |
| Courses/access | `courses`, teachers, enrollments, modules, module grants | None | Planned (schema + DB access function) |
| Lessons/progress | `lessons`, resources, progress, notes, favorites, offline downloads | None | Planned (schema only) |
| Assets/video | `assets`, `asset_aliases`, lesson asset FKs | None | Planned (schema only) |
| Taxonomy | subjects/sections/topics and translations | None | Planned (schema only) |
| Question bank | banks/imports/errors/questions/options/matching/keys/topics/assets/duplicates | None | Planned (schema + immutability guards) |
| Tests/attempts | tests/questions/assignments/attempts/attempt questions/answers/revisions | None | Planned (schema + constraints/guards) |
| Analytics/ranking | activity events; attempt/progress source data | None; no ranking table/formula | Planned/decision required |
| Notifications | preferences/campaigns/notifications/deliveries | Telegram test message only, not notification pipeline | Partial |
| Telegram | identities, OIDC states, connections | Five routes, service/repository/providers | Done |
| Web Push | `push_subscriptions`, deliveries | None; VAPID key unused | Planned |
| AI | conversations/messages/policies/budgets/usage/requests/reservations/ledger/analyses | None; AI key unused | Planned (schema only) |
| Bonuses/achievements | accounts/rules/transactions/offers/redemptions/credits/achievements | None | Planned (schema + append-only guard) |
| Background jobs | `background_jobs` | No worker/job code | Planned (schema only) |
| Idempotency | `idempotency_keys` plus domain unique keys | No generic service | Planned (schema support only) |
| Platform settings | `platform_settings` | None | Planned (schema only) |

## 13. Course access architecture

Confirmed rules: groups are independent from courses; `group_courses` does not exist; membership grants no content access. An authorized administrator must grant `course_enrollments` and each `module_access_grants` row separately. Expiry/revocation blocks protected material but does not delete progress. Locked modules may expose safe published metadata, never lesson content, protected assets, test keys, or grading data.

```mermaid
flowchart TD
    A[Authenticated actor] --> B{Active account and live session?}
    B -- No --> Deny[Deny]
    B -- Yes --> C{Published course/module/resource?}
    C -- No --> Deny
    C -- Yes --> D{Active course_enrollment?}
    D -- No --> Meta[Return safe locked metadata only]
    D -- Yes --> E{Active module_access_grant for same user/course/module?}
    E -- No --> Meta
    E -- Yes --> F{Grant dates valid and not revoked?}
    F -- No --> Meta
    F -- Yes --> Allow[Allow protected content]
```

The database function `can_access_module` implements the grant predicate, but no HTTP authorization path currently calls it.

## 14. Group architecture

The planned group model is `groups` → `group_members`/`group_teachers`/`group_announcements`; announcements may attach assets. Teachers have explicit booleans for announcements, test assignment, and result visibility. Users may be members or teachers independently.

No group routes, services, repositories, list page API, or detail page API exist. The planned UI/API flow is a group list followed by a group detail view containing participants, teachers, announcements, progress summaries, and ranking. Progress aggregation and ranking formula are undecided and unimplemented. Groups must never become an implicit course-access mechanism.

## 15. Question bank architecture

Questions belong to banks and subjects and may reference an import/source question. Options and matching items hold presentation content. `question_answer_keys` is the only source of authored correctness; options have no `is_correct`. Topic links preserve subject consistency; assets are separate; tests compose questions through `test_questions`.

Database triggers prevent publishing without a verified answer key and prevent modification of published questions and their protected children. Unreviewed imports must remain draft, unknown answers must remain unknown, and corrections require copied content rather than mutation. `attempt_questions.grading_snapshot` and revision snapshots are private historical grading evidence and must never be returned to students. Import, review, publication, and query APIs are all planned.

## 16. Test attempt architecture

`test_assignments` scopes a test to one audience type. `test_attempts` carries attempt number, lifecycle status, start/expiry/pause/submission/grading timestamps, scores, and policy snapshot. `attempt_questions` snapshots order, points, and private grading rules. `student_answers` stores the current answer and optimistic `revision` for autosave. `attempt_score_revisions` provides append-only score history and idempotency.

Implemented database protection includes composite ownership FKs, one simultaneously open attempt per assignment/user, answer-to-attempt-question consistency, numeric/status checks, published test/question immutability, and append-only score revisions. The schema does not by itself implement timers, autosave conflict responses, finalization locks, submission, grading, expiry workers, result reveal policy, or student-safe serialization; all corresponding APIs/services/repositories remain planned.

## 17. Notification architecture

In-app notification records (`notifications`) are distinct from delivery attempts (`notification_deliveries`). `notification_preferences` enables channels per event. Broadcast campaigns snapshot content/audience/channels and lifecycle. Telegram destinations come from `telegram_connections`; Web Push destinations come from `push_subscriptions` and contain separate browser permission/key material.

Only Telegram connection persistence and a direct test message are implemented. There is no in-app inbox, preference API, broadcast service, delivery worker, retry processor, or Web Push provider. Telegram OIDC/bot permission does not and cannot grant Web Push permission.

## 18. AI architecture

The database models general or course conversations, messages, scoped limit policies, daily usage, hard provider budget periods, request reservations, an append-only usage ledger, provider request outcomes, and generated analyses. Bonus redemptions may grant request credits, but credits do not override the hard provider cash budget.

No AI route, service, repository, prompt, worker, model selection, or provider call exists. `AI_API_KEY` is unused. Reservation locking, calls, reconciliation of unknown outcomes, settlement/release, and safe context access are confirmed requirements but remain planned.

## 19. Testing architecture

| Script | Purpose |
|---|---|
| `npm test` | Source integrity → schema constraint tests → authentication tests → server lifecycle |
| `npm run test:sources` | Baseline migration/source digest and guard counts |
| `npm run test:integrity` | Eight negative database constraint cases, final rollback |
| `npm run test:auth` | All Node authentication unit and HTTP/PostgreSQL integration tests |
| `npm run test:telegram` | Compatibility alias for `test:auth` |
| `npm run test:server` | Liveness, readiness, and explicit graceful shutdown |
| `npm run test:migrations` | Disposable database create/up/down/up/drop cycle; currently blocked |

Telegram unit tests cover PKCE, state/nonce hashing, verifier encryption, JWKS signature, issuer, audience, expiry, and nonce. Telegram integration tests mock discovery/token/JWKS behavior and Bot API delivery; they exercise start, unknown login, replay, expiry, provider denial, invalid claims, link, duplicate link, login cookie, blocked connection, and unlink. Password tests cover E.164/password validation, salted hashing, pending registration, role injection denial, duplicate/concurrent phone protection, rollback, account-state denial, generic credentials, session creation, auditing, and safe responses. PostgreSQL integration is real, external providers are not contacted, and fixtures are removed in `finally`.

Last result, 25 October 2026: `npm test` passed all 24 reported authentication tests plus migration-source verification, eight schema-integrity cases, and server lifecycle. The numeric baseline migrated cleanly and a second `migrate:up` was a no-op. `verify-database.js` confirmed the expected 82-table, 13-migration catalog, 64 identity columns, all entity `id` columns and foreign keys as `BIGINT`, PostgreSQL-generated IDs, and only the justified UUID idempotency column. The disposable up/no-op/down/up cycle passed.

## 20. Security architecture

Implemented controls:

- `.env` is ignored and untracked; the template has empty secrets; tracked-secret pattern search found no credential material.
- Parameterized runtime SQL; no application SQL outside repositories.
- OIDC signature/issuer/audience/expiry/nonce/subject verification and one-time state.
- Hash-only state/nonce storage and authenticated encryption for the verifier.
- External identity based only on verified issuer/subject; no profile-based merging.
- Salted asynchronous `scrypt` password hashing, timing-safe comparison, dummy-hash work for unknown phones, and generic invalid-credential responses.
- Transactional pending registration with database-enforced concurrent phone uniqueness and no client-selected role/status.
- HttpOnly, SameSite cookie, production Secure flag, short expiry, and server-side revocation check.
- Credentialed CORS restricted to configured origins; `x-powered-by` disabled.
- Database FK/UNIQUE/CHECK constraints, immutability triggers, append-only journals, and idempotency keys.
- Telegram link/unlink audit events and safe Bot API failure mapping.

Known security gaps:

- Local `JWT_ACCESS_SECRET` is missing; live authentication is unavailable until configured.
- No rate limiting, brute-force protection, OTP controls, or SMS provider exists.
- No explicit CSRF token/origin middleware; cookie protection currently relies on SameSite and configured CORS. CORS is not itself a CSRF defense.
- No refresh rotation, logout, or session-management API.
- No RBAC/action/resource authorization middleware.
- No Helmet/content-security header package; only `x-powered-by` is disabled.
- No production deployment, secret manager, TLS termination, webhook handler/signature check, or operational monitoring is implemented.
- Integration tests use the development DB rather than a dedicated disposable test DB, although they roll back or clean fixtures.

## 21. Error handling and API responses

`AppError(status, code, message, details)` represents expected operational failures. `asyncHandler` forwards rejected controller promises. Authentication middleware forwards its own errors. The global handler returns the supplied status/code/message/details only for `AppError`; unexpected failures are logged by code only and become `500 INTERNAL_ERROR` without stack trace, SQL text, or original message. Not-found responses use `404 ROUTE_NOT_FOUND`.

Repositories use PostgreSQL constraints as final race protection. Telegram linking translates unique violations into stable `409 TELEGRAM_IDENTITY_ALREADY_LINKED` or `TELEGRAM_IDENTITY_CONFLICT`; there is not yet a general database-error translation layer.

Actual response envelopes:

```json
{"data":{"status":"ok"}}
```

```json
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","details":[]}}
```

## 22. Current implementation status

| Area | Status | Current reality |
|---|---|---|
| Project foundation | Done | ESM Express app/server, config, Pool, errors, tests |
| Database schema | Done | 82-table current catalog; numeric baseline verified |
| Numeric identifiers (M01R) | Done | 64 identity columns; internal IDs/FKs are `BIGINT`; decimal-string API/JWT contract |
| Telegram OIDC | Done | Login/link/unlink/session/test-message routes and tests |
| Phone/password authentication | Done | Pending registration, salted `scrypt`, active-only login, shared session, audit, tests |
| Account approval | Planned | User status columns only |
| Session refresh/rotation | Planned | Refresh table only |
| Password recovery | Planned | Challenge/SMS tables only |
| Roles and permissions | Planned | Seeded schema, no enforcement |
| Profiles | Partial | Registration creates the initial private profile; profile APIs remain planned |
| Groups | Planned | Schema only |
| Courses/access | Planned | Schema/DB constraints only |
| Question bank | Planned | Schema/DB guards only |
| Test engine | Planned | Schema/DB constraints only |
| Progress | Planned | Schema only |
| Notifications | Partial | Telegram connection/test only |
| AI | Planned | Schema only |
| Bonuses | Planned | Schema/append-only guard only |
| Deployment | Planned | No deployment configuration |
| Disposable rollback test | Done | Separate generated test database passed up/no-op/down-one/up and was dropped |

## 23. Known gaps, risks, and documentation consistency

Confirmed implementation gaps are the unselected SMS provider, absent approval APIs, absent refresh/logout flows, absent RBAC/resource checks, schema-only product domains, and no deployment/worker infrastructure.

Documentation was normalized on 25 October 2026:

1. Root `documentation.md` is the canonical broad specification referenced by `AGENTS.md` and `CLAUDE.md`.
2. Root `schema_tables.md` is the authoritative schema contract; the executable baseline lives in migrations.
3. SQL/DBML/import documents mentioned for possible future work are explicitly planned and are not represented as existing files.
4. `src/jobs/`, `src/prompts/`, and `src/uploads/` are approved future locations, not required empty directories.
5. The obsolete mojibake document with superseded service-SQL rules was removed after confirming that current documents preserve all active requirements.
6. `docs/api.md`, `docs/decisions.md`, `docs/progress.md`, and implemented Telegram code agree on current behavior and status.

No unresolved contradiction affecting the current implementation was found. Product decisions listed here remain intentionally open rather than contradictory.

## 24. Recommended next increment

### M02B — Phone and password registration/login

Implemented on 25 October 2026. The two routes, transactional registration, `scrypt` password handling, active-only login, shared session issuance, audit events, and focused/regression tests are complete. SMS/OTP, approval, refresh/logout, recovery, and general authorization remain excluded.

Scope:

- normalize and validate an E.164 phone number;
- register with phone, password, first name, and last name;
- atomically create `users`, `user_profiles`, `user_phones`, and `user_passwords`;
- assign the `student` role and create the account with status `pending`;
- securely hash the password;
- log in with phone/password only when the account is `active`;
- reject pending, blocked, and rejected accounts with stable safe errors;
- reuse the existing `auth_sessions` and access-token mechanism;
- create safe audit events;
- prevent duplicate phones, including concurrent registration;
- use generic authentication errors that do not reveal unnecessary account details.

Implemented M02B routes:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login/password`

Tables involved: `users`, `user_profiles`, `user_phones`, `user_passwords`, `roles`, `user_roles`, `auth_sessions`, and `audit_events`.

Implementation repositories: `user-repository.js` owns user/profile/phone/password/role persistence, while the existing auth repository retains session and audit ownership.

Implementation services: password registration/login and shared session issuance reused by Telegram login.

Verified tests cover phone normalization, invalid E.164, weak/invalid password, duplicate phone, concurrent duplicate registration, password hashing, successful registration, transaction rollback, pending/blocked/rejected login rejection, incorrect password, active-account login, session creation, safe errors, and proof that hashes never appear in responses.

Explicit M02B exclusions: SMS, OTP, password recovery, Telegram recovery, administrator approval endpoints, refresh rotation, logout/session listing, device management, RBAC, rate limiting implementation, CSRF implementation, and all learning domains.

### M02C — Account approval

This is the next implementation milestone: list pending accounts, approve/reject, block/unblock, audit administrator decisions, and revoke sessions when an active account is blocked. It requires a narrowly scoped authenticated administrator guard; general RBAC remains M02F.

### M02D — Session lifecycle

Planned separately: refresh-token creation/rotation and reuse detection, logout, logout all devices, session listing/revocation, device metadata, and last-used tracking.

### M02E — Password recovery

Planned separately: recovery through a linked Telegram identity; an SMS provider adapter after provider selection; OTP expiry, cooldown, attempts, and one-time lifecycle; password reset; and old-session revocation. SMS is not a dependency of M02B.

### M02F — Authorization and protection

Planned separately: RBAC, action permissions, resource authorization, rate limiting, brute-force protection, CSRF strategy, and security hardening.

M02B documentation is recorded in `docs/api.md`, `docs/decisions.md`, `docs/progress.md`, the roadmap, handoff, and this file. Unrelated schema refactors and later milestones remain excluded.

## 25. Major domain dependencies

```mermaid
flowchart LR
    Identity[Users / identities / sessions] --> Roles[Roles and authorization]
    Identity --> Profiles[Profiles and phones]
    Identity --> Groups
    Identity --> Access[Course and module grants]
    Taxonomy --> Courses
    Taxonomy --> Questions
    Assets --> Courses
    Assets --> Questions
    Groups --> Assignments[Test assignments]
    Courses --> Access
    Courses --> Lessons
    Questions --> Tests
    Tests --> Attempts
    Access --> Lessons
    Access --> Attempts
    Attempts --> Progress[Progress and analytics]
    Identity --> Notifications
    Identity --> AI
    Attempts --> AI
    Identity --> Bonuses
    Bonuses --> AI
    Notifications --> Jobs[Background jobs]
    AI --> Jobs
```

Detailed column-level schema remains in `../schema_tables.md`; implemented endpoint contracts remain in `api.md`; accepted decisions remain in `decisions.md`; execution history remains in `progress.md`.
