// Texts of in-app (and later Telegram) notifications, rendered once when the notification is
// created, in the recipient's profile language and time zone (decisions.md 2026-11-21, D2).
// The database stores Tajik as 'tg' (user_profiles.language_code); the API calls it 'tj'.
// Both are accepted here; anything else falls back to Russian.

const defaultLanguage = 'ru'
const defaultTimeZone = 'Asia/Dushanbe'
const languageAliases = { tg: 'tg', tj: 'tg', ru: 'ru', en: 'en' }
const maxParamLength = 120

const templates = {
   'test.assigned': {
      title: { ru: 'Новый тест', tg: 'Санҷиши нав', en: 'New test' },
      body: {
         ru: (p) => (p.closesAt ? `Новый тест «${p.test}». Доступен до ${p.closesAt}.` : `Новый тест «${p.test}».`),
         tg: (p) => (p.closesAt ? `Санҷиши нав «${p.test}». То ${p.closesAt} дастрас аст.` : `Санҷиши нав «${p.test}».`),
         en: (p) => (p.closesAt ? `New test “${p.test}”. Open until ${p.closesAt}.` : `New test “${p.test}”.`),
      },
   },
   'group.announcement': {
      title: { ru: 'Новое объявление', tg: 'Эълони нав', en: 'New announcement' },
      body: {
         ru: (p) => `${p.group}: новое объявление «${p.title}»`,
         tg: (p) => `${p.group}: эълони нав «${p.title}»`,
         en: (p) => `${p.group}: new announcement “${p.title}”`,
      },
   },
   'test.extra_attempts': {
      title: { ru: 'Дополнительные попытки', tg: 'Кӯшишҳои иловагӣ', en: 'Extra attempts' },
      body: {
         ru: (p) => `Вам выданы доп. попытки (${p.count}) в тесте «${p.test}».`,
         tg: (p) => `Ба шумо дар санҷиши «${p.test}» ${p.count} кӯшиши иловагӣ дода шуд.`,
         en: (p) => `You got ${p.count} extra attempt(s) for “${p.test}”.`,
      },
   },
   'account.approved': {
      title: { ru: 'Аккаунт одобрен', tg: 'Ҳисоб тасдиқ шуд', en: 'Account approved' },
      body: {
         ru: () => 'Ваш аккаунт EVEREST одобрен. Можно войти.',
         tg: () => 'Ҳисоби EVEREST-и шумо тасдиқ шуд. Метавонед ворид шавед.',
         en: () => 'Your EVEREST account is approved. You can sign in.',
      },
   },
   'account.unblocked': {
      title: { ru: 'Аккаунт активен', tg: 'Ҳисоб фаъол аст', en: 'Account active' },
      body: {
         ru: () => 'Ваш аккаунт EVEREST снова активен.',
         tg: () => 'Ҳисоби EVEREST-и шумо боз фаъол аст.',
         en: () => 'Your EVEREST account is active again.',
      },
   },
   'course.enrolled': {
      title: { ru: 'Новый курс', tg: 'Курси нав', en: 'New course' },
      body: {
         ru: (p) => `Вам открыт курс «${p.course}».`,
         tg: (p) => `Ба шумо курси «${p.course}» кушода шуд.`,
         en: (p) => `You now have access to “${p.course}”.`,
      },
   },
   'module.opened': {
      title: { ru: 'Модуль открыт', tg: 'Модул кушода шуд', en: 'Module opened' },
      body: {
         ru: (p) => `Вам открыт модуль «${p.module}» курса «${p.course}».`,
         tg: (p) => `Ба шумо модули «${p.module}»-и курси «${p.course}» кушода шуд.`,
         en: (p) => `Module “${p.module}” of “${p.course}” is now open to you.`,
      },
   },
   'test.closing_24h': {
      title: { ru: 'Скоро закрытие теста', tg: 'Санҷиш ба наздикӣ пӯшида мешавад', en: 'Test closing soon' },
      body: {
         ru: (p) => `До закрытия теста «${p.test}» осталось 24 часа.`,
         tg: (p) => `То пӯшидани санҷиши «${p.test}» 24 соат монд.`,
         en: (p) => `“${p.test}” closes in 24 hours.`,
      },
   },
   'test.answers_available': {
      title: { ru: 'Ответы открыты', tg: 'Ҷавобҳо кушода шуданд', en: 'Answers available' },
      body: {
         ru: (p) => `Открыты ответы теста «${p.test}».`,
         tg: (p) => `Ҷавобҳои санҷиши «${p.test}» кушода шуданд.`,
         en: (p) => `Answers for “${p.test}” are now available.`,
      },
   },
   'test.result_updated': {
      telegram: false,
      title: { ru: 'Результат обновлён', tg: 'Натиҷа нав шуд', en: 'Result updated' },
      body: {
         ru: (p) => `Результат теста «${p.test}» обновлён.`,
         tg: (p) => `Натиҷаи санҷиши «${p.test}» нав карда шуд.`,
         en: (p) => `Your result for “${p.test}” was updated.`,
      },
   },
   'attempt.expired': {
      telegram: false,
      title: { ru: 'Время вышло', tg: 'Вақт тамом шуд', en: 'Time is up' },
      body: {
         ru: (p) => `Время вышло, попытка в тесте «${p.test}» завершена.`,
         tg: (p) => `Вақт тамом шуд, кӯшиш дар санҷиши «${p.test}» анҷом ёфт.`,
         en: (p) => `Time is up: your attempt at “${p.test}” was submitted.`,
      },
   },
   // M13 (2026-11-26). On the site always; on Telegram only when the student turns it on.
   'achievement.unlocked': {
      telegramDefault: false,
      title: { ru: 'Новое достижение', tg: 'Дастоварди нав', en: 'New achievement' },
      body: {
         ru: (p) => `Вы получили достижение «${p.achievement}».`,
         tg: (p) => `Шумо дастоварди «${p.achievement}»-ро гирифтед.`,
         en: (p) => `You earned the achievement “${p.achievement}”.`,
      },
   },
   'telegram.disconnected': {
      telegram: false,
      title: { ru: 'Telegram отключён', tg: 'Telegram ҷудо шуд', en: 'Telegram disconnected' },
      body: {
         ru: () => 'Бот не может писать вам в Telegram. Подключите его снова в профиле.',
         tg: () => 'Бот ба шумо дар Telegram навишта наметавонад. Онро дар профил дубора пайваст кунед.',
         en: () => "The bot can't message you on Telegram. Reconnect it in your profile.",
      },
   },
}

