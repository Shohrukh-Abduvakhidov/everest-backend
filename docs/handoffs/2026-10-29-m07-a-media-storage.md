---
project: EVEREST Backend
current_milestone: M07-A
status: in_progress
branch: feat/m07-a-media-storage
base_commit: ec815f1
updated_at: 2026-10-29
---

# Current handoff

## Pending (blocks marking M07-A Done)

- **Real MinIO/S3 verification pending:** install Docker Desktop (or the MinIO Windows binary), run `docker-compose up`, and run the optional real-storage test, including a 3 GB upload with a network interruption and resume.
   1. Set `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000`, `S3_BUCKET=everest-media`, and `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (compose defaults `everest-local`/`everest-local-secret`) in `.env`.
   2. Run `docker compose up -d`. The `minio-init` container creates the bucket. Alternatively, run `npm run storage:configure`.
   3. Run `npm test`. `real S3-compatible storage round trip` must report as passed, not skipped.
   4. Run a manual 3 GB upload through `/api/v1/assets/uploads`. Interrupt the network mid-upload, resume with `GET /uploads/:id` → presign missing parts → complete.
- If the pinned `minio/minio:RELEASE.2025-09-07T16-13-09Z` image cannot be pulled (official images reportedly withdrawn), set `MINIO_IMAGE` to a pinned community rebuild of the same release.
- Add the new `S3_*` and `STORAGE_*` variables to `.env.example` by hand. This session was denied access to env files. The list is in `docs/architecture.md` §13a.

## Completed work (M07-A, branch `feat/m07-a-media-storage`)

- Provider-neutral S3 adapter: `src/providers/storage/s3-storage-provider.js` and `index.js` (lazy, env-only).
- Migration `src/migrations/20261030010000000_add-asset-uploads.js` (21st). It creates `asset_uploads`, adds `assets.kind`, `processing_status` and `processing_error`, and the `assets.upload`/`assets.manage` permissions for owner/admin.
- New files:
   - `src/repositories/asset-upload-repository.js`
   - `src/repositories/background-job-repository.js`
   - `src/services/asset-upload-service.js`
   - `src/controllers/asset-upload-controller.js`
   - `src/routes/assets.js` (mounted at `/api/v1/assets`)
   - `src/utils/media-inspection.js`
- Infrastructure: `docker-compose.yml`, `scripts/configure-storage-bucket.js`, and the `storage:configure` npm script.
- Tests:
   - `tests/unit/media-inspection.test.js`
   - `tests/integration/asset-uploads.test.js` (12 subtests)
   - optional `tests/integration/real-storage.test.js`
   - helpers `tests/helpers/memory-storage-provider.js` and `tests/helpers/media-fixtures.js`
- Changed files: `src/configs/env.js`, `src/routes/index.js`, `package.json` and the lockfile, `tests/all.test.js`, `scripts/verify-database.js`, `scripts/test-migration-cycle.js`, and the docs.
- The archive copy is `docs/handoffs/2026-10-29-m07-a-media-storage.md`.

## Decisions to review

Product and storage decisions, the MinIO maintenance finding, and 16 assumptions made without the user are recorded in `docs/decisions.md` under "Media storage and multipart uploads (M07-A)". The ones most worth a look:

- `courseId` is required on every upload, and archived courses are refused.
- The detected type must equal the declared type.
- Codec allowlist: H.264, HEVC, AV1 and VP9; audio AAC or Opus. WebM allows VP8, VP9 or AV1 with Opus or Vorbis.
- A rejection is final: the object is deleted and the asset is quarantined.
- `mov` files and `mp4` files without faststart are `ready` with `processingStatus: pending` plus a remux job. M07-B must decide whether those play before the remux; the deny-by-default proposal is no.

## Verification (2026-10-29)

- Baseline on `main` (`ec815f1`): `migrate:up` was a no-op; `npm test` passed 130 tests.
- `npm run migrate:up` applied the new migration. `node scripts/verify-database.js` reported `valid: true`.
- `npm test`: 156 tests, 155 passed, 0 failed, 1 skipped (real storage not configured). Source integrity, schema integrity and the server lifecycle check passed.
- `npm run test:migrations`: 21/21/20/21; the disposable database was dropped. No rollback ran against `everest_db`.
- Not verified: any real S3/MinIO call, presigned URL signatures against a live server, CORS/ETag in a browser, bucket configuration, and large or interrupted uploads.

## Next concrete task

1. Close the real-storage pending item above.
2. Then start M07-B: lessons, chapters, materials, notes, playback and offline download via short-lived signed URL (`presignDownload` already exists), offline licences, favourites and progress. Requirements:
   - Every content route calls `requireModuleAccessService`.
   - Course copy steps are extended for lessons.
   - Decide how teachers and admins preview protected content.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- No multi-quality video, HLS, `asset_variants`, or `group_courses`.
- Do not edit the 21 published migrations. Never merge, force-push, or push to `main`.

## Safe startup commands

```powershell
git status --short
git branch --show-current
git log -5 --oneline
Get-Content ROADMAP.md
Get-Content docs/handoffs/current.md
npm run migrate:up
npm test
```
