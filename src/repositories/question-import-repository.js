import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

const runColumns = `run.id, run.bank_id, bank.code AS bank_code, run.initiated_by,
   run.package_sha256, run.schema_version, run.idempotency_key, run.is_dry_run, run.status,
   run.manifest, run.counters, run.created_at, run.finished_at`

// Runs are visible to administrators, the bank owner and the user who started the run.
const visibleRunSql = `(${administratorSql} OR bank.owner_id = $1 OR run.initiated_by = $1)`

async function findActorByPhone(phoneE164, db = pool) {
   const result = await db.query(
      `SELECT account.id, account.status
       FROM user_phones AS phone
       JOIN users AS account ON account.id = phone.user_id
       WHERE phone.phone_e164 = $1`,
      [phoneE164],
   )
   return result.rows[0] || null
}

async function findActorById(userId, db = pool) {
   const result = await db.query('SELECT id, status FROM users WHERE id = $1', [normalizeInternalId(userId)])
   return result.rows[0] || null
}

async function isAdministrator(userId, db = pool) {
   const result = await db.query(`SELECT ${administratorSql} AS administrator`, [normalizeInternalId(userId)])
   return result.rows[0].administrator
}

async function findBankByCode(code, db = pool) {
   const result = await db.query(
      'SELECT id, code, title, subject_id, owner_id, visibility FROM question_banks WHERE code = $1',
      [code],
   )
   return result.rows[0] || null
}

async function findQuestionsByExternalIds(bankId, externalIds, db = pool) {
   const result = await db.query(
      `SELECT id, external_id, question_type, status
       FROM questions WHERE bank_id = $1 AND external_id = ANY($2::text[])`,
      [normalizeInternalId(bankId), externalIds],
   )
   return result.rows
}

async function lockQuestionByExternalId(bankId, externalId, client) {
   const result = await client.query(
      `SELECT id, external_id, question_type, status
       FROM questions WHERE bank_id = $1 AND external_id = $2
       FOR UPDATE`,
      [normalizeInternalId(bankId), externalId],
   )
   return result.rows[0] || null
}

async function setQuestionImport(questionId, importId, client) {
   await client.query(
      'UPDATE questions SET import_id = $2 WHERE id = $1',
      [normalizeInternalId(questionId), normalizeInternalId(importId)],
   )
}

// --- Import runs ---------------------------------------------------------------------

async function findRunByKey(bankId, idempotencyKey, db = pool) {
   const result = await db.query(
      `SELECT ${runColumns}
       FROM question_imports AS run
       JOIN question_banks AS bank ON bank.id = run.bank_id
       WHERE run.bank_id = $1 AND run.idempotency_key = $2`,
      [normalizeInternalId(bankId), idempotencyKey],
   )
   return result.rows[0] || null
}

async function insertRun(run, client) {
   const result = await client.query(
      `INSERT INTO question_imports
         (bank_id, initiated_by, package_sha256, schema_version, idempotency_key, is_dry_run,
          status, manifest, counters)
       VALUES ($1, $2, $3, $4, $5, FALSE, 'importing', $6, $7)
       RETURNING id`,
      [
         normalizeInternalId(run.bankId),
         normalizeInternalId(run.initiatedBy),
         run.packageSha256,
         run.schemaVersion,
         run.idempotencyKey,
         run.manifest,
         run.counters,
      ],
   )
   return result.rows[0].id
}

async function updateRunProgress(runId, counters, client) {
   await client.query(
      'UPDATE question_imports SET counters = $2 WHERE id = $1',
      [normalizeInternalId(runId), counters],
   )
}

async function finishRun(runId, status, counters, db = pool) {
   await db.query(
      `UPDATE question_imports SET status = $2, counters = $3, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [normalizeInternalId(runId), status, counters],
   )
}

async function insertRunErrors(runId, entries, db = pool) {
   if (!entries.length) return
   await db.query(
      `INSERT INTO question_import_errors
         (import_id, external_id, record_path, severity, error_code, message)
       SELECT $1, external_id, record_path, severity, error_code, message
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS input(external_id, record_path, severity, error_code, message)`,
      [
         normalizeInternalId(runId),
         entries.map((entry) => entry.externalId ?? null),
         entries.map((entry) => entry.path ?? null),
         entries.map((entry) => entry.severity),
         entries.map((entry) => entry.code),
         entries.map((entry) => entry.message),
      ],
   )
}

async function listVisibleRuns(userId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${runColumns}
       FROM question_imports AS run
       JOIN question_banks AS bank ON bank.id = run.bank_id
       WHERE ${visibleRunSql}
         AND ($2::bigint IS NULL OR run.bank_id = $2)
         AND ($3::text IS NULL OR run.status = $3)
       ORDER BY run.id DESC
       LIMIT $4 OFFSET $5`,
      [normalizeInternalId(userId), filters.bankId, filters.status, filters.limit + 1, filters.offset],
   )
   return result.rows
}

