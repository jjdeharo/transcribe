type Segment = {
  id: number
  start: number
  end: number
  text: string
}

export type SubtitleAppearanceProfile = 'standard' | 'youtube'
export type SubtitleAlignment = 'left' | 'center' | 'right'
export type SubtitleShadow = 'none' | 'soft' | 'strong'

export type SubtitleAppearance = {
  profile: SubtitleAppearanceProfile
  fontSize: number
  textColor: string
  backgroundColor: string
  backgroundOpacity: number
  alignment: SubtitleAlignment
  linePosition: number
  width: number
  bold: boolean
  italic: boolean
  underline: boolean
  shadow: SubtitleShadow
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

export function toVtt(segments: Segment[], appearance?: SubtitleAppearance): string {
  const styleBlock = appearance?.profile === 'standard' ? buildStyleBlock(appearance) : ''
  const body = segments
    .map(
      (segment) =>
        `${formatTimestamp(segment.start, '.')} --> ${formatTimestamp(segment.end, '.')}${buildCueSettings(appearance)}\n${formatCueText(segment.text.trim(), appearance)}`,
    )
    .join('\n\n')
    .trim()

  return `WEBVTT\n\n${styleBlock}${body}`.trim()
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

function buildCueSettings(appearance?: SubtitleAppearance): string {
  if (!appearance) {
    return ''
  }

  return ` line:${clamp(Math.round(appearance.linePosition), 5, 95)}% position:50% size:${clamp(Math.round(appearance.width), 30, 100)}% align:${toCueAlign(appearance.alignment)}`
}

function buildStyleBlock(appearance: SubtitleAppearance): string {
  const weight = appearance.bold ? '700' : '400'
  const fontStyle = appearance.italic ? 'italic' : 'normal'
  const decoration = appearance.underline ? 'underline' : 'none'
  const shadow = appearance.shadow === 'none'
    ? 'none'
    : appearance.shadow === 'strong'
      ? '0 2px 8px rgba(0, 0, 0, 0.9)'
      : '0 1px 4px rgba(0, 0, 0, 0.75)'

  return `STYLE
::cue {
  color: ${appearance.textColor};
  background: ${toRgba(appearance.backgroundColor, appearance.backgroundOpacity)};
  font-size: ${clamp(Math.round(appearance.fontSize), 70, 220)}%;
  font-weight: ${weight};
  font-style: ${fontStyle};
  text-decoration: ${decoration};
  text-shadow: ${shadow};
}

`
}

function formatCueText(text: string, appearance?: SubtitleAppearance): string {
  if (!appearance) {
    return text
  }

  let nextText = text
  if (appearance.bold) {
    nextText = `<b>${nextText}</b>`
  }
  if (appearance.italic) {
    nextText = `<i>${nextText}</i>`
  }
  if (appearance.underline) {
    nextText = `<u>${nextText}</u>`
  }

  return nextText
}

function toCueAlign(alignment: SubtitleAlignment): 'start' | 'center' | 'end' {
  if (alignment === 'left') {
    return 'start'
  }

  if (alignment === 'right') {
    return 'end'
  }

  return 'center'
}

function toRgba(hexColor: string, alpha: number): string {
  const match = hexColor.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
  if (!match) {
    return `rgba(0, 0, 0, ${alpha})`
  }

  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${clamp(alpha, 0, 1)})`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
