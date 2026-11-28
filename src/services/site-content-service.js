import { createHash, randomUUID } from 'node:crypto'

import env from '../configs/env.js'
import { getStorageProvider } from '../providers/storage/index.js'
import { siteRevalidationProvider } from '../providers/site/revalidation-provider.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as jobRepository from '../repositories/job-repository.js'
import * as siteRepository from '../repositories/site-content-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { inspectMedia, MediaRejection, mimeTypes } from '../utils/media-inspection.js'
import {
   adminTranslatables,
   courseFormats,
   employmentTypes,
   eventModes,
   eventTypes,
   fallbackLanguage,
   imageDimensions,
   labelToApi,
   mergeTranslations,
   normalizeSitePhone,
   parseDate,
   parseDushanbeDateTime,
   parseEnum,
   parseGeo,
   parseHours,
   parseInstagram,
   parseIsoDuration,
   parsePhones,
   parsePlayMarketUrl,
   parseSalary,
   parseSlug,
   parseStats,
   parseTelegram,
   parseTranslatableInput,
   parseVideoUrl,
   rejectUnknownPaths,
   requireCollection,
   statuses,
   subjectKeys,
   timeZone,
   toDateString,
   toDushanbeIso,
   translatableFields,
   validationError,
   videoPlacements,
} from '../utils/site-content.js'

// Admin side of the marketing site module (permission site.manage, owner and admin).
// A change to content that is published (before or after the change) queues one
// 'site.revalidate' background job in the same transaction (worker:jobs sends the webhook and
// retries with backoff). The webhook never blocks or fails a save.

const maxImageBytes = 5 * 1024 * 1024
const imageTypes = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png' })
const revalidateJobType = 'site.revalidate'
// One first try and three retries (30 s, 60 s, 120 s backoff of worker:jobs).
const revalidateMaxAttempts = 4

const labels = Object.freeze({
   courses: { entity: 'site_course', audit: 'site.course', notFound: 'SITE_COURSE_NOT_FOUND', name: 'Site course', tag: 'site:courses' },
   vacancies: { entity: 'site_vacancy', audit: 'site.vacancy', notFound: 'SITE_VACANCY_NOT_FOUND', name: 'Site vacancy', tag: 'site:vacancies' },
   events: { entity: 'site_event', audit: 'site.event', notFound: 'SITE_EVENT_NOT_FOUND', name: 'Site event', tag: 'site:events' },
   videos: { entity: 'site_video', audit: 'site.video', notFound: 'SITE_VIDEO_NOT_FOUND', name: 'Site video', tag: 'site:videos' },
})

// Non-translated request fields per collection; `required` on create.
const itemFields = Object.freeze({
   courses: { slug: { required: true }, subjectKey: { required: true }, format: {}, coverAssetId: {}, platformCourseId: {} },
   vacancies: { slug: { required: true }, employmentType: {}, salary: {}, datePosted: {}, validThrough: {} },
   events: { type: {}, mode: {}, startsAt: {}, endsAt: {}, imageAssetId: {} },
   videos: { url: { required: true }, thumbnailAssetId: {}, duration: {}, uploadDate: {}, placement: {}, courseSlug: {} },
})

const settingsPlainPaths = Object.freeze([
   ['phones'], ['whatsapp'], ['telegram'], ['instagram'], ['playMarketUrl'], ['geo'], ['hours'],
   ['stats', 'enabled'], ['stats', 'items'], ['hero', 'imageAssetId'], ['seo', 'ogImageAssetId'],
])

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || siteRepository,
      auth: overrides.auth || authRepository,
      jobs: overrides.jobs || jobRepository,
      transaction: overrides.transaction || withTransaction,
      storage: () => overrides.storage || getStorageProvider(),
      revalidateConfig: overrides.revalidateConfig || env.siteRevalidate,
      baseUrl: overrides.baseUrl ?? env.apiPublicUrl ?? '',
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function parseActorId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_USER_ID', 'User identifier is invalid')
   }
}

