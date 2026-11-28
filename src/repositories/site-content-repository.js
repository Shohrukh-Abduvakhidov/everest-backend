import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// Fixed identifier maps: table and column names never come from request input. Keys are the
// API field names the service uses; values are SQL columns. JSONB columns are listed apart.
const collections = Object.freeze({
   courses: {
      table: 'site_courses',
      translations: 'site_course_translations',
      foreignKey: 'site_course_id',
      columns: {
         slug: 'slug',
         subjectKey: 'subject_key',
         format: 'format',
         coverAssetId: 'cover_asset_id',
         platformCourseId: 'course_id',
      },
      images: { cover: 'cover_asset_id' },
      text: {
         title: 'title', summary: 'summary', description: 'description', audience: 'audience',
         duration: 'duration', label: 'label', coverAlt: 'cover_alt', seoTitle: 'seo_title',
         seoDescription: 'seo_description', topics: 'topics', learn: 'learn',
         howItWorks: 'how_it_works', program: 'program',
      },
   },
   vacancies: {
      table: 'site_vacancies',
      translations: 'site_vacancy_translations',
      foreignKey: 'site_vacancy_id',
      columns: {
         slug: 'slug',
         employmentType: 'employment_type',
         salaryMin: 'salary_min',
         salaryMax: 'salary_max',
         salaryCurrency: 'salary_currency',
         datePosted: 'date_posted',
         validThrough: 'valid_through',
      },
      images: {},
      text: {
         title: 'title', location: 'location', description: 'description',
         requirements: 'requirements', conditions: 'conditions',
      },
   },
   events: {
      table: 'site_events',
      translations: 'site_event_translations',
      foreignKey: 'site_event_id',
      columns: {
         type: 'event_type',
         mode: 'mode',
         startsAt: 'starts_at',
         endsAt: 'ends_at',
         imageAssetId: 'image_asset_id',
      },
      images: { image: 'image_asset_id' },
      text: { title: 'title', description: 'description', location: 'location', imageAlt: 'image_alt' },
   },
   videos: {
      table: 'site_videos',
      translations: 'site_video_translations',
      foreignKey: 'site_video_id',
      columns: {
         provider: 'provider',
         videoId: 'video_id',
         url: 'url',
         thumbnailAssetId: 'thumbnail_asset_id',
         duration: 'duration',
         uploadDate: 'upload_date',
         placement: 'placement',
         siteCourseId: 'site_course_id',
      },
      images: { thumbnail: 'thumbnail_asset_id' },
      text: { title: 'title', description: 'description', thumbnailAlt: 'thumbnail_alt' },
   },
})

// DATE columns are read as text so the calendar day never shifts with the server time zone.
const dateColumns = new Set(['date_posted', 'valid_through', 'upload_date'])

const settingsColumns = Object.freeze({
   phones: 'phones',
   whatsappPhone: 'whatsapp_phone',
   telegram: 'telegram_username',
   instagram: 'instagram_username',
   playMarketUrl: 'play_market_url',
   geoLat: 'geo_lat',
   geoLng: 'geo_lng',
   hours: 'hours',
   statsEnabled: 'stats_enabled',
   stats: 'stats',
   heroImageAssetId: 'hero_image_asset_id',
   seoImageAssetId: 'seo_image_asset_id',
})

const settingsText = Object.freeze({
   address: 'address', whatsappTemplate: 'whatsapp_template',
   whatsappCourseTemplate: 'whatsapp_course_template', heroTitle: 'hero_title',
   heroSubtitle: 'hero_subtitle', heroPrimaryCta: 'hero_primary_cta',
   heroSecondaryCta: 'hero_secondary_cta', heroImageAlt: 'hero_image_alt',
   whyEverest: 'why_everest', stages: 'stages', seoTitle: 'seo_title',
   seoDescription: 'seo_description', seoImageAlt: 'seo_image_alt',
})

const jsonbColumns = new Set([
   'topics', 'learn', 'how_it_works', 'program', 'requirements', 'conditions', 'phones', 'hours',
   'stats', 'why_everest', 'stages',
])

function config(collection) {
   const entry = collections[collection]
   if (!entry) throw new TypeError('Unknown site collection')
   return entry
}

function encode(column, value) {
   return jsonbColumns.has(column) ? JSON.stringify(value ?? []) : value
}

function placeholder(column, index) {
   return jsonbColumns.has(column) ? `$${index}::jsonb` : `$${index}`
}

function translationObjectSql(text, alias) {
   return `jsonb_build_object(${Object.entries(text)
      .map(([field, column]) => `'${field}', ${alias}.${column}`).join(', ')})`
}

function imageSql(column) {
   return `(SELECT jsonb_build_object('assetId', asset.id::text, 'mimeType', asset.mime_type,
         'widthPx', asset.width_px, 'heightPx', asset.height_px)
       FROM assets AS asset WHERE asset.id = item.${column})`
}

