import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { DeferredPrompt } from '../types'

// Prompts waiting for the main loop's turn to end, oldest first.
const held = atom({ plugin: 'defer-queue', key: 'held' } as const, [])
// The main-loop turn running now, by id; null while the main loop is idle.
const runningTurn = atom({ plugin: 'defer-queue', key: 'runningTurn' } as const, null)

// True from a release's submit until its turn starts, so one finished turn
// sends one prompt. A module variable on purpose: a reload resets it, so a
// submit lost to a reload can't wedge the queue.
let inFlight = false

const BAND_ROWS = 5

// Only the person's own prompts are held: notifications, peers and plugins
// keep their usual delivery.
const isPersons = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge'

// A plugin can't resubmit a slash command or shell line as typed, and Claude
// Code already holds both until the turn ends.
const isCommandLike = (text: string) => /^\s*[/!]/.test(text)

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

// Puts prompts in the prompt box ahead of the draft. Resolves whether the box
// took them; the caller decides what happens to them if it didn't.
async function handBack($: EngineInterface, items: DeferredPrompt[]): Promise<boolean> {
  if (items.length === 0) return true
  const draft = await $.prompt.read()
  const parts = [...items.map(m => m.text), ...(draft.text === '' ? [] : [draft.text])]
  const { isFilled } = await $.prompt.fill({ text: parts.join('\n'), mode: 'replace' })
  return isFilled
}

// A release that failed: back to the prompt box so it is never lost, or back
// to the head of the queue if the box can't take it now.
async function returnFailed($: EngineInterface, item: DeferredPrompt, why: string): Promise<void> {
  if (await handBack($, [item])) {
    $.ui.toast(`Deferred prompt not sent (${why}); it is back in the prompt box`)
    return
  }
  await update($, held, list => [item, ...list])
  $.ui.toast(`Deferred prompt not sent (${why}); kept it in the queue`)
}

// Sends the oldest held prompt as a turn of its own. Never awaits the submit:
// it resolves only once the session is idle and the new turn starts.
async function releaseNext($: EngineInterface): Promise<void> {
  if (inFlight) return
  inFlight = true
  let item: DeferredPrompt | undefined
  try {
    await update($, held, list => {
      item = list[0]
      return list.slice(1)
    })
  } finally {
    if (item === undefined) inFlight = false
  }
  if (item === undefined) return
  const sending = item
  void $.prompt.submit({ text: sending.text, asUser: true }).then(
    async result => {
      inFlight = false
      if (result.drop !== undefined) await returnFailed($, sending, `dropped: ${result.drop}`)
    },
    async (error: unknown) => {
      inFlight = false
      await returnFailed($, sending, String(error))
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
    if (!isMidTurn || !wantsToWait || !isPersons(e.origin) || isCommandLike(e.text)) return next(e)
    if (e.attachments !== undefined && e.attachments.length > 0) {
      $.ui.toast('defer-queue: prompts with attachments are not deferred; this one goes to the turn now')
      return next(e)
    }
    const count = await hold($, e.text)
    return { drop: `Deferred until Claude finishes this turn (${count} waiting)` }
  })

  on('turn.start', async ($, e, next) => {
    // Subagent and teammate runs raise turn.start too; only the main loop counts.
    if (e.agentId === undefined) await update($, runningTurn, () => e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Only the end of the tracked main turn counts, and only once: a late
      // end of an older turn, or a repeat, must not mark a newer one idle or
      // release another prompt.
      let isOurs = false
      await update($, runningTurn, id => {
        isOurs = id === e.turnId
        return isOurs ? null : id
      })
      // Only a turn the model ended itself counts as finished. After an
      // interrupt, API error or refusal the prompts wait for the next answer.
      if (isOurs && e.reason === 'answer') await releaseNext($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // Prompts written for the old conversation don't belong in the new one.
      await update($, runningTurn, () => null)
      const taken = await takeAll($)
      if (taken.length > 0) {
        const isBack = await handBack($, taken)
        $.ui.toast(
          isBack
            ? `/clear: ${taken.length} deferred prompt(s) moved back to the prompt box`
            : `/clear: discarded ${taken.length} deferred prompt(s): ${taken.map(m => firstLine(m.text)).join(' | ')}`,
        )
      }
    }
    return next(e)
  })

  on('command.run', { command: 'defer' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      const list = await read($, held)
      if (list.length === 0) return { text: 'Nothing is deferred.' }
      return { text: `Deferred (${list.length}):\n${list.map((m, i) => `${i + 1}. ${firstLine(m.text)}`).join('\n')}` }
    }
    if (isCommandLike(text)) {
      return { text: "Can't defer a slash command or shell line. Type it while Claude works; Claude Code already runs it after the turn." }
    }
    const count = await hold($, text)
    if ((await read($, runningTurn)) !== null) {
      return { text: `Deferred until Claude finishes this turn (${count} waiting).` }
    }
    // Nothing is running: send the oldest now. The host refuses a submit from
    // inside command.run (it would wait on this run), so a timer sends it.
    $.clock.after(0, () => void releaseNext($))
    return { text: count === 1 ? 'Nothing is running; sending it now.' : `Queued behind ${count - 1}; sending the oldest now.` }
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
              if (await handBack($, taken)) return
              await update($, held, list => [...taken, ...list])
              $.ui.toast('Could not reach the prompt box; kept the deferred prompts')
            }}
          />
          <Button key="discard" label="Discard" onPress={() => takeAll($)} />
        </Box>
      </Box>
    )
  })
}
