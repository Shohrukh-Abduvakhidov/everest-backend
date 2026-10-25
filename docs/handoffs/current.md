---
project: EVEREST Backend
current_milestone: M02E
status: planned
branch: feat/m02d-session-lifecycle
base_commit: 7b84082
updated_at: 2026-10-25
---

# Current handoff

## Completed work

- M00 through M02D are complete in the current feature branch.
- M02D added shared hash-only refresh issuance for password and Telegram login, atomic single-use rotation, session-family replay revocation, and auditable lifecycle changes.
- Implemented refresh, logout, logout-all, owned session listing/revocation, matching HttpOnly cookies, coarse device summaries, and bounded activity updates.
- Blocking an account now explicitly revokes both sessions and their refresh tokens.
- No migration, schema, dependency, or published baseline changed.

## Verification

- Both final `npm run migrate:up` executions were no-ops.
- `npm test` passed migration-source integrity, eight schema-integrity cases, 45 authentication tests, and server lifecycle checks.
- `node scripts/verify-database.js` passed: 82 tables, 650 columns, 157 foreign keys, 293 indexes, 13 migrations, and 64 identity columns.
- Exact baseline digest, JavaScript syntax, SQL-layer, ESM, secret/ignore, Markdown-link, and portable-skill-copy checks passed.
- A disposable rollback cycle was not run because M02D adds no migration and the local role lacks `CREATEDB`; no rollback ran against `everest_db`.

## Current milestone

M02E — password recovery — is Planned and ready for product decisions before implementation.

## Next concrete task

Decide the permitted recovery methods and abuse limits: linked-Telegram proof behavior, SMS provider, OTP expiry, attempt count, resend cooldown, rate limits, and non-enumerating response contract. Then implement reset ownership, single-use challenges, password replacement, and old-session revocation through the existing layered and transactional boundaries.

## Reading order

1. `AGENTS.md` and `.agents/skills/everest-backend/SKILL.md`
2. `ROADMAP.md` and this handoff
3. `docs/architecture.md`, `docs/decisions.md`, `docs/api.md`, and `docs/progress.md`
4. Existing password, Telegram, session lifecycle, challenge, and SMS-delivery schema/code

## Constraints and exclusions

- Numeric IDs remain canonical positive decimal strings at JavaScript/API/JWT boundaries.
- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not select or call an SMS provider without explicit approval; do not leak account existence.
- Keep generalized RBAC, rate limiting, and complete CSRF hardening in M02F unless M02E needs a narrowly approved protection.
- Do not edit the 13 published migrations or run destructive rollback tests against `everest_db`.

## Expected M02E files

- Auth routes/controllers, recovery service, challenge/SMS repositories, provider adapter, focused utilities and tests.
- Incremental migration only if the verified existing schema cannot safely express the accepted recovery design.
- `docs/api.md`, `docs/decisions.md`, `docs/architecture.md`, `docs/progress.md`, `ROADMAP.md`, and this handoff.

## Safe startup commands

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
npm run migrate:up
npm test
node scripts/verify-database.js
```