function selectSql(collection) {
   const { table, translations, foreignKey, columns, images, text } = config(collection)
   const plain = Object.values(columns).map((column) => (dateColumns.has(column)
      ? `item.${column}::text AS ${column}`
      : `item.${column}`))
   const imageColumns = Object.entries(images).map(([name, column]) => `${imageSql(column)} AS image_${name}`)
   if (collection === 'videos') {
      imageColumns.push('(SELECT course.slug FROM site_courses AS course WHERE course.id = item.site_course_id) AS course_slug')
   }
   return `SELECT item.id, item.status, item.position, item.published_at, item.created_at,
         item.updated_at${plain.length ? `, ${plain.join(', ')}` : ''}${imageColumns.length ? `, ${imageColumns.join(', ')}` : ''},
         COALESCE((
            SELECT jsonb_object_agg(translation.language_code, ${translationObjectSql(text, 'translation')})
            FROM ${translations} AS translation
            WHERE translation.${foreignKey} = item.id
         ), '{}'::jsonb) AS translations
      FROM ${table} AS item`
}

async function listItems(collection, { status = null } = {}, db = pool) {
   const result = await db.query(
      `${selectSql(collection)}
       WHERE ($1::varchar IS NULL OR item.status = $1)
       ORDER BY item.position, item.id`,
      [status],
   )
   return result.rows
}

async function findItem(collection, id, db = pool) {
   const result = await db.query(`${selectSql(collection)} WHERE item.id = $1`, [normalizeInternalId(id)])
   return result.rows[0] || null
}

async function lockItem(collection, id, client) {
   const result = await client.query(
      `SELECT id, status FROM ${config(collection).table} WHERE id = $1 FOR UPDATE`,
      [normalizeInternalId(id)],
   )
   return result.rows[0] || null
}

async function findPublishedCourseBySlug(slug, db = pool) {
   const result = await db.query(
      `${selectSql('courses')} WHERE item.slug = $1 AND item.status = 'published'`,
      [slug],
   )
   return result.rows[0] || null
}

async function nextPosition(collection, client) {
   const result = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS position FROM ${config(collection).table}`,
   )
   return Number(result.rows[0].position)
}

// values: API field -> value, only fields of the collection's column map are written.
async function insertItem(collection, values, actorId, client) {
   const { table, columns } = config(collection)
   const names = ['position', 'created_by', 'updated_by']
   const params = [values.position, normalizeInternalId(actorId), normalizeInternalId(actorId)]
   for (const [field, column] of Object.entries(columns)) {
      if (values[field] === undefined) continue
      names.push(column)
      params.push(encode(column, values[field]))
   }
   const result = await client.query(
      `INSERT INTO ${table} (${names.join(', ')})
       VALUES (${names.map((column, index) => placeholder(column, index + 1)).join(', ')})
       RETURNING id`,
      params,
   )
   return result.rows[0].id
}

async function updateItem(collection, id, values, actorId, client) {
   const { table, columns } = config(collection)
   const params = [normalizeInternalId(id), normalizeInternalId(actorId)]
   const assignments = ['updated_by = $2', 'updated_at = CURRENT_TIMESTAMP']
   for (const [field, column] of Object.entries(columns)) {
      if (values[field] === undefined) continue
      params.push(encode(column, values[field]))
      assignments.push(`${column} = ${placeholder(column, params.length)}`)
   }
   await client.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $1`, params)
}

async function insertTranslationRows(table, keyColumn, keyValue, text, translations, client) {
   for (const [language, values] of Object.entries(translations)) {
      const names = [...(keyColumn ? [keyColumn] : []), 'language_code']
      const params = [...(keyColumn ? [keyValue] : []), language]
      for (const [field, column] of Object.entries(text)) {
         names.push(column)
         params.push(encode(column, values[field]))
      }
      await client.query(
         `INSERT INTO ${table} (${names.join(', ')})
          VALUES (${names.map((column, index) => placeholder(column, index + 1)).join(', ')})`,
         params,
      )
   }
}

// translations is the complete new set { ru: {...}, tg?: {...}, en?: {...} }.
async function replaceTranslations(collection, id, translations, client) {
   const { translations: table, foreignKey, text } = config(collection)
   const itemId = normalizeInternalId(id)
   await client.query(`DELETE FROM ${table} WHERE ${foreignKey} = $1`, [itemId])
   await insertTranslationRows(table, foreignKey, itemId, text, translations, client)
}

