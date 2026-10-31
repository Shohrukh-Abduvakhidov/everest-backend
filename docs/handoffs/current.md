---
project: EVEREST Backend
current_milestone: M04-B follow-up (group API improvements)
status: awaiting_review
branch: feat/groups-api-improvements
base_commit: 625d34f
updated_at: 2026-10-31
---

# Current handoff

## State

- PR #27 (owner-role grant restriction) is merged into `main`.
- Group API improvements are implemented on `feat/groups-api-improvements`. The PR is open for review and must not be merged by the agent.

## Completed work

- `POST /admin/groups`: `code` optional, generated from the name (`<slug>-<6 hex>`, ≤ 80 chars) with collision retry inside the transaction; explicit duplicates return `409 GROUP_CODE_CONFLICT`.
- `GET /groups`: `status`, `q` (2–100, case-insensitive, literal wildcards), unknown params rejected, `pagination.total`.
- `PATCH /admin/groups/:groupId/members/:userId` `{ isRepresentative }` and `PATCH /admin/groups/:groupId/teachers/:userId` `{ canPublishAnnouncements?, canAssignTests?, canViewResults? }`; audited; list-item shapes.
- `GET /admin/users`: `notInGroup`, `notTeacherOfGroup`.
- `POST`/`PATCH /admin/groups` return `memberCount`/`teacherCount`.
- `409 GROUP_ARCHIVED` for member/teacher add/edit/remove and new announcements in archived groups.
- `GET /groups/:groupId/announcements?status=` for owner/admin and publishing teachers.
- Docs: OpenAPI, `api.md`, `frontend-handoff.md`, `decisions.md`, `progress.md`, `ROADMAP.md`.

## Verification (2026-10-31)

- `npm test` (disposable database): 238 passed, 0 failed (includes `tests/integration/group-improvements.test.js`, 11 subtests, and the OpenAPI route test).
- No migration was added, so `migrate:up` / `test:migrations` were not rerun.

## Decisions needed

1. `GROUP_ARCHIVED` semantics (implemented as proposed, also covers the two new PATCH edits).
2. Announcement `status` filter for non-staff returns published-only results (empty list for draft/archived) rather than 403; "staff" includes only teachers with `can_publish_announcements`.

## Next concrete tasks

1. Review and merge the group improvements PR.
2. Frontend consumes the new group endpoints and candidate filters.
3. Real S3/MinIO verification and the first real book import (M09 runbook).

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 25 applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database; never delete data in `everest_db`.
