---
project: EVEREST Backend
current_milestone: M17 (admin accounts slice)
status: awaiting_review
branch: feat/admin-accounts-api
base_commit: c9b1085
updated_at: 2026-10-31
---

# Current handoff

## State

- M09 (PR #24) is merged.
- The M17 admin-accounts slice is implemented on `feat/admin-accounts-api`. The PR is open for review and must not be merged by the agent.

## Completed work

- **`GET /api/v1/admin/users`:**
   - filters: `status`, `role`, `q` (2–100 characters; names, full name or any phone; LIKE wildcards literal), `sort` (`-createdAt` default, `createdAt`), `limit`/`offset`;
   - items: `id, firstName, lastName, displayName, phone, status, roles, createdAt, lastLoginAt, telegramLinked`;
   - `pagination.total`.
- **`GET /api/v1/admin/users/pending`:** additive `pagination.total`.
- **`PUT /api/v1/admin/users/:userId/roles`:** `{ roles }`.
   - Owners manage every role. Admins manage teacher/student of non-privileged accounts.
   - No self-change; `student` is mandatory; the last active owner is protected.
   - Unchanged sets are idempotent.
   - Audited, and the subject's sessions are revoked (`roles_changed`).
- **Status transitions:** block/reject/unblock on an owner need an owner actor (`OWNER_ACTION_FORBIDDEN`); block/reject never remove the last active owner (`LAST_OWNER_PROTECTED`).
- **Concurrency:** role changes, owner status changes and owner bootstrap share one advisory lock.
- **Docs:** `api.md`, `decisions.md` (M17 assumptions 1–9), `progress.md`, `ROADMAP.md`, and the OpenAPI spec (`AdminAccount`, `RoleChange`, `Pagination.total`).

## Verification (2026-10-31)

- `npm test` (disposable database): 228 tests, 227 passed, 0 failed, 1 skipped (real storage).
- `npm run test:migrations`: 25/25/24/25. No migration was added.
- `node scripts/verify-database.js`: valid.

## Next concrete tasks

1. The frontend (PR #7) consumes `GET /admin/users` and `PUT /admin/users/:userId/roles`.
2. Optional: seed a dedicated `accounts.roles.manage` permission if role management should differ from `accounts.approve`.
3. Real S3/MinIO verification and the first real book import (M09 runbook).

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 25 applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database; never delete data in `everest_db`.
