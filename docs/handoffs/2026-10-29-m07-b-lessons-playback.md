---
project: EVEREST Backend
current_milestone: M07-B
status: in_progress
branch: feat/m07-b-lessons-playback
base_commit: 68e4fab
updated_at: 2026-10-29
---

# Current handoff

## Pending (blocks marking M07-A and M07-B Done)

- **Real MinIO/S3 verification pending:** install Docker Desktop (or the MinIO Windows binary), run `docker-compose up`, and run the optional real-storage test, including a 3 GB upload with a network interruption and resume.
   1. In `.env`, set `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000`, `S3_BUCKET=everest-media` and the compose credentials (`everest-local`/`everest-local-secret`).
   2. Run `docker compose up -d`, or alternatively `npm run storage:configure`.
   3. Run `npm test`. `real S3-compatible storage round trip` must pass, not be skipped.
   4. Run a manual 3 GB upload with a network interruption, then resume through `GET /assets/uploads/:id`, presign the missing parts, and complete.
- **Verify Range seeking of a real faststart mp4 through a signed URL against real storage.**
   - Upload a real fast-start MP4 and attach it to a published lesson. Request `GET /api/v1/courses/:courseId/lessons/:lessonId/playback` as an entitled student.
   - Check that `curl -r 1000000-1999999 "<url>"` returns `206` with the right `Content-Range`, `Content-Type: video/mp4` and inline disposition. Then seek with a browser `<video>` element and click a chapter.
- If the pinned `minio/minio:RELEASE.2025-09-07T16-13-09Z` image cannot be pulled, set `MINIO_IMAGE` to a pinned community rebuild.
- Add the `S3_*`, `STORAGE_*` and `PLAYBACK_RATE_LIMIT` variables to `.env.example` by hand. Env files are denied to this agent. The list is in `docs/architecture.md` §13a.

## Completed work (M07-B, branch `feat/m07-b-lessons-playback`)

- **Seek-ready video policy** (supersedes the M07-A remux decision):
   - MP4 must be fast start and WebM must have Cues before clusters; QuickTime is refused. Anything else gets `422 VIDEO_NOT_SEEKABLE` and the object is deleted.
   - No remux jobs; `background-job-repository` was removed.
   - Videos are stored with `processing_status = 'not_required'`, and playback requires `ready` plus `not_required`.
   - `scripts/remux-faststart.js` (`npm run video:faststart`) wraps a local ffmpeg for staff.
- **Migration** `src/migrations/20261030020000000_add-lesson-playback.js` (22nd): `lesson_video_chapters`, the offline license columns, `not_required`, and the `lessons.read`, `lessons.manage` and `lessons.offline.manage` permissions.
- **New code:**
   - Repositories: `lesson-repository.js`, `learner-lesson-repository.js`, `offline-license-repository.js`.
   - Services: `lesson-service.js`, `learner-lesson-service.js`, `offline-license-service.js`.
   - Controllers: `lesson-controller.js`, `learner-lesson-controller.js`, `offline-license-controller.js`.
   - Routes: `routes/offline-licenses.js`.
   - Test: `tests/integration/lessons.test.js`.
- **Changed code:**
   - `media-inspection.js`, `asset-upload-service.js`, `s3-storage-provider.js` (disposition), `course-module-service.js` (lesson copy steps).
   - `routes/admin.js`, `routes/courses.js`, `routes/index.js`, `course-admin-middleware.js`, `auth-protection-middleware.js` (`learnerMediaRateMiddleware`), `env.js` (`PLAYBACK_RATE_LIMIT`).
   - Tests and helpers, `verify-database.js`, `test-migration-cycle.js`, `package.json`, and the docs.
- The archive copy is `docs/handoffs/2026-10-29-m07-b-lessons-playback.md`.

## Decisions to review

All are in `docs/decisions.md` under "Lessons, playback and offline licenses (M07-B)": 20 assumptions made without the user. The ones most worth a look:

- Lessons can be edited only as drafts (archive → restore → edit → publish).
- `test` lessons cannot be published until M10.
- Notes and progress reads also require current module access; rows are kept.
- Lessons without a video are completed with `{ completed: true }`.
- An offline license covers only the lesson video. Licenses are managed only from their own session; signing a session out frees its device slot.
- A license revoked by an administrator cannot be renewed from the same session.
- Video assets uploaded under M07-A keep `processing_status = 'none'`, so they are not playable. Re-upload them.

## Verification (2026-10-29)

- Baseline on `main` (`68e4fab`): `migrate:up` was a no-op; 156 tests, 155 passed, 1 skipped.
- `npm run migrate:up` applied the migration. `verify-database.js` reported `valid: true`.
- `npm test`: 173 tests, 172 passed, 0 failed, 1 skipped (real storage). Source integrity, schema integrity and the server lifecycle check passed.
- `npm run test:migrations`: 22/22/21/22; the disposable database was dropped. No rollback ran against `everest_db`.
- Not verified:
   - any real S3/MinIO call, Range seeking, or browser playback;
   - ffmpeg remux with a real file (ffmpeg is not installed; only the missing-ffmpeg path was exercised).

## Next concrete task

1. Close the two real-storage pending items above.
2. Then continue with M08 (taxonomy and question bank), or resolve the review items above first.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- No HLS, multi-quality video, `asset_variants`, workers, or `group_courses`.
- Do not edit the 22 published migrations. Never merge, force-push, or push to `main`.

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
