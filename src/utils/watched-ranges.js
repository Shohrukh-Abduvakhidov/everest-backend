// Watched intervals of a video in whole seconds, as [start, end) pairs. Stored merged and
// sorted, so their total length is the unique watched time: seeking to the end adds only
// the seconds actually played.

const maximumRangesPerReport = 50
const maximumSeconds = 1000000

function isRange(value) {
   return Array.isArray(value) && value.length === 2
      && Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1])
      && value[0] >= 0 && value[1] > value[0] && value[1] <= maximumSeconds
}

// Returns null when the value is not a valid list; ranges are clamped to the duration and
// empty results dropped.
function normalizeRanges(value, durationSeconds = null) {
   if (!Array.isArray(value) || value.length > maximumRangesPerReport || !value.every(isRange)) {
      return null
   }
   return value
      .map(([start, end]) => (durationSeconds === null
         ? [start, end]
         : [Math.min(start, durationSeconds), Math.min(end, durationSeconds)]))
      .filter(([start, end]) => end > start)
}

// Touching ranges ([0, 10) and [10, 20)) merge into one.
function mergeRanges(...lists) {
   const sorted = lists.flat()
      .filter(isRange)
      .map(([start, end]) => [start, end])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
   const merged = []
   for (const range of sorted) {
      const last = merged.at(-1)
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
      else merged.push(range)
   }
   return merged
}

function totalSeconds(ranges) {
   return ranges.reduce((sum, [start, end]) => sum + end - start, 0)
}

export { maximumRangesPerReport, mergeRanges, normalizeRanges, totalSeconds }
