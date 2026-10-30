---
project: EVEREST Backend
current_milestone: M07-C
status: awaiting_review
branch: feat/m07-c-learner-catalog
base_commit: 27563b3
updated_at: 2026-10-30
---

# Current handoff

## State

- M08 is merged (PR #20).
- M07-C (learner catalog enrichment plus `telegramLinked`) is implemented and verified on `feat/m07-c-learner-catalog`. The PR is open for review and must not be merged by the agent.
- Next ROADMAP milestone: **M09 (indexed book import)**.
   - It depends on "approved input formats" for the Tajik, mathematics and biology books.
   - Before starting, ask the user for sample files or a format spec. Do not invent one.
   - Alternatively, ask which milestone to take instead.

## Completed work (M07-C)

- **Migration** `20261031020000000_add-subject-color.js` (24th): `subjects.color VARCHAR(16) NOT NULL DEFAULT 'neutral'` plus CHECK `subjects_color_check` (`green|blue|orange|purple|neutral`).
- **Subject API:** the M08 subject API accepts and returns `color` (`taxonomy-repository.js`, `taxonomy-service.js`).
- **Learner catalog:** `course-access-repository.js` (`learnerCardColumns`) and `learner-course-service.js` (`safeCardMetadata`) add `subject { id, title, translations, color }|null`, `moduleCount` and `lessonCount`. They appear in `GET /courses` and in the `course` block of `GET /courses/:courseId/modules`.
- **Profile:** `profile-repository.js` and `profile-service.js` add `telegramLinked` to `GET /profile` and `PATCH` responses.
- **Test:** `tests/integration/learner-catalog.test.js` (3 subtests), registered in `tests/all.test.js`.
- **Updated:** `verify-database.js` (24 migrations, 698 columns), `test-migration-cycle.js` (24/24/23/24), and the docs.

## Decisions to review

All are in `docs/decisions.md` under "Learner catalog enrichment (M07-C)":

- Counts include published lessons of non-granted (locked) published modules.
- `subject: null` is returned for courses without a subject.
- The favorites list is unchanged.

## Verification (2026-10-30)

- Baseline on `main` (`27563b3`): `migrate:up` was a no-op.
- `npm run migrate:up` applied the migration. `verify-database.js` reported `valid: true`.
- `npm test`: 193 tests, 192 passed, 0 failed, 1 skipped (real storage).
- `npm run test:migrations`: 24/24/23/24. The disposable database was dropped.

## Still pending from M07-A/M07-B (external)

- Real MinIO/S3 round trip, a 3 GB resumable upload, and Range seeking of a real faststart MP4. All need Docker Desktop or the MinIO binary.
- Add the `S3_*`, `STORAGE_*` and `PLAYBACK_RATE_LIMIT` variables to `.env.example` by hand. M07-C adds no variables.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 24 published migrations. Never merge, force-push, or push to `main`.
- Do not commit `.claude/settings.json`; it is ignored.
