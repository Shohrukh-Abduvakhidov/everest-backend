import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'

// Synthetic fixtures for the M09 importer: tiny generated PNGs, a minimal ZIP writer and
// a helper that writes a package directory. No real book content is used anywhere.

function chunk(type, data) {
   const length = Buffer.alloc(4)
   length.writeUInt32BE(data.length)
   const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
   const checksum = Buffer.alloc(4)
   checksum.writeUInt32BE(crc32(body))
   return Buffer.concat([length, body, checksum])
}

// A valid RGB PNG filled with one colour; different seeds give different bytes.
function createPng(width = 2, height = 2, seed = 0) {
   const header = Buffer.alloc(13)
   header.writeUInt32BE(width, 0)
   header.writeUInt32BE(height, 4)
   header[8] = 8
   header[9] = 2
   const row = Buffer.alloc(1 + width * 3)
   for (let x = 0; x < width; x += 1) row.set([seed % 256, (seed * 7) % 256, (seed * 13) % 256], 1 + x * 3)
   const raw = Buffer.concat(Array.from({ length: height }, () => row))
   return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
   ])
}

// Minimal ZIP writer (stored or deflated entries) used to test the package reader.
function createZip(entries) {
   const locals = []
   const centrals = []
   let offset = 0
   for (const { name, data, deflate = true } of entries) {
      const nameBuffer = Buffer.from(name, 'utf8')
      const body = deflate ? deflateRawSync(data) : data
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(deflate ? 8 : 0, 8)
      local.writeUInt32LE(crc32(data), 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(deflate ? 8 : 0, 10)
      central.writeUInt32LE(crc32(data), 16)
      central.writeUInt32LE(body.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt32LE(offset, 42)
      locals.push(local, nameBuffer, body)
      centrals.push(central, nameBuffer)
      offset += local.length + nameBuffer.length + body.length
   }
   const directory = Buffer.concat(centrals)
   const end = Buffer.alloc(22)
   end.writeUInt32LE(0x06054b50, 0)
   end.writeUInt16LE(entries.length, 8)
   end.writeUInt16LE(entries.length, 10)
   end.writeUInt32LE(directory.length, 12)
   end.writeUInt32LE(offset, 16)
   return Buffer.concat([...locals, directory, end])
}

// Writes `manifest` (object or raw string) and `files` ({ relativePath: Buffer }) to a new
// temporary directory and returns its path.
async function writePackageDirectory(manifest, files = {}) {
   const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-import-'))
   await writeFile(
      path.join(directory, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
   )
   for (const [name, data] of Object.entries(files)) {
      const full = path.join(directory, ...name.split('/'))
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, data)
   }
   return directory
}

export { createPng, createZip, writePackageDirectory }
