type Segment = {
  id: number
  start: number
  end: number
  text: string
}

export async function parseSubtitleFile(file: File): Promise<Segment[]> {
  const text = await file.text()
  const normalized = text.replace(/\r\n/g, '\n').trim()

  if (normalized.startsWith('WEBVTT')) {
    return parseVtt(normalized)
  }

  return parseSrt(normalized)
}

function parseSrt(source: string): Segment[] {
  const blocks = source.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  const segments: Segment[] = []

  for (const block of blocks) {
    const lines = block.split('\n')
    const timingLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingLineIndex === -1) {
      continue
    }

    const timing = lines[timingLineIndex]
    const text = lines.slice(timingLineIndex + 1).join('\n').trim()
    const [startRaw, endRaw] = timing.split('-->').map((value) => value.trim())
    const start = parseTimestamp(startRaw)
    const end = parseTimestamp(endRaw)

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue
    }

    segments.push({
      id: segments.length + 1,
      start,
      end,
      text,
    })
  }

  return segments
}

function parseVtt(source: string): Segment[] {
  const body = source.replace(/^WEBVTT[^\n]*\n+/, '')
  const blocks = body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  const segments: Segment[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timingLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingLineIndex === -1) {
      continue
    }

    const timing = lines[timingLineIndex]
    const text = lines.slice(timingLineIndex + 1).join('\n').trim()
    const [startRaw, endWithSettings] = timing.split('-->').map((value) => value.trim())
    const endRaw = endWithSettings.split(/\s+/)[0]
    const start = parseTimestamp(startRaw)
    const end = parseTimestamp(endRaw)

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue
    }

    segments.push({
      id: segments.length + 1,
      start,
      end,
      text,
    })
  }

  return segments
}

function parseTimestamp(value: string): number {
  const match = value.match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/)
  if (!match) {
    return Number.NaN
  }

  const hours = Number(match[1] ?? '0')
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(match[4])

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}
