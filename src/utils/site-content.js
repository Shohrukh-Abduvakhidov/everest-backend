import AppError from './app-error.js'
import { normalizePhone } from './auth-input.js'

// Pure rules of the marketing site module: field specs, input parsing, language fallback,
// video links, phones, hours and image sizes. No database or HTTP access.
//
// Translatable fields travel as one object per field, { ru, tj, en } (ru is the fallback).
// Storage keeps one translation row per language with the database code 'tg' for Tajik,
// as subject/section/topic translations do; this module converts between the two shapes.

const languages = Object.freeze(['ru', 'tg', 'en'])
const apiToDb = Object.freeze({ ru: 'ru', tj: 'tg', en: 'en' })
const dbToApi = Object.freeze({ ru: 'ru', tg: 'tj', en: 'en' })
const fallbackLanguage = 'ru'
const timeZone = 'Asia/Dushanbe'
// Asia/Dushanbe is UTC+05:00 all year (no daylight saving time).
const dushanbeOffsetMs = 5 * 3600 * 1000

const subjectKeys = Object.freeze(['biology', 'chemistry', 'physics', 'tajik'])
const courseFormats = Object.freeze(['online', 'offline', 'hybrid'])
const employmentTypes = Object.freeze(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN'])
const eventTypes = Object.freeze(['enrollment', 'mock-nct', 'open-lesson', 'other'])
const eventModes = Object.freeze(['online', 'offline'])
const videoPlacements = Object.freeze(['home', 'course'])
const weekDays = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
const statuses = Object.freeze(['draft', 'published'])
const collections = Object.freeze(['courses', 'vacancies', 'events', 'videos'])
const templatePlaceholders = Object.freeze(['course', 'vacancy', 'event'])

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
const youtubeIdPattern = /^[A-Za-z0-9_-]{11}$/
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
const vimeoHosts = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'])
const isoDurationPattern = /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/

const limits = Object.freeze({ title: 200, text: 2000, long: 5000, item: 300, listItems: 30, slug: 64 })

// name: storage field (the repository maps it to a column); kind: value type;
// path: where the field sits in API objects (default [name]).
const field = (name, kind, path = [name]) => Object.freeze({ name, kind, path })
const translatableFields = Object.freeze({
   courses: [
      field('title', 'title'), field('summary', 'text'), field('description', 'long'),
      field('audience', 'title'), field('duration', 'title'), field('label', 'title'),
      field('topics', 'strings'), field('learn', 'strings'), field('howItWorks', 'strings'),
      field('program', 'program'), field('coverAlt', 'title'),
      field('seoTitle', 'title', ['seo', 'title']), field('seoDescription', 'text', ['seo', 'description']),
   ],
   vacancies: [
      field('title', 'title'), field('location', 'title'), field('description', 'long'),
      field('requirements', 'strings'), field('conditions', 'strings'),
   ],
   events: [
      field('title', 'title'), field('description', 'long'), field('location', 'title'), field('imageAlt', 'title'),
   ],
   videos: [field('title', 'title'), field('description', 'long'), field('thumbnailAlt', 'title')],
   settings: [
      field('address', 'text'), field('whatsappTemplate', 'template'), field('whatsappCourseTemplate', 'template'),
      field('heroTitle', 'title', ['hero', 'title']), field('heroSubtitle', 'text', ['hero', 'subtitle']),
      field('heroPrimaryCta', 'title', ['hero', 'primaryCta']),
      field('heroSecondaryCta', 'title', ['hero', 'secondaryCta']),
      field('heroImageAlt', 'title', ['hero', 'imageAlt']),
      field('whyEverest', 'steps'), field('stages', 'steps'),
      field('seoTitle', 'title', ['seo', 'title']), field('seoDescription', 'text', ['seo', 'description']),
      field('seoImageAlt', 'title', ['seo', 'ogImageAlt']),
   ],
})

const listKinds = new Set(['strings', 'steps', 'program'])

function validationError(fieldName, message = `${fieldName} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field: fieldName, message }])
}

function isPlainObject(value) {
   return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireCollection(value) {
   if (!collections.includes(value)) throw new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found')
   return value
}

function getPath(object, path) {
   return path.reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), object)
}

function setPath(object, path, value) {
   let target = object
   for (const key of path.slice(0, -1)) {
      target[key] ||= {}
      target = target[key]
   }
   target[path.at(-1)] = value
}

// Rejects any key that is not a declared path (top level and inside groups such as hero, seo).
function rejectUnknownPaths(body, paths) {
   if (!isPlainObject(body)) throw validationError('body')
   const walk = (value, prefix) => {
      for (const key of Object.keys(value)) {
         const path = [...prefix, key]
         const exact = paths.some((candidate) => candidate.length === path.length
            && candidate.every((part, index) => part === path[index]))
         const group = paths.some((candidate) => candidate.length > path.length
            && path.every((part, index) => candidate[index] === part))
         if (exact) continue
         if (group && isPlainObject(value[key])) {
            walk(value[key], path)
            continue
         }
         throw validationError(path.join('.'), `${path.join('.')} is not allowed`)
      }
   }
   walk(body, [])
}

// lang=ru|tj|en (default ru); 'tg' is accepted as an alias of 'tj'.
function parseApiLanguage(value) {
   if (value === undefined || value === '') return 'ru'
   if (value === 'tg') return 'tg'
   if (typeof value !== 'string' || !Object.hasOwn(apiToDb, value)) {
      throw validationError('lang', 'lang must be ru, tj or en')
   }
   return apiToDb[value]
}

function parseText(value, fieldName, max) {
   if (value === null) return null
   if (typeof value !== 'string') throw validationError(fieldName)
   const text = value.trim()
   if (text.length > max) throw validationError(fieldName, `${fieldName} must be at most ${max} characters`)
   return text || null
}

function parseStringList(value, fieldName, max = limits.item) {
   if (!Array.isArray(value) || value.length > limits.listItems) {
      throw validationError(fieldName, `${fieldName} must be a list of at most ${limits.listItems} items`)
   }
   return value.map((item, index) => {
      const text = parseText(item, `${fieldName}[${index}]`, max)
      if (!text) throw validationError(`${fieldName}[${index}]`, 'List items must not be empty')
      return text
   })
}

function parseObjectList(value, fieldName, parseItem) {
   if (!Array.isArray(value) || value.length > limits.listItems) {
      throw validationError(fieldName, `${fieldName} must be a list of at most ${limits.listItems} items`)
   }
   return value.map((item, index) => {
      const path = `${fieldName}[${index}]`
      if (!isPlainObject(item)) throw validationError(path)
      return parseItem(item, path)
   })
}

function rejectExtraKeys(item, keys, path) {
   const unknown = Object.keys(item).find((key) => !keys.includes(key))
   if (unknown) throw validationError(`${path}.${unknown}`, `${unknown} is not allowed`)
}

function parseTemplate(value, fieldName) {
   const text = parseText(value, fieldName, limits.text)
   for (const [, name] of (text || '').matchAll(/\{([^{}]*)\}/g)) {
      if (!templatePlaceholders.includes(name)) {
         throw validationError(fieldName, 'Placeholders are {course}, {vacancy} and {event}')
      }
   }
   return text
}

function parseFieldValue(kind, value, fieldName) {
   if (kind === 'title') return parseText(value, fieldName, limits.title)
   if (kind === 'text') return parseText(value, fieldName, limits.text)
   if (kind === 'long') return parseText(value, fieldName, limits.long)
   if (kind === 'template') return parseTemplate(value, fieldName)
   if (value === null) return []
   if (kind === 'strings') return parseStringList(value, fieldName)
   if (kind === 'steps') {
      return parseObjectList(value, fieldName, (item, path) => {
         rejectExtraKeys(item, ['title', 'text'], path)
         const title = item.title === undefined ? null : parseText(item.title, `${path}.title`, limits.title)
         if (!title) throw validationError(`${path}.title`, 'title is required')
         return { title, text: item.text === undefined ? '' : parseText(item.text, `${path}.text`, limits.text) ?? '' }
      })
   }
   return parseObjectList(value, fieldName, (item, path) => {
      rejectExtraKeys(item, ['title', 'items'], path)
      const title = item.title === undefined ? null : parseText(item.title, `${path}.title`, limits.title)
      if (!title) throw validationError(`${path}.title`, 'title is required')
      return { title, items: item.items === undefined || item.items === null ? [] : parseStringList(item.items, `${path}.items`) }
   })
}

// { ru?, tj?, en? } -> { ru?, tg?, en? }; null clears the language's value.
function parseLocalized(kind, value, fieldName) {
   if (!isPlainObject(value)) throw validationError(fieldName, `${fieldName} must be an object { ru, tj, en }`)
   const parsed = {}
   for (const [language, languageValue] of Object.entries(value)) {
      if (!Object.hasOwn(apiToDb, language)) throw validationError(`${fieldName}.${language}`, 'Languages are ru, tj and en')
      parsed[apiToDb[language]] = parseFieldValue(kind, languageValue, `${fieldName}.${language}`)
   }
   return parsed
}

// Request body -> { ru: { name: value }, tg: {...}, en: {...} } with only the values sent.
function parseTranslatableInput(kind, body) {
   const changes = {}
   for (const spec of translatableFields[kind]) {
      const value = getPath(body, spec.path)
      if (value === undefined) continue
      const parsed = parseLocalized(spec.kind, value, spec.path.join('.'))
      for (const [language, languageValue] of Object.entries(parsed)) {
         changes[language] ||= {}
         changes[language][spec.name] = languageValue
      }
   }
   return changes
}

function isEmptyValue(value) {
   return value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
}

function emptyTranslation(kind) {
   return Object.fromEntries(translatableFields[kind].map((spec) => [spec.name, listKinds.has(spec.kind) ? [] : null]))
}

// Stored rows + changes -> the complete new set; a language with no value left is dropped.
function mergeTranslations(kind, stored, changes) {
   const result = {}
   for (const language of languages) {
      const merged = { ...emptyTranslation(kind), ...(stored?.[language] || {}), ...(changes[language] || {}) }
      if (Object.values(merged).some((value) => !isEmptyValue(value))) result[language] = merged
   }
   return result
}

// Stored rows -> API objects { ru, tj, en } placed at their paths.
function adminTranslatables(kind, stored) {
   const result = {}
   for (const spec of translatableFields[kind]) {
      const empty = listKinds.has(spec.kind) ? [] : null
      setPath(result, spec.path, Object.fromEntries(languages.map((language) => [
         dbToApi[language],
         stored?.[language]?.[spec.name] ?? empty,
      ])))
   }
   return result
}

// Per field: the requested language, else Russian. Returns storage names -> values.
function localize(kind, stored, language) {
   const result = {}
   for (const spec of translatableFields[kind]) {
      const own = stored?.[language]?.[spec.name]
      const value = !isEmptyValue(own) ? own : stored?.[fallbackLanguage]?.[spec.name]
      result[spec.name] = isEmptyValue(value) ? (listKinds.has(spec.kind) ? [] : null) : value
   }
   return result
}

// Localized values placed at their API paths (flat names stay flat, seo/hero become groups).
function placeLocalized(kind, values, omit = []) {
   const result = {}
   for (const spec of translatableFields[kind]) {
      if (!omit.includes(spec.name)) setPath(result, spec.path, values[spec.name])
   }
   return result
}

// The language an object is shown in: the requested one when it has its own title (settings:
// any own text), otherwise Russian. Returned as the API code.
function resolvedLanguage(stored, language, key = 'title') {
   const own = stored?.[language]
   const hasOwn = key ? !isEmptyValue(own?.[key]) : Boolean(own && Object.values(own).some((value) => !isEmptyValue(value)))
   return dbToApi[hasOwn ? language : fallbackLanguage]
}

// { ru, tj, en } of short labels inside a JSONB list (phones, stats) <-> stored { ru, tg, en }.
function parseLabel(value, fieldName, required) {
   if (value === null || value === undefined) {
      if (required) throw validationError(`${fieldName}.ru`, 'The Russian label is required')
      return {}
   }
   const parsed = parseLocalized('title', value, fieldName)
   const label = Object.fromEntries(Object.entries(parsed).filter(([, text]) => text))
   if (required && !label.ru) throw validationError(`${fieldName}.ru`, 'The Russian label is required')
   return label
}

function labelToApi(label) {
   return Object.fromEntries(languages.map((language) => [dbToApi[language], label?.[language] ?? null]))
}

function localizeLabel(label, language) {
   return label?.[language] || label?.[fallbackLanguage] || null
}

function parseSlug(value, fieldName = 'slug') {
   if (typeof value !== 'string' || value.length > limits.slug || !slugPattern.test(value)) {
      throw validationError(fieldName, `${fieldName} must be lowercase latin letters, digits and single hyphens`)
   }
   return value
}

function parseEnum(value, allowed, fieldName, nullable = false) {
   if (nullable && value === null) return null
   if (!allowed.includes(value)) throw validationError(fieldName, `${fieldName} must be one of ${allowed.join(', ')}`)
   return value
}

function parseUrl(value, fieldName) {
   if (typeof value !== 'string' || value.length > 1000) throw validationError(fieldName)
   let url
   try {
      url = new URL(value.trim())
   } catch {
      throw validationError(fieldName, `${fieldName} must be an absolute URL`)
   }
   if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw validationError(fieldName, `${fieldName} must be an http(s) URL`)
   }
   return url
}

// YouTube (youtube.com watch/embed/shorts/live/v, youtu.be), Vimeo (vimeo.com/<id>,
// player.vimeo.com/video/<id>) or an https .mp4/.webm file. Anything else is refused.
function parseVideoUrl(value, fieldName = 'url') {
   const refuse = () => validationError(fieldName, 'Use a youtube.com, youtu.be or vimeo.com link, or an https .mp4/.webm file')
   let url
   try {
      url = parseUrl(value, fieldName)
   } catch {
      throw refuse()
   }
   if (url.port) throw refuse()
   const host = url.hostname.toLowerCase()
   const parts = url.pathname.split('/')
   if (host === 'youtu.be' || youtubeHosts.has(host)) {
      let videoId = null
      if (host === 'youtu.be') videoId = parts[1] || null
      else if (parts[1] === 'watch' && !parts[2]) videoId = url.searchParams.get('v')
      else if (['embed', 'shorts', 'live', 'v'].includes(parts[1])) videoId = parts[2] || null
      if (!videoId || !youtubeIdPattern.test(videoId)) throw refuse()
      return { provider: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}` }
   }
   if (vimeoHosts.has(host)) {
      const videoId = host === 'player.vimeo.com' ? (parts[1] === 'video' ? parts[2] : null) : parts[1]
      if (!videoId || !/^[0-9]{1,15}$/.test(videoId)) throw refuse()
      return { provider: 'vimeo', videoId, url: `https://vimeo.com/${videoId}` }
   }
   if (url.protocol === 'https:' && /\.(mp4|webm)$/i.test(url.pathname)) {
      return { provider: 'file', videoId: null, url: url.toString() }
   }
   throw refuse()
}

