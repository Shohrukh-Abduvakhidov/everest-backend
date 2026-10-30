---
project: EVEREST Backend
current_milestone: M08
status: awaiting_review
branch: feat/m08-taxonomy-question-bank
base_commit: 0bf88ae
updated_at: 2026-10-30
---

# Current handoff

## State

- M07-B is merged (PR #19).
- M08 (taxonomy and question bank) is implemented and verified on `feat/m08-taxonomy-question-bank`. The PR is open for review and must not be merged by the agent.
- The next milestone after the merge is **M07-C (learner catalog enrichment)**. It is approved by the user and described in `ROADMAP.md`:
   - `subjects.color` palette keys `green|blue|orange|purple|neutral` (CHECK, default `neutral`);
   - `subject { id, title, translations, color }` in `GET /courses` and the course card;
   - `moduleCount` and `lessonCount` counting published, learner-visible items only;
   - no `testCount` until M10, and no slugs.
   - Use a separate branch and PR.

## Completed work (M08)

- **First commit:** `.claude/settings.json` was added to `.gitignore`. Do not commit that file.
- **Migration:** `20261031010000000_add-question-bank-permissions.js` (23rd). It adds five permissions and the `question_answer_keys_verified_source_check` CHECK, and no tables.
- **New code:**
   - `repositories/taxonomy-repository.js`, `repositories/question-bank-repository.js`
   - `services/taxonomy-service.js`, `services/question-bank-service.js`
   - `controllers/taxonomy-controller.js`, `controllers/question-bank-controller.js`
   - `middleware/question-admin-middleware.js`, `utils/question-content.js`
   - Routes in `routes/admin.js`.
- **Tests:** `tests/unit/question-content.test.js` and `tests/integration/question-bank.test.js`, both registered in `tests/all.test.js`. The integration cleanup disables the question triggers inside one transaction, as test-only maintenance SQL, because published questions are immutable.
- **Updated:** `verify-database.js` (23 migrations, 29 permissions, 67 role grants, 9 teacher grants), `test-migration-cycle.js` (23/23/22/23), `docs/api.md`, `docs/decisions.md`, `docs/architecture.md`, `docs/progress.md` and `ROADMAP.md`.

## Decisions to review

All 12 are in `docs/decisions.md` under "Taxonomy and question bank (M08)". The ones most worth a look:

- Teachers can create banks and author questions. Only owner/admin can verify keys, publish and archive.
- Admins may verify their own keys; there is no four-eyes rule.
- Read-only staff (shared bank) never see answer data.
- Any edit of a draft returns a verified key to `proposed`. Removing a referenced item resets the key to `unknown`.
- Archive is one-way; corrections go through copy.
- Question images must be ready PNG/JPEG assets the author uploaded. Bank-bound uploads are deferred to M09.

## Verification (2026-10-30)

- Baseline on `main` (`0bf88ae`): `migrate:up` was a no-op. `npm test`: 174 tests, 173 passed, 1 skipped.
- `npm run migrate:up` applied the migration. `verify-database.js` reported `valid: true`.
- `npm test`: 189 tests, 188 passed, 0 failed, 1 skipped (real storage). Source integrity, schema integrity and the server lifecycle check passed.
- `npm run test:migrations`: 23/23/22/23. The disposable database was dropped. No rollback ran against `everest_db`.
- After the integration test, `everest_db` has no leftover questions, banks or subjects, and every question trigger is enabled.

## Still pending from M07-A/M07-B (external)

- Real MinIO/S3 round trip, a 3 GB interrupted/resumed upload, and Range seeking of a real faststart MP4. All need Docker Desktop or the MinIO binary; see `docs/architecture.md` §13a.
- Add the `S3_*`, `STORAGE_*` and `PLAYBACK_RATE_LIMIT` variables to `.env.example` by hand. M08 adds no environment variables.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 23 published migrations. Never merge, force-push, or push to `main`.
- `question_answer_keys` is the only source of correctness; no `is_correct`. Imports stay draft.

## Safe startup commands

```powershell
git checkout main; git pull
git status --short
git log -5 --oneline
npm run migrate:up
npm test
```
