import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import {
  EMPTY,
  USAGE,
  firstLine,
  insertBySeq,
  isCommandLike,
  appendText,
  listText,
  mergeCarry,
  parseQueueShorthand,
  splitQueuedMessages,
} from './policy'
import type { Entry, Queue } from '../types'

// The whole queue in one record (see AGENTS.md). Change the shape tag when
// Queue's fields change: a value an older version stored then reads as EMPTY.
const queue = atom({ plugin: 'defer-queue', key: 'queue' } as const, EMPTY, { shape: 'queue-2' })
// 0.1's keys, emptied on session.start; its held prompts move into `queue`
// so an upgrade mid-session keeps them.
const legacyHeld = atom({ plugin: 'defer-queue', key: 'held' } as const, [])
const legacyRunningTurn = atom({ plugin: 'defer-queue', key: 'runningTurn' } as const, null)

// Live on 2.1.310, $.state is held per session id and /clear starts a new
// one, so the queue reads empty after it. What must outlive the /clear (the
// bumped epoch, Not sent) is carried in this module variable from session.end
// and merged into the new session's state by a timer session.end starts
// (live, 2.1.310: it fires in the new session, about 20 ms later), or by any
// access before that. A reload inside that moment loses the carry (module
// variables don't survive one); README lists it.
let carry: { from: string; value: Queue } | null = null

// Resolves whether nothing is left to carry.
async function adoptCarry($: EngineInterface): Promise<boolean> {
  const c = carry
  if (c === null) return true
  let id: string
  try {
    id = await $.session.id()
  } catch {
    return false
  }
  if (carry !== c) return carry === null
  if (id === c.from) return false
  carry = null
  await update($, queue, q => mergeCarry(q, c.value))
  return true
}

// The timer's waits: the first try is the next tick; later ones cover an
// engine that switches the session id later than 2.1.310 does.
const ADOPT_RETRIES_MS = [0, 100, 1000] as const

function scheduleAdoption($: EngineInterface, attempt: number): void {
  const wait = ADOPT_RETRIES_MS[attempt]
  if (wait === undefined) return
  $.clock.after(wait, () => void retryAdoption($, attempt))
}

async function retryAdoption($: EngineInterface, attempt: number): Promise<void> {
  // A timer never throws: a failed try is retried, and any access adopts too.
  const isDone = await adoptCarry($).catch(() => false)
  if (!isDone) scheduleAdoption($, attempt + 1)
}

async function getQ($: EngineInterface): Promise<Queue> {
  await adoptCarry($)
  return read($, queue)
}

async function updQ($: EngineInterface, change: (q: Queue) => Queue): Promise<Queue> {
  await adoptCarry($)
  return update($, queue, change)
}

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
  return updQ($, q => ({
    ...q,
    runningTurn: q.runningTurn ?? turnId ?? null,
    nextSeq: q.nextSeq + texts.length,
    items: [...q.items, ...texts.map((text, i) => ({ seq: q.nextSeq + i, text }))],
  }))
}

// Puts texts in the prompt box after the draft. Resolves whether the box took
// them; the caller decides what happens to them if it didn't.
//
// Never a read-then-replace: the person can type between a read and a write,
// and replacing would delete that. An `append` keeps whatever the box holds
// when it lands. Handbacks also run one at a time, in the order asked, so two
// overlapping ones can't interleave. (The read only decides the separator.)
let boxChain: Promise<unknown> = Promise.resolve()

async function handBack($: EngineInterface, texts: readonly string[]): Promise<boolean> {
  if (texts.length === 0) return true
  const turn = boxChain.then(() => appendToBox($, texts))
  boxChain = turn.catch(() => false)
  return turn
}

