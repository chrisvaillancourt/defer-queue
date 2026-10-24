import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { EMPTY, firstLine, insertBySeq, isCommandLike, joinForBox, listText } from './policy'
import type { Entry, Queue } from '../types'

// The whole queue in one record (see AGENTS.md). Change the shape tag when
// Queue's fields change: a value an older version stored then reads as EMPTY.
const queue = atom({ plugin: 'defer-queue', key: 'queue' } as const, EMPTY, { shape: 'queue-1' })
// 0.1's keys, emptied into `queue` once on session.start so an upgrade
// mid-session keeps what was held.
const legacyHeld = atom({ plugin: 'defer-queue', key: 'held' } as const, [])
const legacyRunningTurn = atom({ plugin: 'defer-queue', key: 'runningTurn' } as const, null)

const BAND_ROWS = 5

// Only the person's own prompts are held: notifications, peers and plugins
// keep their usual delivery.
const isPersons = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge'

// A release's token names its claim; a module counter is enough, since a
// reload moves any standing claim to recovery before minting new ones.
let lastToken = 0
const newToken = () => `${Date.now()}-${(lastToken += 1)}`

/** Queues texts at the back. `turnId`, when given, is a running main turn the engine attests. */
async function hold($: EngineInterface, texts: readonly string[], turnId?: string): Promise<Queue> {
  return update($, queue, q => ({
    ...q,
    runningTurn: q.runningTurn ?? turnId ?? null,
    nextSeq: q.nextSeq + texts.length,
    items: [...q.items, ...texts.map((text, i) => ({ seq: q.nextSeq + i, text }))],
  }))
}

// Puts texts in the prompt box ahead of the draft. Resolves whether the box
// took them; the caller decides what happens to them if it didn't.
async function handBack($: EngineInterface, texts: readonly string[]): Promise<boolean> {
  if (texts.length === 0) return true
  try {
    const draft = await $.prompt.read()
    const { isFilled } = await $.prompt.fill({ text: joinForBox(texts, draft.text), mode: 'replace' })
    return isFilled
  } catch {
    return false
  }
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // Reporting is best effort.
  }
}

// Sends the oldest queued entry as a turn of its own. It is reserved as the
// claim in the same update that takes it off the queue, so nothing else is
// released until it settles. Never awaits the submit: that resolves only
// once the session is idle and the new turn starts.
//
// `auto` (a finished turn, an idle /defer) respects a pause; `explicit`
// (Send next) lifts it. `epoch`, when given, is the queue's epoch when the
// release was scheduled: a /clear since then cancels it.
async function releaseNext($: EngineInterface, why: 'auto' | 'explicit', epoch?: number): Promise<void> {
  const token = newToken()
  let sending: Entry | undefined
  await update($, queue, q => {
    sending = undefined
    const head = q.items[0]
    if (head === undefined || q.claim !== null) return q
    if (epoch !== undefined && q.epoch !== epoch) return q
    if (q.paused && why === 'auto') return q
    sending = head
    return { ...q, items: q.items.slice(1), claim: { entry: head, token }, paused: false }
  })
  if (sending === undefined) return
  void $.prompt.submit({ text: sending.text, asUser: true }).then(
    result => settleRelease($, token, result.drop === undefined ? undefined : `dropped: ${result.drop}`),
    (error: unknown) => settleRelease($, token, String(error)),
  )
}

