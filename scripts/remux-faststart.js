import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Staff helper: make a video seek-ready before uploading it. It remuxes into MP4 with
// the moov index at the front (fast start) and copies the streams without re-encoding.
// Runs on a staff computer only; the API server never needs ffmpeg.
//
//   npm run video:faststart -- input.mov [output.mp4]

const [input, requestedOutput] = process.argv.slice(2)

if (!input) {
   console.error('Usage: npm run video:faststart -- <input video> [output.mp4]')
   process.exit(2)
}

if (!existsSync(input)) {
   console.error(`Input file not found: ${input}`)
   process.exit(2)
}

const parsed = path.parse(input)
const output = requestedOutput || path.join(parsed.dir, `${parsed.name}.faststart.mp4`)

if (path.resolve(output) === path.resolve(input)) {
   console.error('Output must be a different file from the input')
   process.exit(2)
}

if (path.extname(output).toLowerCase() !== '.mp4') {
   console.error('Output must have the .mp4 extension')
   process.exit(2)
}

const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
if (probe.error || probe.status !== 0) {
   console.error(
      'ffmpeg was not found. Install ffmpeg (https://ffmpeg.org/download.html) and make sure '
      + 'it is on PATH, or export the video from your editor as "MP4, fast start / web optimized".',
   )
   process.exit(3)
}

const result = spawnSync('ffmpeg', [
   '-hide_banner',
   '-n',
   '-i', input,
   '-map', '0:v:0',
   '-map', '0:a?',
   '-c', 'copy',
   '-movflags', '+faststart',
   output,
], { stdio: 'inherit' })

if (result.status !== 0) {
   console.error(
      'ffmpeg could not remux this file without re-encoding. Its codecs may not be allowed in MP4; '
      + 'export it as H.264/AAC MP4 with fast start from your editor instead.',
   )
   process.exit(result.status || 1)
}

console.log(`Seek-ready MP4 written to ${output}`)
