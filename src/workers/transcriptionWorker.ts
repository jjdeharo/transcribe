import { env, LogLevel, pipeline } from '@huggingface/transformers'

type Segment = {
  id: number
  start: number
  end: number
  text: string
}

type WorkerRequest = {
  type: 'transcribe'
  payload: {
    duration: number
    language: string | null
    modelId: string
    samples: ArrayBufferLike
  }
}

type PipelineChunk = {
  text?: string
  timestamp?: [number | null, number | null]
}

type PipelineResult = {
  chunks?: PipelineChunk[]
  text?: string
}

type WhisperDecodeChunk = {
  stride: [number, number, number]
  tokens: bigint[]
}

type WhisperDecodedChunk = {
  language?: string | null
  text?: string
  timestamp?: [number | null, number | null]
}

type WhisperPipeline = {
  (audio: Float32Array, options: Record<string, unknown>): Promise<PipelineResult>
  model: {
    config: {
      max_source_positions: number
    }
    generation_config?: {
      decoder_start_token_id?: number | null
      is_multilingual?: boolean | null
      lang_to_id?: Record<string, number> | null
    }
    generate(args: Record<string, unknown>): Promise<unknown>
  }
  processor: {
    feature_extractor: {
      config: {
        chunk_length: number
        hop_length: number
      }
    }
    (audio: Float32Array): Promise<{ input_features: unknown }>
  }
  tokenizer: {
    _decode_asr(
      sequences: WhisperDecodeChunk[],
      options: {
        force_full_sequences?: boolean
        return_language?: boolean
        return_timestamps?: boolean | 'word'
        time_precision: number
      },
    ): [string, { chunks?: WhisperDecodedChunk[] }]
  }
}

const SAMPLE_RATE = 16_000
const CHUNK_SECONDS = 20

env.logLevel = LogLevel.NONE

let currentModelId: string | null = null
let currentTranscriber: WhisperPipeline | null = null

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data

  if (message.type !== 'transcribe') {
    return
  }

  try {
    const { duration, language, modelId, samples } = message.payload
    const audio = new Float32Array(samples)

    postMessage({ type: 'status', payload: 'Preparando el modelo de transcripción…' })
    const transcriber = await getTranscriber(modelId)
    const resolvedLanguage = language || await detectWhisperLanguage(transcriber, audio)

    const pieces = splitAudio(audio, CHUNK_SECONDS)
    const total = pieces.length
    const collectedSegments: Segment[] = []
    const collectedTexts: string[] = []

    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]

      postMessage({ type: 'chunkProgress', payload: { completed: index + 1, total } })
      const result = await transcriber(piece.audio, {
        return_timestamps: true,
        task: 'transcribe',
        ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
      })

      const normalized = normalizeChunkSegments(result, piece.offsetSeconds, piece.durationSeconds)
      if (normalized.length > 0) {
        collectedSegments.push(...normalized)
      }

      const chunkText = (result.text ?? normalized.map((segment) => segment.text).join(' ')).trim()
      if (chunkText) {
        collectedTexts.push(chunkText)
      }
    }

    const finalSegments = reindexSegments(fixSegmentBounds(collectedSegments, duration))
    postMessage({
      type: 'result',
      payload: {
        segments: finalSegments,
        text: collectedTexts.join('\n').trim(),
        detectedLanguage: resolvedLanguage,
      },
    })
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'La transcripción falló en el worker.'
    const normalizedMessage = rawMessage.toLowerCase()
    const message =
      rawMessage.includes('Unauthorized access to file')
        ? 'El modelo seleccionado no está disponible públicamente para esta aplicación en el navegador.'
        : normalizedMessage.includes('bad_alloc') || normalizedMessage.includes('out of memory')
          ? 'No hay memoria suficiente para cargar o ejecutar este modelo en el navegador. Prueba con un modelo mas ligero o cierra otras pestañas y aplicaciones antes de reintentarlo.'
        : normalizedMessage.includes('networkerror') || normalizedMessage.includes('failed to fetch')
          ? 'No se pudo descargar o cargar el modelo por un problema de red. Si tu conexion es inestable, vuelve a intentarlo o prueba primero con un modelo mas ligero.'
          : rawMessage
    postMessage({ type: 'error', payload: message })
  }
}

async function getTranscriber(modelId: string) {
  if (currentTranscriber && currentModelId === modelId) {
    return currentTranscriber
  }

  currentModelId = modelId
  currentTranscriber = (await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'fp32',
    progress_callback: (progress) => {
      postMessage({ type: 'download', payload: progress })
    },
  })) as unknown as WhisperPipeline

  return currentTranscriber
}