async function appendToBox($: EngineInterface, texts: readonly string[]): Promise<boolean> {
  try {
    const box = await $.prompt.read()
    const { isFilled } = await $.prompt.fill({ text: appendText(texts, box.text.trim() !== ''), mode: 'append' })
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
  await updQ($, q => {
    sending = undefined
    const head = q.items[0]
    if (head === undefined || q.claim !== null) return q
    if (epoch !== undefined && q.epoch !== epoch) return q
    if (q.paused && why === 'auto') return q
    sending = head
    return { ...q, items: q.items.slice(1), claim: { entry: head, token, epoch: q.epoch }, paused: false }
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
  if (failure === `dropped: ${STALE_RELEASE}`) {
    // Refused at admission (see admitOwnRelease): it was not sent, and it
    // belongs to the old conversation, so it stays under Not sent.
    await updQ($, q => ({
      ...q,
      recovery: q.recovery.map(r => (r.token === token ? { seq: r.seq, text: r.text } : r)),
    }))
    toast($, 'A queued prompt from before /clear was not sent into the new conversation; it is under "Not sent"')
    return
  }
  if (failure === undefined) {
    await updQ($, q =>
      q.claim?.token === token
        ? { ...q, claim: null }
        : { ...q, recovery: q.recovery.filter(r => r.token !== token) },
    )
    return
  }
  const before = await getQ($)
  const entry = before.claim?.token === token ? before.claim.entry : before.recovery.find(r => r.token === token)
  if (entry === undefined) return
  const isBack = await handBack($, [entry.text])
  let where: 'box' | 'queue' | 'recovery' = 'box'
  await updQ($, q => {
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
      ? `Queued prompt not sent (${failure}); it is back in the prompt box`
      : where === 'queue'
        ? `Queued prompt not sent (${failure}); kept it first in the queue, which is paused`
        : `Queued prompt not sent (${failure}); kept it under "Not sent"`,
  )
}

// Runs on load and on every hot reload. A claim standing now was made by a
// module that is gone, its callback with it: whether it went out is unknown,
// so it moves to recovery instead of being sent again, and the queue pauses.
async function adoptOnLoad($: EngineInterface): Promise<void> {
  const oldHeld = await read($, legacyHeld)
  const oldRunning = await read($, legacyRunningTurn)
  await updQ($, q => {
    let next = q
    if (oldHeld.length > 0) {
      next = {
        ...next,
        nextSeq: next.nextSeq + oldHeld.length,
        items: [...next.items, ...oldHeld.map((m, i) => ({ seq: next.nextSeq + i, text: m.text }))],
      }
    }
    // 0.1's runningTurn is not adopted: 0.1 set it on every turn.start,
    // subagents' included, so it can name a finished one. The next main
    // turn.start sets the real one; until then the queue counts as idle.
    if (next.pending.length > 0) {
      // Handbacks a reload interrupted: whether the box took them is unknown,
      // so they are kept under Not sent rather than queued again.
      next = mergeCarry({ ...next, pending: [] }, { ...EMPTY, recovery: next.pending.flatMap(p => p.entries) })
    }
    if (next.claim !== null) {
      const { entry, token } = next.claim
      next = { ...next, claim: null, paused: true, recovery: [...next.recovery, { ...entry, token, maybeSent: true }] }
    }
    return next
  })
  if (oldHeld.length > 0) await update($, legacyHeld, () => [])
  if (oldRunning !== null) await update($, legacyRunningTurn, () => null)
}

const STALE_RELEASE = 'Queued before /clear; not sent into the new conversation (kept under "Not sent")'

// The mod's own release passes through prompt.submit when the engine admits
// it, which (live, 2.1.310) can be after a /clear that ran while it waited.
// Admit it only while it is still the current conversation's claim; a release
// /clear or a reload moved to recovery is refused there and stays recoverable.
async function admitOwnRelease($: EngineInterface, text: string): Promise<boolean> {
  const q = await getQ($)
  if (q.claim !== null && q.claim.entry.text === text && q.claim.epoch === q.epoch) return true
  // Refused here, so it is known unsent. Keep it under Not sent: drop the "may
  // already have been sent" mark if it is there (after a reload no callback is
  // left to do it), or add it if nothing remembers it (a reload lost the
  // /clear carry).
  await updQ($, s =>
    s.recovery.some(r => r.token !== undefined && r.text === text)
      ? { ...s, recovery: s.recovery.map(r => (r.token !== undefined && r.text === text ? { seq: r.seq, text: r.text } : r)) }
      : { ...s, nextSeq: s.nextSeq + 1, recovery: [...s.recovery, { seq: s.nextSeq, text }] },
  )
  return false
}

const CANT_QUEUE_COMMAND =
  "Can't queue a slash command or shell line. Type it while Claude works; Claude Code already runs it after the turn."

// Queues entries at the back and says what happens next. While the main loop
// is idle the oldest entry is sent now, so queue input never overtakes older
// held work. The host refuses a submit from inside command.run and
// prompt.submit (it would wait on that hook), so a timer sends it.
async function queueEntries($: EngineInterface, entries: readonly string[], turnId?: string): Promise<string> {
  const q = await hold($, entries, turnId)
  const count = q.items.length
  const n = entries.length
  const what = n === 1 ? 'Queued' : `Queued ${n}`
  if (q.runningTurn !== null) return `${what} until Claude finishes this turn (${count} waiting).`
  if (q.paused) return `${what} (${count} waiting). The queue is paused: press Send next to resume.`
  if (q.claim !== null) return `${what} behind the prompt being sent (${count} waiting).`
  const epoch = q.epoch
  $.clock.after(0, () => void releaseNext($, 'auto', epoch))
  if (count > n) return `${what} behind ${count - n}; sending the oldest now.`
  return n === 1 ? 'Nothing is running; sending it now.' : `Nothing is running; sending the first now (${n - 1} waiting).`
}

// Live on 2.1.310, a prompt a prompt.submit hook drops stays in the prompt
// box. Clearing it would need a read-then-replace, which can delete what the
// person types meanwhile (the API has no write-if-unchanged), so the text is
// left there and the drop message says so.
const LEFTOVER = ' Your text stays in the box: clear the box before pressing Enter, or it is sent again.'

function held(message: string): { drop: string } {
  return { drop: `${message}${LEFTOVER}` }
}

// /queue and its alias /defer.
async function runQueue($: EngineInterface, args: string): Promise<{ text: string }> {
  const body = args.trim()
  if (body === '') return { text: `${USAGE}\n\n${listText(await getQ($))}` }
  const entries = splitQueuedMessages(body)
  if (entries.some(isCommandLike)) return { text: CANT_QUEUE_COMMAND }
  return { text: await queueEntries($, entries) }
}

async function takeAllItems($: EngineInterface): Promise<Entry[]> {
  let taken: Entry[] = []
  await updQ($, q => {
    taken = q.items
    return { ...q, items: [], paused: false }
  })
  return taken
}

// Hands entries the queue picks back to the prompt box, owning them in state
// (`pending`) until the box answers, so a /clear or reload in between can
// see them. Taken off `items` in the same update that records them. If the
// box refuses: back to their place in the queue with the pause they had (or
// paused, for an interrupt), unless a /clear came since, when they go to
// recovery instead. A failed edit never grants delivery.
async function handBackFromQueue(
  $: EngineInterface,
  pick: (items: readonly Entry[]) => Entry[],
  pauseOnFail: boolean,
): Promise<'none' | 'box' | 'queue' | 'recovery'> {
  const id = newToken()
  let taken: Entry[] = []
  await updQ($, q => {
    taken = pick(q.items)
    if (taken.length === 0) return q
    const seqs = new Set(taken.map(m => m.seq))
    return {
      ...q,
      items: q.items.filter(m => !seqs.has(m.seq)),
      pending: [...q.pending, { id, epoch: q.epoch, entries: taken, wasPaused: q.paused, pauseOnFail }],
    }
  })
  if (taken.length === 0) return 'none'
  const entries = taken
  const isBack = await handBack($, entries.map(m => m.text))
  let where: 'box' | 'queue' | 'recovery' = 'box'
  await updQ($, q => {
    const mine = q.pending.find(p => p.id === id)
    const pending = q.pending.filter(p => p.id !== id)
    if (isBack) {
      where = 'box'
      return { ...q, pending, paused: q.items.length === 0 ? false : q.paused }
    }
    if (mine === undefined || mine.epoch !== q.epoch) {
      // A /clear came since (or a reload lost the record): old input never
      // re-enters the new conversation's queue.
      where = 'recovery'
      return mergeCarry({ ...q, pending }, { ...EMPTY, recovery: mine?.entries ?? entries })
    }
    where = 'queue'
    return {
      ...q,
      pending,
      items: insertBySeq(q.items, mine.entries),
      paused: q.paused || mine.wasPaused || mine.pauseOnFail,
    }
  })
  return where
}

function sayKept($: EngineInterface, where: 'none' | 'box' | 'queue' | 'recovery', what: string): void {
  if (where === 'queue') toast($, `Could not reach the prompt box; kept ${what} in the queue`)
  if (where === 'recovery') toast($, `Could not reach the prompt box; kept ${what} under "Not sent" (from before /clear)`)
}

async function takeBackAll($: EngineInterface): Promise<void> {
  sayKept($, await handBackFromQueue($, items => [...items], false), 'the queued prompts')
}

// omp's dequeue: the newest entry alone back into the prompt box, the turn
// left running.
async function takeBackNewest($: EngineInterface): Promise<void> {
  sayKept($, await handBackFromQueue($, items => items.slice(-1), false), 'the queued prompt')
}

// omp's Esc: an interrupted main turn hands every queued entry back, oldest
// first, after the draft, and sends nothing. If the box can't take them
// they stay queued, paused, so no later answer sends them unasked.
async function restoreAfterAbort($: EngineInterface): Promise<void> {
  const where = await handBackFromQueue($, items => [...items], true)
  if (where === 'queue') toast($, 'Turn interrupted; could not reach the prompt box, so the queued prompts wait, paused')
  else sayKept($, where, 'the queued prompts')
}

// /clear or a resume: prompts written for the old conversation don't belong
// in the new one. omp discards them; this hands them back to the prompt box
// instead, so nothing is lost. The epoch bump cancels sends scheduled before
// it, and an unsettled release moves to recovery (it may land, or not). What
// the box can't take goes to recovery too: never sent by the mod.
async function resetForNewConversation($: EngineInterface, why: 'clear' | 'resume', sessionId: string): Promise<void> {
  let taken: Entry[] = []
  const after = await updQ($, q => {
    taken = q.items
    const recovery = q.claim === null ? q.recovery : [...q.recovery, { ...q.claim.entry, token: q.claim.token, maybeSent: true as const }]
    return { ...q, epoch: q.epoch + 1, runningTurn: null, items: [], claim: null, paused: false, recovery }
  })
  // This session's state is gone once the new one starts; carry what matters.
  carry = { from: sessionId, value: after }
  scheduleAdoption($, 0)
  if (taken.length === 0) return
  const label = why === 'clear' ? '/clear' : 'Resume'
  if (await handBack($, taken.map(m => m.text))) {
    toast($, `${label}: ${taken.length} queued prompt(s) moved back to the prompt box`)
    return
  }
  const kept = taken
  const withKept = (q: Queue): Queue => mergeCarry(q, { ...EMPTY, recovery: kept })
  // Into both: the carry (this session's state is going) and the state (in
  // case it isn't, as when the engine keeps it). mergeCarry keeps each once.
  if (carry !== null && carry.from === sessionId) carry = { from: sessionId, value: withKept(carry.value) }
  await update($, queue, withKept)
  toast($, `${label}: could not reach the prompt box; kept ${kept.length} queued prompt(s) under "Not sent" (/queue lists them)`)
}

async function takeBackRecovery($: EngineInterface): Promise<void> {
  const { recovery } = await getQ($)
  if (recovery.length === 0) return
  if (!(await handBack($, recovery.map(m => m.text)))) {
    toast($, 'Could not reach the prompt box; kept them under "Not sent"')
    return
  }
  const seqs = new Set(recovery.map(m => m.seq))
  await updQ($, q => ({ ...q, recovery: q.recovery.filter(m => !seqs.has(m.seq)) }))
}

async function dropRecovery($: EngineInterface): Promise<void> {
  await updQ($, q => ({ ...q, recovery: [] }))
}

export const register: Register = (on, options) => {
  const deferAll = options.defer_all_mid_turn === true

  on('session.start', async ($, e, next) => {
    await adoptOnLoad($)
    await $.command.register({
      name: 'queue',
      description: 'Queue a prompt (or a numbered list, one per item) for after Claude finishes the turn; alone, usage and the queue',
      argumentHint: '[prompt]',
      immediate: true,
    })
    await $.command.register({
      name: 'defer',
      description: 'Same as /queue',
      argumentHint: '[prompt]',
      immediate: true,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'defer-queue') {
      return (await admitOwnRelease($, e.text)) ? next(e) : { drop: STALE_RELEASE }
    }
    if (!isPersons(e.origin) || isCommandLike(e.text)) return next(e)
    const isMidTurn = e.turnId !== undefined
    const body = parseQueueShorthand(e.text)
    // Without the shorthand, only a mid-turn prompt marked to wait is held,
    // as one entry.
    if (body === undefined && (!isMidTurn || !(e.wait || deferAll))) return next(e)
    if (e.attachments !== undefined && e.attachments.length > 0) {
      toast($, 'prompts with attachments are not queued (a resend would lose them); this one goes through now')
      return next(e)
    }
    if (body === undefined) return held(await queueEntries($, [e.text], e.turnId))
    const entries = splitQueuedMessages(body)
    if (entries.length === 0) return { drop: USAGE }
    if (entries.some(isCommandLike)) return { drop: CANT_QUEUE_COMMAND }
    if (!isMidTurn) {
      const q = await getQ($)
      const [first, ...rest] = entries
      if (first !== undefined && q.runningTurn === null && q.items.length === 0 && q.claim === null && !q.paused) {
        // Nothing waits: the first entry goes through as the person's own
        // prompt (keeping @-mentions and hook context); the rest wait for it.
        const result = await next({ ...e, text: first })
        if (result.drop === undefined && rest.length > 0) await hold($, rest)
        return result
      }
    }
    return held(await queueEntries($, entries, e.turnId))
  }).catch(($, e, next) => next(e)) // Fails open: a prompt the queue couldn't take goes to the turn, never lost.

  on('turn.start', async ($, e, next) => {
    // Subagent and teammate runs raise turn.start too; only the main loop counts.
    if (e.agentId === undefined) await updQ($, q => ({ ...q, runningTurn: e.turnId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Only the end of the tracked main turn counts, and only once: a late
      // end of an older turn, or a repeat, must not mark a newer one idle or
      // release another prompt.
      let isOurs = false
      await updQ($, q => {
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
    if (e.reason === 'clear' || e.reason === 'resume') await resetForNewConversation($, e.reason, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e) => runQueue($, e.args))
  on('command.run', { command: 'defer' }, async ($, e) => runQueue($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    // A render may not write state, so a pending /clear carry is shown merged.
    const stored = await read($, queue)
    const q = carry === null ? stored : mergeCarry(stored, carry.value)
    const list = q.items
    const kept = q.recovery
    if (list.length === 0 && kept.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = list.slice(0, BAND_ROWS)
    const keptShown = kept.slice(0, BAND_ROWS)
    const status = q.paused
      ? 'and paused: press Send next to resume'
      : e.props.isWorking
        ? 'until this turn finishes'
        : 'until the next turn finishes'

    return (
      <Box flexDirection="column">
        {list.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>
              Queued {status} ({list.length}):
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
        )}
        {kept.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Not sent, kept for you ({kept.length}):</Text>
            {keptShown.map(m => (
              <Text wrap="truncate-end">
                - {firstLine(m.text)}
                {m.maybeSent === true ? ' (may already have been sent)' : ''}
              </Text>
            ))}
            {kept.length > keptShown.length && <Text dimColor>…and {kept.length - keptShown.length} more</Text>}
            <Box flexDirection="row" gap={1}>
              <Button key="recovery-take" label="Put back in prompt box" onPress={() => takeBackRecovery($)} />
              <Button key="recovery-drop" label="Drop" onPress={() => dropRecovery($)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