// A release's submit settled. Sent: retire its claim (or its recovery entry,
// if a reload or /clear moved it there meanwhile). Failed: hand it back to the
// prompt box while the claim still blocks other releases; if the box can't
// take it, it returns to its place in the queue and the queue pauses, so a
// failed release never starts another.
async function settleRelease($: EngineInterface, token: string, failure: string | undefined): Promise<void> {
  if (failure === undefined) {
    await update($, queue, q =>
      q.claim?.token === token
        ? { ...q, claim: null }
        : { ...q, recovery: q.recovery.filter(r => r.token !== token) },
    )
    return
  }
  const before = await read($, queue)
  const entry = before.claim?.token === token ? before.claim.entry : before.recovery.find(r => r.token === token)
  if (entry === undefined) return
  const isBack = await handBack($, [entry.text])
  let where: 'box' | 'queue' | 'recovery' = 'box'
  await update($, queue, q => {
    if (q.claim?.token === token) {
      where = isBack ? 'box' : 'queue'
      return isBack
        ? { ...q, claim: null }
        : { ...q, claim: null, items: insertBySeq(q.items, [q.claim.entry]), paused: true }
    }
    where = isBack ? 'box' : 'recovery'
    return {
      ...q,
      recovery: isBack
        ? q.recovery.filter(r => r.token !== token)
        : q.recovery.map(r => (r.token === token ? { seq: r.seq, text: r.text } : r)),
    }
  })
  toast(
    $,
    where === 'box'
      ? `Deferred prompt not sent (${failure}); it is back in the prompt box`
      : where === 'queue'
        ? `Deferred prompt not sent (${failure}); kept it first in the queue, which is paused`
        : `Deferred prompt not sent (${failure}); kept it under "Not sent"`,
  )
}

// Runs on load and on every hot reload. A claim standing now was made by a
// module that is gone, its callback with it: whether it went out is unknown,
// so it moves to recovery instead of being sent again, and the queue pauses.
async function adoptOnLoad($: EngineInterface): Promise<void> {
  const oldHeld = await read($, legacyHeld)
  const oldRunning = await read($, legacyRunningTurn)
  await update($, queue, q => {
    let next = q
    if (oldHeld.length > 0) {
      next = {
        ...next,
        nextSeq: next.nextSeq + oldHeld.length,
        items: [...next.items, ...oldHeld.map((m, i) => ({ seq: next.nextSeq + i, text: m.text }))],
      }
    }
    if (next.runningTurn === null && oldRunning !== null) next = { ...next, runningTurn: oldRunning }
    if (next.claim !== null) {
      const { entry, token } = next.claim
      next = { ...next, claim: null, paused: true, recovery: [...next.recovery, { ...entry, token, maybeSent: true }] }
    }
    return next
  })
  if (oldHeld.length > 0) await update($, legacyHeld, () => [])
  if (oldRunning !== null) await update($, legacyRunningTurn, () => null)
}

async function runDefer($: EngineInterface, args: string): Promise<{ text: string }> {
  const text = args.trim()
  if (text === '') return { text: listText(await read($, queue)) }
  if (isCommandLike(text)) {
    return { text: "Can't defer a slash command or shell line. Type it while Claude works; Claude Code already runs it after the turn." }
  }
  const q = await hold($, [text])
  const count = q.items.length
  if (q.runningTurn !== null) return { text: `Deferred until Claude finishes this turn (${count} waiting).` }
  if (q.paused) return { text: `Queued (${count} waiting). The queue is paused: press Send next to resume.` }
  if (q.claim !== null) return { text: `Queued behind the prompt being sent (${count} waiting).` }
  // Nothing is running: send the oldest now. The host refuses a submit from
  // inside command.run (it would wait on this run), so a timer sends it.
  const epoch = q.epoch
  $.clock.after(0, () => void releaseNext($, 'auto', epoch))
  return { text: count === 1 ? 'Nothing is running; sending it now.' : `Queued behind ${count - 1}; sending the oldest now.` }
}

async function takeAllItems($: EngineInterface): Promise<Entry[]> {
  let taken: Entry[] = []
  await update($, queue, q => {
    taken = q.items
    return { ...q, items: [], paused: false }
  })
  return taken
}

async function takeBackAll($: EngineInterface): Promise<void> {
  const taken = await takeAllItems($)
  if (await handBack($, taken.map(m => m.text))) return
  await update($, queue, q => ({ ...q, items: insertBySeq(q.items, taken) }))
  toast($, 'Could not reach the prompt box; kept the deferred prompts')
}

