import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY,
  abandonInFlight,
  admitsRelease,
  appendText,
  isUntouched,
  keepRefusedRelease,
  keepUnsent,
  mergeCarry,
  ownerOf,
  parseQueueShorthand,
  parseSaved,
  resetQueue,
  restoreSaved,
  savedOf,
  settleHandback,
  splitQueuedMessages,
} from '../hooks/policy'
import type { Queue } from '../types'

describe('the -> and => shorthand', () => {
  test('takes the body after either prefix', () => {
    expect(parseQueueShorthand('-> then run the tests')).toBe('then run the tests')
    expect(parseQueueShorthand('=>review')).toBe('review')
    expect(parseQueueShorthand('  -> leading space')).toBe('leading space')
    expect(parseQueueShorthand('->')).toBe('')
  })

  test('ignores an arrow anywhere but the start', () => {
    expect(parseQueueShorthand('a -> b')).toBeUndefined()
    expect(parseQueueShorthand('plain prompt')).toBeUndefined()
  })
})

describe('splitting a queued list', () => {
  test('splits numbered, Roman-numeral and lettered sequences', () => {
    expect(splitQueuedMessages('1. a\n2. b\n3. c')).toEqual(['a', 'b', 'c'])
    expect(splitQueuedMessages('i. a\nii. b\niii. c')).toEqual(['a', 'b', 'c'])
    expect(splitQueuedMessages('IV) a\nV) b')).toEqual(['a', 'b'])
    expect(splitQueuedMessages('a) x\nb) y')).toEqual(['x', 'y'])
    expect(splitQueuedMessages('A. x\nB. y')).toEqual(['x', 'y'])
  })

  test('keeps lines under an item with it', () => {
    expect(splitQueuedMessages('1. a\n   more about a\n- note\n2. b')).toEqual(['a\n   more about a\n- note', 'b'])
    expect(splitQueuedMessages('1. a\n  1. nested\n  2. nested\n2. b')).toEqual(['a\n  1. nested\n  2. nested', 'b'])
  })

  test('keeps a gap, mixed punctuation, mixed case or one item as one prompt', () => {
    expect(splitQueuedMessages('1. a\n3. b')).toEqual(['1. a\n3. b'])
    expect(splitQueuedMessages('1. a\n2) b')).toEqual(['1. a\n2) b'])
    expect(splitQueuedMessages('a. x\nB. y')).toEqual(['a. x\nB. y'])
    expect(splitQueuedMessages('1. only one')).toEqual(['1. only one'])
    expect(splitQueuedMessages('no list here\n1. a\n2. b')).toEqual(['no list here\n1. a\n2. b'])
  })

  test('keeps a list with an empty item inside it as one prompt', () => {
    expect(splitQueuedMessages('1. a\n2.\n3. c')).toEqual(['1. a\n2.\n3. c'])
  })

  test('drops an unfinished trailing item', () => {
    expect(splitQueuedMessages('1. a\n2. b\n3.')).toEqual(['a', 'b'])
  })

  test('gives nothing for empty text', () => {
    expect(splitQueuedMessages('   \n ')).toEqual([])
  })
})

describe('the prompt box text', () => {
  test('appends entries after the draft with blank lines between', () => {
    expect(appendText(['a', 'b'], true)).toBe('\n\na\n\nb')
    expect(appendText(['a'], false)).toBe('a')
  })
})

describe('carrying the queue across /clear', () => {
  test('merges Not sent once by seq and only raises epoch and nextSeq', () => {
    const carried = { ...EMPTY, epoch: 3, nextSeq: 9, recovery: [{ seq: 4, text: 'old', token: 't', maybeSent: true as const }] }
    const fresh = { ...EMPTY, recovery: [{ seq: 4, text: 'old' }] }
    const merged = mergeCarry(fresh, carried)
    expect(merged.epoch).toBe(3)
    expect(merged.nextSeq).toBe(9)
    expect(merged.recovery).toEqual([{ seq: 4, text: 'old' }])
    expect(mergeCarry(merged, carried)).toEqual(merged)
  })
})

describe('which record owns the queue', () => {
  const table: [string | undefined, string | undefined, ReturnType<typeof ownerOf>][] = [
    [undefined, 's1', 'state'],
    [undefined, undefined, 'state'],
    ['s1', 's1', 'carry'],
    ['s1', undefined, 'carry'],
    ['s1', 's2', 'adopt'],
  ]
  for (const [from, id, owner] of table) {
    test(`carry from ${from ?? 'none'}, session ${id ?? 'unknown'}: ${owner}`, () => {
      expect(ownerOf(from, id)).toBe(owner)
    })
  }
})

