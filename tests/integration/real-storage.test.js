import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import env from '../../src/configs/env.js'
import { isStorageConfigured } from '../../src/providers/storage/index.js'
import { createS3StorageProvider } from '../../src/providers/storage/s3-storage-provider.js'

// Optional live check against a real S3-compatible server (local MinIO from
// docker-compose.yml, or Garage/SeaweedFS). Skipped when S3_* is unset or unreachable.

async function reachable(endpoint) {
   try {
      await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
      return true
   } catch {
      return false
   }
}

const skipReason = !isStorageConfigured()
   ? 'S3_* storage variables are not configured'
   : !await reachable(env.storage.endpoint)
      ? `storage endpoint ${env.storage.endpoint} is unreachable`
      : false

test('real S3-compatible storage round trip', { skip: skipReason }, async () => {
   const storage = createS3StorageProvider(env.storage)
   const key = `integration-tests/${randomUUID()}.bin`
   const partSize = 5 * 1024 * 1024
   const body = Buffer.alloc(partSize + 1024)
   for (let index = 0; index < body.length; index += 1) body[index] = index % 251
   const { uploadId } = await storage.createMultipartUpload({ key, contentType: 'application/octet-stream' })
   try {
      for (const [partNumber, chunk] of [[2, body.subarray(partSize)], [1, body.subarray(0, partSize)]]) {
         const url = await storage.presignUploadPart({ key, uploadId, partNumber, expiresIn: 300 })
         const put = await fetch(url, { method: 'PUT', body: chunk })
         assert.equal(put.status, 200, await put.text())
         assert.ok(put.headers.get('etag'), 'CORS/ETag header must be readable')
      }
      const parts = await storage.listParts({ key, uploadId })
      assert.deepEqual(parts.map((part) => part.size), [partSize, 1024])
      await storage.completeMultipartUpload({ key, uploadId, parts })
      assert.equal(await storage.listParts({ key, uploadId }), null)
      assert.equal((await storage.headObject(key)).size, body.length)
      assert.deepEqual(await storage.readRange(key, 10, 19), body.subarray(10, 20))
      const url = await storage.presignDownload({ key, expiresIn: 60, contentType: 'application/octet-stream' })
      const ranged = await fetch(url, { headers: { range: 'bytes=0-99' } })
      assert.equal(ranged.status, 206)
      assert.equal((await ranged.arrayBuffer()).byteLength, 100)
   } finally {
      await storage.abortMultipartUpload({ key, uploadId })
      await storage.deleteObject(key).catch(() => {})
   }
})