// Kept for clarity in tests: only YouTube links.
function parseYoutubeUrl(value, fieldName = 'url') {
   const video = parseVideoUrl(value, fieldName)
   if (video.provider !== 'youtube') throw validationError(fieldName, 'Only youtube.com and youtu.be links are accepted')
   return video
}

function parseIsoDuration(value, fieldName = 'duration') {
   if (value === null) return null
   if (typeof value !== 'string' || !isoDurationPattern.test(value)) {
      throw validationError(fieldName, `${fieldName} must be an ISO 8601 duration such as PT4M13S`)
   }
   return value
}

function parseDate(value, fieldName) {
   if (value === null) return null
   if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw validationError(fieldName, `${fieldName} must be a date YYYY-MM-DD`)
   }
   const date = new Date(`${value}T00:00:00Z`)
   if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw validationError(fieldName, `${fieldName} is not a valid date`)
   }
   return value
}

function parseSalary(value) {
   if (value === null) return { min: null, max: null, currency: null }
   if (!isPlainObject(value)) throw validationError('salary', 'salary must be { min?, max?, currency: "TJS" } or null')
   rejectExtraKeys(value, ['min', 'max', 'currency'], 'salary')
   if (value.currency !== 'TJS') throw validationError('salary.currency', 'currency must be TJS')
   const amount = (key) => {
      if (value[key] === undefined || value[key] === null) return null
      if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100000000) {
         throw validationError(`salary.${key}`, `${key} must be a whole non-negative number`)
      }
      return value[key]
   }
   const min = amount('min')
   const max = amount('max')
   if (min === null && max === null) throw validationError('salary', 'Give min, max or both')
   if (min !== null && max !== null && max < min) throw validationError('salary.max', 'max must not be below min')
   return { min, max, currency: 'TJS' }
}