const notificationEventCodes = Object.freeze(Object.keys(templates))
// Events that may also go to Telegram (D1); the others are in-app only.
const telegramEventCodes = Object.freeze(
   notificationEventCodes.filter((code) => templates[code].telegram !== false),
)

// Events whose Telegram copy is off until the student turns it on (no notification_preferences
// row means this default).
const telegramOffByDefault = Object.freeze(
   telegramEventCodes.filter((code) => templates[code].telegramDefault === false),
)

function telegramDefaultEnabled(eventCode) {
   return !telegramOffByDefault.includes(eventCode)
}

function resolveLanguage(languageCode) {
   return languageAliases[languageCode] || defaultLanguage
}

function resolveTimeZone(timeZone) {
   if (typeof timeZone !== 'string' || !timeZone) return defaultTimeZone
   try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
      return timeZone
   } catch {
      return defaultTimeZone
   }
}

// DD.MM.YYYY HH:mm in the given zone; the same form in every language.
function formatDateTime(value, timeZone) {
   const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
         timeZone: resolveTimeZone(timeZone),
         year: 'numeric', month: '2-digit', day: '2-digit',
         hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(value)).map((part) => [part.type, part.value]),
   )
   return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`
}

function shorten(value) {
   const text = String(value ?? '').replace(/\s+/g, ' ').trim()
   return text.length > maxParamLength ? `${text.slice(0, maxParamLength - 1)}…` : text
}

// params: plain values; keys ending in "At" are dates and are formatted in the recipient's zone.
// A value { ru, tg, en } is already translated: the recipient's language is taken (Russian when
// that one is missing), e.g. an achievement title from the catalog.
function renderNotification(eventCode, params, { languageCode, timeZone } = {}) {
   const template = templates[eventCode]
   if (!template) throw new Error(`Unknown notification event: ${eventCode}`)
   const language = resolveLanguage(languageCode)
   const values = Object.fromEntries(Object.entries(params || {}).map(([key, value]) => {
      if (value === null || value === undefined) return [key, null]
      if (key.endsWith('At')) return [key, formatDateTime(value, timeZone)]
      if (typeof value === 'object') return [key, shorten(value[language] ?? value[defaultLanguage] ?? '')]
      return [key, shorten(value)]
   }))
   return { title: template.title[language], body: template.body[language](values) }
}

// The moment after which a Telegram copy no longer makes sense (D5, QUIET_EXPIRED), or null.
// Only the 24-hour reminder has one: the close time, kept as the last part of its key
// (test.closing_24h:<assignmentId>:<closesAt ISO>), so no extra column is needed.
function notificationExpiresAt(eventCode, dedupeKey) {
   if (eventCode !== 'test.closing_24h' || typeof dedupeKey !== 'string') return null
   const match = /^test\.closing_24h:\d+:(.+)$/.exec(dedupeKey)
   const value = match ? new Date(match[1]) : null
   return value && !Number.isNaN(value.getTime()) ? value : null
}

const telegramTextLimit = 4000

// Plain text for Telegram (no parse_mode): title, body and, when APP_URL is set, the link.
function telegramMessageText({ title, body, targetPath }, appUrl) {
   const link = appUrl && targetPath && targetPath.startsWith('/') ? `${appUrl}${targetPath}` : null
   const text = [title, body, link].filter(Boolean).join('\n\n')
   return text.length > telegramTextLimit ? `${text.slice(0, telegramTextLimit - 1)}…` : text
}

export {
   formatDateTime,
   notificationEventCodes,
   notificationExpiresAt,
   renderNotification,
   resolveLanguage,
   telegramDefaultEnabled,
   telegramEventCodes,
   telegramOffByDefault,
   telegramMessageText,
}
