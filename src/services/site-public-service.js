import env from '../configs/env.js'
import { getStorageProvider } from '../providers/storage/index.js'
import * as siteRepository from '../repositories/site-content-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import {
   dushanbeToday,
   localize,
   localizeLabel,
   parseApiLanguage,
   parseEnum,
   parseSlug,
   placeLocalized,
   requireCollection,
   resolvedLanguage,
   dbToApi,
   timeZone,
   toDateString,
   toDushanbeIso,
   videoPlacements,
   whatsappUrl,
} from '../utils/site-content.js'
import { imageUrl, profileUrl, salaryDto } from './site-content-service.js'

// Public, unauthenticated reads of the marketing site: published items only, texts in the
// requested language with a per-field fallback to Russian. Every object carries lang (the
// language it is shown in: the requested one when it has its own title, otherwise ru).

// Image links are signed at the start of a 10-minute window and live an hour after it.
const imageUrlTtlSeconds = 3600
const imageCacheSeconds = 600

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || siteRepository,
      storage: () => overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
      baseUrl: overrides.baseUrl ?? env.apiPublicUrl ?? '',
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function publicImage(image, alt, baseUrl) {
   if (!image) return null
   return { url: imageUrl(baseUrl, image.assetId), width: image.widthPx ?? null, height: image.heightPx ?? null, alt: alt || null }
}

function publicItemDto(collection, row, language, baseUrl) {
   const text = localize(collection, row.translations, language)
   const base = { id: row.id, lang: resolvedLanguage(row.translations, language) }
   if (collection === 'courses') {
      return {
         ...base,
         slug: row.slug,
         subjectKey: row.subject_key,
         format: row.format,
         ...placeLocalized('courses', text, ['coverAlt']),
         cover: publicImage(row.image_cover, text.coverAlt || text.title, baseUrl),
         platformCourseId: row.course_id,
         order: row.position,
         updatedAt: iso(row.updated_at),
      }
   }
   if (collection === 'vacancies') {
      return {
         ...base,
         slug: row.slug,
         employmentType: row.employment_type,
         ...placeLocalized('vacancies', text),
         salary: salaryDto(row),
         datePosted: toDateString(row.date_posted),
         validThrough: toDateString(row.valid_through),
         order: row.position,
         updatedAt: iso(row.updated_at),
      }
   }
   if (collection === 'events') {
      return {
         ...base,
         type: row.event_type,
         mode: row.mode,
         ...placeLocalized('events', text, ['imageAlt']),
         startsAt: toDushanbeIso(row.starts_at),
         endsAt: toDushanbeIso(row.ends_at),
         timeZone,
         image: publicImage(row.image_image, text.imageAlt || text.title, baseUrl),
         order: row.position,
         updatedAt: iso(row.updated_at),
      }
   }
   const alt = text.thumbnailAlt || text.title
   let thumbnail = publicImage(row.image_thumbnail, alt, baseUrl)
   if (!thumbnail && row.provider === 'youtube') {
      thumbnail = { url: `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`, width: 480, height: 360, alt }
   }
   const embedUrl = {
      youtube: `https://www.youtube-nocookie.com/embed/${row.video_id}`,
      vimeo: `https://player.vimeo.com/video/${row.video_id}`,
      file: null,
   }[row.provider]
   return {
      ...base,
      provider: row.provider,
      videoId: row.video_id,
      url: row.url,
      embedUrl,
      ...placeLocalized('videos', text, ['thumbnailAlt']),
      thumbnail,
      duration: row.duration,
      uploadDate: toDateString(row.upload_date),
      placement: row.placement,
      courseSlug: row.course_slug,
      order: row.position,
      updatedAt: iso(row.updated_at),
   }
}

const listKeys = Object.freeze({ courses: 'courses', vacancies: 'vacancies', events: 'events', videos: 'videos' })

// Filters: vacancies past validThrough are hidden; videos by placement and courseSlug.
function publicFilter(collection, query, now) {
   if (collection === 'vacancies') {
      const today = dushanbeToday(now)
      return (row) => !row.valid_through || toDateString(row.valid_through) >= today
   }
   if (collection === 'videos') {
      const placement = query.placement === undefined ? null : parseEnum(query.placement, videoPlacements, 'placement')
      const courseSlug = query.courseSlug === undefined ? null : parseSlug(query.courseSlug, 'courseSlug')
      return (row) => (!placement || row.placement === placement) && (!courseSlug || row.course_slug === courseSlug)
   }
   return () => true
}

