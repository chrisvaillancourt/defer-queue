import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

type Submitted = { text: string; origin: PromptOrigin }

// The test's hooks sit beneath the plugin and stand for the engine: they record
// what the plugin submits, fills and shows.
function bottoms(on: On) {
  const submitted: Submitted[] = []
  const filled: string[] = []
  const toasts: string[] = []
  // The plugin submits without awaiting; settle lets that work land.
  const clock = mock.clock(on)
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: 'draft', cursor: 5 } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return { submitted, filled, toasts, settle: clock.settle }
}

const typedMidTurn = (text: string, wait: boolean) => ({
  text,
  wait,
  turnId: 't1',
  origin: { kind: 'composer' } as const,
})

const endTurn = (reason: 'answer' | 'aborted' | 'error', agentId?: string) => ({
  answer: 'done',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

async function startTurn($: Engine) {
  await $.turn.start({ text: 'long task', turnId: 't1' })
}

const BAND = {
  plugin: 'defer-queue',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

describe('holding a queued prompt', () => {
  test('a wait-marked mid-turn prompt is held, not passed to the turn', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit(typedMidTurn('then write the tests', true))
    expect(result.drop).toBeDefined()
    expect(submitted).toEqual([])
  })

  test('it is sent as its own prompt once the turn ends with an answer', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('then write the tests', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['then write the tests'])
    expect(submitted[0]?.origin).toEqual({ kind: 'plugin', name: 'defer-queue', asUser: true })
  })

  test('a plain Enter mid-turn still steers by default', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit(typedMidTurn('steer now', false))
    expect(result.drop).toBeUndefined()
    expect(submitted.map(s => s.text)).toEqual(['steer now'])
  })

  test('with defer_all_mid_turn on, a plain Enter mid-turn is held too', { options: { defer_all_mid_turn: true } }, async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit(typedMidTurn('wait for it', false))
    expect(result.drop).toBeDefined()
    expect(submitted).toEqual([])
  })

  test('a wait-marked prompt sent while idle goes straight through', async ($, on) => {
    const { submitted } = bottoms(on)
    const result = await $.prompt.submit({ text: 'hello', wait: true, origin: { kind: 'composer' } })
    expect(result.drop).toBeUndefined()
    expect(submitted.map(s => s.text)).toEqual(['hello'])
  })

  test('a prompt with attachments is not held, since a resend would lose them', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit({
      ...typedMidTurn('look at this', true),
      attachments: [{ type: 'image', mediaType: 'image/png' }],
    })
    expect(result.drop).toBeUndefined()
    expect(submitted.map(s => s.text)).toEqual(['look at this'])
  })

  test('a notification or peer message mid-turn is never held', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit({ text: 'task done', wait: true, turnId: 't1', origin: { kind: 'task-notification' } })
    expect(result.drop).toBeUndefined()
    expect(submitted.map(s => s.text)).toEqual(['task done'])
  })
})

describe('releasing held prompts', () => {
  test('an interrupted turn does not release them; the next answered turn does', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await $.turn.complete(endTurn('aborted'))
    await settle()
    expect(submitted).toEqual([])
    await startTurn($)
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['after'])
  })

  test('an API error ending the turn does not release them', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await $.turn.complete(endTurn('error'))
    await settle()
    expect(submitted).toEqual([])
  })

  test("a subagent's turn ending does not release them", async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await $.turn.complete(endTurn('answer', 'agent-1'))
    await settle()
    expect(submitted).toEqual([])
  })

  test('several held prompts go one per finished turn, in order', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
    await startTurn($)
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first', 'second'])
  })
})

describe('the /defer command', () => {
  const run = ($: Engine, args: string) =>
    $.command.run({
      command: 'defer',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })

  test('holds its text while a turn runs', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await startTurn($)
    const out = await run($, 'review the diff')
    expect(out.text).toMatch(/[Dd]eferred/)
    expect(submitted).toEqual([])
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['review the diff'])
  })

  test('sends its text right away when nothing is running', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await run($, 'review the diff')
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['review the diff'])
  })

  test('with no text, lists what is held', async ($, on) => {
    bottoms(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    const out = await run($, '')
    expect(out.text).toMatch(/first/)
  })
})

describe('the band above the prompt', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows held prompts and discards them on ${surface}`, async ($, on) => {
      const { submitted, settle } = bottoms(on)
      await startTurn($)
      await $.prompt.submit(typedMidTurn('first', true))
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /first/ })).toBeDefined()
      await ui.press({ key: 'discard' })
      expect(await ui.find({ type: 'Text', text: /first/ })).toBeUndefined()
      await $.turn.complete(endTurn('answer'))
      await settle()
      expect(submitted).toEqual([])
    })

    test(`takes held prompts back into the prompt box on ${surface}`, async ($, on) => {
      const { filled } = bottoms(on)
      await startTurn($)
      await $.prompt.submit(typedMidTurn('first', true))
      await $.prompt.submit(typedMidTurn('second', true))
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'take-back' })
      expect(filled).toEqual(['first\nsecond\ndraft'])
      expect(await ui.find({ type: 'Text', text: /first/ })).toBeUndefined()
    })
  }

  test('offers Send next only while idle', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('aborted'))
    const busy = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await busy.find({ key: 'send' })).toBeUndefined()
    await busy.unmount()
    const idle = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
    await idle.press({ key: 'send' })
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
  })
})
