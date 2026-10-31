import { createHash, randomUUID } from 'node:crypto'

// In-memory double with the same contract as src/providers/storage/s3-storage-provider.js.
// putPart() stands in for the browser PUT to a presigned part URL.
function createMemoryStorageProvider() {
   const uploads = new Map()
   const objects = new Map()
   const calls = []

   function record(name, args) {
      calls.push({ name, ...args })
   }

   return {
      uploads,
      objects,
      calls,
      failNextComplete: false,

      putPart(uploadId, partNumber, buffer) {
         const upload = uploads.get(uploadId)
         if (!upload) throw new Error('NoSuchUpload')
         upload.parts.set(partNumber, {
            buffer,
            etag: `"${createHash('md5').update(buffer).digest('hex')}"`,
         })
      },

      putObject(key, buffer) {
         objects.set(key, buffer)
      },

      async uploadObject({ key, body }) {
         record('uploadObject', { key })
         objects.set(key, Buffer.from(body))
      },

      async createMultipartUpload({ key, contentType }) {
         const uploadId = randomUUID()
         uploads.set(uploadId, { key, contentType, parts: new Map() })
         record('createMultipartUpload', { key })
         return { uploadId }
      },

      async presignUploadPart({ key, uploadId, partNumber, expiresIn }) {
         record('presignUploadPart', { key, partNumber })
         return `memory://${key}?uploadId=${uploadId}&partNumber=${partNumber}&expires=${expiresIn}`
      },

      async listParts({ uploadId }) {
         const upload = uploads.get(uploadId)
         if (!upload) return null
         return [...upload.parts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([partNumber, part]) => ({ partNumber, etag: part.etag, size: part.buffer.length }))
      },

      async completeMultipartUpload({ key, uploadId, parts }) {
         record('completeMultipartUpload', { key, parts: parts.length })
         const upload = uploads.get(uploadId)
         if (!upload) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' })
         const buffers = parts.map((part) => {
            const stored = upload.parts.get(part.partNumber)
            if (!stored || stored.etag !== part.etag) throw new Error('InvalidPart')
            return stored.buffer
         })
         objects.set(key, Buffer.concat(buffers))
         uploads.delete(uploadId)
         if (this.failNextComplete) {
            this.failNextComplete = false
            throw new Error('Simulated failure after storage completion')
         }
      },

      async abortMultipartUpload({ key, uploadId }) {
         record('abortMultipartUpload', { key })
         uploads.delete(uploadId)
      },

      async headObject(key) {
         const object = objects.get(key)
         return object ? { size: object.length } : null
      },

      async readRange(key, start, end) {
         record('readRange', { key, start, end })
         return objects.get(key).subarray(start, end + 1)
      },

      async deleteObject(key) {
         record('deleteObject', { key })
         objects.delete(key)
      },

      async presignDownload({ key, expiresIn, contentType, disposition = 'inline' }) {
         record('presignDownload', { key, expiresIn, contentType, disposition })
         return `https://storage.test/signed/${encodeURIComponent(key)}?expires=${expiresIn}&disposition=${disposition}`
      },
   }
}

export { createMemoryStorageProvider }
