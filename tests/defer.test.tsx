import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, PromptSubmitResult } from 'claude-code'

type Submitted = { text: string; origin: PromptOrigin }
type SubmitAnswer = (text: string) => PromptSubmitResult | Promise<PromptSubmitResult>

// The test's hooks sit beneath the plugin and stand for the engine: they record
// what the plugin submits, fills and shows. `answer` stands for what the engine
// does with a submitted prompt (by default it enters).
function bottoms(on: On, answer: SubmitAnswer = text => ({ text }), canFill: () => boolean = () => true) {
  const submitted: Submitted[] = []
  const filled: string[] = []
  const toasts: string[] = []
  // The plugin submits without awaiting; settle lets that work land.
  const clock = mock.clock(on)
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return answer(e.text)
  })
  on('prompt.fill', ($, e) => {
    if (!canFill()) return { isFilled: false, refusal: 'dialog' }
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: 'draft', cursor: 5 } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  return { submitted, filled, toasts, registered, settle: clock.settle }
}

const typedMidTurn = (text: string, wait: boolean) => ({
  text,
  wait,
  turnId: 't1',
  origin: { kind: 'composer' } as const,
})

const endTurn = (reason: 'answer' | 'aborted' | 'error', agentId?: string, turnId = 't1') => ({
  answer: 'done',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId,
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

async function startTurn($: Engine, turnId = 't1') {
  await $.turn.start({ text: 'long task', turnId })
}

const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const run = ($: Engine, args: string, command: 'queue' | 'defer' = 'queue') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

// A promise the test settles by hand, to hold a submitted prompt in flight.
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
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
  test('an interrupted main turn puts them all back in the prompt box, oldest first, and sends nothing', async ($, on) => {
    const { submitted, filled, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('aborted'))
    await settle()
    expect(filled).toEqual(['first\n\nsecond\n\ndraft'])
    expect(submitted).toEqual([])
    // A background notification's turn answering later restarts nothing.
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't2'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['task done'])
  })

  test("an interrupted turn the prompt box can't take back keeps them, paused", async ($, on) => {
    const { submitted, settle } = bottoms(on, undefined, () => false)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('aborted'))
    await settle()
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't2'))
    await settle()
    expect(submitted).toEqual([])
    expect((await run($, '')).text).toMatch(/paused[\s\S]*first/i)
  })

  test("a subagent's interrupted turn puts nothing back", async ($, on) => {
    const { filled, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('aborted', 'agent-1', 'c1'))
    await settle()
    expect(filled).toEqual([])
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

  test("a subagent's turn starting does not hide the main turn's end", async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await $.turn.start({ text: 'child task', turnId: 'c1', agentId: 'agent-1' })
    await $.turn.complete(endTurn('answer'))
    await run($, 'later')
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['later'])
  })

  test("a subagent's answered turn during the main turn releases nothing", async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await $.turn.start({ text: 'child task', turnId: 'c1', agentId: 'agent-1' })
    await $.turn.complete(endTurn('answer', 'agent-1', 'c1'))
    await settle()
    expect(submitted).toEqual([])
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['after'])
  })

  test("an older turn's late answer releases nothing while a newer turn runs", async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't1'))
    await settle()
    expect(submitted).toEqual([])
  })

  test('the same answered turn reported twice releases one prompt', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
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

describe('the /queue command', () => {
  test('holds its text while a turn runs', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    const out = await run($, 'review the diff')
    expect(out.text).toMatch(/[Qq]ueued until Claude finishes/)
    expect(submitted).toEqual([])
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['review the diff'])
  })

  test('sends its text right away when nothing is running', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await run($, 'review the diff')
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['review the diff'])
  })

  test('with no text, prints usage and lists what is held', async ($, on) => {
    bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    const out = await run($, '')
    expect(out.text).toMatch(/^Usage: \/queue/)
    expect(out.text).toMatch(/1\. first/)
  })

  test('is registered as /queue and as /defer', async ($, on) => {
    const { registered } = bottoms(on)
    await $.session.start(SESSION)
    expect(registered.sort()).toEqual(['defer', 'queue'])
  })

  test('/defer behaves as /queue', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await run($, '1. a\n2. b', 'defer')
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['a'])
  })

  test('splits a list into one prompt per item, sent one per finished turn', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    const out = await run($, '1. write the test\n   with a fixture\n2. make it pass')
    expect(out.text).toMatch(/2 waiting/)
    await $.turn.complete(endTurn('answer'))
    await settle()
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't2'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['write the test\n   with a fixture', 'make it pass'])
  })

  test('while idle, sends the first item now and holds the rest', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await run($, 'a) one\nb) two')
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['one'])
    expect((await run($, '')).text).toMatch(/1\. two/)
  })
})