// An ISO instant with an offset, or a local 'YYYY-MM-DDTHH:mm[:ss]' read as Asia/Dushanbe.
function parseDushanbeDateTime(value, fieldName) {
   if (value === null) return null
   if (typeof value !== 'string') throw validationError(fieldName)
   const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
   let date
   if (local) {
      const [, year, month, day, hour, minute, second = '0'] = local
      const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
      const check = new Date(utc)
      if (check.getUTCDate() !== Number(day) || check.getUTCMonth() !== Number(month) - 1
         || check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute)) {
         throw validationError(fieldName, `${fieldName} is not a valid date`)
      }
      date = new Date(utc - dushanbeOffsetMs)
   } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
      date = new Date(value)
   } else {
      throw validationError(fieldName, `${fieldName} must be ISO 8601 with an offset, or a local Asia/Dushanbe time`)
   }
   if (Number.isNaN(date.getTime())) throw validationError(fieldName, `${fieldName} is not a valid date`)
   return date.toISOString()
}

// ISO 8601 with the Dushanbe offset: 2026-12-05T10:00:00+05:00.
function toDushanbeIso(value) {
   if (value === null || value === undefined) return null
   return `${new Date(new Date(value).getTime() + dushanbeOffsetMs).toISOString().slice(0, 19)}+05:00`
}

