---
project: EVEREST Backend
current_milestone: M-DOCS
status: awaiting_review
branch: feat/m-docs-swagger
base_commit: 78b50f5
updated_at: 2026-10-30
---

# Current handoff

## State

- M07-C is merged (PR #21).
- M-DOCS (OpenAPI 3.1 + Swagger UI) is implemented and verified on `feat/m-docs-swagger`. The PR is open for review and must not be merged by the agent.
- The next ROADMAP milestone is M09 (indexed book import). It needs approved input formats: ask the user for samples or a spec first.

## Completed work (M-DOCS)

- **Spec:** `src/docs/openapi.js`, OpenAPI 3.1 covering 133 operations on 103 paths.
- **Serving:**
   - `src/controllers/docs-controller.js` and `src/routes/docs.js`: page with CSP, `openapi.json`, CSRF-aware initializer, and allowlisted `swagger-ui-dist` assets.
   - `src/app.js` mounts it at `/api/docs` when enabled.
   - `src/configs/env.js` adds `swaggerEnabled` (`SWAGGER_ENABLED`, default `NODE_ENV !== 'production'`).
- **Coverage hook:** `src/routes/index.js` exports `routeMounts`, used by the router and the coverage test.
- **Dependencies (exact pins):** `swagger-ui-dist@5.33.1`, dev `@seriousme/openapi-schema-validator@2.11.0`.
- **Owner bootstrap:** `scripts/bootstrap-owner.js` had a broken import (`accountAdminService` no longer exists). It now uses `bootstrapOwnerService`, guarded by a test. It was not executed against `everest_db`.
- **Docs repair:** the duplicated block at the top of `docs/api.md` (introduced in M07-C by `String.replace` treating `` $` `` specially) is fixed.
- **Test:** `tests/unit/openapi.test.js` (6 tests), registered in `tests/all.test.js`.
- **Docs updated:** `docs/api.md` (Swagger, login, owner/approval walkthrough), `architecture.md` §18a, `decisions.md`, `progress.md`, `ROADMAP.md`.

## Rule for future milestones

Every new route must be added to `src/docs/openapi.js`, otherwise `npm test` fails (two-way coverage).

## Verification (2026-10-30)

- `npm test`: 199 tests, 198 passed, 0 failed, 1 skipped (real storage).
- `npm run test:migrations`: 24/24/23/24. No migration was added.
- Manual check on port 4999: `/api/docs`, `openapi.json` and `swagger-ui.css` returned `200`; the package's `index.html` returned `404`.
- Not verified: a browser click-through of Swagger login, because the local `.env` lacks `JWT_ACCESS_SECRET`/`OTP_HMAC_SECRET`.

## User environment actions (agent cannot edit env files)

- `.env`:
   - add `JWT_ACCESS_SECRET` and `OTP_HMAC_SECRET` (each ≥32 characters, different values);
   - add the Swagger origin (for example `http://localhost:4000`) to `CORS_ORIGINS`;
   - remove the duplicate `CORS_ORIGINS` line;
   - optionally set `SWAGGER_ENABLED`.
- `.env.example`: replace it with the prepared key list and add `SWAGGER_ENABLED=`.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit the 24 published migrations. Never merge, force-push, or push to `main`.
- When editing docs with scripts, do not pass literal text as a `String.replace` replacement (`$` patterns); use the Edit tool or a replacer function.
