import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

const bankColumns = `bank.id, bank.code, bank.title, bank.subject_id, bank.owner_id,
   bank.visibility, bank.source_metadata, bank.created_at,
   ${administratorSql} AS administrator`

// Readers see their own banks, staff-visible banks and, as administrators, every bank.
const readableBankSql = `(${administratorSql} OR bank.owner_id = $1 OR bank.visibility = 'staff')`

const questionColumns = `question.id, question.bank_id, question.subject_id, question.external_id,
   question.question_type, question.language_code, question.difficulty, question.difficulty_source,
   question.status, question.content, question.interaction_settings, question.source_metadata,
   question.source_question_id, question.import_id, question.created_by, question.created_at,
   question.updated_at`

async function listReadableBanks(userId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${bankColumns},
         (SELECT count(*)::integer FROM questions WHERE bank_id = bank.id) AS question_count
       FROM question_banks AS bank
       WHERE ${readableBankSql}
         AND ($2::bigint IS NULL OR bank.subject_id = $2)
       ORDER BY bank.title, bank.id
       LIMIT $3 OFFSET $4`,
      [normalizeInternalId(userId), filters.subjectId, filters.limit + 1, filters.offset],
   )
   return result.rows
}

async function findReadableBank(userId, bankId, db = pool) {
   const result = await db.query(
      `SELECT ${bankColumns},
         (SELECT count(*)::integer FROM questions WHERE bank_id = bank.id) AS question_count
       FROM question_banks AS bank
       WHERE bank.id = $2 AND ${readableBankSql}`,
      [normalizeInternalId(userId), normalizeInternalId(bankId)],
   )
   return result.rows[0] || null
}

async function lockReadableBank(userId, bankId, client) {
   const result = await client.query(
      `SELECT ${bankColumns}
       FROM question_banks AS bank
       WHERE bank.id = $2 AND ${readableBankSql}
       FOR UPDATE OF bank`,
      [normalizeInternalId(userId), normalizeInternalId(bankId)],
   )
   return result.rows[0] || null
}

async function subjectExists(subjectId, client) {
   const result = await client.query(
      'SELECT EXISTS (SELECT 1 FROM subjects WHERE id = $1) AS found',
      [normalizeInternalId(subjectId)],
   )
   return result.rows[0].found
}

async function createBank(bank, client) {
   const result = await client.query(
      `INSERT INTO question_banks (code, title, subject_id, owner_id, visibility, source_metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
         bank.code,
         bank.title,
         normalizeInternalId(bank.subjectId),
         normalizeInternalId(bank.ownerId),
         bank.visibility,
         bank.sourceMetadata,
      ],
   )
   return result.rows[0].id
}

async function updateBank(bankId, changes, client) {
   await client.query(
      `UPDATE question_banks SET
         code = COALESCE($2, code),
         title = COALESCE($3, title),
         visibility = COALESCE($4, visibility),
         source_metadata = COALESCE($5, source_metadata)
       WHERE id = $1`,
      [
         normalizeInternalId(bankId),
         changes.code,
         changes.title,
         changes.visibility,
         changes.sourceMetadata,
      ],
   )
}