function parseItemId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_SITE_ITEM_ID', 'Site item identifier is invalid')
   }
}

function parseNullableId(value, fieldName) {
   if (value === null) return null
   try {
      return normalizeInternalId(typeof value === 'number' ? String(value) : value)
   } catch {
      throw validationError(fieldName)
   }
}

function notFound(collection) {
   return new AppError(404, labels[collection].notFound, `${labels[collection].name} was not found`)
}

function imageUrl(baseUrl, assetId) {
   return `${baseUrl}/api/v1/public/site/images/${assetId}`
}

// Admin view of an attached image; alt texts are edited with the item's translations.
function adminImage(image, baseUrl) {
   if (!image) return null
   return {
      assetId: image.assetId,
      url: imageUrl(baseUrl, image.assetId),
      width: image.widthPx ?? null,
      height: image.heightPx ?? null,
      mimeType: image.mimeType,
   }
}

function salaryDto(row) {
   if (row.salary_currency === null || row.salary_currency === undefined) return null
   return { min: row.salary_min, max: row.salary_max, currency: row.salary_currency }
}

function adminItemDto(collection, row, baseUrl) {
   const meta = { id: row.id, status: row.status, order: row.position }
   let specific = {}
   if (collection === 'courses') {
      specific = {
         slug: row.slug,
         subjectKey: row.subject_key,
         format: row.format,
         coverAssetId: row.cover_asset_id,
         cover: adminImage(row.image_cover, baseUrl),
         platformCourseId: row.course_id,
      }
   }
   if (collection === 'vacancies') {
      specific = {
         slug: row.slug,
         employmentType: row.employment_type,
         salary: salaryDto(row),
         datePosted: toDateString(row.date_posted),
         validThrough: toDateString(row.valid_through),
      }
   }
   if (collection === 'events') {
      specific = {
         type: row.event_type,
         mode: row.mode,
         startsAt: toDushanbeIso(row.starts_at),
         endsAt: toDushanbeIso(row.ends_at),
         timeZone,
         imageAssetId: row.image_asset_id,
         image: adminImage(row.image_image, baseUrl),
      }
   }
   if (collection === 'videos') {
      specific = {
         provider: row.provider,
         videoId: row.video_id,
         url: row.url,
         thumbnailAssetId: row.thumbnail_asset_id,
         thumbnail: adminImage(row.image_thumbnail, baseUrl),
         duration: row.duration,
         uploadDate: toDateString(row.upload_date),
         placement: row.placement,
         courseSlug: row.course_slug,
      }
   }
   return {
      ...meta,
      ...specific,
      ...adminTranslatables(collection, row.translations),
      publishedAt: iso(row.published_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
   }
}

function bodyPaths(collection) {
   return [
      ...Object.keys(itemFields[collection]).map((name) => [name]),
      ...translatableFields[collection].map((spec) => spec.path),
   ]
}

async function requireSiteImage(deps, assetId, fieldName, client) {
   if (assetId === null) return null
   if (!await deps.repository.findSiteImage(assetId, client)) {
      throw validationError(fieldName, 'Use an image uploaded with POST /admin/site/images')
   }
   return assetId
}

// Parses the non-translated fields; returns repository field -> value.
async function parseItemFields(deps, collection, body, partial, client) {
   const values = {}
   for (const [name, spec] of Object.entries(itemFields[collection])) {
      if (body[name] === undefined) {
         if (!partial && spec.required) throw validationError(name, `${name} is required`)
         continue
      }
      const value = body[name]
      switch (name) {
         case 'slug': values.slug = parseSlug(value); break
         case 'subjectKey': values.subjectKey = parseEnum(value, subjectKeys, name); break
         case 'format': values.format = parseEnum(value, courseFormats, name); break
         case 'employmentType': values.employmentType = parseEnum(value, employmentTypes, name); break
         case 'type': values.type = parseEnum(value, eventTypes, name); break
         case 'mode': values.mode = parseEnum(value, eventModes, name); break
         case 'placement': values.placement = parseEnum(value, videoPlacements, name); break
         case 'coverAssetId':
         case 'imageAssetId':
         case 'thumbnailAssetId':
            values[name] = await requireSiteImage(deps, parseNullableId(value, name), name, client)
            break
         case 'platformCourseId': {
            const courseId = parseNullableId(value, name)
            if (courseId && !await deps.repository.platformCourseExists(courseId, client)) {
               throw validationError(name, 'Platform course was not found')
            }
            values.platformCourseId = courseId
            break
         }
         case 'salary': {
            const salary = parseSalary(value)
            values.salaryMin = salary.min
            values.salaryMax = salary.max
            values.salaryCurrency = salary.currency
            break
         }
         case 'datePosted':
         case 'validThrough':
         case 'uploadDate':
            values[name] = parseDate(value, name)
            break
         case 'startsAt':
         case 'endsAt':
            values[name] = parseDushanbeDateTime(value, name)
            break
         case 'duration': values.duration = parseIsoDuration(value); break
         case 'url': Object.assign(values, parseVideoUrl(value)); break
         case 'courseSlug': {
            if (value === null) {
               values.siteCourseId = null
               break
            }
            const siteCourseId = await deps.repository.findSiteCourseIdBySlug(parseSlug(value, name), client)
            if (!siteCourseId) throw validationError(name, 'Site course was not found')
            values.siteCourseId = siteCourseId
            break
         }
         default:
            break
      }
   }
   return values
}

// Rules that need the stored row as well as the request.
function checkItemConsistency(collection, before, values) {
   const pick = (field, column) => (values[field] !== undefined ? values[field] : before?.[column] ?? null)
   if (collection === 'videos') {
      const placement = pick('placement', 'placement') ?? 'home'
      const siteCourseId = pick('siteCourseId', 'site_course_id')
      if (placement === 'home' && siteCourseId) {
         if (values.siteCourseId !== undefined) throw validationError('courseSlug', 'courseSlug is only for placement course')
         values.siteCourseId = null
      }
      if (placement === 'course' && !siteCourseId) throw validationError('courseSlug', 'placement course needs courseSlug')
   }
   if (collection === 'events') {
      const startsAt = pick('startsAt', 'starts_at')
      const endsAt = pick('endsAt', 'ends_at')
      if (endsAt && (!startsAt || new Date(endsAt) < new Date(startsAt))) {
         throw validationError('endsAt', 'endsAt must not be before startsAt')
      }
      if (before?.status === 'published' && !startsAt) {
         throw validationError('startsAt', 'A published event needs startsAt')
      }
   }
   if (collection === 'vacancies') {
      const posted = pick('datePosted', 'date_posted')
      const valid = pick('validThrough', 'valid_through')
      if (posted && valid && toDateString(valid) < toDateString(posted)) {
         throw validationError('validThrough', 'validThrough must not be before datePosted')
      }
   }
}

function requireRussianTitle(translations) {
   if (!translations[fallbackLanguage]?.title) {
      throw validationError('title.ru', 'The Russian title is required')
   }
}

function mapConstraintError(collection, error) {
   if (error.code === '23505' && collection === 'courses') {
      return new AppError(409, 'SITE_COURSE_SLUG_CONFLICT', 'A site course with this slug already exists')
   }
   if (error.code === '23505' && collection === 'vacancies') {
      return new AppError(409, 'SITE_VACANCY_SLUG_CONFLICT', 'A site vacancy with this slug already exists')
   }
   return error
}

function tagsFor(collection, ...rows) {
   const tags = ['site', labels[collection].tag]
   for (const row of rows) {
      if (!row) continue
      if (collection === 'courses' && row.slug) tags.push(`site:course:${row.slug}`)
      if (collection === 'videos' && row.course_slug) tags.push(`site:course:${row.course_slug}`)
   }
   return [...new Set(tags)]
}

// Queued in the caller's transaction (outbox); skipped silently when the webhook is not set.
async function queueRevalidation(deps, client, tags) {
   if (!deps.revalidateConfig?.url || !deps.revalidateConfig?.secret) return
   await deps.jobs.enqueueJob({
      jobType: revalidateJobType,
      payload: { tags },
      dedupeKey: `${revalidateJobType}:${randomUUID()}`,
      maxAttempts: revalidateMaxAttempts,
   }, client)
}

async function audit(deps, client, actorId, collection, action, entityId, metadata = {}) {
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code: `${labels[collection].audit}.${action}`,
      entityType: labels[collection].entity,
      entityId,
      metadata,
   }, client)
}

