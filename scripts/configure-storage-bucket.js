import {
   CreateBucketCommand,
   HeadBucketCommand,
   PutBucketCorsCommand,
   PutBucketLifecycleConfigurationCommand,
   S3Client,
} from '@aws-sdk/client-s3'

import env from '../src/configs/env.js'

// Provider-neutral bucket setup for MinIO (local), Garage or SeaweedFS (production).
// Creates the bucket, applies a 3-day abort-incomplete-multipart rule and a CORS rule
// that lets the browser read the ETag of each uploaded part and seek in videos (Range). Servers that do not
// implement an API (MinIO CE has no bucket CORS API) get a warning, and the server-side
// equivalent must be configured instead (see docker-compose.yml).

const config = env.storage
const origins = (process.env.STORAGE_CORS_ORIGINS || env.corsOrigins.join(','))
   .split(',')
   .map((origin) => origin.trim())
   .filter(Boolean)

if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
   console.error('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required')
   process.exit(1)
}

const client = new S3Client({
   endpoint: config.endpoint,
   region: config.region,
   forcePathStyle: config.forcePathStyle,
   credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
})
const Bucket = config.bucket

async function attempt(label, command) {
   try {
      await client.send(command)
      console.log(`${label}: applied`)
   } catch (error) {
      console.warn(`${label}: not applied by this server (${error.name}); configure it server-side`)
   }
}

try {
   await client.send(new HeadBucketCommand({ Bucket }))
   console.log(`bucket ${Bucket}: exists`)
} catch {
   await client.send(new CreateBucketCommand({ Bucket }))
   console.log(`bucket ${Bucket}: created`)
}

await attempt('lifecycle (abort incomplete multipart after 3 days)',
   new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
         Rules: [{
            ID: 'abort-incomplete-multipart-3d',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
         }],
      },
   }))

await attempt('cors (PUT/GET/HEAD, Range, expose ETag/Content-Range/Accept-Ranges)', new PutBucketCorsCommand({
   Bucket,
   CORSConfiguration: {
      CORSRules: [{
         AllowedOrigins: origins,
         AllowedMethods: ['GET', 'HEAD', 'PUT'],
         // '*' covers Range, If-Range and Content-Type of part uploads.
         AllowedHeaders: ['*'],
         ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
         MaxAgeSeconds: 3600,
      }],
   },
}))
