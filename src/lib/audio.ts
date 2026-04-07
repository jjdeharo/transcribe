import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

const SAMPLE_RATE = 16_000
const FFMPEG_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

let ffmpegInstance: FFmpeg | null = null
let ffmpegLoaded = false

export class TranscriptionError extends Error {}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatDuration(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)

  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':') + `.${String(ms).padStart(3, '0')}`
}

export async function extractMono16kAudio(
  file: File,
  onStatus: (message: string) => void,
): Promise<Float32Array> {
  onStatus('Preparando el archivo…')

  let audioBuffer: ArrayBuffer
  if (isVideoFile(file)) {
    onStatus('Extrayendo audio del vídeo con ffmpeg.wasm…')
    audioBuffer = await extractAudioTrack(file, onStatus)
  } else {
    audioBuffer = await file.arrayBuffer()
  }

  onStatus('Decodificando audio…')
  return decodeToMono16k(audioBuffer)
}

async function extractAudioTrack(file: File, onStatus: (message: string) => void): Promise<ArrayBuffer> {
  const ffmpeg = await getFfmpeg(onStatus)
  const inputName = `input${getFileExtension(file.name) || '.bin'}`
  const outputName = 'audio.wav'

  await ffmpeg.writeFile(inputName, await fetchFile(file))
  await ffmpeg.exec([
    '-i',
    inputName,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'wav',
    outputName,
  ])

  const data = await ffmpeg.readFile(outputName)
  await safeDelete(ffmpeg, inputName)
  await safeDelete(ffmpeg, outputName)

  if (!(data instanceof Uint8Array)) {
    throw new TranscriptionError('ffmpeg.wasm devolvió un formato inesperado al extraer el audio.')
  }

  return data.slice().buffer
}

async function getFfmpeg(onStatus: (message: string) => void): Promise<FFmpeg> {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg()
  }

  if (!ffmpegLoaded) {
    onStatus('Cargando ffmpeg.wasm (~31 MB)…')
    await ffmpegInstance.load({
      coreURL: await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    ffmpegLoaded = true
  }

  return ffmpegInstance
}

async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // Ignore virtual FS cleanup failures.
  }
}

async function decodeToMono16k(audioFile: ArrayBuffer): Promise<Float32Array> {
  const audioContext = new AudioContext()

  try {
    const decoded = await audioContext.decodeAudioData(audioFile.slice(0))
    const mono = mixToMono(decoded)
    return resampleTo16k(mono, decoded.sampleRate)
  } catch (error) {
    throw new TranscriptionError(
      error instanceof Error
        ? `El navegador no pudo decodificar el audio: ${error.message}`
        : 'El navegador no pudo decodificar el audio.',
    )
  } finally {
    await audioContext.close()
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length)

  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex)
    for (let index = 0; index < buffer.length; index += 1) {
      mono[index] += channel[index] / buffer.numberOfChannels
    }
  }

  return mono
}

function resampleTo16k(input: Float32Array, originalSampleRate: number): Float32Array {
  if (originalSampleRate === SAMPLE_RATE) {
    return input
  }

  const ratio = originalSampleRate / SAMPLE_RATE
  const newLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(newLength)

  for (let index = 0; index < newLength; index += 1) {
    const position = index * ratio
    const lowerIndex = Math.floor(position)
    const upperIndex = Math.min(lowerIndex + 1, input.length - 1)
    const weight = position - lowerIndex
    output[index] = input[lowerIndex] * (1 - weight) + input[upperIndex] * weight
  }

  return output
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex) : ''
}