async function requireItem(deps, collection, id, db) {
   const row = await deps.repository.findItem(collection, id, db)
   if (!row) throw notFound(collection)
   return row
}

// --- Items --------------------------------------------------------------------------------

async function listSiteItemsService(collectionValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const collection = requireCollection(collectionValue)
   const status = query.status === undefined ? null : parseEnum(query.status, statuses, 'status')
   const rows = await deps.repository.listItems(collection, { status })
   return { items: rows.map((row) => adminItemDto(collection, row, deps.baseUrl)) }
}

async function getSiteItemService(collectionValue, itemIdValue, overrides) {
   const deps = dependencies(overrides)
   const collection = requireCollection(collectionValue)
   return adminItemDto(collection, await requireItem(deps, collection, parseItemId(itemIdValue)), deps.baseUrl)
}

async function createSiteItemService(userId, collectionValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const collection = requireCollection(collectionValue)
   rejectUnknownPaths(body, bodyPaths(collection))
   const translations = mergeTranslations(collection, {}, parseTranslatableInput(collection, body))
   requireRussianTitle(translations)
   try {
      const id = await deps.transaction(async (client) => {
         const values = await parseItemFields(deps, collection, body, false, client)
         checkItemConsistency(collection, null, values)
         values.position = await deps.repository.nextPosition(collection, client)
         const itemId = await deps.repository.insertItem(collection, values, actorId, client)
         await deps.repository.replaceTranslations(collection, itemId, translations, client)
         await audit(deps, client, actorId, collection, 'created', itemId)
         return itemId
      })
      return adminItemDto(collection, await requireItem(deps, collection, id), deps.baseUrl)
   } catch (error) {
      throw mapConstraintError(collection, error)
   }
}