async function listQuestions(bankId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${questionColumns}, COALESCE(answer_key.status, 'unknown') AS key_status
       FROM questions AS question
       LEFT JOIN question_answer_keys AS answer_key ON answer_key.question_id = question.id
       WHERE question.bank_id = $1
         AND ($2::text IS NULL OR question.status = $2)
         AND ($3::text IS NULL OR question.question_type = $3)
         AND ($4::text IS NULL OR question.language_code = $4)
         AND ($5::bigint IS NULL OR EXISTS (
            SELECT 1 FROM question_topics AS link
            WHERE link.question_id = question.id AND link.topic_id = $5
         ))
         AND ($6::text IS NULL OR COALESCE(answer_key.status, 'unknown') = $6)
       ORDER BY question.id
       LIMIT $7 OFFSET $8`,
      [
         normalizeInternalId(bankId),
         filters.status,
         filters.questionType,
         filters.languageCode,
         filters.topicId,
         filters.keyStatus,
         filters.limit + 1,
         filters.offset,
      ],
   )
   return result.rows
}

async function findQuestion(questionId, db = pool) {
   const result = await db.query(
      `SELECT ${questionColumns} FROM questions AS question WHERE question.id = $1`,
      [normalizeInternalId(questionId)],
   )
   return result.rows[0] || null
}

async function lockQuestion(questionId, client) {
   const result = await client.query(
      `SELECT ${questionColumns} FROM questions AS question WHERE question.id = $1 FOR UPDATE`,
      [normalizeInternalId(questionId)],
   )
   return result.rows[0] || null
}

async function findQuestionParts(questionId, db = pool) {
   const id = normalizeInternalId(questionId)
   // Sequential on purpose: `db` may be a transaction client, which cannot run queries in parallel.
   const options = await db.query(
      `SELECT option_key, position, source_label, content
       FROM question_options WHERE question_id = $1 ORDER BY position`,
      [id],
   )
   const matching = await db.query(
      `SELECT side, item_key, position, source_label, content
       FROM question_matching_items WHERE question_id = $1 ORDER BY side, position`,
      [id],
   )
   const topics = await db.query(
      'SELECT topic_id FROM question_topics WHERE question_id = $1 ORDER BY topic_id',
      [id],
   )
   const answerKey = await db.query(
      `SELECT status, source, answer_data, explanation, verified_by, verified_at, updated_at
       FROM question_answer_keys WHERE question_id = $1`,
      [id],
   )
   const assets = await db.query(
      'SELECT asset_id FROM question_assets WHERE question_id = $1 ORDER BY asset_id',
      [id],
   )
   return {
      options: options.rows,
      matching: matching.rows,
      topicIds: topics.rows.map((row) => row.topic_id),
      answerKey: answerKey.rows[0] || null,
      assetIds: assets.rows.map((row) => row.asset_id),
   }
}

async function createQuestion(question, client) {
   const result = await client.query(
      `INSERT INTO questions
         (bank_id, subject_id, external_id, question_type, language_code, difficulty,
          difficulty_source, status, content, interaction_settings, source_metadata,
          source_question_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11, $12)
       RETURNING id`,
      [
         normalizeInternalId(question.bankId),
         normalizeInternalId(question.subjectId),
         question.externalId,
         question.questionType,
         question.languageCode,
         question.difficulty,
         question.difficultySource,
         question.content,
         question.interactionSettings,
         question.sourceMetadata,
         question.sourceQuestionId,
         normalizeInternalId(question.actorId),
      ],
   )
   return result.rows[0].id
}

async function updateQuestion(questionId, changes, client) {
   await client.query(
      `UPDATE questions SET
         external_id = CASE WHEN $2 THEN $3 ELSE external_id END,
         language_code = COALESCE($4, language_code),
         difficulty = CASE WHEN $5 THEN $6::smallint ELSE difficulty END,
         difficulty_source = CASE WHEN $5 THEN $7 ELSE difficulty_source END,
         content = COALESCE($8, content),
         interaction_settings = COALESCE($9, interaction_settings),
         source_metadata = COALESCE($10, source_metadata),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
         normalizeInternalId(questionId),
         changes.hasExternalId,
         changes.externalId,
         changes.languageCode,
         changes.hasDifficulty,
         changes.difficulty,
         changes.difficultySource,
         changes.content,
         changes.interactionSettings,
         changes.sourceMetadata,
      ],
   )
}

async function setQuestionStatus(questionId, status, client) {
   await client.query(
      'UPDATE questions SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [normalizeInternalId(questionId), status],
   )
}

async function replaceOptions(questionId, options, client) {
   const id = normalizeInternalId(questionId)
   await client.query('DELETE FROM question_options WHERE question_id = $1', [id])
   for (const option of options) {
      await client.query(
         `INSERT INTO question_options (question_id, option_key, position, source_label, content)
          VALUES ($1, $2, $3, $4, $5)`,
         [id, option.key, option.position, option.sourceLabel, option.content],
      )
   }
}

