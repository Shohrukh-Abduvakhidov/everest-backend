// Content inspection for uploaded objects. The declared MIME type is never trusted:
// every object is read back from storage by byte ranges and identified from its own
// structure. Videos are parsed ffprobe-style (container, tracks, codecs, duration,
// dimensions) without decoding or re-encoding anything.

const mib = 1024 * 1024
const maxMoovBytes = 64 * mib
const maxTopLevelBoxes = 4096
const webmProbeBytes = 4 * mib
const zipTailBytes = 256 * 1024
const seekMessage = 'Export as MP4 with fast start (web optimized)'

const mimeTypes = Object.freeze({
   mp4: 'video/mp4',
   mov: 'video/quicktime',
   webm: 'video/webm',
   pdf: 'application/pdf',
   docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
   pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
   jpg: 'image/jpeg',
   png: 'image/png',
})

const isoVideoCodecs = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'])
const isoAudioCodecs = new Set(['mp4a', 'Opus'])
const webmVideoCodecs = new Set(['V_VP8', 'V_VP9', 'V_AV1'])
const webmAudioCodecs = new Set(['A_OPUS', 'A_VORBIS'])

class MediaRejection extends Error {
   constructor(code, message) {
      super(message)
      this.name = 'MediaRejection'
      this.code = code
   }
}

function reject(code, message) {
   throw new MediaRejection(code, message)
}

function startsWith(buffer, bytes) {
   return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte)
}

// ---------------------------------------------------------------- ISO BMFF (mp4/mov)

function readBoxHeader(buffer, offset, limit) {
   if (offset + 8 > limit) return null
   let size = buffer.readUInt32BE(offset)
   const type = buffer.toString('latin1', offset + 4, offset + 8)
   let headerSize = 8
   if (size === 1) {
      if (offset + 16 > limit) return null
      size = Number(buffer.readBigUInt64BE(offset + 8))
      headerSize = 16
   } else if (size === 0) {
      size = limit - offset
   }
   if (size < headerSize || offset + size > limit) return null
   return { type, start: offset, size, headerSize, end: offset + size }
}

function childBoxes(buffer, start, end) {
   const boxes = []
   let offset = start
   while (offset < end) {
      const box = readBoxHeader(buffer, offset, end)
      if (!box) break
      boxes.push(box)
      offset = box.end
   }
   return boxes
}

function findChild(buffer, parent, type) {
   return childBoxes(buffer, parent.start + parent.headerSize, parent.end)
      .find((box) => box.type === type) || null
}

async function scanTopLevelBoxes(read, size) {
   const boxes = []
   let offset = 0
   while (offset < size) {
      if (boxes.length >= maxTopLevelBoxes) reject('MEDIA_MALFORMED', 'Video container is malformed')
      const header = await read(offset, Math.min(offset + 16, size) - 1)
      let boxSize = header.length >= 8 ? header.readUInt32BE(0) : 0
      const type = header.length >= 8 ? header.toString('latin1', 4, 8) : ''
      let headerSize = 8
      if (header.length < 8) reject('MEDIA_MALFORMED', 'Video container is malformed')
      if (boxSize === 1) {
         if (header.length < 16) reject('MEDIA_MALFORMED', 'Video container is malformed')
         boxSize = Number(header.readBigUInt64BE(8))
         headerSize = 16
      } else if (boxSize === 0) {
         boxSize = size - offset
      }
      if (boxSize < headerSize || offset + boxSize > size) {
         reject('MEDIA_MALFORMED', 'Video container is malformed')
      }
      boxes.push({ type, start: offset, size: boxSize, headerSize })
      offset += boxSize
   }
   return boxes
}

