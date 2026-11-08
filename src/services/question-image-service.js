import { getStorageProvider } from '../providers/storage/index.js'
import * as questionBankRepository from '../repositories/question-bank-repository.js'

// Short-lived download URLs for image blocks of question content, shared by the admin
// question views and the learner attempt views. URLs exist only in responses; stored content
// keeps `{ type: 'image', assetId, alt? }`. The caller has already checked that the viewer may
// see these questions; an image is signed only when its asset is ready and linked to the same
// question. A missing, unready or foreign asset, or unavailable storage, leaves the block
// without `url`, and the request still succeeds.

// The same lifetime as lesson materials.
const imageUrlTtlSeconds = 5 * 60

function dependencies(overrides = {}) {
   return {
      repository: overrides.questionImages || questionBankRepository,
      storage: () => overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
   }
}

function imageKey(questionId, assetId) {
   return `${questionId}:${assetId}`
}

// One query for every question of the response, then local signing per asset.
async function issueQuestionImageUrls(questionIds, overrides, db) {
   const deps = dependencies(overrides)
   const urls = new Map()
   if (!questionIds.length) return urls
   const rows = await deps.repository.listQuestionImageAssets(questionIds, db)
   if (!rows.length) return urls
   let storage
   try {
      storage = deps.storage()
   } catch {
      return urls
   }
   const expiresAt = new Date(deps.clock().getTime() + imageUrlTtlSeconds * 1000).toISOString()
   for (const row of rows) {
      try {
         const url = await storage.presignDownload({
            key: row.storage_key,
            expiresIn: imageUrlTtlSeconds,
            contentType: row.mime_type,
            disposition: 'inline',
         })
         urls.set(imageKey(String(row.question_id), String(row.asset_id)), { url, expiresAt })
      } catch {
         // This block is returned without a URL.
      }
   }
   return urls
}

// Returns a copy of `content` with url/expiresAt on signed image blocks; the input is unchanged.
function withImageUrls(content, questionId, urls) {
   if (!content || !Array.isArray(content.blocks)) return content
   return {
      ...content,
      blocks: content.blocks.map((block) => {
         if (block?.type !== 'image') return block
         const signed = urls.get(imageKey(String(questionId), String(block.assetId)))
         return signed ? { ...block, url: signed.url, expiresAt: signed.expiresAt } : block
      }),
   }
}

export { imageUrlTtlSeconds, issueQuestionImageUrls, withImageUrls }
