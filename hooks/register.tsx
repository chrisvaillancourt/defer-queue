import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { DeferredPrompt } from '../types'

// Prompts waiting for the main loop's turn to end, oldest first.
const held = atom({ plugin: 'defer-queue', key: 'held' } as const, [])
// Whether a main-loop turn is running; subagent runs raise no turn.start.
const isWorking = atom({ plugin: 'defer-queue', key: 'isWorking' } as const, false)

const BAND_ROWS = 5

// Only the person's own prompts are held: notifications, peers and plugins
// keep their usual delivery.
const isPersons = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge'

const firstLine = (text: string) => {
  const trimmed = text.trim()
  const line = trimmed.split('\n', 1)[0] ?? ''
  return trimmed.includes('\n') ? `${line} …` : line
}

let lastId = 0
const nextId = () => `${Date.now()}-${(lastId += 1)}`

async function hold($: EngineInterface, text: string): Promise<number> {
  const item: DeferredPrompt = { id: nextId(), text }
  const list = await update($, held, list => [...list, item])
  return list.length
}

async function takeAll($: EngineInterface): Promise<DeferredPrompt[]> {
  let taken: DeferredPrompt[] = []
  await update($, held, list => {
    taken = list
    return []
  })
  return taken
}

// Sends the oldest held prompt as a turn of its own. Never awaited inside a
// turn's hooks: $.prompt.submit resolves only once the session is idle.
async function releaseNext($: EngineInterface): Promise<void> {
  let item: DeferredPrompt | undefined
  await update($, held, list => {
    item = list[0]
    return list.slice(1)
  })
  if (item === undefined) return
  const sending = item
  void $.prompt.submit({ text: sending.text, asUser: true }).then(
    result => {
      if (result.drop !== undefined) $.ui.toast(`Deferred prompt was dropped: ${result.drop}`)
    },
    async (error: unknown) => {
      await update($, held, list => [sending, ...list])
      $.ui.toast(`Could not send the deferred prompt, kept it: ${String(error)}`)
    },
  )
}

export const register: Register = (on, options) => {
  const deferAll = options.defer_all_mid_turn === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'defer',
      description: 'Send a prompt once Claude finishes the current turn; with no text, list what is waiting',
      argumentHint: '[prompt]',
      immediate: true,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isMidTurn = e.turnId !== undefined
    const wantsToWait = e.wait || deferAll
    if (!isMidTurn || !wantsToWait || !isPersons(e.origin)) return next(e)
    if (e.attachments !== undefined && e.attachments.length > 0) {
      $.ui.toast('defer-queue: prompts with attachments are not deferred; this one goes to the turn now')
      return next(e)
    }
    const count = await hold($, e.text)
    return { drop: `Deferred until Claude finishes this turn (${count} waiting)` }
  })

  on('turn.start', async ($, e, next) => {
    await update($, isWorking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await update($, isWorking, () => false)
    // Only a turn the model ended itself counts as finished. After an
    // interrupt, API error or refusal the prompts wait for the next answer.
    if (e.reason === 'answer') await releaseNext($)
    return result
  })

  on('command.run', { command: 'defer' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      const list = await read($, held)
      if (list.length === 0) return { text: 'Nothing is deferred.' }
      return { text: `Deferred (${list.length}):\n${list.map((m, i) => `${i + 1}. ${firstLine(m.text)}`).join('\n')}` }
    }
    if (!(await read($, isWorking))) {
      // The host refuses a submit from inside command.run (it would wait on
      // the command's own run), so it goes out from a timer instead.
      $.clock.after(0, () => {
        void $.prompt.submit({ text, asUser: true }).catch((error: unknown) => {
          $.ui.toast(`Could not send the prompt: ${String(error)}`)
        })
      })
      return { text: 'Nothing is running; sending it now.' }
    }
    const count = await hold($, text)
    return { text: `Deferred until Claude finishes this turn (${count} waiting).` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const list = await read($, held)
    if (list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = list.slice(0, BAND_ROWS)
    const status = e.props.isWorking ? 'until this turn finishes' : 'until the next turn finishes'

    return (
      <Box flexDirection="column">
        <Text dimColor>
          Deferred {status} ({list.length}):
        </Text>
        {shown.map((m, i) => (
          <Text wrap="truncate-end">
            {i + 1}. {firstLine(m.text)}
          </Text>
        ))}
        {list.length > shown.length && <Text dimColor>…and {list.length - shown.length} more</Text>}
        <Box flexDirection="row" gap={1}>
          {!e.props.isWorking && (
            <Button key="send" label="Send next" variant="primary" onPress={() => releaseNext($)} />
          )}
          <Button
            key="take-back"
            label="Take back"
            onPress={async () => {
              const taken = await takeAll($)
              if (taken.length === 0) return
              const draft = await $.prompt.read()
              const parts = [...taken.map(m => m.text), ...(draft.text === '' ? [] : [draft.text])]
              const { isFilled } = await $.prompt.fill({ text: parts.join('\n'), mode: 'replace' })
              if (!isFilled) {
                await update($, held, list => [...taken, ...list])
                $.ui.toast('Could not reach the prompt box; kept the deferred prompts')
              }
            }}
          />
          <Button key="discard" label="Discard" onPress={() => takeAll($)} />
        </Box>
      </Box>
    )
  })
}