async function findVisibleRun(userId, runId, db = pool) {
   const result = await db.query(
      `SELECT ${runColumns}
       FROM question_imports AS run
       JOIN question_banks AS bank ON bank.id = run.bank_id
       WHERE run.id = $2 AND ${visibleRunSql}`,
      [normalizeInternalId(userId), normalizeInternalId(runId)],
   )
   return result.rows[0] || null
}

async function listRunErrors(runId, filters, db = pool) {
   const result = await db.query(
      `SELECT id, external_id, record_path, severity, error_code, message, created_at
       FROM question_import_errors
       WHERE import_id = $1 AND ($2::text IS NULL OR severity = $2)
       ORDER BY id
       LIMIT $3 OFFSET $4`,
      [normalizeInternalId(runId), filters.severity, filters.limit + 1, filters.offset],
   )
   return result.rows
}

// --- Assets --------------------------------------------------------------------------

async function findAliases(sourceNamespace, externalIds, db = pool) {
   const result = await db.query(
      `SELECT alias.external_id, asset.id AS asset_id, asset.sha256, asset.status, asset.mime_type
       FROM asset_aliases AS alias
       JOIN assets AS asset ON asset.id = alias.asset_id
       WHERE alias.source_namespace = $1 AND alias.external_id = ANY($2::text[])`,
      [sourceNamespace, externalIds],
   )
   return result.rows
}

async function findAssetsBySha256(hashes, db = pool) {
   const result = await db.query(
      'SELECT id, sha256, status, mime_type FROM assets WHERE sha256 = ANY($1::text[])',
      [hashes],
   )
   return result.rows
}

// Content-addressed insert: a concurrent import of the same bytes resolves to one row.
async function insertImportedImage(asset, client) {
   await client.query(
      `INSERT INTO assets
         (storage_key, mime_type, file_name, size_bytes, sha256, width_px, height_px, kind,
          status, processing_status, uploaded_by, source_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'material', 'ready', 'not_required', $8, $9)
       ON CONFLICT (sha256) WHERE sha256 IS NOT NULL DO NOTHING`,
      [
         asset.storageKey,
         asset.mimeType,
         asset.fileName,
         asset.sizeBytes,
         asset.sha256,
         asset.widthPx,
         asset.heightPx,
         normalizeInternalId(asset.uploadedBy),
         asset.sourceMetadata,
      ],
   )
   const result = await client.query(
      'SELECT id, sha256, status, mime_type FROM assets WHERE sha256 = $1',
      [asset.sha256],
   )
   return result.rows[0]
}

// Returns the asset the alias points to after the insert (an existing alias wins).
async function insertAlias(sourceNamespace, externalId, assetId, client) {
   await client.query(
      `INSERT INTO asset_aliases (source_namespace, external_id, asset_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_namespace, external_id) DO NOTHING`,
      [sourceNamespace, externalId, normalizeInternalId(assetId)],
   )
   const result = await client.query(
      'SELECT asset_id FROM asset_aliases WHERE source_namespace = $1 AND external_id = $2',
      [sourceNamespace, externalId],
   )
   return result.rows[0].asset_id
}

// --- Duplicate suggestions ----------------------------------------------------------

async function listDuplicateCandidates(bankId, client) {
   const result = await client.query(
      `SELECT question.id, question.question_type, question.content,
         COALESCE((
            SELECT jsonb_agg(option.content ORDER BY option.position)
            FROM question_options AS option WHERE option.question_id = question.id
         ), '[]'::jsonb) AS options,
         COALESCE((
            SELECT jsonb_agg(item.content ORDER BY item.side, item.position)
            FROM question_matching_items AS item WHERE item.question_id = question.id
         ), '[]'::jsonb) AS matching
       FROM questions AS question
       WHERE question.bank_id = $1
       ORDER BY question.id`,
      [normalizeInternalId(bankId)],
   )
   return result.rows
}

async function insertDuplicateSuggestion(questionId, duplicateOfId, reason, markedBy, client) {
   const result = await client.query(
      `INSERT INTO question_duplicate_links (question_id, duplicate_of_id, reason, marked_by)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
          SELECT 1 FROM question_duplicate_links
          WHERE (question_id = $1 AND duplicate_of_id = $2) OR (question_id = $2 AND duplicate_of_id = $1)
       )`,
      [normalizeInternalId(questionId), normalizeInternalId(duplicateOfId), reason, normalizeInternalId(markedBy)],
   )
   return result.rowCount === 1
}

export {
   findActorById,
   findActorByPhone,
   findAliases,
   findAssetsBySha256,
   findBankByCode,
   findQuestionsByExternalIds,
   findRunByKey,
   findVisibleRun,
   finishRun,
   insertAlias,
   insertDuplicateSuggestion,
   insertImportedImage,
   insertRun,
   insertRunErrors,
   isAdministrator,
   listDuplicateCandidates,
   listRunErrors,
   listVisibleRuns,
   lockQuestionByExternalId,
   setQuestionImport,
   updateRunProgress,
}
