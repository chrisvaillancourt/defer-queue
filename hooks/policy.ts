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
  pending: [],
}

/**
 * Folds what a /clear carried over into the new session's queue. Idempotent:
 * recovery entries are kept once by `seq`, epoch and nextSeq only grow.
 */
export function mergeCarry(q: Queue, carried: Queue): Queue {
  const bySeq = new Map<number, Queue['recovery'][number]>()
  for (const r of [...carried.recovery, ...q.recovery]) bySeq.set(r.seq, r)
  return {
    ...q,
    epoch: Math.max(q.epoch, carried.epoch),
    nextSeq: Math.max(q.nextSeq, carried.nextSeq),
    recovery: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    pending: [...new Map([...carried.pending, ...q.pending].map(p => [p.id, p])).values()],
  }
}

// ---- Queue transitions: (event, record) -> record, applied to the record
// that owns the queue when the event lands (see ownerOf). -------------------

/**
 * Which record a queue change applies to while a /clear carry exists (`from`
 * is the session it left). Before the engine switches session ids the carry
 * owns the queue; once the id differs it is adopted into the new session's
 * state, and the change applies there. No carry: the session's state.
 */
export function ownerOf(carryFrom: string | undefined, sessionId: string | undefined): 'state' | 'carry' | 'adopt' {
  if (carryFrom === undefined) return 'state'
  return sessionId === undefined || sessionId === carryFrom ? 'carry' : 'adopt'
}

/**
 * /clear or a resume: the epoch moves on (cancelling sends scheduled before
 * it), queued entries leave for the prompt box (`taken`), and an unsettled
 * release is kept under Not sent, marked "may already have been sent".
 * Handbacks in flight stay in `pending`, to be settled by id.
 */
export function resetQueue(q: Queue): { next: Queue; taken: Entry[] } {
  const recovery = q.claim === null ? q.recovery : [...q.recovery, { ...q.claim.entry, token: q.claim.token, maybeSent: true as const }]
  return {
    next: { ...q, epoch: q.epoch + 1, runningTurn: null, items: [], claim: null, paused: false, recovery },
    taken: q.items,
  }
}

/** Entries nothing will send on its own: kept under Not sent, once each by `seq`. */
export function keepUnsent(q: Queue, entries: readonly Entry[]): Queue {
  return entries.length === 0 ? q : mergeCarry(q, { ...EMPTY, recovery: [...entries] })
}

/**
 * The prompt box answered the handback `id`. Filled: it leaves `pending`.
 * Refused: back to its place in the queue with the pause it had (or paused,
 * for an interrupt), unless the epoch moved since it left (a /clear), when it
 * goes under Not sent; never both pending and Not sent. `entries` stands in
 * for a record a reload already settled.
 */
export function settleHandback(
  q: Queue,
  id: string,
  isFilled: boolean,
  entries: readonly Entry[],
): { next: Queue; where: 'box' | 'queue' | 'recovery' } {
  const mine = q.pending.find(p => p.id === id)
  const pending = q.pending.filter(p => p.id !== id)
  const isCurrent = mine !== undefined && mine.epoch === q.epoch
  if (isFilled) {
    const paused = isCurrent && q.items.length === 0 ? false : q.paused
    return { next: { ...q, pending, paused }, where: 'box' }
  }
  if (!isCurrent) {
    return { next: keepUnsent({ ...q, pending }, mine?.entries ?? entries), where: 'recovery' }
  }
  return {
    next: { ...q, pending, items: insertBySeq(q.items, mine.entries), paused: q.paused || mine.wasPaused || mine.pauseOnFail },
    where: 'queue',
  }
}

/**
 * On load: what a module that is gone left in flight. Its callbacks died with
 * it, so whether a handback reached the box, or a release went out, is
 * unknown: both are kept under Not sent (the release "may already have been
 * sent"), and an unsettled release pauses the queue.
 */
export function abandonInFlight(q: Queue): Queue {
  let next = q.pending.length === 0 ? q : keepUnsent({ ...q, pending: [] }, q.pending.flatMap(p => p.entries))
  if (next.claim !== null) {
    const { entry, token } = next.claim
    next = { ...next, claim: null, paused: true, recovery: [...next.recovery, { ...entry, token, maybeSent: true }] }
  }
  return next
}

/** Puts entries back in `seq` order, so a returned entry lands ahead of newer ones. */
export function insertBySeq(items: readonly Entry[], back: readonly Entry[]): Entry[] {
  return [...items, ...back].sort((a, b) => a.seq - b.seq)
}

/**
 * What an `append` fill adds after the draft: entries oldest first, blank
 * lines between (omp's join), and a blank line after a draft that has text.
 * omp puts them ahead of the draft; a plugin can only replace the whole box
 * (losing what is typed meanwhile) or add after it, so they go after.
 */
export function appendText(texts: readonly string[], draftHasText: boolean): string {
  const body = texts.filter(t => t.trim() !== '').join('\n\n')
  return draftHasText && body !== '' ? `\n\n${body}` : body
}

