import * as authRepository from '../repositories/auth-repository.js'
import * as taxonomyRepository from '../repositories/taxonomy-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const languages = ['tg', 'ru', 'en']
const codePattern = /^[a-z0-9][a-z0-9_-]{0,49}$/
// Palette keys only; the frontend maps each key to its design tokens.
const subjectColors = ['green', 'blue', 'orange', 'purple', 'neutral']
const labels = Object.freeze({
   subject: { name: 'Subject', code: 'SUBJECT' },
   section: { name: 'Section', code: 'SECTION' },
   topic: { name: 'Topic', code: 'TOPIC' },
})

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || taxonomyRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function parseEntityId(kind, value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, `INVALID_${labels[kind].code}_ID`, `${labels[kind].name} identifier is invalid`)
   }
}

function parseNullableReference(value, field) {
   if (value === null) return null
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

function notFound(kind) {
   return new AppError(404, `${labels[kind].code}_NOT_FOUND`, `${labels[kind].name} was not found`)
}

function requireEntity(kind, row) {
   if (!row) throw notFound(kind)
   return row
}

function parseTranslations(value) {
   if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('translations')
   const parsed = {}
   for (const [language, translation] of Object.entries(value)) {
      if (!languages.includes(language) || !translation || typeof translation !== 'object'
         || Array.isArray(translation) || Object.keys(translation).join() !== 'title'
         || typeof translation.title !== 'string') {
         throw validationError('translations')
      }
      const title = translation.title.trim()
      if (!title || title.length > 200) throw validationError('translations')
      parsed[language] = { title }
   }
   return parsed
}

function parseBody(kind, body, partial) {
   const allowed = ['code', 'primaryLanguage', 'translations']
   if (kind === 'topic') allowed.push('sectionId', 'parentId')
   if (kind === 'subject') allowed.push('color')
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => !allowed.includes(field))
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   if (partial && !Object.keys(body).length) throw validationError('body')
   if (!partial || body.code !== undefined) {
      if (typeof body.code !== 'string' || !codePattern.test(body.code)) throw validationError('code')
   }
   if (body.primaryLanguage !== undefined && !languages.includes(body.primaryLanguage)) {
      throw validationError('primaryLanguage')
   }
   if (body.color !== undefined && !subjectColors.includes(body.color)) throw validationError('color')
   if (!partial && body.translations === undefined) throw validationError('translations')
   return {
      code: body.code === undefined ? null : body.code,
      primaryLanguage: body.primaryLanguage === undefined ? (partial ? null : 'tg') : body.primaryLanguage,
      color: body.color === undefined ? (partial ? null : 'neutral') : body.color,
      hasTranslations: body.translations !== undefined,
      translations: body.translations === undefined ? null : parseTranslations(body.translations),
      hasSectionId: body.sectionId !== undefined,
      sectionId: body.sectionId === undefined ? null : parseNullableReference(body.sectionId, 'sectionId'),
      hasParentId: body.parentId !== undefined,
      parentId: body.parentId === undefined ? null : parseNullableReference(body.parentId, 'parentId'),
   }
}

// The primary-language title is the entity's display name, so it must always exist.
function requirePrimaryTitle(primaryLanguage, translations) {
   if (!translations?.[primaryLanguage]) {
      throw validationError('translations', 'translations must include the primary language title')
   }
}

function safeEntity(kind, row) {
   const title = row.translations[row.primary_language]?.title || null
   return {
      id: row.id,
      ...(kind === 'subject' ? {} : { subjectId: row.subject_id }),
      ...(kind === 'topic' ? { sectionId: row.section_id, parentId: row.parent_id } : {}),
      code: row.code,
      primaryLanguage: row.primary_language,
      title,
      translations: row.translations,
      ...(kind === 'subject' ? { color: row.color } : {}),
   }
}

function mapConstraintError(kind, error) {
   if (error.code === '23505') {
      return new AppError(409, `${labels[kind].code}_CODE_CONFLICT`, `${labels[kind].name} code already exists`)
   }
   if (error.code === '23503') {
      return new AppError(409, `${labels[kind].code}_IN_USE`, `${labels[kind].name} is still referenced`)
   }
   return error
}

async function audit(auth, client, actorId, kind, action, entityId, metadata = {}) {
   await auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code: `taxonomy.${kind}.${action}`,
      entityType: kind,
      entityId,
      metadata,
   }, client)
}

async function validateTopicReferences(repository, client, subjectId, values, topicId = null) {
   if (values.hasSectionId && values.sectionId !== null) {
      const section = await repository.lockEntity('section', values.sectionId, client)
      if (!section || section.subject_id !== subjectId) {
         throw new AppError(422, 'TAXONOMY_SUBJECT_MISMATCH', 'Section belongs to another subject')
      }
   }
   if (values.hasParentId && values.parentId !== null) {
      await repository.lockTopicTree(subjectId, client)
      const parent = await repository.lockEntity('topic', values.parentId, client)
      if (!parent || parent.subject_id !== subjectId) {
         throw new AppError(422, 'TAXONOMY_SUBJECT_MISMATCH', 'Parent topic belongs to another subject')
      }
      if (topicId && (values.parentId === topicId
         || await repository.topicParentCreatesCycle(topicId, values.parentId, client))) {
         throw new AppError(409, 'TOPIC_CYCLE', 'Topic parent would create a cycle')
      }
   }
}