function toDateString(value) {
   if (value === null || value === undefined) return null
   if (typeof value === 'string') return value.slice(0, 10)
   // pg returns DATE as a local-midnight Date; read its local calendar day.
   const pad = (number) => String(number).padStart(2, '0')
   return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function dushanbeToday(now = new Date()) {
   return new Date(now.getTime() + dushanbeOffsetMs).toISOString().slice(0, 10)
}

// A Tajik number may be given without the country code (9 digits) or with 992 and no plus;
// the result is E.164 as everywhere in the project (normalizePhone). +992 needs 9 digits.
function normalizeSitePhone(value, fieldName) {
   if (typeof value !== 'string') throw validationError(fieldName, 'Phone must be a string')
   const compact = value.trim().replace(/[()\s-]/g, '')
   let candidate = value.trim()
   if (/^[0-9]{9}$/.test(compact)) candidate = `+992${compact}`
   else if (/^992[0-9]{9}$/.test(compact)) candidate = `+${compact}`
   else if (/^00[1-9][0-9]+$/.test(compact)) candidate = `+${compact.slice(2)}`
   let phone
   try {
      phone = normalizePhone(candidate)
   } catch {
      throw validationError(fieldName, 'Phone must be a valid number, e.g. +992 90 123 45 67')
   }
   if (phone.startsWith('+992') && phone.length !== 13) {
      throw validationError(fieldName, 'A +992 number has 9 digits after the country code')
   }
   return phone
}

// [{ number, label: { ru, tj, en } }] -> stored [{ number, label: { ru, tg, en } }].
function parsePhones(value) {
   if (value === null) return []
   if (!Array.isArray(value) || value.length > 10) throw validationError('phones', 'phones must be a list of at most 10 entries')
   const seen = new Set()
   return value.map((item, index) => {
      const path = `phones[${index}]`
      if (!isPlainObject(item)) throw validationError(path, 'Each phone is { number, label }')
      rejectExtraKeys(item, ['number', 'label'], path)
      const number = normalizeSitePhone(item.number, `${path}.number`)
      if (seen.has(number)) throw validationError(`${path}.number`, 'The number is listed twice')
      seen.add(number)
      return { number, label: parseLabel(item.label, `${path}.label`, false) }
   })
}

// [{ value, label: { ru, tj, en } }]; ru label required.
function parseStats(value) {
   if (value === null) return []
   return parseObjectList(value, 'stats.items', (item, path) => {
      rejectExtraKeys(item, ['value', 'label'], path)
      const text = item.value === undefined ? null : parseText(item.value, `${path}.value`, 32)
      if (!text) throw validationError(`${path}.value`, 'value is required')
      return { value: text, label: parseLabel(item.label, `${path}.label`, true) }
   })
}

// [{ days: ['mon'..'sun'], opens: 'HH:mm', closes: 'HH:mm' }].
function parseHours(value) {
   if (value === null) return []
   if (!Array.isArray(value) || value.length > 7) throw validationError('hours', 'hours must be a list of at most 7 entries')
   const used = new Set()
   return value.map((item, index) => {
      const path = `hours[${index}]`
      if (!isPlainObject(item)) throw validationError(path)
      rejectExtraKeys(item, ['days', 'opens', 'closes'], path)
      if (!Array.isArray(item.days) || !item.days.length || item.days.some((day) => !weekDays.includes(day))) {
         throw validationError(`${path}.days`, `days must list ${weekDays.join(', ')}`)
      }
      for (const day of item.days) {
         if (used.has(day)) throw validationError(`${path}.days`, `${day} is listed twice`)
         used.add(day)
      }
      const time = (key) => {
         if (typeof item[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item[key])) {
            throw validationError(`${path}.${key}`, `${key} must be HH:mm`)
         }
         return item[key]
      }
      const opens = time('opens')
      const closes = time('closes')
      if (closes <= opens) throw validationError(`${path}.closes`, 'closes must be after opens')
      return { days: weekDays.filter((day) => item.days.includes(day)), opens, closes }
   })
}

// '@name', 'name' or a profile link -> the bare username.
function parseUsername(value, fieldName, { hosts, pattern }) {
   if (value === null) return null
   if (typeof value !== 'string') throw validationError(fieldName)
   let text = value.trim()
   if (!text) return null
   if (/^https?:\/\//i.test(text)) {
      let url
      try {
         url = new URL(text)
      } catch {
         throw validationError(fieldName)
      }
      if (!hosts.includes(url.hostname.toLowerCase())) throw validationError(fieldName, `Use a ${hosts[0]} link or a username`)
      text = url.pathname.split('/').filter(Boolean)[0] || ''
   }
   text = text.replace(/^@/, '')
   if (!pattern.test(text)) throw validationError(fieldName, 'Username is invalid')
   return text
}

function parseTelegram(value) {
   return parseUsername(value, 'telegram', {
      hosts: ['t.me', 'telegram.me', 'www.t.me'],
      pattern: /^[A-Za-z][A-Za-z0-9_]{3,31}$/,
   })
}

function parseInstagram(value) {
   return parseUsername(value, 'instagram', {
      hosts: ['instagram.com', 'www.instagram.com'],
      pattern: /^[A-Za-z0-9._]{1,30}$/,
   })
}

function parsePlayMarketUrl(value) {
   if (value === null || value === '') return null
   const url = parseUrl(value, 'playMarketUrl')
   if (url.protocol !== 'https:' || url.hostname !== 'play.google.com' || !url.pathname.startsWith('/store/apps/')) {
      throw validationError('playMarketUrl', 'Use a https://play.google.com/store/apps/... link')
   }
   return url.toString()
}

function parseGeo(value) {
   if (value === null) return { lat: null, lng: null }
   if (!isPlainObject(value) || Object.keys(value).sort().join() !== 'lat,lng') {
      throw validationError('geo', 'geo must be { lat, lng } or null')
   }
   const { lat, lng } = value
   if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) throw validationError('geo.lat')
   if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) throw validationError('geo.lng')
   return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
}

