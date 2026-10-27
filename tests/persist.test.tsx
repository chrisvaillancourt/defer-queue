// The queue's record in $.store, which outlives the process: $.state does
// not (a background session moved to a new process, an upgrade, a crash). The
// fixture keeps one state store per session id, as the engine does, and one
// $.store shared by every session, which the test reads back and seeds.
import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptFillResult, PromptSubmitResult } from 'claude-code'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const T0 = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000
const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const typed = (text: string, turnId = 't1') => ({ text, turnId, wait: true, origin: { kind: 'composer' } as const })
const ended = (reason: 'answer' | 'error', turnId = 't1') => ({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason })
const LIST = { command: 'queue', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

type Opts = {
  store?: Record<string, unknown>
  storeFails?: boolean
  fill?: () => Promise<PromptFillResult> | PromptFillResult
  submit?: (text: string) => Promise<PromptSubmitResult> | PromptSubmitResult
}

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: T0 })
  const sent: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const notes: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return opts.submit ? opts.submit(e.text) : { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => (opts.fill ? opts.fill() : { isFilled: true }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    notes.push(e.text)
    return { value: { isSent: false, reason: 'no-channel' } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const sid = { value: 's1' }
  const states: Record<string, Map<string, { value: unknown; version: number }>> = {}
  const state = () => (states[sid.value] ??= new Map())
  on('session.id', () => ({ value: sid.value }))
  on('state.get', ($, e) => ({ value: state().get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    const k = `${e.plugin}/${e.key}`
    const version = state().get(k)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state().set(k, { value: e.value, version: version + 1 })
    return { value: { isSet: true, version: version + 1 } }
  })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => (opts.storeFails ? { deny: 'store unreadable' } : { value: store.get(e.key) }))
  on('store.set', ($, e) => {
    if (opts.storeFails) return { deny: 'store full' }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    if (opts.storeFails) return { deny: 'store unwritable' }
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => (opts.storeFails ? { deny: 'store unreadable' } : { value: [...store.keys()] }))
  return { clock, sid, sent, logs, toasts, notes, states, store }
}

const restartLogs = (logs: readonly string[]) => logs.filter(l => /restart/i.test(l))

test('the record holds what waits, what is being sent and Not sent, and goes when the queue empties', async ($, on) => {
  const gate = deferred<PromptSubmitResult>()
  const w = world(on, { submit: text => (text === 'FIRST' ? gate.promise : { text }) })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('FIRST'))
  await $.prompt.submit(typed('SECOND'))
  const held = w.store.get('queue/s1') as Record<string, unknown> | undefined
  expect(held).toMatchObject({ v: 1, at: T0, items: [{ text: 'FIRST' }, { text: 'SECOND' }], claim: null })

  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  // FIRST was submitted and hasn't been confirmed: it is the claim.
  const sending = w.store.get('queue/s1') as Record<string, unknown> | undefined
  expect(sending).toMatchObject({ items: [{ text: 'SECOND' }], claim: { text: 'FIRST' } })
  // Nothing that names the dead process: no turn id, no release token.
  expect(Object.keys(sending ?? {}).sort()).toEqual(['at', 'claim', 'items', 'pending', 'recovery', 'v'])
  expect(Object.keys((sending?.claim ?? {}) as object).sort()).toEqual(['seq', 'text'])

  gate.resolve({ text: 'FIRST' })
  await w.clock.settle()
  await $.turn.start({ text: 'FIRST', turnId: 't2' })
  await $.turn.complete(ended('answer', 't2'))
  await w.clock.settle()
  expect(w.sent).toEqual(['FIRST', 'SECOND'])
  expect(w.store.has('queue/s1')).toBe(false)
  expect(w.notes).toEqual([])
})

test('a new process puts every kept prompt under Not sent, sends none, and says so', async ($, on) => {
  const w = world(on, {
    store: {
      'queue/s1': {
        v: 1,
        at: T0 - 60_000,
        items: [{ seq: 3, text: 'WAITING_3' }, { seq: 4, text: 'WAITING_4' }],
        claim: { seq: 2, text: 'CLAIMED_2' },
        recovery: [{ seq: 1, text: 'KEPT_1' }],
        pending: [],
      },
    },
  })
  await $.session.start(SESSION)
  const listed = (await $.command.run(LIST)).text ?? ''
  expect(listed).toContain('Nothing is queued.')
  const notSent = listed.slice(listed.indexOf('Not sent'))
  expect(notSent).toContain('(4)')
  // Oldest first: Not sent, then the claim, then what waited.
  expect(notSent.indexOf('KEPT_1')).toBeLessThan(notSent.indexOf('CLAIMED_2'))
  expect(notSent.indexOf('CLAIMED_2')).toBeLessThan(notSent.indexOf('WAITING_3'))
  expect(notSent.indexOf('WAITING_3')).toBeLessThan(notSent.indexOf('WAITING_4'))
  expect(notSent).toContain('CLAIMED_2 (may already have been sent)')
  expect(notSent).not.toContain('WAITING_3 (may already have been sent)')

  expect(restartLogs(w.logs)).toHaveLength(1)
  expect(restartLogs(w.logs)[0]).toContain('4 prompts')
  expect(restartLogs(w.logs)[0]).not.toMatch(/^defer-queue:/)
  expect(w.toasts.some(t => /restart/i.test(t))).toBe(true)
  expect(w.notes).toHaveLength(1)

  // Nothing goes out on its own, and a new prompt doesn't take an old seq.
  await $.turn.start({ text: 'resumed', turnId: 't9' })
  await $.prompt.submit(typed('NEW', 't9'))
  await $.turn.complete(ended('answer', 't9'))
  await w.clock.settle()
  expect(w.sent).toEqual(['NEW'])
  const after = (await $.command.run(LIST)).text ?? ''
  expect(after.slice(after.indexOf('Not sent'))).toContain('(4)')
  // The record is rewritten to what the new process keeps.
  const rewritten = w.store.get('queue/s1') as { items: unknown[]; claim: unknown; recovery: unknown[]; at: number }
  expect(rewritten.items).toEqual([])
  expect(rewritten.claim).toBeNull()
  expect(rewritten.recovery).toHaveLength(4)
  expect(rewritten.at).toBe(T0)
})

test('a hot reload, with the state still there, restores nothing and reports nothing', async ($, on) => {
  const w = world(on)
  w.sid.value = 'donor'
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('HELD'))
  // Session s1's state as a reload finds it (the donor's, copied), and its record.
  w.states.s1 = new Map(w.states.donor)
  w.store.set('queue/s1', w.store.get('queue/donor'))
  w.sid.value = 's1'
  await $.session.start(SESSION)
  const listed = (await $.command.run(LIST)).text ?? ''
  expect(listed).toContain('1. HELD')
  expect(listed).not.toContain('Not sent')
  expect(restartLogs(w.logs)).toEqual([])
  expect(w.notes).toEqual([])
  expect(w.store.get('queue/s1')).toMatchObject({ items: [{ text: 'HELD' }] })
})

test("other sessions' records are left alone, and old or unreadable ones are pruned", async ($, on) => {
  const record = (at: number) => ({ v: 1, at, items: [{ seq: 1, text: 'theirs' }], claim: null, recovery: [], pending: [] })
  const w = world(on, {
    store: {
      'queue/other': record(T0 - DAY),
      'queue/old': record(T0 - 8 * DAY),
      'queue/garbled': { v: 1, items: 'nope' },
      unrelated: { at: T0 - 30 * DAY },
    },
  })
  await $.session.start(SESSION)
  expect(w.store.get('queue/other')).toEqual(record(T0 - DAY))
  expect(w.store.has('queue/old')).toBe(false)
  expect(w.store.has('queue/garbled')).toBe(false)
  expect(w.store.has('unrelated')).toBe(true)
  const listed = (await $.command.run(LIST)).text ?? ''
  expect(listed).not.toContain('theirs')
  expect(restartLogs(w.logs)).toEqual([])
  expect(w.notes).toEqual([])
})

test('after /clear the record belongs to the new session, and the old key is gone', async ($, on) => {
  const w = world(on, { fill: () => ({ isFilled: false, refusal: 'dialog' }) })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('OLD_A'))
  await $.turn.complete(ended('error'))
  expect(w.store.has('queue/s1')).toBe(true)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  w.sid.value = 's2'
  await w.clock.advance(200)
  expect(w.store.has('queue/s1')).toBe(false)
  expect(w.store.get('queue/s2')).toMatchObject({ items: [], recovery: [{ text: 'OLD_A' }] })
  expect(restartLogs(w.logs)).toEqual([])
  expect(w.notes).toEqual([])
})