async function listPublicSiteItemsService(collectionValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const collection = requireCollection(collectionValue)
   const language = parseApiLanguage(query.lang)
   const keep = publicFilter(collection, query, deps.clock())
   const rows = await deps.repository.listItems(collection, { status: 'published' })
   return {
      lang: dbToApi[language],
      [listKeys[collection]]: rows.filter(keep).map((row) => publicItemDto(collection, row, language, deps.baseUrl)),
   }
}

async function getPublicSiteCourseService(slugValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const language = parseApiLanguage(query.lang)
   let slug
   try {
      slug = parseSlug(slugValue)
   } catch {
      throw new AppError(404, 'SITE_COURSE_NOT_FOUND', 'Site course was not found')
   }
   const row = await deps.repository.findPublishedCourseBySlug(slug)
   if (!row) throw new AppError(404, 'SITE_COURSE_NOT_FOUND', 'Site course was not found')
   return publicItemDto('courses', row, language, deps.baseUrl)
}

async function getPublicSiteSettingsService(query = {}, overrides) {
   const deps = dependencies(overrides)
   const language = parseApiLanguage(query.lang)
   const row = await deps.repository.findSettings()
   const text = localize('settings', row.translations, language)
   return {
      lang: resolvedLanguage(row.translations, language, null),
      phones: row.phones.map((phone) => ({ number: phone.number, label: localizeLabel(phone.label, language) })),
      whatsapp: row.whatsapp_phone,
      whatsappTemplate: text.whatsappTemplate,
      whatsappCourseTemplate: text.whatsappCourseTemplate,
      whatsappUrl: whatsappUrl(row.whatsapp_phone, text.whatsappTemplate),
      telegram: profileUrl(row.telegram_username, 'https://t.me/'),
      instagram: profileUrl(row.instagram_username, 'https://www.instagram.com/'),
      playMarketUrl: row.play_market_url,
      address: text.address,
      geo: row.geo_lat === null ? null : { lat: row.geo_lat, lng: row.geo_lng },
      hours: row.hours,
      // Unconfirmed figures never leave the server while the block is off.
      stats: {
         enabled: row.stats_enabled,
         items: row.stats_enabled
            ? row.stats.map((item) => ({ value: item.value, label: localizeLabel(item.label, language) }))
            : [],
      },
      hero: {
         title: text.heroTitle,
         subtitle: text.heroSubtitle,
         primaryCta: text.heroPrimaryCta,
         secondaryCta: text.heroSecondaryCta,
         image: publicImage(row.image_hero, text.heroImageAlt || text.heroTitle, deps.baseUrl),
      },
      whyEverest: text.whyEverest,
      stages: text.stages,
      seo: {
         title: text.seoTitle,
         description: text.seoDescription,
         ogImage: publicImage(row.image_seo, text.seoImageAlt || text.seoTitle, deps.baseUrl),
      },
      updatedAt: iso(row.updated_at),
   }
}

// Redirect target for a site image: a signed storage URL, stable within a 10-minute window so
// browsers and the frontend image optimizer can reuse the cached file.
async function getPublicSiteImageService(assetIdValue, overrides) {
   const deps = dependencies(overrides)
   let assetId
   try {
      assetId = normalizeInternalId(assetIdValue)
   } catch {
      throw new AppError(404, 'SITE_IMAGE_NOT_FOUND', 'Image was not found')
   }
   const asset = await deps.repository.findSiteImage(assetId)
   if (!asset) throw new AppError(404, 'SITE_IMAGE_NOT_FOUND', 'Image was not found')
   const windowMs = imageCacheSeconds * 1000
   const signingDate = new Date(Math.floor(deps.clock().getTime() / windowMs) * windowMs)
   const url = await deps.storage().presignDownload({
      key: asset.storage_key,
      expiresIn: imageUrlTtlSeconds + imageCacheSeconds,
      contentType: asset.mime_type,
      disposition: 'inline',
      signingDate,
      cacheControl: 'public, max-age=86400',
   })
   return { url, cacheSeconds: imageCacheSeconds }
}

export {
   getPublicSiteCourseService,
   getPublicSiteImageService,
   getPublicSiteSettingsService,
   listPublicSiteItemsService,
}