describe('the -> and => shorthand', () => {
  test('a prompt starting with -> typed mid-turn is queued, even with plain Enter', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit(typedMidTurn('-> then run the linter', false))
    expect(result.drop).toMatch(/[Qq]ueued/)
    expect(submitted).toEqual([])
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['then run the linter'])
  })

  test('=> with a list mid-turn queues one prompt per item', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('=> 1. a\n2. b', false))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['a'])
    expect((await run($, '')).text).toMatch(/1\. b/)
  })

  test('while idle with nothing held, the first item goes through as typed and the rest wait', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    const result = await $.prompt.submit({ text: '-> 1. a\n2. b', wait: false, origin: { kind: 'composer' } })
    expect(result.drop).toBeUndefined()
    expect(submitted).toEqual([{ text: 'a', origin: { kind: 'composer' } }])
    await startTurn($)
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['a', 'b'])
  })

  test('while idle with older prompts held, it waits behind them and the oldest is sent', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('old', true))
    await $.turn.complete(endTurn('error'))
    const result = await $.prompt.submit({ text: '-> new', wait: false, origin: { kind: 'composer' } })
    expect(result.drop).toBeDefined()
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['old'])
    expect((await run($, '')).text).toMatch(/1\. new/)
  })

  test('an empty -> queues nothing and shows usage', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    const result = await $.prompt.submit(typedMidTurn('->', false))
    expect(result.drop).toMatch(/Usage: \/queue/)
    expect(submitted).toEqual([])
  })

  test('a wait-marked list without the shorthand stays one prompt', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('1. a\n2. b', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['1. a\n2. b'])
  })

  test("-> from a notification, peer or schedule is left alone", async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    for (const kind of ['task-notification', 'peer', 'scheduled-trigger', 'sdk'] as const) {
      const result = await $.prompt.submit({ text: '-> x', wait: false, turnId: 't1', origin: { kind } })
      expect(result.drop).toBeUndefined()
    }
    expect(submitted.length).toBe(4)
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

    test(`Take back returns only the newest held prompt, ahead of the draft, on ${surface}`, async ($, on) => {
      const { filled, submitted, settle } = bottoms(on)
      await startTurn($)
      await $.prompt.submit(typedMidTurn('first', true))
      await $.prompt.submit(typedMidTurn('second', true))
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'take-back' })
      expect(filled).toEqual(['second\n\ndraft'])
      expect(await ui.find({ type: 'Text', text: /second/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /first/ })).toBeDefined()
      await $.turn.complete(endTurn('answer'))
      await settle()
      expect(submitted.map(s => s.text)).toEqual(['first'])
    })

    test(`Take back all returns every held prompt, oldest first, on ${surface}`, async ($, on) => {
      const { filled } = bottoms(on)
      await startTurn($)
      await $.prompt.submit(typedMidTurn('first', true))
      await $.prompt.submit(typedMidTurn('second', true))
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'take-back-all' })
      expect(filled).toEqual(['first\n\nsecond\n\ndraft'])
      expect(await ui.find({ type: 'Text', text: /first/ })).toBeUndefined()
    })
  }

  test('Take back keeps the prompt held when the box cannot take it', async ($, on) => {
    const { filled } = bottoms(on, undefined, () => false)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'take-back' })
    expect(filled).toEqual([])
    expect(await ui.find({ type: 'Text', text: /2\. second/ })).toBeDefined()
  })

  test('offers Send next only while idle', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('error'))
    const busy = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await busy.find({ key: 'send' })).toBeUndefined()
    await busy.unmount()
    const idle = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
    await idle.press({ key: 'send' })
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
  })
})

describe('what a resend cannot carry', () => {
  test('a slash command or shell line typed mid-turn is not held', async ($, on) => {
    const { submitted } = bottoms(on)
    await startTurn($)
    for (const text of ['/compact keep', '  /compact keep', '!ls']) {
      const result = await $.prompt.submit(typedMidTurn(text, true))
      expect(result.drop).toBeUndefined()
    }
    expect(submitted.map(s => s.text)).toEqual(['/compact keep', '  /compact keep', '!ls'])
  })

  test('/queue refuses a slash command or shell line', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    const out = await run($, '/compact keep')
    expect(out.text).toMatch(/can't queue/i)
    await settle()
    expect(submitted).toEqual([])
  })
})

