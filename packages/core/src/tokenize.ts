// whitespace->ws, {...}->action, (N.N)->gap, punct chars->punct, else->word

export type TokenKind = 'word' | 'ws' | 'punct' | 'action' | 'gap'

export interface TokenFragment {
  kind: TokenKind
  text: string
}

export const DEFAULT_PUNCT_CHARS = '.,!?…'

export interface TokenizeOpts {
  /** Characters to split as individual punct tokens. Defaults to DEFAULT_PUNCT_CHARS. */
  punctuationChars?: string
}

export function parseGapDuration(text: string): number | null {
  const m = text.match(/^\(([\d.]+)(ms|s)?\)$/)
  if (!m) return null
  const val = parseFloat(m[1]!)
  if (isNaN(val)) return null
  return m[2] === 'ms' ? val / 1000 : val
}

export function tokenizeString(raw: string, opts?: TokenizeOpts): TokenFragment[] {
  const PUNCT = new Set(
    (opts?.punctuationChars ?? DEFAULT_PUNCT_CHARS).split('')
  )
  const tokens: TokenFragment[] = []
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]!

    // Whitespace run
    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j]!)) j++
      tokens.push({ kind: 'ws', text: raw.slice(i, j) })
      i = j
      continue
    }

    // Action: {...}
    if (ch === '{') {
      let j = i + 1
      while (j < raw.length && raw[j] !== '}') j++
      const text = raw.slice(i, j + 1)
      tokens.push({ kind: 'action', text })
      i = j + 1
      continue
    }

    // Gap: (N), (N.N), (N.Ns), (Nms) - parenthesised numeric pause with optional unit
    if (ch === '(') {
      const gapMatch = raw.slice(i).match(/^\([\d.]+(ms|s)?\)/)
      if (gapMatch) {
        tokens.push({ kind: 'gap', text: gapMatch[0] })
        i += gapMatch[0].length
        continue
      }
    }

    // Ellipsis (three dots - treat as single punct)
    if (raw.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...' })
      i += 3
      continue
    }

    // Single punct chars
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', text: ch })
      i++
      continue
    }

    // Word: consume until whitespace or special char
    let j = i + 1
    while (j < raw.length) {
      const c = raw[j]!
      if (/\s/.test(c) || c === '{' || c === '(' || PUNCT.has(c)) break
      j++
    }
    tokens.push({ kind: 'word', text: raw.slice(i, j) })
    i = j
  }

  return tokens
}
