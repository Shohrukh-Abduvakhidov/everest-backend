import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import env from '../configs/env.js'
import { getStorageProvider } from '../providers/storage/index.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as questionImportUploadRepository from '../repositories/question-import-upload-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { parseQuestionPackageBuffer } from '../utils/question-package.js'
import { validateBody, validationError } from './course-service.js'
import { dryRunQuestionImportService, runQuestionImportService } from './question-import-service.js'

// HTTP path into the shared M09 importer: upload (with dry run), confirm, background run.
// Only the transport differs from the CLI; planning and writing are the same functions.

const reportEntryLimit = 200
const leaseSeconds = 300

function dependencies(overrides = {}) {
   return {
      uploads: overrides.uploads || questionImportUploadRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      storage: () => overrides.storage || getStorageProvider(),
      directory: overrides.uploadDirectory || env.questionImportUploadDirectory,
      ttlHours: overrides.uploadTtlHours || env.questionImportUploadTtlHours,
      log: overrides.log || (() => {}),
   }
}

function parseUploadId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_IMPORT_UPLOAD_ID', 'Import upload identifier is invalid')
   }
}

function uploadNotFound() {
   return new AppError(404, 'QUESTION_IMPORT_UPLOAD_NOT_FOUND', 'Question import upload was not found')
}

function parseUploadQuery(query = {}) {
   validateBody(query, ['applyMatchingDefaults', 'idempotencyKey'])
   const flag = query.applyMatchingDefaults
   if (flag !== undefined && flag !== 'true' && flag !== 'false') throw validationError('applyMatchingDefaults')
   return {
      applyMatchingDefaults: flag === 'true',
      ...(query.idempotencyKey === undefined ? {} : { idempotencyKey: query.idempotencyKey }),
   }
}

function storedReport(report) {
   return {
      valid: report.valid,
      idempotencyKey: report.idempotencyKey,
      counters: report.counters,
      topErrorCodes: report.topErrorCodes,
      topWarningCodes: report.topWarningCodes,
      errors: report.errors.slice(0, reportEntryLimit),
      warnings: report.warnings.slice(0, reportEntryLimit),
   }
}

function safeUpload(row) {
   return {
      id: row.id,
      uploadedBy: row.uploaded_by,
      packageSha256: row.package_sha256,
      sizeBytes: Number(row.size_bytes),
      status: row.status,
      options: row.options,
      dryRun: row.dry_run_report,
      previousRunId: row.previous_run_id,
      runId: row.run_id,
      errorCode: row.error_code,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      confirmedAt: row.confirmed_at,
      finishedAt: row.finished_at,
   }
}

async function storePackage(directory, buffer) {
   await mkdir(directory, { recursive: true })
   const storedName = `${randomUUID()}.zip`
   const temporary = path.join(directory, `${storedName}.part`)
   await writeFile(temporary, buffer)
   await rename(temporary, path.join(directory, storedName))
   return storedName
}

async function removePackage(directory, storedName) {
   if (storedName) await rm(path.join(directory, storedName), { force: true })
}

async function audit(deps, client, actorId, code, uploadId, metadata) {
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code,
      entityType: 'question_import_upload',
      entityId: uploadId,
      metadata,
   }, client)
}

// Validates the archive, runs the dry run and keeps the package only when it can be imported.
async function uploadQuestionPackageService(userId, buffer, query, overrides) {
   const deps = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const options = parseUploadQuery(query)
   if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new AppError(400, 'PACKAGE_ARCHIVE_INVALID', 'The request body must be a ZIP archive')
   }
   const pkg = parseQuestionPackageBuffer(buffer)
   const live = await deps.uploads.findLiveUploadByHash(pkg.sha256)
   if (live && live.uploaded_by !== actorId) {
      throw new AppError(409, 'IMPORT_PACKAGE_IN_PROGRESS', 'Another user is importing this package')
   }
   if (live && live.status !== 'validated') return { upload: safeUpload(live), duplicate: true }

   const report = await dryRunQuestionImportService(actorId, pkg, options, overrides)
   const storedName = report.valid ? await storePackage(deps.directory, buffer) : null
   try {
      const upload = await deps.transaction(async (client) => {
         // Options may differ, so an unconfirmed upload of the same bytes is replaced.
         if (live && report.valid) await deps.uploads.supersedeUpload(live.id, client)
         const row = await deps.uploads.insertUpload({
            uploadedBy: actorId,
            packageSha256: pkg.sha256,
            sizeBytes: buffer.length,
            storedName,
            status: report.valid ? 'validated' : 'rejected',
            options,
            dryRunReport: storedReport(report),
            previousRunId: report.previousRunId,
            expiresAt: new Date(Date.now() + deps.ttlHours * 3600000),
         }, client)
         await audit(deps, client, actorId, 'question_import.package_uploaded', row.id, {
            packageSha256: pkg.sha256,
            sizeBytes: buffer.length,
            valid: report.valid,
         })
         return row
      })
      if (live && report.valid) await removePackage(deps.directory, live.stored_name)
      return { upload: safeUpload(upload), duplicate: false }
   } catch (error) {
      await removePackage(deps.directory, storedName)
      if (error.code === '23505') {
         throw new AppError(409, 'IMPORT_PACKAGE_IN_PROGRESS', 'This package is already being imported')
      }
      throw error
   }
}