// (event x record) -> record, as the hooks apply them to the owner.
const A = { seq: 1, text: 'A' }
const B = { seq: 2, text: 'B' }
const C = { seq: 3, text: 'C' }
const pendingB = { id: 'h1', epoch: 0, entries: [B], wasPaused: false, pauseOnFail: false }

describe('the /clear reset', () => {
  test('bumps the epoch, takes the queue, keeps a release as maybe sent, keeps handbacks pending', () => {
    const q: Queue = {
      ...EMPTY,
      nextSeq: 4,
      runningTurn: 't1',
      items: [A],
      claim: { entry: C, token: 'r1', epoch: 0 },
      paused: true,
      pending: [pendingB],
    }
    const { next, taken } = resetQueue(q)
    expect(taken).toEqual([A])
    expect(next).toEqual({
      ...EMPTY,
      epoch: 1,
      nextSeq: 4,
      recovery: [{ ...C, token: 'r1', maybeSent: true }],
      pending: [pendingB],
    })
  })
})

describe('settling a handback by id', () => {
  const rows: [string, Queue, boolean, Queue, 'box' | 'queue' | 'recovery'][] = [
    ['filled, same epoch', { ...EMPTY, paused: true, pending: [pendingB] }, true, { ...EMPTY, pending: [] }, 'box'],
    ['filled, same epoch, others still queued', { ...EMPTY, items: [A], paused: true, pending: [pendingB] }, true, { ...EMPTY, items: [A], paused: true }, 'box'],
    ['filled after /clear', { ...EMPTY, epoch: 1, paused: true, pending: [pendingB] }, true, { ...EMPTY, epoch: 1, paused: true }, 'box'],
    ['refused, same epoch', { ...EMPTY, items: [C], pending: [pendingB] }, false, { ...EMPTY, items: [B, C] }, 'queue'],
    ['refused, same epoch, interrupt', { ...EMPTY, items: [C], pending: [{ ...pendingB, pauseOnFail: true }] }, false, { ...EMPTY, items: [B, C], paused: true }, 'queue'],
    ['refused after /clear', { ...EMPTY, epoch: 1, pending: [pendingB] }, false, { ...EMPTY, epoch: 1, recovery: [B] }, 'recovery'],
    ['refused, record gone (reload)', { ...EMPTY, epoch: 1, recovery: [{ ...B, maybeSent: true }] }, false, { ...EMPTY, epoch: 1, recovery: [{ ...B, maybeSent: true }] }, 'recovery'],
    ['filled, record gone', { ...EMPTY, items: [A] }, true, { ...EMPTY, items: [A] }, 'box'],
  ]
  for (const [name, before, isFilled, after, where] of rows) {
    test(name, () => {
      const settled = settleHandback(before, 'h1', isFilled, [B])
      expect(settled.next).toEqual(after)
      expect(settled.where).toBe(where)
      // Never both pending and Not sent, never pending once settled.
      expect(settled.next.pending.some(p => p.id === 'h1')).toBe(false)
    })
  }

  test('settling twice changes nothing more', () => {
    const once = settleHandback({ ...EMPTY, epoch: 1, pending: [pendingB] }, 'h1', false, [B]).next
    expect(settleHandback(once, 'h1', false, [B]).next).toEqual(once)
  })
})

describe('on load', () => {
  test('moves handbacks and a release a gone module left to Not sent, and pauses', () => {
    const q: Queue = { ...EMPTY, items: [A], claim: { entry: C, token: 'r1', epoch: 0 }, pending: [pendingB] }
    expect(abandonInFlight(q)).toEqual({
      ...EMPTY,
      items: [A],
      paused: true,
      recovery: [B, { ...C, token: 'r1', maybeSent: true }],
    })
    expect(abandonInFlight({ ...EMPTY, items: [A] })).toEqual({ ...EMPTY, items: [A] })
  })

  test('keepUnsent keeps each entry once', () => {
    const once = keepUnsent(EMPTY, [A, B])
    expect(keepUnsent(once, [B])).toEqual(once)
    expect(once.recovery).toEqual([A, B])
  })
})

