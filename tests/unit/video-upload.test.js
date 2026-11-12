import assert from 'node:assert/strict'
import test from 'node:test'

import env from '../../src/configs/env.js'
import { choosePartSize, initiateAssetUploadService } from '../../src/services/asset-upload-service.js'

const mib = 1024 * 1024
const gib = 1024 * mib

test('part size: 32 MiB default, raised so that there are at most 10,000 parts', () => {
   assert.deepEqual(choosePartSize(4 * gib, 32 * mib), { partSizeBytes: 32 * mib, partCount: 128 })
   assert.deepEqual(choosePartSize(1, 32 * mib), { partSizeBytes: 32 * mib, partCount: 1 })
   const huge = choosePartSize(500 * gib, 32 * mib)
   assert.ok(huge.partCount <= 10000)
   assert.ok(huge.partSizeBytes >= 5 * mib && huge.partSizeBytes % mib === 0)
   assert.ok(choosePartSize(10 * mib, 5 * mib).partSizeBytes >= 5 * mib)
})

// Repository and storage doubles: the checks run before any storage call.
function fakeDeps({ open = 0, used = 0, lesson = { lesson_type: 'video' }, canUpload = true } = {}) {
   const storageCalls = []
   return {
      storageCalls,
      overrides: {
         authorization: { hasPermission: async () => canUpload },
         repository: {
            isCourseLessonManager: async () => false,
            findCourse: async () => ({ id: '1', status: 'draft' }),
            findLesson: async () => lesson,
            countOpenVideoUploads: async () => open,
            sumVideoLibraryBytes: async () => used,
         },
         storage: { createMultipartUpload: async () => { storageCalls.push('create'); throw new Error('stop') } },
         config: { ...env.storage, videoMaxBytes: 4 * gib, videoTotalQuotaBytes: 15 * gib, maxActiveVideoUploads: 3 },
      },
   }
}

const body = (extra = {}) => ({
   courseId: '1', lessonId: '2', kind: 'video', fileName: 'a.mp4', mimeType: 'video/mp4', sizeBytes: gib, ...extra,
})

test('video limits are refused before storage is touched', async () => {
   const cases = [
      [fakeDeps(), body({ sizeBytes: 4 * gib + 1 }), 'VIDEO_TOO_LARGE', 413],
      [fakeDeps({ open: 3 }), body(), 'VIDEO_UPLOAD_LIMIT_REACHED', 409],
      [fakeDeps({ used: 14.5 * gib }), body(), 'VIDEO_QUOTA_EXCEEDED', 409],
      [fakeDeps({ lesson: null }), body(), 'LESSON_NOT_FOUND', 404],
      [fakeDeps({ lesson: { lesson_type: 'test' } }), body(), 'VALIDATION_ERROR', 400],
      [fakeDeps({ canUpload: false }), body(), 'ACTION_FORBIDDEN', 403],
      [fakeDeps(), body({ fileName: 'a.webm' }), 'VALIDATION_ERROR', 400],
      [fakeDeps(), body({ kind: 'material', fileName: 'a.pdf', mimeType: 'application/pdf' }), 'VALIDATION_ERROR', 400],
   ]
   for (const [deps, request, code, status] of cases) {
      const error = await initiateAssetUploadService('5', request, deps.overrides).catch((caught) => caught)
      assert.deepEqual([error.code, error.status], [code, status], JSON.stringify(request))
      assert.deepEqual(deps.storageCalls, [])
   }
})

test('within the limits the storage upload is created', async () => {
   const deps = fakeDeps({ open: 2, used: 14 * gib })
   await assert.rejects(initiateAssetUploadService('5', body(), deps.overrides), /stop/)
   assert.deepEqual(deps.storageCalls, ['create'])
})