async function updateSiteItemService(userId, collectionValue, itemIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const collection = requireCollection(collectionValue)
   const itemId = parseItemId(itemIdValue)
   rejectUnknownPaths(body, bodyPaths(collection))
   if (!Object.keys(body).length) throw validationError('body', 'Send at least one field')
   const changes = parseTranslatableInput(collection, body)
   try {
      const row = await deps.transaction(async (client) => {
         if (!await deps.repository.lockItem(collection, itemId, client)) throw notFound(collection)
         const before = await requireItem(deps, collection, itemId, client)
         const values = await parseItemFields(deps, collection, body, true, client)
         checkItemConsistency(collection, before, values)
         await deps.repository.updateItem(collection, itemId, values, actorId, client)
         if (Object.keys(changes).length) {
            const translations = mergeTranslations(collection, before.translations, changes)
            requireRussianTitle(translations)
            await deps.repository.replaceTranslations(collection, itemId, translations, client)
         }
         await audit(deps, client, actorId, collection, 'updated', itemId, { fields: Object.keys(body) })
         const after = await requireItem(deps, collection, itemId, client)
         if (after.status === 'published') await queueRevalidation(deps, client, tagsFor(collection, before, after))
         return after
      })
      return adminItemDto(collection, row, deps.baseUrl)
   } catch (error) {
      throw mapConstraintError(collection, error)
   }
}