describe('admitting an own release', () => {
  const claimed: Queue = { ...EMPTY, epoch: 1, claim: { entry: A, token: 'r2', epoch: 1 } }
  const rows: [string, Queue, string | undefined, boolean][] = [
    ['the current claim', claimed, 'r2', true],
    ['an older release while a newer claim stands', claimed, 'r1', false],
    ['an admission nothing in flight matches (a reload)', claimed, undefined, false],
    ['no claim (a /clear moved it)', { ...EMPTY, epoch: 1 }, 'r1', false],
  ]
  for (const [name, q, token, admits] of rows) {
    test(name, () => expect(admitsRelease(q, token)).toBe(admits))
  }

  test('a refusal keeps the release under Not sent, known unsent', () => {
    const moved: Queue = { ...EMPTY, epoch: 1, nextSeq: 5, recovery: [{ ...A, token: 'r1', maybeSent: true }] }
    expect(keepRefusedRelease(moved, 'r1', 'A, rewritten').recovery).toEqual([A])
    // After a reload no token is known: matched by text, else added.
    expect(keepRefusedRelease(moved, undefined, 'A').recovery).toEqual([A])
    expect(keepRefusedRelease({ ...EMPTY, nextSeq: 5 }, undefined, 'X').recovery).toEqual([{ seq: 5, text: 'X' }])
    // A standing claim is left for its settlement to finish.
    expect(keepRefusedRelease(claimed, 'r2', 'A')).toEqual(claimed)
  })
})

describe('the record kept in the store', () => {
  const A = { seq: 3, text: 'waiting A' }
  const B = { seq: 4, text: 'waiting B' }
  const C = { seq: 2, text: 'being sent' }
  const D = { seq: 1, text: 'not sent' }
  const H = { seq: 5, text: 'on its way back' }

  test('keeps the waiting items, the claimed entry, Not sent and handbacks, without turn ids or tokens', () => {
    const q: Queue = {
      ...EMPTY,
      epoch: 2,
      nextSeq: 6,
      runningTurn: 'turn-9',
      items: [A, B],
      claim: { entry: C, token: 'tok-1', epoch: 2 },
      paused: true,
      recovery: [{ ...D, token: 'tok-0', maybeSent: true }],
      pending: [{ id: 'h1', epoch: 2, entries: [H], wasPaused: false, pauseOnFail: false }],
    }
    expect(savedOf(q)).toEqual({ v: 1, items: [A, B], claim: C, recovery: [{ ...D, maybeSent: true }], pending: [H] })
  })

  test('is nothing when there is nothing to keep', () => {
    expect(savedOf(EMPTY)).toBeNull()
    expect(savedOf({ ...EMPTY, epoch: 4, nextSeq: 9, runningTurn: 't', paused: true })).toBeNull()
  })

  test('reads back only a well-formed record', () => {
    const good = { v: 1, at: 5, items: [A], claim: C, recovery: [{ ...D, maybeSent: true }], pending: [] }
    expect(parseSaved(good)).toEqual(good)
    expect(parseSaved({ ...good, claim: null })).toEqual({ ...good, claim: null })
    for (const bad of [
      undefined,
      null,
      'text',
      [],
      { ...good, v: 2 },
      { ...good, at: 'now' },
      { ...good, at: undefined },
      { ...good, items: [{ seq: 1 }] },
      { ...good, items: 'A' },
      { ...good, claim: { text: 'x' } },
      { ...good, recovery: [{ seq: 1, text: 'x', maybeSent: 'yes' }] },
      { ...good, pending: [{ seq: 1.5, text: 'x' }] },
    ]) {
      expect(parseSaved(bad)).toBeUndefined()
    }
  })

  test('restores everything under Not sent in seq order, the claimed entry marked, and never into the queue', () => {
    const saved = { v: 1 as const, at: 0, items: [A, B], claim: C, recovery: [D], pending: [H] }
    const { next, count } = restoreSaved(EMPTY, saved)
    expect(count).toBe(5)
    expect(next.items).toEqual([])
    expect(next.claim).toBeNull()
    expect(next.recovery.map(r => r.text)).toEqual([D.text, C.text, A.text, B.text, H.text])
    expect(next.recovery.filter(r => r.maybeSent === true).map(r => r.text)).toEqual([C.text])
    // New entries are numbered after the restored ones, so none is merged away.
    expect(next.nextSeq).toBe(6)
  })

  test("renumbers what it restores after the queue's own entries, so a /clear carry merged into it loses none", () => {
    const own: Queue = { ...EMPTY, nextSeq: 4, recovery: [{ seq: 1, text: 'carried' }] }
    const { next } = restoreSaved(own, { v: 1, at: 0, items: [{ seq: 1, text: 'restored' }], claim: null, recovery: [], pending: [] })
    expect(next.recovery).toEqual([{ seq: 1, text: 'carried' }, { seq: 4, text: 'restored' }])
    expect(next.nextSeq).toBe(5)
  })

  test('a queue is untouched until something was ever held, sent, cleared or kept', () => {
    expect(isUntouched(EMPTY)).toBe(true)
    expect(isUntouched({ ...EMPTY, runningTurn: 't1' })).toBe(true)
    expect(isUntouched({ ...EMPTY, nextSeq: 2 })).toBe(false)
    expect(isUntouched({ ...EMPTY, epoch: 1 })).toBe(false)
    expect(isUntouched({ ...EMPTY, recovery: [D] })).toBe(false)
  })
})