test("a /resume into a session a dead process left a record for keeps that record's prompts under Not sent", async ($, on) => {
  // Both queues numbered their first entry 1; the box refuses the handback,
  // so the carried one goes under Not sent beside the restored one.
  const w = world(on, {
    store: { 'queue/s2': { v: 1, at: T0 - DAY, items: [{ seq: 1, text: 'LEFT_IN_S2' }], claim: null, recovery: [], pending: [] } },
    fill: () => ({ isFilled: false, refusal: 'dialog' }),
  })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('FROM_S1'))
  await $.turn.complete(ended('error'))
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } })
  w.sid.value = 's2'
  await w.clock.advance(200)
  const listed = (await $.command.run(LIST)).text ?? ''
  expect(listed).toContain('Nothing is queued.')
  const notSent = listed.slice(listed.indexOf('Not sent'))
  expect(notSent).toContain('(2)')
  expect(notSent).toContain('FROM_S1')
  expect(notSent).toContain('LEFT_IN_S2')
  expect(restartLogs(w.logs)).toHaveLength(1)
  expect(restartLogs(w.logs)[0]).toContain('1 prompt you queued is')
  expect(w.notes).toHaveLength(1)
  expect(w.store.has('queue/s1')).toBe(false)
  expect(w.store.get('queue/s2')).toMatchObject({ recovery: [{ text: 'FROM_S1' }, { text: 'LEFT_IN_S2' }] })
  await $.turn.start({ text: 'new', turnId: 't2' })
  await $.turn.complete(ended('answer', 't2'))
  await w.clock.settle()
  expect(w.sent).not.toContain('LEFT_IN_S2')
})

test('a store that refuses every call leaves the queue working', async ($, on) => {
  const w = world(on, { storeFails: true })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const held = await $.prompt.submit(typed('STILL_QUEUED'))
  expect(held.drop).toMatch(/Queued/)
  await $.turn.complete(ended('answer'))
  await w.clock.settle()
  expect(w.sent).toEqual(['STILL_QUEUED'])
  expect(w.notes).toEqual([])
})
