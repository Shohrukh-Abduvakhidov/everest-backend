# EVEREST backend progress

Updated: 2026-10-29.

## Current increment

Milestone M06 (course enrollments and module access grants) is implemented on `feat/m06-course-access`. M07 lessons and protected assets is next. Production SMS remains unavailable pending provider approval.

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