function parseTrack(moov, trak) {
   const mdia = findChild(moov, trak, 'mdia')
   const hdlr = mdia && findChild(moov, mdia, 'hdlr')
   if (!hdlr) return null
   const handler = moov.toString('latin1', hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12)
   const minf = findChild(moov, mdia, 'minf')
   const stbl = minf && findChild(moov, minf, 'stbl')
   const stsd = stbl && findChild(moov, stbl, 'stsd')
   let codec = null
   if (stsd) {
      const entryStart = stsd.start + stsd.headerSize + 8
      if (entryStart + 8 <= stsd.end) codec = moov.toString('latin1', entryStart + 4, entryStart + 8)
   }
   let width = null
   let height = null
   const tkhd = findChild(moov, trak, 'tkhd')
   if (tkhd && tkhd.end - 8 >= tkhd.start + tkhd.headerSize) {
      width = moov.readUInt32BE(tkhd.end - 8) >>> 16
      height = moov.readUInt32BE(tkhd.end - 4) >>> 16
   }
   return { handler, codec, width, height }
}

function parseDuration(moov, mvhd) {
   if (!mvhd) return null
   const payload = mvhd.start + mvhd.headerSize
   const version = moov[payload]
   const timescale = moov.readUInt32BE(payload + (version === 1 ? 20 : 12))
   const duration = version === 1
      ? Number(moov.readBigUInt64BE(payload + 24))
      : moov.readUInt32BE(payload + 16)
   if (!timescale) return null
   return Math.round(duration / timescale)
}

async function inspectIsoMedia(read, size) {
   const boxes = await scanTopLevelBoxes(read, size)
   const ftyp = boxes[0]?.type === 'ftyp' ? boxes[0] : null
   const moovBox = boxes.find((box) => box.type === 'moov')
   const mdat = boxes.find((box) => box.type === 'mdat')
   if (!moovBox || !mdat) reject('MEDIA_MALFORMED', 'Video has no playable movie data')
   if (moovBox.size > maxMoovBytes) reject('MEDIA_MALFORMED', 'Video metadata is too large')
   let container = 'mov'
   if (ftyp) {
      const brand = (await read(ftyp.start + 8, ftyp.start + 11)).toString('latin1')
      container = brand === 'qt  ' ? 'mov' : 'mp4'
   }
   if (container === 'mov') {
      reject('MEDIA_TYPE_MISMATCH', `QuickTime files are not accepted. ${seekMessage}`)
   }
   const moov = await read(moovBox.start, moovBox.start + moovBox.size - 1)
   const root = { start: 0, headerSize: moovBox.headerSize, end: moov.length }
   const children = childBoxes(moov, root.headerSize, root.end)
   const tracks = children
      .filter((box) => box.type === 'trak')
      .map((trak) => parseTrack(moov, trak))
      .filter(Boolean)
   const video = tracks.filter((track) => track.handler === 'vide')
   const audio = tracks.filter((track) => track.handler === 'soun')
   if (!video.length) reject('MEDIA_NO_VIDEO_TRACK', 'Video has no video track')
   for (const track of video) {
      if (!isoVideoCodecs.has(track.codec)) {
         reject('MEDIA_UNSUPPORTED_CODEC', `Video codec ${track.codec || 'unknown'} is not supported`)
      }
   }
   for (const track of audio) {
      if (!isoAudioCodecs.has(track.codec)) {
         reject('MEDIA_UNSUPPORTED_CODEC', `Audio codec ${track.codec || 'unknown'} is not supported`)
      }
   }
   // Seek-ready only: the moov index must precede the media data so a player can
   // seek through Range requests without first downloading the whole file.
   if (moovBox.start > mdat.start) reject('VIDEO_NOT_SEEKABLE', seekMessage)
   return {
      mimeType: mimeTypes[container],
      container,
      videoCodec: video[0].codec,
      audioCodec: audio[0]?.codec || null,
      durationSeconds: parseDuration(moov, children.find((box) => box.type === 'mvhd')),
      widthPx: video[0].width || null,
      heightPx: video[0].height || null,
   }
}

// ---------------------------------------------------------------- EBML (webm)