export function firstLine(text: string): string {
  const trimmed = text.trim()
  const line = trimmed.split('\n', 1)[0] ?? ''
  return trimmed.includes('\n') ? `${line} …` : line
}

// ---- Queue grammar: a port of omp's pi-tui prompt/queue-input.ts ----------

const QUEUE_PREFIXES: readonly string[] = ['->', '=>']
const LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/
const CANONICAL_ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i
const ROMAN: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

type ListItem = { line: number; indent: string; marker: string; punctuation: string; content: string }

/** The body after a leading `->` or `=>` (trimmed), or undefined when the text has neither. */
export function parseQueueShorthand(text: string): string | undefined {
  const start = text.trimStart()
  const prefix = QUEUE_PREFIXES.find(p => start.startsWith(p))
  return prefix === undefined ? undefined : start.slice(prefix.length).trim()
}

function parseItem(line: string, index: number): ListItem | undefined {
  const match = LIST_MARKER_RE.exec(line)
  if (match === null) return undefined
  const [matched, indent, marker, punctuation] = match
  if (indent === undefined || marker === undefined || punctuation === undefined) return undefined
  return { line: index, indent, marker, punctuation, content: line.slice(matched.length).trimStart() }
}

function decodeDecimal(marker: string): number | undefined {
  if (!/^\d+$/.test(marker)) return undefined
  const value = Number(marker)
  return Number.isSafeInteger(value) ? value : undefined
}

function decodeRoman(marker: string): number | undefined {
  if (!CANONICAL_ROMAN_RE.test(marker)) return undefined
  const upper = marker.toUpperCase()
  let value = 0
  for (let i = 0; i < upper.length; i++) {
    const current = ROMAN[upper[i] ?? '']
    if (current === undefined) return undefined
    const next = ROMAN[upper[i + 1] ?? ''] ?? 0
    value += current < next ? -current : current
  }
  return value
}

function decodeAlpha(marker: string): number | undefined {
  if (!/^[A-Za-z]+$/.test(marker)) return undefined
  let value = 0
  for (const char of marker.toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64
    if (!Number.isSafeInteger(value)) return undefined
  }
  return value
}

function isSequential(markers: readonly string[], decode: (marker: string) => number | undefined): boolean {
  let previous = decode(markers[0] ?? '')
  if (previous === undefined) return false
  for (let i = 1; i < markers.length; i++) {
    const current = decode(markers[i] ?? '')
    if (current === undefined || current !== previous + 1) return false
    previous = current
  }
  return true
}

function isEnumeratedSequence(items: readonly ListItem[]): boolean {
  const markers = items.map(item => item.marker)
  if (markers.every(m => /^\d+$/.test(m))) return isSequential(markers, decodeDecimal)
  if (!markers.every(m => m === m.toUpperCase()) && !markers.every(m => m === m.toLowerCase())) return false
  return isSequential(markers, decodeRoman) || isSequential(markers, decodeAlpha)
}

/**
 * Splits a sequential numbered, Roman-numeral or lettered list (two or more
 * items, one punctuation, one indent) into one entry per item; lines under an
 * item stay with it. Anything else (a gap, mixed `.`/`)`, an empty item
 * inside the list) is one entry. Trailing empty items are dropped. Empty text
 * gives no entries.
 */
export function splitQueuedMessages(text: string): string[] {
  const source = text.trim()
  if (source === '') return []
  const lines = source.split(/\r?\n/)
  const first = parseItem(lines[0] ?? '', 0)
  if (first === undefined) return [source]
  const items = [first]
  for (let i = 1; i < lines.length; i++) {
    const item = parseItem(lines[i] ?? '', i)
    if (item?.indent === first.indent) items.push(item)
  }
  if (items.length < 2 || items.some(item => item.punctuation !== first.punctuation) || !isEnumeratedSequence(items)) {
    return [source]
  }
  const messages = items.map((item, i) => {
    const end = items[i + 1]?.line ?? lines.length
    return [item.content, ...lines.slice(item.line + 1, end)].join('\n').trim()
  })
  while (messages.at(-1) === '') messages.pop()
  return messages.length > 0 && messages.every(m => m !== '') ? messages : [source]
}

export const USAGE =
  'Usage: /queue <message> (or start a prompt with -> or =>). A numbered, lettered or Roman-numeral list queues one prompt per item. /defer is the same command.'

/** A plugin can't resubmit a slash command or shell line as typed. */
export const isCommandLike = (text: string) => /^\s*[/!]/.test(text)

/** What `/queue` with no text, and the empty shorthand, print: usage, then the queue. */
export function listText(q: Queue): string {
  const lines: string[] = []
  if (q.claim !== null) lines.push(`Sending: ${firstLine(q.claim.entry.text)}`)
  const back = q.pending.reduce((n, p) => n + p.entries.length, 0)
  if (back > 0) lines.push(`Going back to the prompt box: ${back}`)
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
