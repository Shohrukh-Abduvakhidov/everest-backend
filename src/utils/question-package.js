import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import AppError from './app-error.js'
import { isSafePath, readZipEntries } from './zip-reader.js'

// Loads an `everest.question-import.v1` package from a directory or a ZIP file. The result
// is plain data (manifest + file buffers + package hash); no database access happens here.

const mib = 1024 * 1024
const maxPackageBytes = 512 * mib
const maxEntryBytes = 64 * mib
const manifestName = 'manifest.json'

function sha256(buffer) {
   return createHash('sha256').update(buffer).digest('hex')
}

async function readDirectoryFiles(root) {
   const files = new Map()
   let total = 0
   async function walk(directory, prefix) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
         const relative = prefix ? `${prefix}/${entry.name}` : entry.name
         const full = path.join(directory, entry.name)
         if (entry.isDirectory()) await walk(full, relative)
         else if (entry.isFile()) {
            const size = (await stat(full)).size
            if (size > maxEntryBytes) {
               throw new AppError(400, 'PACKAGE_ENTRY_TOO_LARGE', 'Package file exceeds the size limit', [
                  { field: relative, message: 'file is too large' },
               ])
            }
            total += size
            if (total > maxPackageBytes) throw new AppError(400, 'PACKAGE_TOO_LARGE', 'Package exceeds the size limit')
            files.set(relative, await readFile(full))
         }
      }
   }
   await walk(root, '')
   return files
}

// A directory hash is computed over the sorted `path NUL sha256` lines so it does not
// depend on file system order or timestamps.
function directoryHash(files) {
   const lines = [...files.keys()].sort().map((name) => `${name}\0${sha256(files.get(name))}\n`)
   return sha256(Buffer.from(lines.join(''), 'utf8'))
}

// ZIP tools often wrap everything in one top-level folder; accept that layout too.
function unwrapSingleFolder(files) {
   if (files.has(manifestName)) return files
   const tops = new Set([...files.keys()].map((name) => name.split('/')[0]))
   if (tops.size !== 1) return files
   const [top] = tops
   if (!files.has(`${top}/${manifestName}`)) return files
   return new Map([...files].map(([name, data]) => [name.slice(top.length + 1), data]))
}

function parseManifest(files) {
   const raw = files.get(manifestName)
   if (!raw) throw new AppError(400, 'PACKAGE_MANIFEST_MISSING', 'manifest.json was not found in the package')
   try {
      return JSON.parse(raw.toString('utf8').replace(/^﻿/, ''))
   } catch {
      throw new AppError(400, 'PACKAGE_JSON_INVALID', 'manifest.json is not valid JSON')
   }
}

async function loadQuestionPackage(packagePath) {
   let info
   try {
      info = await stat(packagePath)
   } catch {
      throw new AppError(400, 'PACKAGE_NOT_FOUND', 'Package path does not exist')
   }
   let files
   let packageSha256
   if (info.isDirectory()) {
      files = await readDirectoryFiles(packagePath)
      packageSha256 = directoryHash(files)
   } else {
      if (info.size > maxPackageBytes) throw new AppError(400, 'PACKAGE_TOO_LARGE', 'Package exceeds the size limit')
      const buffer = await readFile(packagePath)
      packageSha256 = sha256(buffer)
      files = readZipEntries(buffer, { maxEntryBytes })
   }
   files = unwrapSingleFolder(files)
   return { sha256: packageSha256, manifest: parseManifest(files), files }
}

// Resolves a manifest-relative file reference without allowing escapes from the package.
function packageFile(files, reference) {
   if (typeof reference !== 'string') return null
   const normalized = reference.replace(/^\.\//, '')
   if (!isSafePath(normalized)) return null
   return files.get(normalized) || null
}

export { loadQuestionPackage, packageFile, sha256 }
