import { listTimeZoneNames } from '../repositories/timezone-repository.js'
import { createTimeZoneCache } from '../utils/time-zone-cache.js'

// Validation of a stored profile time zone against the names PostgreSQL accepts. Intl is not
// used for this: it accepts offset zones such as "+05:00", which AT TIME ZONE reads as a POSIX
// zone with the opposite sign. The list lives in process memory and is reloaded once a day.
const cache = createTimeZoneCache({ load: () => listTimeZoneNames() })

async function isKnownTimeZoneService(name) {
   return cache.has(name)
}

export { isKnownTimeZoneService }
