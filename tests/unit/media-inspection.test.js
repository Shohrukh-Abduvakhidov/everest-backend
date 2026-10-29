import assert from 'node:assert/strict'
import test from 'node:test'

import { choosePartSize } from '../../src/services/asset-upload-service.js'
import { inspectMedia, mimeTypes } from '../../src/utils/media-inspection.js'
import {
   isoMedia,
   jpg,
   officeDocument,
   pdf,
   png,
   webmMedia,
} from '../helpers/media-fixtures.js'

function input(buffer, kind, declaredMimeType) {
   return {
      read: async (start, end) => buffer.subarray(start, end + 1),
      size: buffer.length,
      kind,
      declaredMimeType,
   }
}

async function rejects(promise, code) {
   await assert.rejects(promise, (error) => error.name === 'MediaRejection' && error.code === code)
}

test('media inspection identifies videos by structure, not declared type', async (t) => {
   await t.test('faststart H.264/AAC mp4 is seek-ready with duration and dimensions', async () => {
      const result = await inspectMedia(input(isoMedia(), 'video', mimeTypes.mp4))
      assert.equal(result.container, 'mp4')
      assert.equal(result.videoCodec, 'avc1')
      assert.equal(result.audioCodec, 'mp4a')
      assert.equal(result.durationSeconds, 90)
      assert.equal(result.widthPx, 1920)
      assert.equal(result.heightPx, 1080)
   })

   await t.test('mp4 with moov after mdat is not seekable', async () => {
      await rejects(
         inspectMedia(input(isoMedia({ faststart: false }), 'video', mimeTypes.mp4)),
         'VIDEO_NOT_SEEKABLE',
      )
   })

   await t.test('QuickTime files are rejected whatever they are declared as', async () => {
      const mov = isoMedia({ brand: 'qt  ', videoCodec: 'hvc1' })
      await rejects(inspectMedia(input(mov, 'video', mimeTypes.mov)), 'MEDIA_TYPE_MISMATCH')
      await rejects(inspectMedia(input(mov, 'video', mimeTypes.mp4)), 'MEDIA_TYPE_MISMATCH')
   })

   await t.test('unsupported video and audio codecs are rejected', async () => {
      await rejects(
         inspectMedia(input(isoMedia({ videoCodec: 'apcn' }), 'video', mimeTypes.mp4)),
         'MEDIA_UNSUPPORTED_CODEC',
      )
      await rejects(
         inspectMedia(input(isoMedia({ audioCodec: 'alac' }), 'video', mimeTypes.mp4)),
         'MEDIA_UNSUPPORTED_CODEC',
      )
   })

   await t.test('VP9/Opus webm with cues before clusters', async () => {
      const result = await inspectMedia(input(webmMedia(), 'video', mimeTypes.webm))
      assert.equal(result.videoCodec, 'V_VP9')
      assert.equal(result.audioCodec, 'A_OPUS')
      assert.equal(result.durationSeconds, 12)
      assert.equal(result.widthPx, 1280)
   })

   await t.test('webm without cues, or with cues only after clusters, is not seekable', async () => {
      await rejects(inspectMedia(input(webmMedia({ cues: 'none' }), 'video', mimeTypes.webm)), 'VIDEO_NOT_SEEKABLE')
      await rejects(inspectMedia(input(webmMedia({ cues: 'end' }), 'video', mimeTypes.webm)), 'VIDEO_NOT_SEEKABLE')
   })

   await t.test('Matroska docType and unsupported webm codec are rejected', async () => {
      await rejects(
         inspectMedia(input(webmMedia({ docType: 'matroska' }), 'video', mimeTypes.webm)),
         'MEDIA_TYPE_MISMATCH',
      )
      await rejects(
         inspectMedia(input(webmMedia({ videoCodec: 'V_MPEG4/ISO/AVC' }), 'video', mimeTypes.webm)),
         'MEDIA_UNSUPPORTED_CODEC',
      )
   })

   await t.test('a pdf declared as video is rejected', async () => {
      await rejects(inspectMedia(input(pdf, 'video', mimeTypes.mp4)), 'MEDIA_TYPE_MISMATCH')
   })

   await t.test('truncated container is malformed', async () => {
      const truncated = isoMedia().subarray(0, 60)
      await rejects(inspectMedia(input(truncated, 'video', mimeTypes.mp4)), 'MEDIA_MALFORMED')
   })
})

test('media inspection verifies material magic bytes', async (t) => {
   await t.test('each allowed material type is recognized', async () => {
      assert.equal((await inspectMedia(input(pdf, 'material', mimeTypes.pdf))).mimeType, mimeTypes.pdf)
      assert.equal((await inspectMedia(input(jpg, 'material', mimeTypes.jpg))).mimeType, mimeTypes.jpg)
      const image = await inspectMedia(input(png, 'material', mimeTypes.png))
      assert.deepEqual([image.widthPx, image.heightPx], [640, 480])
      const docx = officeDocument('word/document.xml')
      assert.equal((await inspectMedia(input(docx, 'material', mimeTypes.docx))).mimeType, mimeTypes.docx)
      const pptx = officeDocument('ppt/presentation.xml')
      assert.equal((await inspectMedia(input(pptx, 'material', mimeTypes.pptx))).mimeType, mimeTypes.pptx)
   })

   await t.test('renamed or unknown content is rejected', async () => {
      await rejects(inspectMedia(input(png, 'material', mimeTypes.pdf)), 'MEDIA_TYPE_MISMATCH')
      await rejects(
         inspectMedia(input(officeDocument('xl/workbook.xml'), 'material', mimeTypes.docx)),
         'MEDIA_TYPE_MISMATCH',
      )
      await rejects(
         inspectMedia(input(Buffer.from('#!/bin/sh\necho'), 'material', mimeTypes.pdf)),
         'MEDIA_TYPE_MISMATCH',
      )
      await rejects(inspectMedia(input(isoMedia(), 'material', mimeTypes.pdf)), 'MEDIA_TYPE_MISMATCH')
   })
})

test('server-chosen part size respects the 10,000 part limit', () => {
   const mib = 1024 * 1024
   assert.deepEqual(choosePartSize(10, 32 * mib), { partSizeBytes: 32 * mib, partCount: 1 })
   assert.deepEqual(choosePartSize(3 * 1024 * mib, 32 * mib), { partSizeBytes: 32 * mib, partCount: 96 })
   const max = choosePartSize(20 * 1024 * mib, 32 * mib)
   assert.equal(max.partCount, 640)
   const small = choosePartSize(20 * 1024 * mib, 5 * mib)
   assert.ok(small.partCount <= 10000)
   assert.equal(small.partSizeBytes % mib, 0)
})
