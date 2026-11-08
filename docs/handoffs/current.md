---
project: EVEREST Backend
current_milestone: M08/M09 follow-up (bulk publish dry run fix)
status: awaiting_review
branch: fix/publish-dry-run
base_commit: c064a51
updated_at: 2026-11-08
---

# Current handoff

## Done

- `npm run publish:questions -- --dry-run` failed with `BULK_FAILED` "Cannot read properties of undefined (reading 'query')" on banks with image questions. Cause: the dry run runs the publication check without a transaction, and `findUsableImageAssets` required a client (since PR #42; unrelated to the image URLs of PR #43).
- Fix: `findUsableImageAssets` defaults to the pool (read-only). Real runs still pass the batch client.
- `verify:keys --dry-run` and `import:answer-keys --dry-run` checked: they only use pool-defaulted reads; covered by the new test.
- Test: new subtest in `tests/integration/question-bulk-review.test.js` (image bank; service and CLI dry runs of all three commands; `ASSET_NOT_READY` reported; nothing written).

## Verification (2026-11-08)

- Without the fix the new subtest fails with the reported error.
- `npm test` on a fresh migrated disposable database: exit 0; 377 tests, 377 passed, 0 failed, 0 skipped.
- `everest_db` was not touched.

## Not verified

- The dry run against the real `nct-tg-2026` bank in `everest_db`.
- From PR #43: real MinIO/S3 signing of question images; bank lists and the staff attempt view do not sign images.

## Next concrete task

1. Review and merge `fix/publish-dry-run`.
2. Re-run `npm run publish:questions -- --bank <code> --actor-phone ... --dry-run` on the real bank.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