async function getQuestionPackageUploadService(userId, uploadIdValue, overrides) {
   const deps = dependencies(overrides)
   const upload = await deps.uploads.findVisibleUpload(normalizeInternalId(userId), parseUploadId(uploadIdValue))
   if (!upload) throw uploadNotFound()
   return safeUpload(upload)
}

async function confirmQuestionPackageUploadService(userId, uploadIdValue, body = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const uploadId = parseUploadId(uploadIdValue)
   validateBody(body, [])
   return deps.transaction(async (client) => {
      const upload = await deps.uploads.lockVisibleUpload(actorId, uploadId, client)
      if (!upload) throw uploadNotFound()
      if (['queued', 'running'].includes(upload.status)) return safeUpload(upload)
      if (upload.status !== 'validated' || new Date(upload.expires_at) <= new Date()) {
         throw new AppError(409, 'IMPORT_UPLOAD_NOT_CONFIRMABLE', 'Only a validated, unexpired upload can be confirmed')
      }
      // Fail here rather than in the background when the package needs storage.
      if (upload.dry_run_report.counters.assets.uploaded > 0) deps.storage()
      const queued = await deps.uploads.queueUpload(uploadId, client)
      await audit(deps, client, actorId, 'question_import.package_confirmed', uploadId, {
         packageSha256: upload.package_sha256,
      })
      return safeUpload(queued)
   })
}

function outcomeOf(result) {
   if (result.replayed) {
      return result.run.status === 'completed'
         ? { status: 'completed', runId: result.run.id, errorCode: null }
         : { status: 'failed', runId: result.run.id, errorCode: 'IMPORT_PREVIOUS_RUN_NOT_COMPLETED' }
   }
   if (result.status === 'rejected') {
      return { status: 'failed', runId: null, errorCode: result.topErrorCodes[0]?.code ?? 'IMPORT_REJECTED' }
   }
   return {
      status: result.status === 'completed' ? 'completed' : 'failed',
      runId: result.runId,
      errorCode: result.status === 'completed' ? null : result.topErrorCodes[0]?.code ?? 'IMPORT_FAILED',
   }
}

async function maintainUploads(deps) {
   for (const row of await deps.uploads.expireUnconfirmedUploads()) {
      await removePackage(deps.directory, row.stored_name)
   }
   for (const row of await deps.uploads.failAbandonedUploads()) {
      await deps.uploads.failInterruptedRuns(row.package_sha256, row.uploaded_by)
      await removePackage(deps.directory, row.stored_name)
      deps.log('question import upload abandoned', { uploadId: row.id })
   }
}

// One worker tick: housekeeping, then at most one queued package. Returns the upload id or null.
async function processNextQuestionImportService(overrides) {
   const deps = dependencies(overrides)
   await maintainUploads(deps)
   const upload = await deps.uploads.claimNextUpload(leaseSeconds)
   if (!upload) return null
   const heartbeat = setInterval(() => {
      deps.uploads.renewLease(upload.id, leaseSeconds).catch((error) => {
         deps.log('question import lease renewal failed', { uploadId: upload.id, code: error.code })
      })
   }, leaseSeconds * 1000 / 3)
   heartbeat.unref()
   let outcome
   try {
      const buffer = await readFile(path.join(deps.directory, upload.stored_name))
      const pkg = parseQuestionPackageBuffer(buffer)
      outcome = outcomeOf(await runQuestionImportService(upload.uploaded_by, pkg, upload.options, overrides))
   } catch (error) {
      if (!(error instanceof AppError)) deps.log('question import run crashed', { uploadId: upload.id, code: error.code })
      outcome = { status: 'failed', runId: null, errorCode: error instanceof AppError ? error.code : 'IMPORT_FAILED' }
   } finally {
      clearInterval(heartbeat)
   }
   await deps.transaction(async (client) => {
      await deps.uploads.finishUpload(upload.id, outcome, client)
      await audit(deps, client, upload.uploaded_by, `question_import.package_${outcome.status}`, upload.id, {
         runId: outcome.runId,
         errorCode: outcome.errorCode,
      })
   })
   await removePackage(deps.directory, upload.stored_name)
   return upload.id
}

export {
   confirmQuestionPackageUploadService,
   getQuestionPackageUploadService,
   processNextQuestionImportService,
   uploadQuestionPackageService,
}
