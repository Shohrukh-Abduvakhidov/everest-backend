import { readFile } from 'node:fs/promises'

import AppError from './app-error.js'
import { isPlainObject } from './question-content.js'

// Loads the --exclude file of `npm run verify:keys`: either a JSON array of externalId strings
// or { "externalIds": [...] }. Plain data only; no database access happens here.

const maxBytes = 4 * 1024 * 1024

function parseExcludeDocument(document) {
   const list = Array.isArray(document) ? document : isPlainObject(document) ? document.externalIds : null
   if (!Array.isArray(list) || list.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new AppError(400, 'EXCLUDE_FILE_INVALID', 'Exclude file must be a JSON array of externalId strings or { "externalIds": [...] }')
   }
   return [...new Set(list.map((value) => value.trim()))]
}

async function loadExcludeFile(filePath) {
   let buffer
   try {
      buffer = await readFile(filePath)
   } catch {
      throw new AppError(400, 'EXCLUDE_FILE_NOT_FOUND', 'Exclude file does not exist')
   }
   if (buffer.length > maxBytes) throw new AppError(400, 'EXCLUDE_FILE_TOO_LARGE', 'Exclude file exceeds 4 MiB')
   let document
   try {
      document = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
   } catch {
      throw new AppError(400, 'EXCLUDE_FILE_JSON_INVALID', 'Exclude file is not valid JSON')
   }
   return parseExcludeDocument(document)
}

export { loadExcludeFile, parseExcludeDocument }
