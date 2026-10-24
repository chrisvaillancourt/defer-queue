// Pure decisions and text for defer-queue: no `$`, no I/O.

import type { Entry, Queue } from '../types'

export const EMPTY: Queue = {
  epoch: 0,
  nextSeq: 1,
  runningTurn: null,
  items: [],
  claim: null,
  paused: false,
  recovery: [],
}

/** Puts entries back in `seq` order, so a returned entry lands ahead of newer ones. */
export function insertBySeq(items: readonly Entry[], back: readonly Entry[]): Entry[] {
  return [...items, ...back].sort((a, b) => a.seq - b.seq)
}

/** The prompt box text: entries oldest first, then the draft. */
export function joinForBox(texts: readonly string[], draft: string): string {
  return [...texts, ...(draft === '' ? [] : [draft])].join('\n')
}

export function firstLine(text: string): string {
  const trimmed = text.trim()
  const line = trimmed.split('\n', 1)[0] ?? ''
  return trimmed.includes('\n') ? `${line} …` : line
}

/** A plugin can't resubmit a slash command or shell line as typed. */
export const isCommandLike = (text: string) => /^\s*[/!]/.test(text)

/** What `/queue` with no text, and the empty shorthand, print: usage, then the queue. */
export function listText(q: Queue): string {
  const lines: string[] = []
  if (q.claim !== null) lines.push(`Sending: ${firstLine(q.claim.entry.text)}`)
  if (q.items.length === 0) lines.push('Nothing is queued.')
  else {
    lines.push(`Queued${q.paused ? ' (paused: press Send next to resume)' : ''} (${q.items.length}):`)
    q.items.forEach((m, i) => lines.push(`${i + 1}. ${firstLine(m.text)}`))
  }
  if (q.recovery.length > 0) {
    lines.push(`Not sent, kept for you (${q.recovery.length}):`)
    for (const m of q.recovery) {
      lines.push(`- ${firstLine(m.text)}${m.maybeSent === true ? ' (may already have been sent)' : ''}`)
    }
  }
  return lines.join('\n')
}