function whatsappUrl(phone, message) {
   if (!phone) return null
   const digits = phone.replace(/^\+/, '')
   return message ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : `https://wa.me/${digits}`
}

// Width and height from the bytes of a PNG (IHDR) or JPEG (first SOFn marker).
function imageDimensions(buffer, mimeType) {
   if (mimeType === 'image/png') {
      if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
   }
   let offset = 2
   while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return null
      const marker = buffer[offset + 1]
      if (marker === 0xff) {
         offset += 1
         continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
         offset += 2
         continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
         return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (length < 2) return null
      offset += 2 + length
   }
   return null
}

export {
   adminTranslatables,
   collections,
   courseFormats,
   dbToApi,
   dushanbeToday,
   employmentTypes,
   eventModes,
   eventTypes,
   fallbackLanguage,
   imageDimensions,
   isPlainObject,
   labelToApi,
   languages,
   limits,
   localize,
   localizeLabel,
   mergeTranslations,
   normalizeSitePhone,
   parseApiLanguage,
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
   parseYoutubeUrl,
   placeLocalized,
   rejectUnknownPaths,
   requireCollection,
   resolvedLanguage,
   statuses,
   subjectKeys,
   timeZone,
   toDateString,
   toDushanbeIso,
   translatableFields,
   validationError,
   videoPlacements,
   whatsappUrl,
}
