---
project: EVEREST Backend
current_milestone: M08/M11 follow-up (question image URLs)
status: awaiting_review
branch: feat/question-image-urls
base_commit: d9c0a69
updated_at: 2026-11-08
---

# Current handoff

## Done

- Image blocks in question responses carry `url` and `expiresAt` (presigned, 5 minutes) when the asset is ready, PNG/JPEG and linked to the same question: `{ "type": "image", "assetId", "alt", "url", "expiresAt" }`. Both fields are absent when no link can be issued.
- Admin: every question detail response (get, create, PATCH, copy, answer key, verify, publish, archive), covering the stem, options, matching items and the key explanation.
- Learner: start, get attempt, submit, result (stem, options, matching and the revealed explanation), only for the learner's own attempt.
- One repository query per response (`listQuestionImageAssets`). Storage missing or failing leaves blocks without URLs, and the request succeeds.
- Nothing is stored. The input parser accepts and drops `url`/`expiresAt` on image blocks.
- Docs: api (Question bank APIs, rich content), OpenAPI `ImageBlock`, decisions, architecture, progress, ROADMAP.

## Verification (2026-11-08)

- `npm test` on a fresh migrated disposable database: exit 0; 376 tests, 376 passed, 0 failed, 0 skipped.
- New: `tests/integration/question-image-urls.test.js` (4 subtests).
- `everest_db` was not touched.

## Not verified

- Real MinIO/S3 signing for question images and the `S3_PUBLIC_ENDPOINT` host (tests use the memory storage provider; the provider code is the one used for lessons).
- Bank question lists (`GET /admin/question-banks/:bankId/questions`) and the staff attempt view do not sign images yet.

## Next concrete task

1. Review and merge `feat/question-image-urls`.
2. Locally with MinIO: open an imported Tajik question with an image in the admin and in an attempt, and check that the URL loads.
3. Decide whether bank lists and the staff attempt view need URLs.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/` (book content, key PDF, key JSON, reports).
