---
project: EVEREST Backend
current_milestone: M02C
status: ready
branch: feat/m02b-phone-password-auth
last_verified_commit: ecbaa18
updated_at: 2026-10-25
---

# Current handoff

## Completed work

- M00 project foundation, M01 database foundation, M02A Telegram OIDC, and M02B phone/password registration and login are complete.
- M02B adds pending-student registration, normalized E.164 phones, salted asynchronous `scrypt` hashing, active-only login, shared session issuance, safe audit events, and focused integration coverage.
- No migration or dependency was needed; the existing schema and Node.js crypto runtime satisfy the increment.

## Current repository state

- Working branch for the completed increment: `feat/m02b-phone-password-auth`.
- Verified base commit: `ecbaa18` (merged roadmap workflow).
- M02B implementation and documentation are verified in the branch worktree represented by this handoff; inspect the branch tip, status, and diff because this record can become stale.
- Implemented HTTP surface now includes health/readiness, phone/password registration/login, and five Telegram authentication/linking routes.
- Most learning/product domains remain schema-only.

## Current milestone

M02C — account approval — is Planned and ready for design/implementation after the M02B pull request is reviewed and merged.

## Next concrete task

Define and implement the narrowly scoped administrator guard and account-state API for listing pending users, approving, rejecting, blocking, and unblocking. Lock the target account for transitions, audit the administrator decision atomically, and revoke live sessions when blocking. Keep generalized RBAC in M02F.

## Required reading order

1. Root `AGENTS.md` and `CLAUDE.md`.
2. [Roadmap](../../ROADMAP.md).
3. This handoff and the [M02B archive](archive/2026-10-25-m02b.md).
4. [Current architecture](../architecture.md), especially authentication, sessions, authorization, and section 24.
5. [Progress](../progress.md) and [decisions](../decisions.md).
6. [Implemented API](../api.md).
7. Root `documentation.md` and affected authentication/role portions of `schema_tables.md`.
8. Actual auth routes, controllers, services, repositories, tests, and applied migrations.

## Test status

- Password/input unit tests: 3 passed.
- Password-auth PostgreSQL integration: 8 subtests passed (9 reported tests including the parent).
- Full `npm test`: passed 22 reported auth tests plus migration-source verification, eight schema-integrity cases, and server lifecycle checks.
- Telegram provider calls remain mocked; password integration used real local PostgreSQL and removed its fixtures.

## Migration status

- Thirteen migrations remain applied: twelve immutable baseline migrations and the Telegram OIDC-state migration.
- M02B changed no migration and added no table or column.
- Post-M02B `npm run migrate:up` passed as a no-op and catalog verification passed. Repeat the safe up check before M02C; never run destructive rollback tests against `everest_db`.

## Known blockers

- Disposable migration down/up testing remains Blocked because the configured role lacks `CREATEDB` and no separately provisioned safe database is available.
- SMS provider/limits and later product rules remain unresolved but do not block M02C.

## Important constraints

- Preserve route → middleware → controller → service → repository → `pg`.
- M02C endpoints require an authenticated administrator check; never trust a client-supplied actor or role.
- Services own state-transition rules and transaction scope; repositories own SQL and row locks.
- Use one transaction/client for account transition, audit, and session revocation.
- Preserve applied migrations and existing data. Add an incremental migration only for a verified schema gap.
- Never expose password hashes, JWTs, database details, secrets, or `.env` values.

## Files expected to change in M02C

- Auth/admin route and controller wiring under `src/routes/` and `src/controllers/`.
- Account-approval and narrowly scoped authorization services under `src/services/`.
- User/role/session/audit repository methods under `src/repositories/`, reusing existing table ownership.
- Focused unit and PostgreSQL integration tests.
- API, decisions when required, architecture, progress, roadmap, and this handoff.
- A new migration only if inspection proves the existing schema insufficient; never edit applied migrations.

## Explicit exclusions

Generalized RBAC, refresh rotation, logout/session-management APIs, password recovery, SMS/OTP, rate limiting, CSRF implementation, learning domains, and unrelated refactors remain outside M02C.

## Commands before coding

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
Get-Content docs/architecture.md
Get-Content docs/progress.md
Get-Content docs/decisions.md
rg -n "status|approved_by|blocked_by|user_roles|auth_sessions|audit_events" src tests
npm test
npm run migrate:up
node scripts/verify-database.js
```

Confirm the configured database is the intended local development target. Do not print `.env` or run `migrate:down` against `everest_db`.

## Archive policy

Replace this file as work advances. Archive only milestone completion, a significant architecture change, or a Codex/Claude transfer—not every chat.