function readVint(buffer, offset, keepMarker) {
   const first = buffer[offset]
   if (first === undefined || first === 0) return null
   let length = 1
   while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1
   if (length > 8 || offset + length > buffer.length) return null
   let value = keepMarker ? first : first & (0xff >> length)
   let allOnes = value === (0xff >> length)
   for (let index = 1; index < length; index += 1) {
      value = value * 256 + buffer[offset + index]
      if (buffer[offset + index] !== 0xff) allOnes = false
   }
   return { value, length, unknown: !keepMarker && allOnes }
}

function readElement(buffer, offset) {
   const id = readVint(buffer, offset, true)
   if (!id) return null
   const size = readVint(buffer, offset + id.length, false)
   if (!size) return null
   const dataStart = offset + id.length + size.length
   const dataEnd = size.unknown ? buffer.length : Math.min(dataStart + size.value, buffer.length)
   return { id: id.value, dataStart, dataEnd, unknown: size.unknown, truncated: !size.unknown && dataStart + size.value > buffer.length }
}

const ebml = Object.freeze({
   header: 0x1a45dfa3,
   docType: 0x4282,
   segment: 0x18538067,
   info: 0x1549a966,
   timecodeScale: 0x2ad7b1,
   duration: 0x4489,
   tracks: 0x1654ae6b,
   trackEntry: 0xae,
   trackType: 0x83,
   codecId: 0x86,
   video: 0xe0,
   pixelWidth: 0xb0,
   pixelHeight: 0xba,
   cluster: 0x1f43b675,
   cues: 0x1c53bb6b,
})

function children(buffer, start, end, visit) {
   let offset = start
   while (offset < end) {
      const element = readElement(buffer, offset)
      if (!element) return
      if (visit(element) === false) return
      if (element.unknown) return
      offset = element.dataEnd
   }
}

function readUnsigned(buffer, element) {
   let value = 0
   for (let index = element.dataStart; index < element.dataEnd; index += 1) {
      value = value * 256 + buffer[index]
   }
   return value
}

function readFloat(buffer, element) {
   const length = element.dataEnd - element.dataStart
   if (length === 4) return buffer.readFloatBE(element.dataStart)
   if (length === 8) return buffer.readDoubleBE(element.dataStart)
   return null
}

async function inspectWebm(read, size) {
   const buffer = await read(0, Math.min(size, webmProbeBytes) - 1)
   const header = readElement(buffer, 0)
   if (!header || header.id !== ebml.header) reject('MEDIA_MALFORMED', 'Video container is malformed')
   let docType = null
   children(buffer, header.dataStart, header.dataEnd, (element) => {
      if (element.id === ebml.docType) {
         docType = buffer.toString('latin1', element.dataStart, element.dataEnd).replace(/\0+$/, '')
      }
   })
   if (docType !== 'webm') reject('MEDIA_TYPE_MISMATCH', 'File is not a WebM video')
   const segment = readElement(buffer, header.dataEnd)
   if (!segment || segment.id !== ebml.segment) reject('MEDIA_MALFORMED', 'Video container is malformed')
   const tracks = []
   let timecodeScale = 1000000
   let duration = null
   let cuesBeforeClusters = false
   children(buffer, segment.dataStart, segment.dataEnd, (element) => {
      if (element.id === ebml.cluster) return false
      if (element.id === ebml.cues) cuesBeforeClusters = true
      if (element.id === ebml.info) {
         children(buffer, element.dataStart, element.dataEnd, (field) => {
            if (field.id === ebml.timecodeScale) timecodeScale = readUnsigned(buffer, field)
            if (field.id === ebml.duration) duration = readFloat(buffer, field)
         })
      }
      if (element.id === ebml.tracks) {
         children(buffer, element.dataStart, element.dataEnd, (entry) => {
            if (entry.id !== ebml.trackEntry) return
            const track = { type: null, codec: null, width: null, height: null }
            children(buffer, entry.dataStart, entry.dataEnd, (field) => {
               if (field.id === ebml.trackType) track.type = readUnsigned(buffer, field)
               if (field.id === ebml.codecId) {
                  track.codec = buffer.toString('latin1', field.dataStart, field.dataEnd)
               }
               if (field.id === ebml.video) {
                  children(buffer, field.dataStart, field.dataEnd, (dimension) => {
                     if (dimension.id === ebml.pixelWidth) track.width = readUnsigned(buffer, dimension)
                     if (dimension.id === ebml.pixelHeight) track.height = readUnsigned(buffer, dimension)
                  })
               }
            })
            tracks.push(track)
         })
      }
      return true
   })
   const video = tracks.filter((track) => track.type === 1)
   const audio = tracks.filter((track) => track.type === 2)
   if (!video.length) reject('MEDIA_NO_VIDEO_TRACK', 'Video has no video track')
   for (const track of video) {
      if (!webmVideoCodecs.has(track.codec)) {
         reject('MEDIA_UNSUPPORTED_CODEC', `Video codec ${track.codec || 'unknown'} is not supported`)
      }
   }
   for (const track of audio) {
      if (!webmAudioCodecs.has(track.codec)) {
         reject('MEDIA_UNSUPPORTED_CODEC', `Audio codec ${track.codec || 'unknown'} is not supported`)
      }
   }
   // Cues (the seek index) must be written before the first cluster.
   if (!cuesBeforeClusters) reject('VIDEO_NOT_SEEKABLE', 'Export as WebM with cues at the start, or as MP4 with fast start (web optimized)')
   return {
      mimeType: mimeTypes.webm,
      container: 'webm',
      videoCodec: video[0].codec,
      audioCodec: audio[0]?.codec || null,
      durationSeconds: duration === null ? null : Math.round(duration * timecodeScale / 1e9),
      widthPx: video[0].width || null,
      heightPx: video[0].height || null,
   }
}