// omp's dequeue: the newest entry alone back into the prompt box, the turn
// left running.
async function takeBackNewest($: EngineInterface): Promise<void> {
  let taken: Entry | undefined
  await update($, queue, q => {
    taken = q.items.at(-1)
    return taken === undefined ? q : { ...q, items: q.items.slice(0, -1) }
  })
  if (taken === undefined) return
  const entry = taken
  if (await handBack($, [entry.text])) {
    await update($, queue, q => (q.items.length === 0 ? { ...q, paused: false } : q))
    return
  }
  await update($, queue, q => ({ ...q, items: insertBySeq(q.items, [entry]) }))
  toast($, 'Could not reach the prompt box; kept the deferred prompt')
}

// omp's Esc: an interrupted main turn hands every queued entry back, oldest
// first, ahead of the draft, and sends nothing. If the box can't take them
// they stay queued, paused, so no later answer sends them unasked.
async function restoreAfterAbort($: EngineInterface): Promise<void> {
  const taken = await takeAllItems($)
  if (taken.length === 0) return
  if (await handBack($, taken.map(m => m.text))) return
  await update($, queue, q => ({ ...q, items: insertBySeq(q.items, taken), paused: true }))
  toast($, `Turn interrupted; could not reach the prompt box, so ${taken.length} deferred prompt(s) wait, paused`)
}

export const register: Register = (on, options) => {
  const deferAll = options.defer_all_mid_turn === true

  on('session.start', async ($, e, next) => {
    await adoptOnLoad($)
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
      toast($, 'prompts with attachments are not deferred; this one goes to the turn now')
      return next(e)
    }
    const q = await hold($, [e.text], e.turnId)
    return { drop: `Deferred until Claude finishes this turn (${q.items.length} waiting)` }
  }).catch(($, e, next) => next(e)) // Fails open: a prompt the queue couldn't take goes to the turn, never lost.

  on('turn.start', async ($, e, next) => {
    // Subagent and teammate runs raise turn.start too; only the main loop counts.
    if (e.agentId === undefined) await update($, queue, q => ({ ...q, runningTurn: e.turnId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Only the end of the tracked main turn counts, and only once: a late
      // end of an older turn, or a repeat, must not mark a newer one idle or
      // release another prompt.
      let isOurs = false
      await update($, queue, q => {
        isOurs = q.runningTurn === e.turnId
        return isOurs ? { ...q, runningTurn: null } : q
      })
      // An answer releases the next entry. An interrupt hands them all back.
      // After an API error or refusal they wait for the next answer.
      if (isOurs && e.reason === 'answer') await releaseNext($, 'auto')
      if (isOurs && e.reason === 'aborted') await restoreAfterAbort($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // Prompts written for the old conversation don't belong in the new one.
      await update($, queue, q => ({ ...q, runningTurn: null }))
      const taken = await takeAllItems($)
      if (taken.length > 0) {
        const isBack = await handBack($, taken.map(m => m.text))
        toast(
          $,
          isBack
            ? `/clear: ${taken.length} deferred prompt(s) moved back to the prompt box`
            : `/clear: discarded ${taken.length} deferred prompt(s): ${taken.map(m => firstLine(m.text)).join(' | ')}`,
        )
      }
    }
    return next(e)
  })

  on('command.run', { command: 'defer' }, async ($, e) => runDefer($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const q = await read($, queue)
    const list = q.items
    if (list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = list.slice(0, BAND_ROWS)
    const status = q.paused
      ? 'and paused: press Send next to resume'
      : e.props.isWorking
        ? 'until this turn finishes'
        : 'until the next turn finishes'

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
            <Button key="send" label="Send next" variant="primary" onPress={() => releaseNext($, 'explicit')} />
          )}
          <Button key="take-back" label="Take back" onPress={() => takeBackNewest($)} />
          {list.length > 1 && <Button key="take-back-all" label="Take back all" onPress={() => takeBackAll($)} />}
          <Button key="discard" label="Discard" onPress={() => takeAllItems($)} />
        </Box>
      </Box>
    )
  })
}