async function changeSiteItemStatus(userId, collectionValue, itemIdValue, status, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const collection = requireCollection(collectionValue)
   const itemId = parseItemId(itemIdValue)
   const row = await deps.transaction(async (client) => {
      const locked = await deps.repository.lockItem(collection, itemId, client)
      if (!locked) throw notFound(collection)
      if (locked.status === status) return requireItem(deps, collection, itemId, client)
      const before = await requireItem(deps, collection, itemId, client)
      if (collection === 'events' && status === 'published' && !before.starts_at) {
         throw new AppError(409, 'SITE_EVENT_START_REQUIRED', 'Set startsAt before publishing the event')
      }
      await deps.repository.setItemStatus(collection, itemId, status, actorId, client)
      await audit(deps, client, actorId, collection, status === 'published' ? 'published' : 'unpublished', itemId)
      const after = await requireItem(deps, collection, itemId, client)
      await queueRevalidation(deps, client, tagsFor(collection, after))
      return after
   })
   return adminItemDto(collection, row, deps.baseUrl)
}

async function publishSiteItemService(userId, collection, itemId, overrides) {
   return changeSiteItemStatus(userId, collection, itemId, 'published', overrides)
}

async function unpublishSiteItemService(userId, collection, itemId, overrides) {
   return changeSiteItemStatus(userId, collection, itemId, 'draft', overrides)
}

async function deleteSiteItemService(userId, collectionValue, itemIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const collection = requireCollection(collectionValue)
   const itemId = parseItemId(itemIdValue)
   await deps.transaction(async (client) => {
      if (!await deps.repository.lockItem(collection, itemId, client)) throw notFound(collection)
      const current = await requireItem(deps, collection, itemId, client)
      await deps.repository.deleteItem(collection, itemId, client)
      await audit(deps, client, actorId, collection, 'deleted', itemId, {
         status: current.status,
         ...(current.slug ? { slug: current.slug } : {}),
      })
      if (current.status === 'published') await queueRevalidation(deps, client, tagsFor(collection, current))
   })
   return { id: itemId, status: 'deleted' }
}

// ids: every item of the collection exactly once, in the new order (order becomes 1..n).
async function reorderSiteItemsService(userId, collectionValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const collection = requireCollection(collectionValue)
   rejectUnknownPaths(body, [['ids']])
   if (!Array.isArray(body.ids) || !body.ids.length) throw validationError('ids', 'ids must list every item')
   const ids = body.ids.map((value, index) => parseNullableId(value ?? '', `ids[${index}]`))
   if (new Set(ids).size !== ids.length) throw validationError('ids', 'ids must not repeat')
   const rows = await deps.transaction(async (client) => {
      const existing = await deps.repository.lockCollectionIds(collection, client)
      if (existing.length !== ids.length || existing.some((id) => !ids.includes(id))) {
         throw validationError('ids', 'ids must list every item of the collection exactly once')
      }
      await deps.repository.updatePositions(collection, ids, actorId, client)
      await audit(deps, client, actorId, collection, 'reordered', null, { ids })
      const list = await deps.repository.listItems(collection, {}, client)
      if (list.some((row) => row.status === 'published')) {
         await queueRevalidation(deps, client, ['site', labels[collection].tag])
      }
      return list
   })
   return { items: rows.map((row) => adminItemDto(collection, row, deps.baseUrl)) }
}

// --- Settings -----------------------------------------------------------------------------

