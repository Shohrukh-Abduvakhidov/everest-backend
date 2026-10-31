import { crc32, inflateRawSync } from 'node:zlib'

import AppError from './app-error.js'

// Minimal ZIP reader for question packages: stored and deflated entries only, no ZIP64,
// no encryption. Entries are read from the central directory, never by scanning local
// headers, and every path is checked before use.

const endOfCentralDirectory = 0x06054b50
const centralEntry = 0x02014b50
const localEntry = 0x04034b50
const maxEntries = 100000

function invalid(message) {
   return new AppError(400, 'PACKAGE_ARCHIVE_INVALID', message)
}

function findEndRecord(buffer) {
   const lowest = Math.max(0, buffer.length - 65557)
   for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
      if (buffer.readUInt32LE(offset) === endOfCentralDirectory) return offset
   }
   throw invalid('ZIP end of central directory was not found')
}

function isSafePath(name) {
   return name.length > 0 && name.length <= 500 && !name.startsWith('/') && !name.includes('\\')
      && !/^[A-Za-z]:/.test(name) && !name.split('/').some((part) => part === '..' || part === '.')
}

// Returns Map<path, Buffer> of file entries; directories are skipped.
function readZipEntries(buffer, { maxEntryBytes }) {
   if (buffer.length < 22) throw invalid('ZIP archive is too small')
   const end = findEndRecord(buffer)
   const count = buffer.readUInt16LE(end + 10)
   const directorySize = buffer.readUInt32LE(end + 12)
   const directoryOffset = buffer.readUInt32LE(end + 16)
   if (count === 0xffff || directoryOffset === 0xffffffff || count > maxEntries
      || directoryOffset + directorySize > end) {
      throw invalid('ZIP64 or malformed central directory is not supported')
   }
   const entries = new Map()
   let offset = directoryOffset
   for (let index = 0; index < count; index += 1) {
      if (offset + 46 > end || buffer.readUInt32LE(offset) !== centralEntry) {
         throw invalid('ZIP central directory entry is malformed')
      }
      const flags = buffer.readUInt16LE(offset + 8)
      const method = buffer.readUInt16LE(offset + 10)
      const expectedCrc = buffer.readUInt32LE(offset + 16)
      const compressedSize = buffer.readUInt32LE(offset + 20)
      const size = buffer.readUInt32LE(offset + 24)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const localOffset = buffer.readUInt32LE(offset + 42)
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
      offset += 46 + nameLength + extraLength + commentLength
      if (name.endsWith('/')) continue
      if (!isSafePath(name)) throw invalid('ZIP entry path is not allowed')
      if (flags & 0x1) throw invalid('Encrypted ZIP entries are not supported')
      if (size > maxEntryBytes) {
         throw new AppError(400, 'PACKAGE_ENTRY_TOO_LARGE', 'ZIP entry exceeds the size limit', [
            { field: name, message: 'entry is too large' },
         ])
      }
      if (entries.has(name)) throw invalid('ZIP archive contains a duplicate path')
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== localEntry) {
         throw invalid('ZIP local header is malformed')
      }
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26)
         + buffer.readUInt16LE(localOffset + 28)
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
      if (compressed.length !== compressedSize) throw invalid('ZIP entry data is truncated')
      let data
      if (method === 0) data = Buffer.from(compressed)
      else if (method === 8) {
         try {
            data = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) })
         } catch {
            throw invalid('ZIP entry cannot be decompressed')
         }
      } else throw invalid('ZIP compression method is not supported')
      if (data.length !== size || crc32(data) !== expectedCrc) throw invalid('ZIP entry checksum failed')
      entries.set(name, data)
   }
   return entries
}

export { isSafePath, readZipEntries }
