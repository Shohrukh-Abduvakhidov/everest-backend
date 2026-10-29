// Minimal structurally valid media files for inspection tests. They carry real
// container structure (boxes / EBML elements) but no decodable frames.

function box(type, ...payloads) {
   const body = Buffer.concat(payloads)
   const header = Buffer.alloc(8)
   header.writeUInt32BE(body.length + 8, 0)
   header.write(type, 4, 'latin1')
   return Buffer.concat([header, body])
}

function mvhd(timescale, duration) {
   const payload = Buffer.alloc(100)
   payload.writeUInt32BE(timescale, 12)
   payload.writeUInt32BE(duration, 16)
   return box('mvhd', payload)
}

function tkhd(width, height) {
   const payload = Buffer.alloc(84)
   payload.writeUInt32BE(width << 16, 76)
   payload.writeUInt32BE(height << 16, 80)
   return box('tkhd', payload)
}

function hdlr(handler) {
   const payload = Buffer.alloc(25)
   payload.write(handler, 8, 'latin1')
   return box('hdlr', payload)
}

function stsd(codec) {
   const header = Buffer.alloc(8)
   header.writeUInt32BE(1, 4)
   const entry = Buffer.alloc(16)
   entry.writeUInt32BE(16, 0)
   entry.write(codec, 4, 'latin1')
   return box('stsd', header, entry)
}

function trak(handler, codec, width = 0, height = 0) {
   return box('trak', tkhd(width, height), box('mdia', hdlr(handler),
      box('minf', box('stbl', stsd(codec)))))
}

function isoMedia({
   brand = 'isom',
   videoCodec = 'avc1',
   audioCodec = 'mp4a',
   faststart = true,
   mdatBytes = 1024,
   seconds = 90,
} = {}) {
   const ftyp = box('ftyp', Buffer.from(`${brand}\0\0\0\0${brand}`, 'latin1'))
   const tracks = [trak('vide', videoCodec, 1920, 1080)]
   if (audioCodec) tracks.push(trak('soun', audioCodec))
   const moov = box('moov', mvhd(1000, seconds * 1000), ...tracks)
   const mdat = box('mdat', Buffer.alloc(mdatBytes, 7))
   return Buffer.concat(faststart ? [ftyp, moov, mdat] : [ftyp, mdat, moov])
}

function ebml(idHex, ...payloads) {
   const body = Buffer.concat(payloads)
   const size = Buffer.alloc(8)
   size[0] = 0x01
   size.writeUIntBE(body.length, 2, 6)
   return Buffer.concat([Buffer.from(idHex, 'hex'), size, body])
}

function uint(value, bytes = 4) {
   const buffer = Buffer.alloc(bytes)
   buffer.writeUIntBE(value, 0, bytes)
   return buffer
}

function webmMedia({
   videoCodec = 'V_VP9',
   audioCodec = 'A_OPUS',
   docType = 'webm',
   cues = 'start',
} = {}) {
   const cuesElement = ebml('1c53bb6b', ebml('bb', ebml('b3', uint(0, 1))))
   const duration = Buffer.alloc(8)
   duration.writeDoubleBE(12000)
   const tracks = [ebml('ae', ebml('83', uint(1, 1)), ebml('86', Buffer.from(videoCodec)),
      ebml('e0', ebml('b0', uint(1280, 2)), ebml('ba', uint(720, 2))))]
   if (audioCodec) {
      tracks.push(ebml('ae', ebml('83', uint(2, 1)), ebml('86', Buffer.from(audioCodec))))
   }
   return Buffer.concat([
      ebml('1a45dfa3', ebml('4282', Buffer.from(docType))),
      ebml('18538067',
         ebml('1549a966', ebml('2ad7b1', uint(1000000)), ebml('4489', duration)),
         ebml('1654ae6b', ...tracks),
         ...(cues === 'start' ? [cuesElement] : []),
         ebml('1f43b675', Buffer.alloc(512, 3)),
         ...(cues === 'end' ? [cuesElement] : [])),
   ])
}

function officeDocument(entryName) {
   return Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'),
      Buffer.alloc(64),
      Buffer.from(`PK\x01\x02${entryName}`, 'latin1'),
      Buffer.from('PK\x05\x06', 'latin1'),
      Buffer.alloc(18),
   ])
}

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 32)])
const png = Buffer.concat([
   Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
   Buffer.from('IHDR'),
   uint(640),
   uint(480),
   Buffer.alloc(64),
])
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128)])

export { isoMedia, jpg, officeDocument, pdf, png, webmMedia }
