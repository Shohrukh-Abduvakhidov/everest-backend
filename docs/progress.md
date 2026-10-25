# EVEREST backend progress

Updated: 2026-10-25.

## Current increment

Milestone M02E: secure password recovery. Implementation and verification are complete on `feat/m02e-password-recovery`; M02F authorization and authentication protection is next. Production SMS remains unavailable pending provider approval.

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

M02C: implement account approval state management with a narrowly scoped authenticated administrator guard: list pending accounts; approve, reject, block, and unblock; audit decisions; and atomically revoke sessions when blocking. General RBAC remains M02F. SMS/OTP, refresh/logout/session management, password recovery, learning domains, and unrelated refactors remain excluded.