function phoneDisplay(phone) {
   const match = /^\+992(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone)
   return match ? `+992 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone
}

function profileUrl(username, base) {
   return username ? `${base}${username}` : null
}

function adminSettingsDto(row, baseUrl) {
   const text = adminTranslatables('settings', row.translations)
   return {
      phones: row.phones.map((phone) => ({ number: phone.number, label: labelToApi(phone.label) })),
      whatsapp: row.whatsapp_phone,
      whatsappTemplate: text.whatsappTemplate,
      whatsappCourseTemplate: text.whatsappCourseTemplate,
      telegram: profileUrl(row.telegram_username, 'https://t.me/'),
      instagram: profileUrl(row.instagram_username, 'https://www.instagram.com/'),
      playMarketUrl: row.play_market_url,
      address: text.address,
      geo: row.geo_lat === null ? null : { lat: row.geo_lat, lng: row.geo_lng },
      hours: row.hours,
      stats: {
         enabled: row.stats_enabled,
         items: row.stats.map((item) => ({ value: item.value, label: labelToApi(item.label) })),
      },
      hero: {
         ...text.hero,
         imageAssetId: row.hero_image_asset_id,
         image: adminImage(row.image_hero, baseUrl),
      },
      whyEverest: text.whyEverest,
      stages: text.stages,
      seo: {
         ...text.seo,
         ogImageAssetId: row.seo_image_asset_id,
         ogImage: adminImage(row.image_seo, baseUrl),
      },
      updatedAt: iso(row.updated_at),
   }
}

async function getSiteSettingsService(overrides) {
   const deps = dependencies(overrides)
   return adminSettingsDto(await deps.repository.findSettings(), deps.baseUrl)
}

// PUT semantics for a single document whose parts are edited separately: fields that are not
// sent keep their value; inside { ru, tj, en } only the languages sent change.
async function updateSiteSettingsService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   rejectUnknownPaths(body, [...settingsPlainPaths, ...translatableFields.settings.map((spec) => spec.path)])
   if (!Object.keys(body).length) throw validationError('body', 'Send at least one field')
   const values = {}
   if (body.phones !== undefined) values.phones = parsePhones(body.phones)
   if (body.whatsapp !== undefined) {
      values.whatsappPhone = body.whatsapp === null || body.whatsapp === ''
         ? null
         : normalizeSitePhone(body.whatsapp, 'whatsapp')
   }
   if (body.telegram !== undefined) values.telegram = parseTelegram(body.telegram)
   if (body.instagram !== undefined) values.instagram = parseInstagram(body.instagram)
   if (body.playMarketUrl !== undefined) values.playMarketUrl = parsePlayMarketUrl(body.playMarketUrl)
   if (body.geo !== undefined) {
      const geo = parseGeo(body.geo)
      values.geoLat = geo.lat
      values.geoLng = geo.lng
   }
   if (body.hours !== undefined) values.hours = parseHours(body.hours)
   if (body.stats?.enabled !== undefined) {
      if (typeof body.stats.enabled !== 'boolean') throw validationError('stats.enabled')
      values.statsEnabled = body.stats.enabled
   }
   if (body.stats?.items !== undefined) values.stats = parseStats(body.stats.items)
   const changes = parseTranslatableInput('settings', body)
   const row = await deps.transaction(async (client) => {
      await deps.repository.lockSettings(client)
      if (body.hero?.imageAssetId !== undefined) {
         values.heroImageAssetId = await requireSiteImage(deps, parseNullableId(body.hero.imageAssetId, 'hero.imageAssetId'), 'hero.imageAssetId', client)
      }
      if (body.seo?.ogImageAssetId !== undefined) {
         values.seoImageAssetId = await requireSiteImage(deps, parseNullableId(body.seo.ogImageAssetId, 'seo.ogImageAssetId'), 'seo.ogImageAssetId', client)
      }
      const before = await deps.repository.findSettings(client)
      await deps.repository.updateSettings(values, actorId, client)
      if (Object.keys(changes).length) {
         await deps.repository.replaceSettingsTranslations(
            mergeTranslations('settings', before.translations, changes),
            client,
         )
      }
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'site.settings.updated',
         entityType: 'site_settings',
         entityId: null,
         metadata: { fields: Object.keys(body) },
      }, client)
      await queueRevalidation(deps, client, ['site', 'site:settings'])
      return deps.repository.findSettings(client)
   })
   return adminSettingsDto(row, deps.baseUrl)
}

// --- Revalidation job ---------------------------------------------------------------------

// worker:jobs handler. A refused or failed webhook throws, so the queue retries it.
function createSiteJobHandlers(provider = siteRevalidationProvider) {
   return {
      async [revalidateJobType](payload) {
         const tags = Array.isArray(payload?.tags) ? payload.tags.filter((tag) => typeof tag === 'string') : []
         if (!tags.length) return
         const result = await provider.revalidate({ tags })
         if (result.skipped || result.ok) return
         const error = new Error('Site revalidation failed')
         error.code = 'SITE_REVALIDATE_FAILED'
         throw error
      },
   }
}

const siteJobHandlers = createSiteJobHandlers()

// --- Images -------------------------------------------------------------------------------

function parseImageFileName(value, extension) {
   const fallback = `image.${extension}`
   if (typeof value !== 'string' || !value.trim()) return fallback
   let decoded = value
   try {
      decoded = decodeURIComponent(value)
   } catch {
      // Keep the raw header value.
   }
   const baseName = decoded.split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
   return baseName && baseName.length <= 255 && !baseName.startsWith('.') ? baseName : fallback
}

// body: the raw bytes; contentType: image/jpeg or image/png. The type is re-identified from the
// bytes, width and height are read from them, and the asset is stored ready with scope 'site'.
async function uploadSiteImageService(userId, { body, contentType, fileName }, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const mimeType = (contentType || '').split(';')[0].trim().toLowerCase()
   const extension = imageTypes[mimeType]
   if (!extension) {
      throw new AppError(415, 'SITE_IMAGE_TYPE_INVALID', 'Send the image as image/jpeg or image/png')
   }
   if (!Buffer.isBuffer(body) || !body.length) throw validationError('body', 'The image is empty')
   if (body.length > maxImageBytes) throw new AppError(413, 'SITE_IMAGE_TOO_LARGE', 'The image is larger than 5 MB')
   const invalid = () => new AppError(422, 'SITE_IMAGE_CONTENT_INVALID', 'The file is not a valid JPEG or PNG image')
   try {
      await inspectMedia({
         read: async (start, end) => body.subarray(start, end + 1),
         size: body.length,
         kind: 'material',
         declaredMimeType: mimeTypes[extension],
      })
   } catch (error) {
      if (error instanceof MediaRejection) throw invalid()
      throw error
   }
   const size = imageDimensions(body, mimeTypes[extension])
   if (!size || !size.width || !size.height) throw invalid()
   const storage = deps.storage()
   const storageKey = `site/images/${randomUUID()}.${extension}`
   await storage.uploadObject({ key: storageKey, body, contentType: mimeTypes[extension] })
   try {
      const asset = await deps.transaction(async (client) => {
         const inserted = await deps.repository.insertSiteImage({
            storageKey,
            mimeType: mimeTypes[extension],
            fileName: parseImageFileName(fileName, extension),
            sizeBytes: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
            widthPx: size.width,
            heightPx: size.height,
            uploadedBy: actorId,
         }, client)
         await deps.auth.appendAuditEvent({
            actorUserId: actorId,
            subjectUserId: null,
            code: 'site.image.uploaded',
            entityType: 'asset',
            entityId: inserted.id,
            metadata: { sizeBytes: body.length, mimeType: mimeTypes[extension] },
         }, client)
         return inserted
      })
      return {
         assetId: asset.id,
         url: imageUrl(deps.baseUrl, asset.id),
         width: asset.width_px,
         height: asset.height_px,
         mimeType: asset.mime_type,
         fileName: asset.file_name,
         sizeBytes: Number(asset.size_bytes),
         createdAt: iso(asset.created_at),
      }
   } catch (error) {
      await Promise.resolve(storage.deleteObject?.(storageKey)).catch(() => {})
      throw error
   }
}

export {
   createSiteItemService,
   createSiteJobHandlers,
   deleteSiteItemService,
   getSiteItemService,
   getSiteSettingsService,
   imageUrl,
   listSiteItemsService,
   maxImageBytes,
   phoneDisplay,
   profileUrl,
   publishSiteItemService,
   reorderSiteItemsService,
   salaryDto,
   siteJobHandlers,
   unpublishSiteItemService,
   updateSiteItemService,
   updateSiteSettingsService,
   uploadSiteImageService,
}
