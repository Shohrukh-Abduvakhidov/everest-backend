---
project: EVEREST Backend
current_milestone: M12 learning progress and analytics (next)
status: awaiting_review
branch: docs/roadmap-sync
base_commit: 233c10b
updated_at: 2026-11-07
---

# Current handoff

## State

- M11 is merged together with its gaps: PR #35 (`3bdeed7`) and PR #36 (`233c10b`).
- `docs/roadmap-sync` (a documentation-only PR) syncs `ROADMAP.md` with `git log origin/main --merges` and the code.

## Roadmap sync, checked against git log and code

- **Merged:** M07-A (#18), M07-B (#19), M-DOCS (#22), M09 (#24), M10 (#31, #33), M11 (#35, #36). Follow-ups were also merged: M04-B (#28), M06 (#29), M17 admin accounts (#25).
- **M07-A and M07-B stay In progress.** Real MinIO/S3 verification is still open.
- **M10 stays In progress although merged.** Parameter-based question selection and course or lesson audiences are listed deliverables and are not built.
- **Teacher-granted extra attempts are not implemented.** There is no code, migration, permission or decision for them. They are recorded as an open M11 line.

## Verification

- Documentation only. No tests were run; no code changed.

## Decisions needed

- Rules for teacher-granted extra attempts:
  - who may grant them;
  - per assignment or per student;
  - whether they count against `maxAttempts`;
  - how they interact with reveal while attempts remain.
- M10: build parameter selection and course or lesson audiences, or drop them from the deliverables.

## Next concrete task

1. Review and merge `docs/roadmap-sync`.
2. Run `migrate:up` on the local `everest_db` (it was on 28 of 30 migrations before M11; PR #36 added none).
3. Start M12: lesson and course progress, test history and homepage summaries. First confirm the metric definitions with the owner, then build on `lesson_progress` and the M11 course `progress`.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` uses the configured database for `test:integrity`; point `DB_NAME` at a disposable database. Never delete data in `everest_db`.
