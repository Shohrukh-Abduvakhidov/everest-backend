---
project: EVEREST Backend
current_milestone: M09 follow-up (merge duplicate Tajik subjects)
status: awaiting_review
branch: chore/merge-tajik-subjects
base_commit: aa00d8f
updated_at: 2026-11-09
---

# Current handoff

## Done

- Migration `20261109010000000_merge-tajik-subjects`: merges subject `tajik_language` into `zaboni-tochiki` (banks, questions, question topics, sections, topics, courses, missing translations), then deletes `tajik_language`. Found by code, no-op when either is missing; in-migration checks for question count and leftover references; section/topic code conflicts abort. Down is a no-op.
- Importer alias `tajik_language` → `zaboni-tochiki` with warning `SUBJECT_CODE_ALIASED`; runbook "Subject codes".
- Tests: `tests/integration/merge-tajik-subjects.test.js`; migration-cycle count 34.

## Verification (2026-11-09)

- `npm run test:auth` on a disposable database: exit 0; 382 tests, 382 passed, 0 failed.
- `test:migrations`, `test:sources`, `test:integrity`: exit 0.
- Rehearsal on a disposable restore of an `everest_db` dump: 972 published questions, 999 question topics, bank, 7 sections, 5 topics now on 135; 143 deleted; repeated `migrate:up` is a no-op. Rehearsal database dropped.
- `everest_db` was only read and dumped; no migration ran on it.

## Not verified

- `migrate:up` on `everest_db` itself.
- A real (non-dry) import run with the alias; the dry run plan is covered.

## Next concrete task

1. Review and merge `chore/merge-tajik-subjects`.
2. Stop the dev server, run the "before" queries from the PR, `npm run migrate:up` on `everest_db`, then the "after" queries.
3. Decide whether the canonical `tg` title should be "Забони тоҷикӣ" (the dropped duplicate's spelling) instead of "Забони Точики"; that is an admin taxonomy edit, not part of the migration.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