async function detectWhisperLanguage(transcriber: WhisperPipeline, audio: Float32Array): Promise<string | null> {
  const generationConfig = transcriber.model.generation_config
  if (!generationConfig?.is_multilingual || !generationConfig.lang_to_id) {
    return null
  }

  const decoderStartTokenId = generationConfig.decoder_start_token_id
  if (typeof decoderStartTokenId !== 'number') {
    return null
  }

  const probeChunk = splitAudio(audio, CHUNK_SECONDS)[0]?.audio
  if (!probeChunk || probeChunk.length === 0) {
    return null
  }

  const { input_features } = await transcriber.processor(probeChunk)
  const generated = await transcriber.model.generate({
    inputs: input_features,
    decoder_input_ids: [[decoderStartTokenId]],
    max_new_tokens: 1,
  })

  const sequence = extractGeneratedSequence(generated)
  const languageTokenId = sequence[1]
  if (typeof languageTokenId !== 'number') {
    return null
  }

  const languageToken = Object.entries(generationConfig.lang_to_id).find(([, id]) => id === languageTokenId)?.[0]
  return languageToken ? languageToken.replace(/^<\|/, '').replace(/\|>$/, '') : null
}

function extractGeneratedSequence(generated: unknown): number[] {
  if (generated instanceof Int32Array || generated instanceof Uint32Array || generated instanceof Float32Array) {
    return Array.from(generated)
  }

  if (Array.isArray(generated)) {
    return generated.flat(Infinity).map((value) => Number(value)).filter((value) => Number.isFinite(value))
  }

  if (generated && typeof generated === 'object') {
    const maybeSequence = (generated as { sequences?: unknown }).sequences
    if (Array.isArray(maybeSequence)) {
      return maybeSequence.flat(Infinity).map((value) => Number(value)).filter((value) => Number.isFinite(value))
    }
    if (maybeSequence && typeof maybeSequence === 'object' && 'tolist' in maybeSequence && typeof maybeSequence.tolist === 'function') {
      return (maybeSequence.tolist() as unknown[]).flat(Infinity).map((value) => Number(value)).filter((value) => Number.isFinite(value))
    }
    if ('tolist' in (generated as object) && typeof (generated as { tolist?: unknown }).tolist === 'function') {
      return ((generated as { tolist: () => unknown[] }).tolist() as unknown[]).flat(Infinity).map((value) => Number(value)).filter((value) => Number.isFinite(value))
    }
  }

  return []
}

function splitAudio(audio: Float32Array, chunkSeconds: number) {
  const samplesPerChunk = SAMPLE_RATE * chunkSeconds
  const pieces: Array<{ audio: Float32Array; offsetSeconds: number; durationSeconds: number }> = []

  for (let start = 0; start < audio.length; start += samplesPerChunk) {
    const end = Math.min(start + samplesPerChunk, audio.length)
    const slice = audio.slice(start, end)
    pieces.push({
      audio: slice,
      offsetSeconds: start / SAMPLE_RATE,
      durationSeconds: (end - start) / SAMPLE_RATE,
    })
  }

  return pieces
}

function normalizeChunkSegments(
  result: PipelineResult,
  offsetSeconds: number,
  chunkDurationSeconds: number,
): Segment[] {
  const chunks = result.chunks ?? []

  const segments = chunks
    .map((chunk, index) => {
      const start = asTimestamp(chunk.timestamp?.[0], 0)
      const end = asTimestamp(chunk.timestamp?.[1], Math.min(start + 1.5, chunkDurationSeconds))

      return {
        id: index + 1,
        start: offsetSeconds + start,
        end: offsetSeconds + end,
        text: (chunk.text ?? '').trim(),
      }
    })
    .filter((segment) => segment.text.length > 0)

  if (segments.length > 0) {
    return segments
  }

  const text = (result.text ?? '').trim()
  if (!text) {
    return []
  }

  return [
    {
      id: 1,
      start: offsetSeconds,
      end: offsetSeconds + Math.max(1, chunkDurationSeconds),
      text,
    },
  ]
}

function fixSegmentBounds(segments: Segment[], duration: number): Segment[] {
  return segments.map((segment, index) => {
    const next = segments[index + 1]
    const endFromNext = next ? Math.max(segment.start + 0.2, Math.min(segment.end, next.start)) : segment.end
    const safeEnd = Math.max(
      segment.start + 0.2,
      endFromNext > segment.start ? endFromNext : next ? next.start : duration || segment.start + 1,
    )

    return {
      ...segment,
      end: safeEnd,
    }
  })
}

function reindexSegments(segments: Segment[]): Segment[] {
  return segments.map((segment, index) => ({
    ...segment,
    id: index + 1,
  }))
}


function asTimestamp(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
