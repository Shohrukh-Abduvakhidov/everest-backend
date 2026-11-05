// Lesson content block helpers (the lesson-service block shapes) and catalog builders.

export const h1 = (text) => ({ type: 'heading', text, level: 1 })
export const h2 = (text) => ({ type: 'heading', text, level: 2 })
export const h3 = (text) => ({ type: 'heading', text, level: 3 })
export const p = (text) => ({ type: 'paragraph', text })
export const ul = (...items) => ({ type: 'list', items, ordered: false })
export const ol = (...items) => ({ type: 'list', items, ordered: true })
export const hr = () => ({ type: 'divider' })
export const quote = (text) => ({ type: 'quote', text })
export const note = (text, tone = 'info') => ({ type: 'callout', text, tone })

// status 'published' lessons are published by the seed; video lessons always stay draft
// because the demo has no real storage.
export function lesson(title, tgTitle, lessonType, blocks) {
   return { title, tgTitle, lessonType, blocks }
}

export function module(title, tgTitle, status, lessons) {
   return { title, tgTitle, status, lessons }
}

export function videoLesson(title, tgTitle, summary) {
   return lesson(title, tgTitle, 'video', [
      h2(title),
      p(summary),
      note('Видео ещё не загружено: урок остаётся черновиком до загрузки записи.', 'warning'),
   ])
}
