// Quiet hours (decisions.md 2026-11-21, D5): a daily window in the user's time zone during which
// Telegram messages wait. start == end is not allowed; start > end crosses midnight.

const defaultQuietHours = Object.freeze({ start: '22:00', end: '08:00' })
const timePattern = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

function parseTime(value) {
   if (typeof value !== 'string') return null
   const match = timePattern.exec(value.slice(0, 5))
   if (!match || (value.length !== 5 && !/^\d\d:\d\d:00$/.test(value))) return null
   return Number(match[1]) * 60 + Number(match[2])
}

function formatTime(value) {
   if (value === null || value === undefined) return null
   return String(value).slice(0, 5)
}

function validTimeZone(timeZone) {
   try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
      return timeZone
   } catch {
      return 'Asia/Dushanbe'
   }
}

// Minutes since local midnight and the seconds/milliseconds of the current minute.
function localClock(now, timeZone) {
   const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: validTimeZone(timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
   }).formatToParts(now).map((part) => [part.type, part.value]))
   return { minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

function insideWindow(minutes, start, end) {
   return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

// null when sending is allowed now, otherwise the instant the window ends (start of the end
// minute in local time). Zones without DST (Asia/Dushanbe) are exact; around a DST change the
// result can be off by the shift, which only delays or advances one message.
function quietUntil(now, { start, end, timeZone }) {
   const startMinutes = parseTime(start)
   const endMinutes = parseTime(end)
   if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null
   const { minutes } = localClock(now, timeZone)
   if (!insideWindow(minutes, startMinutes, endMinutes)) return null
   const wait = (endMinutes - minutes + 1440) % 1440
   const minuteStart = new Date(now)
   minuteStart.setUTCSeconds(0, 0)
   return new Date(minuteStart.getTime() + wait * 60000)
}

export { defaultQuietHours, formatTime, parseTime, quietUntil }