async function listSubjectsService(overrides) {
   const { repository } = dependencies(overrides)
   const rows = await repository.listEntities('subject')
   return { subjects: rows.map((row) => safeEntity('subject', row)) }
}

async function listSubjectChildrenService(kind, subjectIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const subjectId = parseEntityId('subject', subjectIdValue)
   requireEntity('subject', await repository.findEntity('subject', subjectId))
   const rows = await repository.listEntities(kind, subjectId)
   return { [`${kind}s`]: rows.map((row) => safeEntity(kind, row)) }
}

async function listSectionsService(subjectId, overrides) {
   return listSubjectChildrenService('section', subjectId, overrides)
}

async function listTopicsService(subjectId, overrides) {
   return listSubjectChildrenService('topic', subjectId, overrides)
}

async function createEntityService(kind, userId, subjectIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const subjectId = kind === 'subject' ? null : parseEntityId('subject', subjectIdValue)
   const values = parseBody(kind, body, false)
   requirePrimaryTitle(values.primaryLanguage, values.translations)
   try {
      return await transaction(async (client) => {
         if (subjectId) requireEntity('subject', await repository.lockEntity('subject', subjectId, client))
         if (kind === 'topic') await validateTopicReferences(repository, client, subjectId, values)
         let id
         if (kind === 'subject') id = await repository.createSubject(values, client)
         if (kind === 'section') id = await repository.createSection({ ...values, subjectId }, client)
         if (kind === 'topic') id = await repository.createTopic({ ...values, subjectId }, client)
         await repository.replaceTranslations(kind, id, values.translations, client)
         await audit(auth, client, actorId, kind, 'created', id, { code: values.code })
         return safeEntity(kind, await repository.findEntity(kind, id, client))
      })
   } catch (error) {
      throw mapConstraintError(kind, error)
   }
}

async function createSubjectService(userId, body, overrides) {
   return createEntityService('subject', userId, null, body, overrides)
}

async function createSectionService(userId, subjectId, body, overrides) {
   return createEntityService('section', userId, subjectId, body, overrides)
}

async function createTopicService(userId, subjectId, body, overrides) {
   return createEntityService('topic', userId, subjectId, body, overrides)
}

async function updateEntityService(kind, userId, idValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const id = parseEntityId(kind, idValue)
   const values = parseBody(kind, body, true)
   try {
      return await transaction(async (client) => {
         const current = requireEntity(kind, await repository.lockEntity(kind, id, client))
         if (kind === 'topic') await validateTopicReferences(repository, client, current.subject_id, values, id)
         const existing = await repository.findEntity(kind, id, client)
         const primaryLanguage = values.primaryLanguage || current.primary_language
         requirePrimaryTitle(primaryLanguage, values.hasTranslations ? values.translations : existing.translations)
         await repository.updateEntity(kind, id, values, client)
         if (values.hasTranslations) await repository.replaceTranslations(kind, id, values.translations, client)
         await audit(auth, client, actorId, kind, 'updated', id, { fields: Object.keys(body) })
         return safeEntity(kind, await repository.findEntity(kind, id, client))
      })
   } catch (error) {
      throw mapConstraintError(kind, error)
   }
}

async function updateSubjectService(userId, subjectId, body, overrides) {
   return updateEntityService('subject', userId, subjectId, body, overrides)
}

async function updateSectionService(userId, sectionId, body, overrides) {
   return updateEntityService('section', userId, sectionId, body, overrides)
}

async function updateTopicService(userId, topicId, body, overrides) {
   return updateEntityService('topic', userId, topicId, body, overrides)
}

// Deletion relies on RESTRICT foreign keys: anything still referenced (sections, topics,
// courses, banks, questions) rolls the whole transaction back with *_IN_USE.
async function deleteEntityService(kind, userId, idValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const id = parseEntityId(kind, idValue)
   try {
      return await transaction(async (client) => {
         const current = requireEntity(kind, await repository.lockEntity(kind, id, client))
         await repository.deleteEntity(kind, id, client)
         await audit(auth, client, actorId, kind, 'deleted', id, { code: current.code })
         return { id, status: 'deleted' }
      })
   } catch (error) {
      throw mapConstraintError(kind, error)
   }
}

async function deleteSubjectService(userId, subjectId, overrides) {
   return deleteEntityService('subject', userId, subjectId, overrides)
}

async function deleteSectionService(userId, sectionId, overrides) {
   return deleteEntityService('section', userId, sectionId, overrides)
}

async function deleteTopicService(userId, topicId, overrides) {
   return deleteEntityService('topic', userId, topicId, overrides)
}

export {
   createSectionService,
   createSubjectService,
   createTopicService,
   deleteSectionService,
   deleteSubjectService,
   deleteTopicService,
   listSectionsService,
   listSubjectsService,
   listTopicsService,
   updateSectionService,
   updateSubjectService,
   updateTopicService,
}