// Publishing also fills the date a vacancy was posted or a video uploaded when still empty.
async function setItemStatus(collection, id, status, actorId, client) {
   const dateFill = { vacancies: 'date_posted', videos: 'upload_date' }[collection]
   const fill = dateFill
      ? `, ${dateFill} = CASE WHEN $2::varchar = 'published' THEN COALESCE(${dateFill}, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dushanbe')::date) ELSE ${dateFill} END`
      : ''
   await client.query(
      `UPDATE ${config(collection).table}
       SET status = $2::varchar${fill},
          published_at = CASE WHEN $2::varchar = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) END,
          updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [normalizeInternalId(id), status, normalizeInternalId(actorId)],
   )
}

async function deleteItem(collection, id, client) {
   await client.query(`DELETE FROM ${config(collection).table} WHERE id = $1`, [normalizeInternalId(id)])
}

async function lockCollectionIds(collection, client) {
   const result = await client.query(
      `SELECT id FROM ${config(collection).table} ORDER BY id FOR UPDATE`,
   )
   return result.rows.map((row) => row.id)
}

async function updatePositions(collection, ids, actorId, client) {
   await client.query(
      `UPDATE ${config(collection).table} AS item
       SET position = ordered.position, updated_by = $2, updated_at = CURRENT_TIMESTAMP
       FROM unnest($1::bigint[]) WITH ORDINALITY AS ordered (id, position)
       WHERE item.id = ordered.id AND item.position <> ordered.position`,
      [ids.map(normalizeInternalId), normalizeInternalId(actorId)],
   )
}

async function findSiteCourseIdBySlug(slug, db = pool) {
   const result = await db.query('SELECT id FROM site_courses WHERE slug = $1', [slug])
   return result.rows[0]?.id ?? null
}

async function platformCourseExists(courseId, db = pool) {
   const result = await db.query('SELECT 1 FROM courses WHERE id = $1', [normalizeInternalId(courseId)])
   return result.rowCount > 0
}

// --- Images -------------------------------------------------------------------------------

async function insertSiteImage(image, client) {
   const result = await client.query(
      `INSERT INTO assets (storage_key, mime_type, file_name, size_bytes, sha256, width_px, height_px,
         status, uploaded_by, source_metadata, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8, '{"scope":"site"}'::jsonb, 'material')
       RETURNING id, mime_type, file_name, size_bytes, width_px, height_px, created_at`,
      [
         image.storageKey, image.mimeType, image.fileName, image.sizeBytes, image.sha256,
         image.widthPx, image.heightPx, normalizeInternalId(image.uploadedBy),
      ],
   )
   return result.rows[0]
}

// Only ready assets uploaded for the site can be attached to site content or served publicly.
async function findSiteImage(assetId, db = pool) {
   const result = await db.query(
      `SELECT id, storage_key, mime_type, width_px, height_px, created_at
       FROM assets
       WHERE id = $1 AND status = 'ready' AND source_metadata->>'scope' = 'site'`,
      [normalizeInternalId(assetId)],
   )
   return result.rows[0] || null
}

// --- Settings -----------------------------------------------------------------------------

async function findSettings(db = pool) {
   const result = await db.query(
      `SELECT settings.id, settings.phones, settings.whatsapp_phone, settings.telegram_username,
          settings.instagram_username, settings.play_market_url, settings.geo_lat::float8 AS geo_lat,
          settings.geo_lng::float8 AS geo_lng, settings.hours, settings.stats_enabled, settings.stats,
          settings.updated_at,
          settings.hero_image_asset_id, settings.seo_image_asset_id,
          ${imageSql('hero_image_asset_id').replaceAll('item.', 'settings.')} AS image_hero,
          ${imageSql('seo_image_asset_id').replaceAll('item.', 'settings.')} AS image_seo,
          COALESCE((
             SELECT jsonb_object_agg(translation.language_code, ${translationObjectSql(settingsText, 'translation')})
             FROM site_settings_translations AS translation
          ), '{}'::jsonb) AS translations
       FROM site_settings AS settings
       WHERE settings.id = 1`,
   )
   return result.rows[0] || null
}

// The row always exists (created by the migration); the insert only guards a manual delete.
async function lockSettings(client) {
   await client.query('INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING')
   await client.query('SELECT id FROM site_settings WHERE id = 1 FOR UPDATE')
}

async function updateSettings(values, actorId, client) {
   const params = [normalizeInternalId(actorId)]
   const assignments = ['updated_by = $1', 'updated_at = CURRENT_TIMESTAMP']
   for (const [field, column] of Object.entries(settingsColumns)) {
      if (values[field] === undefined) continue
      params.push(encode(column, values[field]))
      assignments.push(`${column} = ${placeholder(column, params.length)}`)
   }
   await client.query(`UPDATE site_settings SET ${assignments.join(', ')} WHERE id = 1`, params)
}

async function replaceSettingsTranslations(translations, client) {
   await client.query('DELETE FROM site_settings_translations')
   await insertTranslationRows('site_settings_translations', null, null, settingsText, translations, client)
}

export {
   deleteItem,
   findItem,
   findPublishedCourseBySlug,
   findSettings,
   findSiteCourseIdBySlug,
   findSiteImage,
   insertItem,
   insertSiteImage,
   listItems,
   lockCollectionIds,
   lockItem,
   lockSettings,
   nextPosition,
   platformCourseExists,
   replaceSettingsTranslations,
   replaceTranslations,
   setItemStatus,
   updateItem,
   updatePositions,
   updateSettings,
}