describe('when a release fails', () => {
  test('a resend the engine rejects goes back to the prompt box, and the queue moves on', async ($, on) => {
    let fail = true
    const { submitted, filled, settle } = bottoms(on, text => {
      if (fail) throw new Error('nope')
      return { text }
    })
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(filled).toEqual(['first\n\ndraft'])
    fail = false
    await startTurn($)
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first', 'second'])
  })

  for (const how of ['rejected', 'dropped'] as const) {
    test(`a ${how} resend the prompt box can't take goes back ahead of newer prompts, and the queue pauses`, async ($, on) => {
      let fail = true
      const { submitted, settle } = bottoms(
        on,
        text => {
          if (!fail) return { text }
          if (how === 'dropped') return { drop: 'blocked by policy' }
          throw new Error('nope')
        },
        () => false,
      )
      await $.session.start(SESSION)
      await startTurn($)
      await $.prompt.submit(typedMidTurn('first', true))
      await $.prompt.submit(typedMidTurn('second', true))
      await $.turn.complete(endTurn('answer'))
      await settle()
      fail = false
      await startTurn($, 't2')
      await $.prompt.submit({ ...typedMidTurn('third', true), turnId: 't2' })
      await $.turn.complete(endTurn('answer', undefined, 't2'))
      await settle()
      expect(submitted.map(s => s.text)).toEqual(['first'])
      const listed = (await run($, '')).text ?? ''
      expect(listed).toMatch(/paused/i)
      expect(listed.indexOf('first')).toBeLessThan(listed.indexOf('second'))
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
      await ui.press({ key: 'send' })
      await settle()
      expect(submitted.map(s => s.text)).toEqual(['first', 'first'])
    })
  }

  test('a release left unsettled by a reload is not resent, and is listed as maybe sent', async ($, on) => {
    const gate = deferred<PromptSubmitResult>()
    const { submitted, settle } = bottoms(on, () => gate.promise)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    // A hot reload runs session.start again; the old module's callbacks are gone.
    await $.session.start(SESSION)
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't2'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
    expect((await run($, '')).text).toMatch(/first.*may already have been sent/)
    gate.resolve({ text: 'first' })
    await settle()
  })

  test('a resend a hook beneath drops goes back to the prompt box', async ($, on) => {
    const { filled, settle } = bottoms(on, () => ({ drop: 'blocked by policy' }))
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(filled).toEqual(['first\n\ndraft'])
  })
})

describe('one release at a time', () => {
  test('a second finished turn while a release is in flight sends nothing more', async ($, on) => {
    const gate = deferred<PromptSubmitResult>()
    const { submitted, settle } = bottoms(on, () => gate.promise)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('answer'))
    await settle()
    await startTurn($, 't2')
    await $.turn.complete(endTurn('answer', undefined, 't2'))
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
    gate.resolve({ text: 'first' })
    await settle()
  })

  test('two presses of Send next send one prompt', async ($, on) => {
    const gate = deferred<PromptSubmitResult>()
    const { submitted, settle } = bottoms(on, () => gate.promise)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.prompt.submit(typedMidTurn('second', true))
    await $.turn.complete(endTurn('error'))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
    await ui.press({ key: 'send' })
    await ui.press({ key: 'send' })
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
    gate.resolve({ text: 'first' })
    await settle()
  })
})

describe('ordering and session changes', () => {
  test('/defer while idle with prompts held queues behind them and sends the oldest', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('error'))
    await run($, 'second')
    await settle()
    expect(submitted.map(s => s.text)).toEqual(['first'])
    expect((await run($, '')).text).toMatch(/second/)
  })

  test('a refusal ending the turn does not release them', async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await startTurn($)
    await $.prompt.submit(typedMidTurn('after', true))
    await $.turn.complete({ ...endTurn('answer'), reason: 'refusal', refusal: { category: null, explanation: null } })
    await settle()
    expect(submitted).toEqual([])
  })

  test('/clear hands held prompts back to the prompt box', async ($, on) => {
    const { submitted, filled, settle } = bottoms(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await startTurn($)
    await $.prompt.submit(typedMidTurn('first', true))
    await $.turn.complete(endTurn('error'))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await settle()
    expect(filled).toEqual(['first\n\ndraft'])
    await startTurn($)
    await $.turn.complete(endTurn('answer'))
    await settle()
    expect(submitted).toEqual([])
  })

  test("an older turn's late end does not mark a newer running turn idle", async ($, on) => {
    const { submitted, settle } = bottoms(on)
    await $.session.start(SESSION)
    await startTurn($, 't2')
    await $.turn.complete(endTurn('aborted', undefined, 't1'))
    await run($, 'later')
    await settle()
    expect(submitted).toEqual([])
  })
})
