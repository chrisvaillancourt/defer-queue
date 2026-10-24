// The /clear carry and admission, with the engine's per-session state: the
// fixture keeps one state store per session id, as 2.1.310 does, so the new
// conversation reads empty until the carry is adopted into it. Plugins in
// `prepend` sit above defer-queue (this file loads it in the append tier).
import { expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { On, PromptFillResult } from 'claude-code'

tier('append')

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const typed = (text: string, turnId = 't1') => ({ text, turnId, wait: true, origin: { kind: 'composer' } as const })
const ended = (reason: 'answer' | 'error', turnId = 't1') => ({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason })
const LIST = { command: 'queue', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

function fixture(on: On, fill?: () => Promise<PromptFillResult> | PromptFillResult) {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => (fill ? fill() : { isFilled: true }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const sid = { value: 's1' }
  const stores: Record<string, Map<string, { value: unknown; version: number }>> = {}
  const store = () => (stores[sid.value] ??= new Map())
  on('session.id', () => ({ value: sid.value }))
  on('state.get', ($, e) => ({ value: store().get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', ($, e) => {
    const k = `${e.plugin}/${e.key}`
    const version = store().get(k)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    store().set(k, { value: e.value, version: version + 1 })
    return { value: { isSet: true, version: version + 1 } }
  })
  return { clock, sid, sent, stores }
}

test('adoption waits out a /clear whose handback takes longer than every early retry', async ($, on) => {
  const entered = deferred<void>()
  const gate = deferred<PromptFillResult>()
  const { clock, sid, stores } = fixture(on, () => {
    entered.resolve()
    return gate.promise
  })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('RECOVER_AFTER_SLOW_CLEAR'))
  await $.turn.complete(ended('error'))
  const clearing = $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await entered.promise
  // session.end is still awaiting the prompt box; the session id is the old one.
  await clock.advance(5000)
  gate.resolve({ isFilled: false, refusal: 'dialog' })
  await clearing
  sid.value = 's2'
  await clock.advance(200)
  const persisted = JSON.stringify(stores.s2?.get('defer-queue/queue')?.value ?? null)
  expect(persisted).toContain('RECOVER_AFTER_SLOW_CLEAR')
})
