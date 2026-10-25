---
project: EVEREST Backend
current_milestone: M02B
status: ready
branch: docs/project-roadmap
last_verified_commit:
updated_at: 2026-10-25
---

# Current handoff

## Completed work

- M00 project foundation, M01 database foundation, and M02A Telegram OIDC are complete in code, relevant migrations, tests, and documentation.
- Architecture documents were normalized and committed in `f484a55` (`docs: establish EVEREST backend architecture`).
- The roadmap, session protocols, and reusable handoff skills were added as documentation-only work after that commit. They are not committed at the time of this handoff.

## Current repository state

- Verified branch: `docs/project-roadmap`.
- Last verified commit before this documentation work: `f484a55`.
- Runtime: Node.js 22, Express 5, native ESM, PostgreSQL through `pg`, and `node-pg-migrate`.
- Implemented HTTP surface: health/readiness and five Telegram authentication/linking routes.
- Most product-domain tables exist, but their services and APIs are not implemented.
- Inspect `git status`, the complete diff, and recent commits again because the repository is authoritative and this handoff can become stale.

## Current milestone

M02B — phone and password registration/login — is Planned and ready to begin. Its contract is defined in [ROADMAP.md](../../ROADMAP.md) and the M02B section of [the architecture](../architecture.md).

## Next concrete task

Implement only `POST /api/v1/auth/register` and `POST /api/v1/auth/login/password`: validate E.164/password/name input, atomically create a pending student identity, hash the password, permit active-only password login, reuse session issuance, write safe audits, and test duplicate/concurrent registration and rollback. First inspect existing repository ownership and session-token patterns; do not duplicate table ownership.

## Required reading order

1. Root `AGENTS.md` and `CLAUDE.md`.
2. [Roadmap](../../ROADMAP.md).
3. This handoff.
4. [Current architecture](../architecture.md), especially authentication and M02B.
5. [Progress](../progress.md) and [decisions](../decisions.md).
6. [Implemented API](../api.md).
7. Root `documentation.md` and the affected authentication portions of `schema_tables.md`.
8. `package.json`, lockfile, existing auth routes/controllers/services/repositories, session-token service, tests, and applied migrations.

## Test status

- Last recorded on 2026-10-25: `npm test` passed migration-source verification, schema-integrity checks, Telegram tests, and server lifecycle checks.
- Telegram integration uses real PostgreSQL with mocked provider calls; it does not call live Telegram.
- No application tests were rerun for the roadmap/handoff documentation-only task.
- Run and report M02B-specific tests plus relevant regression tests during implementation; do not infer success from this handoff.

## Migration status

- Thirteen migrations are recorded as applied: twelve baseline migrations and one incremental Telegram OIDC-state migration.
- Repeated `npm run migrate:up` was last recorded as a no-op.
- M02B's required tables already exist; do not edit applied migrations. Add an incremental migration only if verified implementation requirements demand a schema change.
- Never run a destructive rollback test against `everest_db`.

## Known blockers

- Disposable migration down/up testing is Blocked: the configured PostgreSQL role lacks `CREATEDB`, and no separately provisioned safe database is currently available.
- Local live authentication is unavailable until `JWT_ACCESS_SECRET` is configured; do not record its value.
- SMS provider/limits and later product rules remain unresolved, but they do not block M02B because SMS/OTP are excluded.

## Important constraints

- Preserve route → middleware → controller → service → repository → `pg`.
- Services own business rules and transaction scope; repositories own all application SQL.
- Pass the same explicit transaction client to every participating repository method.
- Keep one `users.id` across phone/password/Telegram; never merge on name or unverified phone.
- Use safe DTOs/errors and never expose password hashes, secrets, tokens, SQL, or `.env` values.
- A table existing in PostgreSQL is not evidence that its feature is implemented.
- Keep applied migrations immutable and preserve existing data.

## Files expected to change in M02B

Exact filenames must follow existing ownership and patterns after inspection. Expected areas are:

- `src/routes/auth.js` and the appropriate auth controller(s).
- Registration, password-login, and shared session-issuance services under `src/services/`.
- Table-owning authentication repositories under `src/repositories/`, reusing `auth-repository.js` where appropriate.
- Focused password/phone utilities or middleware only when justified.
- Unit and PostgreSQL integration tests under `tests/`.
- `docs/api.md`, `docs/progress.md`, `docs/architecture.md`, `ROADMAP.md`, and this handoff; `docs/decisions.md` only for accepted decisions.
- A new migration only if a verified schema gap exists; never modify the 13 applied files.

## Explicit exclusions

SMS, OTP, approval endpoints, refresh rotation, logout/session management, password recovery, RBAC, rate limiting, CSRF implementation, learning-domain APIs, deployment, and unrelated refactors are outside M02B.

## Commands before coding

Run these from the repository root, review their output, and confirm the configured database is the intended local development target before database commands:

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
Get-Content docs/architecture.md
Get-Content docs/progress.md
Get-Content docs/decisions.md
rg --files src tests
rg -n "register|password|auth_sessions|user_passwords|user_phones|user_roles" src tests
npm test
npm run migrate:up
node scripts/verify-database.js
```

Do not run `migrate:down` against `everest_db`. Do not print `.env` or credentials.

## Archive policy

Replace this file as work advances. Archive a handoff only when a milestone completes, a significant architecture direction changes, or work transfers between Codex and Claude Code—not after every chat.