// ---------------------------------------------------------------- materials

function pngDimensions(head) {
   if (head.length < 24) return {}
   return { widthPx: head.readUInt32BE(16), heightPx: head.readUInt32BE(20) }
}

async function detectOfficeType(read, size) {
   const start = Math.max(0, size - zipTailBytes)
   const tail = (await read(start, size - 1)).toString('latin1')
   if (!tail.includes('PK\x05\x06')) reject('MEDIA_MALFORMED', 'Document archive is malformed')
   if (tail.includes('word/document.xml')) return 'docx'
   if (tail.includes('ppt/presentation.xml')) return 'pptx'
   return null
}

async function sniffType(read, size) {
   const head = await read(0, Math.min(size, 64) - 1)
   if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: 'pdf' }
   if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { type: 'png', ...pngDimensions(head) }
   }
   if (startsWith(head, [0xff, 0xd8, 0xff])) return { type: 'jpg' }
   if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { type: 'webm' }
   if (head.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']
      .includes(head.toString('latin1', 4, 8))) {
      return { type: 'iso' }
   }
   if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
      const office = await detectOfficeType(read, size)
      if (office) return { type: office }
   }
   return { type: null }
}

// Returns the detected metadata, or throws MediaRejection with a stable code.
async function inspectMedia({ read, size, kind, declaredMimeType }) {
   if (!Number.isSafeInteger(size) || size <= 0) reject('MEDIA_EMPTY', 'Uploaded file is empty')
   const sniffed = await sniffType(read, size)
   let result
   if (kind === 'video') {
      if (sniffed.type === 'iso') result = await inspectIsoMedia(read, size)
      else if (sniffed.type === 'webm') result = await inspectWebm(read, size)
      else reject('MEDIA_TYPE_MISMATCH', 'File content is not a supported video')
   } else {
      if (!sniffed.type || ['iso', 'webm'].includes(sniffed.type)) {
         reject('MEDIA_TYPE_MISMATCH', 'File content is not a supported material type')
      }
      result = {
         mimeType: mimeTypes[sniffed.type],
         widthPx: sniffed.widthPx || null,
         heightPx: sniffed.heightPx || null,
         durationSeconds: null,
      }
   }
   if (result.mimeType !== declaredMimeType) {
      reject('MEDIA_TYPE_MISMATCH', 'File content does not match the declared type')
   }
   return result
}

export { inspectMedia, MediaRejection, mimeTypes }
