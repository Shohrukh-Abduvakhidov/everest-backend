import { createHash } from 'node:crypto'
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

const paragraph = (...children) => ({ type: 'paragraph', children })
const span = (text, marks = []) => ({ type: 'text', text, marks })

// A synthetic package in the real relational format (manifest.json + data/*.json envelopes),
// shaped like the Tajik and biology book packages: paragraph spans with mixed marks, a line
// group, an image block, an image linked only through question_assets, matching column
// headers, an `open` question, unstated matching rules, a declared duplicate and fields
// without a database column.
function entityPackage({ subjectCode, bankCode, namespace, png, answerKeys = {} }) {
   const envelope = (entity, records) => Buffer.from(JSON.stringify({
      schemaVersion: 'everest.question-import.v1',
      entity,
      records,
   }))
   const id = (suffix) => `${bankCode}-${suffix}`
   const question = (suffix, questionType, content, extra = {}) => ({
      bankCode,
      subjectCode,
      sectionCode: 'part-a',
      externalId: id(suffix),
      questionType,
      languageCode: 'tg',
      difficulty: 2,
      difficultySource: 'ai',
      status: 'draft',
      content: { blocks: content },
      interactionSettings: {},
      sourceMetadata: {
         sourceFile: 'synthetic.pdf',
         sequence: 1,
         sourceNumber: '7',
         pageIndex1Based: 3,
         printedPage: '3',
         bookSectionTitle: 'Synthetic section',
         examPart: ['A'],
         isSample: false,
         reviewRequired: false,
         bbox: [0.1, 0.2, 0.3, 0.4],
         transcriptionIssues: [],
      },
      ...extra,
   })
   const option = (suffix, key, position, text) => ({
      bankCode,
      questionExternalId: id(suffix),
      optionKey: key,
      position,
      sourceLabel: `${key.toUpperCase()})`,
      content: { blocks: [paragraph(span(text))] },
      sourceMetadata: { bbox: [0, 0, 1, 1] },
   })
   const item = (suffix, side, key, position, text) => ({
      bankCode,
      questionExternalId: id(suffix),
      side,
      itemKey: key,
      position,
      sourceLabel: `${position})`,
      content: { blocks: [paragraph(span(text))] },
   })
   const key = (suffix) => ({
      bankCode,
      questionExternalId: id(suffix),
      status: 'unknown',
      source: 'none',
      answerDataExternal: null,
      explanation: { blocks: [] },
      ...answerKeys[suffix],
   })
   const questions = [
      question('single-0001', 'single_choice', [
         paragraph(span('Synthetic stem with ', ['bold']), span('mixed', ['bold', 'italic']), span(' marks', ['bold'])),
         { type: 'image', assetExternalId: 'fig-1', alt: 'Synthetic figure' },
      ]),
      question('single-0002', 'single_choice', [paragraph(span('Synthetic stem with a linked figure'))]),
      question('single-0003', 'single_choice', [paragraph(span('Synthetic stem with ', ['bold']), span('mixed', ['bold', 'italic']), span(' marks', ['bold']))]),
      question('matching-0001', 'matching', [
         paragraph(span('Synthetic matching')),
         { type: 'columnHeaders', left: 'Term', right: 'Meaning' },
      ], { interactionSettings: { requireAllLeft: true, allowRightReuse: null } }),
      question('open-0001', 'open', [
         { type: 'line_group', lines: [{ children: [span('Line one', ['italic'])] }, { children: [span('Line two')] }] },
      ], {
         interactionSettings: { answerFormat: 'short_text', inputCells: 4, allowedCharacters: 'digits' },
         difficultyReason: 'synthetic',
      }),
   ]
   const optionsOf = (suffix, prefix) => ['a', 'b', 'c', 'd'].map((optionKey, index) => option(suffix, optionKey, index + 1, `${prefix} ${optionKey}`))
   const files = {
      'data/subjects.json': envelope('subjects', [{ code: subjectCode, primaryLanguage: 'tg', isActive: true }]),
      'data/subject_translations.json': envelope('subject_translations', [{ subjectCode, languageCode: 'tg', title: 'Synthetic subject' }]),
      'data/sections.json': envelope('sections', [{ subjectCode, code: 'part-a', primaryLanguage: 'tg', position: 1, isActive: true }]),
      'data/section_translations.json': envelope('section_translations', [{ subjectCode, sectionCode: 'part-a', languageCode: 'tg', title: 'Part A' }]),
      'data/topics.json': envelope('topics', [{ subjectCode, code: 'topic-a', sectionCode: 'part-a', parentTopicCode: null, primaryLanguage: 'tg', position: 1, metadata: { classificationSource: 'ai' } }]),
      'data/topic_translations.json': envelope('topic_translations', [{ subjectCode, topicCode: 'topic-a', languageCode: 'tg', title: 'Topic A' }]),
      'data/question_banks.json': envelope('question_banks', [{
         code: bankCode,
         title: 'Synthetic book bank',
         subjectCode,
         primaryLanguage: 'tg',
         sourceMetadata: { sourceNamespace: namespace, sourceFile: 'synthetic.pdf', examYear: 2026, totalPdfPages: 3 },
      }]),
      'data/questions.part001.json': envelope('questions', questions.slice(0, 3)),
      'data/questions.part002.json': envelope('questions', questions.slice(3)),
      'data/question_options.part001.json': envelope('question_options', [
         ...optionsOf('single-0001', 'alpha'),
         ...optionsOf('single-0002', 'beta'),
         ...optionsOf('single-0003', 'alpha'),
      ]),
      'data/question_matching_items.json': envelope('question_matching_items', [
         item('matching-0001', 'left', 'l1', 1, 'left one'),
         item('matching-0001', 'left', 'l2', 2, 'left two'),
         item('matching-0001', 'right', 'r1', 1, 'right one'),
         item('matching-0001', 'right', 'r2', 2, 'right two'),
         item('matching-0001', 'right', 'r3', 3, 'right three'),
      ]),
      'data/question_answer_keys.json': envelope('question_answer_keys', ['single-0001', 'single-0002', 'single-0003', 'matching-0001', 'open-0001'].map(key)),
      'data/question_topics.json': envelope('question_topics', questions.map((entry) => ({
         bankCode,
         questionExternalId: entry.externalId,
         subjectCode,
         topicCode: 'topic-a',
         isPrimary: true,
      }))),
      'data/assets.json': envelope('assets', [{
         sourceNamespace: namespace,
         externalId: 'fig-1',
         relativePath: 'assets/fig-1.png',
         mimeType: 'image/png',
         sizeBytes: png.length,
         sha256: createHash('sha256').update(png).digest('hex'),
         widthPx: png.readUInt32BE(16),
         heightPx: png.readUInt32BE(20),
         status: 'ready',
         sourceMetadata: { extractionMethod: 'synthetic', pageIndex1Based: 3 },
      }]),
      'data/question_assets.json': envelope('question_assets', [
         { bankCode, questionExternalId: id('single-0001'), assetExternalId: 'fig-1', sourceNamespace: namespace, usageRole: 'stem' },
         { bankCode, questionExternalId: id('single-0002'), assetExternalId: 'fig-1', sourceNamespace: namespace, usageRole: 'stem' },
      ]),
      'data/question_duplicate_links.json': envelope('question_duplicate_links', [{
         bankCode,
         questionExternalId: id('single-0003'),
         duplicateOfExternalId: id('single-0001'),
         reason: 'synthetic full-text duplicate',
      }]),
      'assets/fig-1.png': png,
   }
   const manifest = {
      schemaVersion: 'everest.question-import.v1',
      packageId: `${bankCode}-synthetic`,
      sourceNamespace: namespace,
      bankCodes: [bankCode],
      subjectCodes: [subjectCode],
      readyForImport: true,
      files: Object.entries(files).filter(([name]) => name.startsWith('data/')).map(([name, data]) => ({
         path: name,
         sha256: createHash('sha256').update(data).digest('hex'),
      })),
   }
   return { manifest, files }
}

export { createPng, createZip, entityPackage, writePackageDirectory }
