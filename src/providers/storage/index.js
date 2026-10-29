import env from '../../configs/env.js'
import AppError from '../../utils/app-error.js'
import { createS3StorageProvider } from './s3-storage-provider.js'

let provider

function isStorageConfigured(config = env.storage) {
   return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey)
}

// Constructed lazily so importing the app never requires storage credentials.
function getStorageProvider() {
   if (!isStorageConfigured()) {
      throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured')
   }
   provider ||= createS3StorageProvider(env.storage)
   return provider
}

export { getStorageProvider, isStorageConfigured }
