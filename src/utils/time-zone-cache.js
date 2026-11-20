// An in-process cache of a set of time zone names. The list is loaded on the first lookup and
// reloaded once it is older than ttlMs. Concurrent lookups share one load. When a reload fails
// and an older list exists, the older list keeps serving and the next lookup tries again; a
// failure of the very first load is thrown to the caller.

const dayMs = 24 * 60 * 60 * 1000

function createTimeZoneCache({ load, clock = () => Date.now(), ttlMs = dayMs }) {
   let names = null
   let loadedAt = 0
   let pending = null

   async function refresh() {
      if (!pending) {
         pending = (async () => {
            try {
               const list = await load()
               names = new Set(list)
               loadedAt = clock()
            } finally {
               pending = null
            }
         })()
      }
      return pending
   }

   async function has(name) {
      if (typeof name !== 'string' || name.length === 0) return false
      const stale = names === null || clock() - loadedAt >= ttlMs
      if (stale) {
         try {
            await refresh()
         } catch (error) {
            if (names === null) throw error
         }
      }
      return names.has(name)
   }

   function clear() {
      names = null
      loadedAt = 0
   }

   return { has, clear }
}

export { createTimeZoneCache, dayMs }
