// Races between the plugin's async steps and the person or the engine,
// adapted from an independent review's regressions. The prompt box here
// honors fill modes and can hold a fill open, so a test can type or /clear
// while one is in flight.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptFillResult, PromptSubmitResult } from 'claude-code'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const typed = (text: string, turnId = 't1') => ({ text, turnId, wait: true, origin: { kind: 'composer' } as const })
const ended = (reason: 'answer' | 'aborted' | 'error', turnId = 't1') => ({
  answer: 'done',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId,
  reason,
})
const BAND = {
  plugin: 'defer-queue',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const
const list = ($: Engine) =>
  $.command.run({ command: 'queue', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

type Fill = (text: string) => Promise<PromptFillResult> | PromptFillResult

function bottoms(on: On, fill?: Fill, submit?: (text: string) => PromptSubmitResult | Promise<PromptSubmitResult>) {
  const clock = mock.clock(on)
  const box = { text: 'draft' }
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return submit ? submit(e.text) : { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', async ($, e) => {
    const r = fill ? await fill(e.text) : { isFilled: true }
    // Applied when the fill lands, to the box as it is then.
    if (r.isFilled) box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return r
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { box, sent, settle: clock.settle }
}

describe('prompt box writes', () => {
  test('two overlapping Take backs keep both entries', async ($, on) => {
    const entered = deferred<void>()
    const gate = deferred<PromptFillResult>()
    let fills = 0
    const { box, settle } = bottoms(on, () => {
      fills++
      if (fills === 1) {
        entered.resolve()
        return gate.promise
      }
      return { isFilled: true }
    })
    await $.session.start(SESSION)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.prompt.submit(typed('A'))
    await $.prompt.submit(typed('B'))
    const ui = await $.ui.mount(BAND)
    const first = ui.press({ key: 'take-back' })
    await entered.promise
    const second = ui.press({ key: 'take-back' })
    await settle()
    gate.resolve({ isFilled: true })
    await first
    await second
    await settle()
    expect(box.text).toContain('A')
    expect(box.text).toContain('B')
    expect(box.text).toContain('draft')
    expect((await list($)).text).toMatch(/Nothing is queued/)
  })

  test('a handback does not erase a draft typed while it was in flight', async ($, on) => {
    const entered = deferred<void>()
    const gate = deferred<PromptFillResult>()
    const { box, settle } = bottoms(on, () => {
      entered.resolve()
      return gate.promise
    })
    await $.session.start(SESSION)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.prompt.submit(typed('A'))
    const ui = await $.ui.mount(BAND)
    const taking = ui.press({ key: 'take-back' })
    await entered.promise
    box.text = 'NEW UNSENT DRAFT'
    gate.resolve({ isFilled: true })
    await taking
    await settle()
    expect(box.text).toContain('NEW UNSENT DRAFT')
    expect(box.text).toContain('A')
  })

  test('a held prompt never clears a draft typed after it', async ($, on) => {
    const gate = deferred<PromptFillResult>()
    const entered = deferred<void>()
    let blanked = false
    const { box, settle } = bottoms(on, text => {
      if (text !== '') return { isFilled: true }
      blanked = true
      entered.resolve()
      return gate.promise
    })
    await $.turn.start({ text: 'work', turnId: 't1' })
    box.text = 'held text'
    await $.prompt.submit(typed('held text'))
    const settling = settle()
    // Typed while a clean-up write, if any, is in flight.
    await Promise.race([entered.promise, settling])
    box.text = 'NEW UNSENT DRAFT'
    gate.resolve({ isFilled: true })
    await settling
    expect(blanked).toBe(false)
    expect(box.text).toBe('NEW UNSENT DRAFT')
  })
})

// Live on 2.1.310, $.state is held per session id, and /clear starts a new
// one: the plugin's state reads empty after it. This stands in for that.
function perSessionState(on: On) {
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
  return sid
}

const clear = async ($: Engine, sid: { value: string }) => {
  await $.session.end({ reason: 'clear', sessionId: sid.value, resume: { id: sid.value } })
  sid.value = `${sid.value}-cleared`
}

describe('across a /clear that empties plugin state', () => {
  test('a release the engine admits after /clear is refused and kept under Not sent', async ($, on) => {
    const gate = deferred<PromptSubmitResult>()
    let calls = 0
    const { box, sent, settle } = bottoms(on, undefined, text => (calls++ === 0 ? gate.promise : { text }))
    const sid = perSessionState(on)
    await $.session.start(SESSION)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.prompt.submit(typed('OLD_A'))
    await $.prompt.submit(typed('OLD_B'))
    await $.turn.complete(ended('answer'))
    await settle()
    await clear($, sid)
    const late = await $.prompt.submit({ text: 'OLD_A', wait: false, origin: { kind: 'plugin', name: 'defer-queue', asUser: true } })
    expect(late.drop).toMatch(/new conversation/)
    gate.resolve(late)
    await settle()
    expect(sent).toEqual(['OLD_A'])
    expect(box.text).toBe('draft\n\nOLD_B')
    const listed = (await list($)).text ?? ''
    expect(listed).toMatch(/Not sent[\s\S]*OLD_A/)
  })

  test('a send scheduled before /clear does not fire after it', async ($, on) => {
    const { sent, settle } = bottoms(on)
    const sid = perSessionState(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'queue', args: 'OLD', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await clear($, sid)
    await $.turn.start({ text: 'new work', turnId: 't2' })
    await $.prompt.submit(typed('NEW', 't2'))
    await settle()
    expect(sent).toEqual([])
  })

  test("prompts /clear can't hand back are still listed under Not sent after it", async ($, on) => {
    const { sent, settle } = bottoms(on, () => ({ isFilled: false, refusal: 'dialog' }))
    const sid = perSessionState(on)
    await $.session.start(SESSION)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.prompt.submit(typed('OLD_A'))
    await clear($, sid)
    await settle()
    expect((await list($)).text).toMatch(/Not sent[\s\S]*OLD_A/)
    await $.turn.start({ text: 'new work', turnId: 't2' })
    await $.turn.complete(ended('answer', 't2'))
    await settle()
    expect(sent).toEqual([])
  })
})
