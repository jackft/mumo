import type { AnnotationStore } from '@mumo/core'
import type { PMNodeJSON } from './types.js'

function textContent(node: PMNodeJSON): string {
  if (node.text !== undefined) return node.text
  return (node.content ?? []).map(textContent).join('')
}

// HH:MM:SS.mmm
function vttTime(sec: number): string {
  const ms = Math.round(sec * 1000)
  const h  = Math.floor(ms / 3_600_000)
  const m  = Math.floor((ms % 3_600_000) / 60_000)
  const s  = Math.floor((ms % 60_000) / 1_000)
  const f  = ms % 1_000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`
}

export function emitVTT(doc: PMNodeJSON): string {
  const lines: string[] = ['WEBVTT', '']
  let idx = 1
  for (const node of doc.content ?? []) {
    if (node.type !== 'utterance') continue
    const start = node.attrs?.['startTimeSeconds'] as number | null ?? null
    const end   = node.attrs?.['endTimeSeconds']   as number | null ?? null
    if (start === null || end === null) continue
    const text = textContent(node).trim()
    if (!text) continue
    const participant = (node.attrs?.['participant'] as string | undefined) ?? ''
    lines.push(String(idx++))
    lines.push(`${vttTime(start)} --> ${vttTime(end)}`)
    lines.push(participant ? `${participant}: ${text}` : text)
    lines.push('')
  }
  return lines.join('\n')
}

export function emitTXT(doc: PMNodeJSON): string {
  const lines: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type !== 'utterance') continue
    const text = textContent(node).trim()
    if (!text) continue
    const start   = node.attrs?.['startTimeSeconds'] as number | null ?? null
    const participant = (node.attrs?.['participant'] as string | undefined) ?? ''
    let line = ''
    if (start !== null) {
      const m = Math.floor(start / 60)
      const s = Math.floor(start % 60)
      line += `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}] `
    }
    if (participant) line += `${participant}: `
    line += text
    lines.push(line)
  }
  return lines.join('\n')
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function row(...fields: (string | number | null | undefined)[]): string {
  return fields.map(cell).join(',')
}

export function emitCSV(doc: PMNodeJSON, store: AnnotationStore): string {
  const rows: string[] = [row('begin_time', 'end_time', 'participant', 'tier', 'type', 'value')]

  for (const node of doc.content ?? []) {
    if (node.type !== 'utterance') continue
    const start    = node.attrs?.['startTimeSeconds'] as number | null ?? null
    const end      = node.attrs?.['endTimeSeconds']   as number | null ?? null
    const participant = (node.attrs?.['participant'] as string | undefined) || 'unknown'
    const tierAttrRaw = (node.attrs?.['tier']        as string | undefined) ?? ''
    const tierAttr    = tierAttrRaw === 'utterance' ? '' : tierAttrRaw
    const tierName    = tierAttr
      ? (participant !== 'unknown' && participant !== tierAttr ? `${tierAttr}:${participant}` : tierAttr)
      : `utterance:${participant}`
    rows.push(row(start, end, participant, tierName, 'utterance', textContent(node).trim()))
  }

  const tierById = new Map(store.allTiers().map(t => [t.id, t]))
  for (const ann of store.allAnnotations()) {
    const ta = ann.anchors.find(a => a.type === 'time') as { type: 'time'; start: number; end: number } | undefined
    if (!ta) continue
    const tier        = tierById.get(ann.features['tierId'] as string)
    const tierName    = tier?.name ?? ''
    const participant = tier?.participant ?? ''
    rows.push(row(ta.start, ta.end, participant, tierName, ann.type, ''))
  }

  return rows.join('\n')
}