async function replaceMatchingItems(questionId, matching, client) {
   const id = normalizeInternalId(questionId)
   await client.query('DELETE FROM question_matching_items WHERE question_id = $1', [id])
   for (const side of ['left', 'right']) {
      for (const item of matching[side]) {
         await client.query(
            `INSERT INTO question_matching_items
               (question_id, side, item_key, position, source_label, content)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, side, item.key, item.position, item.sourceLabel, item.content],
         )
      }
   }
}

async function replaceTopics(questionId, subjectId, topicIds, client) {
   const id = normalizeInternalId(questionId)
   await client.query('DELETE FROM question_topics WHERE question_id = $1', [id])
   if (!topicIds.length) return
   await client.query(
      `INSERT INTO question_topics (question_id, topic_id, subject_id)
       SELECT $1, topic_id, $2 FROM unnest($3::bigint[]) AS topic_id`,
      [id, normalizeInternalId(subjectId), topicIds],
   )
}

async function replaceAssets(questionId, assetIds, client) {
   const id = normalizeInternalId(questionId)
   await client.query('DELETE FROM question_assets WHERE question_id = $1', [id])
   if (!assetIds.length) return
   await client.query(
      `INSERT INTO question_assets (question_id, asset_id)
       SELECT $1, asset_id FROM unnest($2::bigint[]) AS asset_id`,
      [id, assetIds],
   )
}

async function countSubjectTopics(subjectId, topicIds, client) {
   const result = await client.query(
      `SELECT count(*)::integer AS total FROM topics
       WHERE subject_id = $1 AND id = ANY($2::bigint[])`,
      [normalizeInternalId(subjectId), topicIds],
   )
   return result.rows[0].total
}

// An image may be embedded only when it is a ready PNG/JPEG the author uploaded, one already
// used by a question in the same bank, or any ready image for an administrator.
async function findUsableImageAssets(userId, bankId, assetIds, client) {
   const result = await client.query(
      `SELECT asset.id FROM assets AS asset
       WHERE asset.id = ANY($3::bigint[])
         AND asset.status = 'ready'
         AND asset.mime_type IN ('image/png', 'image/jpeg')
         AND (
            ${administratorSql}
            OR asset.uploaded_by = $1
            OR EXISTS (
               SELECT 1 FROM question_assets AS link
               JOIN questions AS question ON question.id = link.question_id
               WHERE link.asset_id = asset.id AND question.bank_id = $2
            )
         )`,
      [normalizeInternalId(userId), normalizeInternalId(bankId), assetIds],
   )
   return result.rows.map((row) => row.id)
}

async function upsertAnswerKey(questionId, key, client) {
   await client.query(
      `INSERT INTO question_answer_keys
         (question_id, status, source, answer_data, explanation, verified_by, verified_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT (question_id) DO UPDATE SET
         status = EXCLUDED.status,
         source = EXCLUDED.source,
         answer_data = EXCLUDED.answer_data,
         explanation = EXCLUDED.explanation,
         verified_by = NULL,
         verified_at = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [normalizeInternalId(questionId), key.status, key.source, key.answerData, key.explanation],
   )
}

async function lockAnswerKey(questionId, client) {
   const result = await client.query(
      `SELECT status, source, answer_data, explanation, verified_by, verified_at
       FROM question_answer_keys WHERE question_id = $1 FOR UPDATE`,
      [normalizeInternalId(questionId)],
   )
   return result.rows[0] || null
}

async function verifyAnswerKey(questionId, source, reviewerId, client) {
   await client.query(
      `UPDATE question_answer_keys SET
         status = 'verified', source = $2, verified_by = $3, verified_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE question_id = $1`,
      [normalizeInternalId(questionId), source, normalizeInternalId(reviewerId)],
   )
}

async function isQuestionReferenced(questionId, client) {
   const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM questions WHERE source_question_id = $1)
         OR EXISTS (SELECT 1 FROM test_questions WHERE question_id = $1)
         OR EXISTS (
            SELECT 1 FROM question_duplicate_links
            WHERE question_id = $1 OR duplicate_of_id = $1
         ) AS referenced`,
      [normalizeInternalId(questionId)],
   )
   return result.rows[0].referenced
}

async function deleteDraftQuestion(questionId, client) {
   const id = normalizeInternalId(questionId)
   await client.query('DELETE FROM question_assets WHERE question_id = $1', [id])
   await client.query('DELETE FROM question_topics WHERE question_id = $1', [id])
   await client.query('DELETE FROM question_answer_keys WHERE question_id = $1', [id])
   await client.query('DELETE FROM question_matching_items WHERE question_id = $1', [id])
   await client.query('DELETE FROM question_options WHERE question_id = $1', [id])
   await client.query('DELETE FROM questions WHERE id = $1', [id])
}

export {
   countSubjectTopics,
   createBank,
   createQuestion,
   deleteDraftQuestion,
   findQuestion,
   findQuestionParts,
   findReadableBank,
   findUsableImageAssets,
   isQuestionReferenced,
   listQuestions,
   listReadableBanks,
   lockAnswerKey,
   lockQuestion,
   lockReadableBank,
   replaceAssets,
   replaceMatchingItems,
   replaceOptions,
   replaceTopics,
   setQuestionStatus,
   subjectExists,
   updateBank,
   updateQuestion,
   upsertAnswerKey,
   verifyAnswerKey,
}
