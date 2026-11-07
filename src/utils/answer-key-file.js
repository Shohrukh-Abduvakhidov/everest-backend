import { readFile, stat } from 'node:fs/promises'

import AppError from './app-error.js'
import { sha256 } from './question-package.js'

// Loads an `everest.answer-key-import.v1` sidecar file. The result is plain data (parsed
// document + sha256 of the exact bytes); no database access happens here.

const maxKeyFileBytes = 16 * 1024 * 1024

function parseAnswerKeyFileBuffer(buffer) {
   if (buffer.length > maxKeyFileBytes) {
      throw new AppError(400, 'KEY_FILE_TOO_LARGE', 'Answer-key file exceeds 16 MiB')
   }
   let document
   try {
      document = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
   } catch {
      throw new AppError(400, 'KEY_FILE_JSON_INVALID', 'Answer-key file is not valid JSON')
   }
   return { sha256: sha256(buffer), document }
}

async function loadAnswerKeyFile(filePath) {
   let info
   try {
      info = await stat(filePath)
   } catch {
      throw new AppError(400, 'KEY_FILE_NOT_FOUND', 'Answer-key file does not exist')
   }
   if (!info.isFile()) throw new AppError(400, 'KEY_FILE_NOT_FOUND', 'Answer-key path is not a file')
   if (info.size > maxKeyFileBytes) {
      throw new AppError(400, 'KEY_FILE_TOO_LARGE', 'Answer-key file exceeds 16 MiB')
   }
   return parseAnswerKeyFileBuffer(await readFile(filePath))
}

export { loadAnswerKeyFile, parseAnswerKeyFileBuffer }
