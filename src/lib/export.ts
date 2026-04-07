type Segment = {
  id: number
  start: number
  end: number
  text: string
}

export function toTxt(segments: Segment[], fallbackText: string): string {
  if (segments.length === 0) {
    return fallbackText.trim()
  }

  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start, ',')} --> ${formatTimestamp(segment.end, ',')}\n${segment.text.trim()}`,
    )
    .join('\n\n')
    .trim()
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map(
      (segment) =>
        `${formatTimestamp(segment.start, '.')} --> ${formatTimestamp(segment.end, '.')}\n${segment.text.trim()}`,
    )
    .join('\n\n')
    .trim()

  return `WEBVTT\n\n${body}`.trim()
}

export function makeOutputBaseName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName
}

export function downloadTextFile(name: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = name
  anchor.click()

  URL.revokeObjectURL(url)
}

function formatTimestamp(seconds: number, msSeparator: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)

  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${String(ms).padStart(3, '0')}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
