import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// Fixed identifier sets: entity names never come from request input.
const entities = Object.freeze({
   subject: { table: 'subjects', translations: 'subject_translations', foreignKey: 'subject_id' },
   section: { table: 'sections', translations: 'section_translations', foreignKey: 'section_id' },
   topic: { table: 'topics', translations: 'topic_translations', foreignKey: 'topic_id' },
})

const columns = Object.freeze({
   subject: 'entity.id, entity.code, entity.primary_language, entity.color',
   section: 'entity.id, entity.subject_id, entity.code, entity.primary_language',
   topic: `entity.id, entity.subject_id, entity.section_id, entity.parent_id, entity.code,
      entity.primary_language`,
})

function translationsSql(kind) {
   const { translations, foreignKey } = entities[kind]
   return `COALESCE((
         SELECT jsonb_object_agg(translation.language_code, jsonb_build_object('title', translation.title))
         FROM ${translations} AS translation
         WHERE translation.${foreignKey} = entity.id
      ), '{}'::jsonb) AS translations`
}

async function listEntities(kind, subjectId, db = pool) {
   const filter = kind === 'subject' ? '' : 'WHERE entity.subject_id = $1'
   const result = await db.query(
      `SELECT ${columns[kind]}, ${translationsSql(kind)}
       FROM ${entities[kind].table} AS entity
       ${filter}
       ORDER BY entity.code, entity.id`,
      kind === 'subject' ? [] : [normalizeInternalId(subjectId)],
   )
   return result.rows
}

async function findEntity(kind, id, db = pool) {
   const result = await db.query(
      `SELECT ${columns[kind]}, ${translationsSql(kind)}
       FROM ${entities[kind].table} AS entity
       WHERE entity.id = $1`,
      [normalizeInternalId(id)],
   )
   return result.rows[0] || null
}

// Natural-key lookup used by the importer: subjects by code, sections/topics by
// (subject, code).
async function findEntityByCode(kind, code, subjectId, db = pool) {
   const subjectFilter = kind === 'subject' ? '' : 'AND entity.subject_id = $2'
   const result = await db.query(
      `SELECT ${columns[kind]}, ${translationsSql(kind)}
       FROM ${entities[kind].table} AS entity
       WHERE entity.code = $1 ${subjectFilter}`,
      kind === 'subject' ? [code] : [code, normalizeInternalId(subjectId)],
   )
   return result.rows[0] || null
}

async function lockEntity(kind, id, client) {
   const result = await client.query(
      `SELECT ${columns[kind]}
       FROM ${entities[kind].table} AS entity
       WHERE entity.id = $1
       FOR UPDATE`,
      [normalizeInternalId(id)],
   )
   return result.rows[0] || null
}

async function createSubject(subject, client) {
   const result = await client.query(
      'INSERT INTO subjects (code, primary_language, color) VALUES ($1, $2, $3) RETURNING id',
      [subject.code, subject.primaryLanguage, subject.color],
   )
   return result.rows[0].id
}

async function createSection(section, client) {
   const result = await client.query(
      `INSERT INTO sections (subject_id, code, primary_language)
       VALUES ($1, $2, $3) RETURNING id`,
      [normalizeInternalId(section.subjectId), section.code, section.primaryLanguage],
   )
   return result.rows[0].id
}

async function createTopic(topic, client) {
   const result = await client.query(
      `INSERT INTO topics (subject_id, section_id, parent_id, code, primary_language)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
         normalizeInternalId(topic.subjectId),
         topic.sectionId,
         topic.parentId,
         topic.code,
         topic.primaryLanguage,
      ],
   )
   return result.rows[0].id
}

async function updateEntity(kind, id, changes, client) {
   let extra = ''
   const values = [normalizeInternalId(id), changes.code, changes.primaryLanguage]
   if (kind === 'topic') {
      extra = `, section_id = CASE WHEN $4 THEN $5::bigint ELSE section_id END,
         parent_id = CASE WHEN $6 THEN $7::bigint ELSE parent_id END`
      values.push(changes.hasSectionId, changes.sectionId, changes.hasParentId, changes.parentId)
   }
   if (kind === 'subject') {
      extra = ', color = COALESCE($4, color)'
      values.push(changes.color)
   }
   await client.query(
      `UPDATE ${entities[kind].table} SET
         code = COALESCE($2, code),
         primary_language = COALESCE($3, primary_language)
         ${extra}
       WHERE id = $1`,
      values,
   )
}

async function replaceTranslations(kind, id, translations, client) {
   const { translations: table, foreignKey } = entities[kind]
   const entityId = normalizeInternalId(id)
   await client.query(`DELETE FROM ${table} WHERE ${foreignKey} = $1`, [entityId])
   const languages = Object.keys(translations)
   if (!languages.length) return
   await client.query(
      `INSERT INTO ${table} (${foreignKey}, language_code, title)
       SELECT $1, language_code, title
       FROM unnest($2::text[], $3::text[]) AS input(language_code, title)`,
      [entityId, languages, languages.map((language) => translations[language].title)],
   )
}

// Adds or retitles the given languages and keeps every other stored translation.
async function upsertTranslations(kind, id, translations, client) {
   const { translations: table, foreignKey } = entities[kind]
   const languages = Object.keys(translations)
   if (!languages.length) return
   await client.query(
      `INSERT INTO ${table} (${foreignKey}, language_code, title)
       SELECT $1, language_code, title
       FROM unnest($2::text[], $3::text[]) AS input(language_code, title)
       ON CONFLICT (${foreignKey}, language_code) DO UPDATE SET title = EXCLUDED.title`,
      [normalizeInternalId(id), languages, languages.map((language) => translations[language].title)],
   )
}

async function deleteEntity(kind, id, client) {
   const { table, translations, foreignKey } = entities[kind]
   const entityId = normalizeInternalId(id)
   await client.query(`DELETE FROM ${translations} WHERE ${foreignKey} = $1`, [entityId])
   await client.query(`DELETE FROM ${table} WHERE id = $1`, [entityId])
}

// Walks up from the proposed parent; reaching the topic itself means a cycle. The service
// locks the subject's topic rows first, so concurrent re-parenting cannot create a cycle.
async function topicParentCreatesCycle(topicId, parentId, client) {
   const result = await client.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id, 1 AS depth FROM topics WHERE id = $1
         UNION ALL
         SELECT topic.id, topic.parent_id, ancestors.depth + 1
         FROM topics AS topic
         JOIN ancestors ON topic.id = ancestors.parent_id
         WHERE ancestors.depth < 100
      )
      SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2) AS found`,
      [normalizeInternalId(parentId), normalizeInternalId(topicId)],
   )
   return result.rows[0].found
}

async function lockTopicTree(subjectId, client) {
   await client.query(
      'SELECT id FROM topics WHERE subject_id = $1 ORDER BY id FOR UPDATE',
      [normalizeInternalId(subjectId)],
   )
}

export {
   createSection,
   createSubject,
   createTopic,
   deleteEntity,
   findEntity,
   findEntityByCode,
   listEntities,
   lockEntity,
   lockTopicTree,
   replaceTranslations,
   topicParentCreatesCycle,
   updateEntity,
   upsertTranslations,
}
