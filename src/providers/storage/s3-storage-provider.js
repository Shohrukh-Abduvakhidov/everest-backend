import {
   AbortMultipartUploadCommand,
   CompleteMultipartUploadCommand,
   CreateMultipartUploadCommand,
   DeleteObjectCommand,
   GetObjectCommand,
   HeadObjectCommand,
   ListPartsCommand,
   PutObjectCommand,
   S3Client,
   UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Provider-neutral S3 adapter. MinIO, Garage and SeaweedFS are selected only through
// S3_ENDPOINT / S3_PUBLIC_ENDPOINT / credentials; no vendor API is used here.
// The internal client talks to S3_ENDPOINT; presigned URLs are signed against
// S3_PUBLIC_ENDPOINT because the host is part of the signature.

const notFoundCodes = new Set(['NoSuchUpload', 'NoSuchKey', 'NotFound'])

function isNotFound(error) {
   return notFoundCodes.has(error?.name) || error?.$metadata?.httpStatusCode === 404
}

function createClient(config, endpoint) {
   return new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
         accessKeyId: config.accessKeyId,
         secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
   })
}

function createS3StorageProvider(config) {
   const client = createClient(config, config.endpoint)
   const signer = createClient(config, config.publicEndpoint || config.endpoint)
   const Bucket = config.bucket

   return {
      async createMultipartUpload({ key, contentType }) {
         const result = await client.send(new CreateMultipartUploadCommand({
            Bucket,
            Key: key,
            ContentType: contentType,
         }))
         return { uploadId: result.UploadId }
      },

      async presignUploadPart({ key, uploadId, partNumber, expiresIn }) {
         return getSignedUrl(signer, new UploadPartCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
         }), { expiresIn })
      },

      // Returns null when the multipart upload no longer exists on the server.
      async listParts({ key, uploadId }) {
         const parts = []
         let marker
         try {
            do {
               const page = await client.send(new ListPartsCommand({
                  Bucket,
                  Key: key,
                  UploadId: uploadId,
                  PartNumberMarker: marker,
                  MaxParts: 1000,
               }))
               for (const part of page.Parts || []) {
                  parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size })
               }
               marker = page.IsTruncated ? page.NextPartNumberMarker : undefined
            } while (marker)
         } catch (error) {
            if (isNotFound(error)) return null
            throw error
         }
         return parts
      },

      async completeMultipartUpload({ key, uploadId, parts }) {
         await client.send(new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
               Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
         }))
      },

      async abortMultipartUpload({ key, uploadId }) {
         try {
            await client.send(new AbortMultipartUploadCommand({
               Bucket,
               Key: key,
               UploadId: uploadId,
            }))
         } catch (error) {
            if (!isNotFound(error)) throw error
         }
      },

      async headObject(key) {
         try {
            const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }))
            return { size: result.ContentLength }
         } catch (error) {
            if (isNotFound(error)) return null
            throw error
         }
      },

      // Single-request upload for small server-side objects (question import images).
      async uploadObject({ key, body, contentType }) {
         await client.send(new PutObjectCommand({
            Bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.length,
         }))
      },

      async readRange(key, start, end) {
         const result = await client.send(new GetObjectCommand({
            Bucket,
            Key: key,
            Range: `bytes=${start}-${end}`,
         }))
         return Buffer.from(await result.Body.transformToByteArray())
      },

      async deleteObject(key) {
         await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
      },

      // GET presigned URLs honour Range requests, which playback and resumable
      // offline downloads rely on.
      async presignDownload({ key, expiresIn, fileName, contentType, disposition = 'inline' }) {
         const type = disposition === 'attachment' ? 'attachment' : 'inline'
         return getSignedUrl(signer, new GetObjectCommand({
            Bucket,
            Key: key,
            ResponseContentType: contentType,
            ResponseContentDisposition: fileName
               ? `${type}; filename*=UTF-8''${encodeURIComponent(fileName)}`
               : type,
         }), { expiresIn })
      },
   }
}

export { createS3StorageProvider }
