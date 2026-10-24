/** A prompt waiting for the main turn to end. `seq` orders entries oldest first. */
export type Entry = { seq: number; text: string }

/** The entry a release took off the queue, until its submit settles; `epoch` is the queue's when it was taken. */
export type Claim = { entry: Entry; token: string; epoch: number }

/**
 * An entry the mod will never send on its own: one handed back from before a
 * `/clear` the prompt box couldn't take, or a release a reload left unsettled
 * (`maybeSent`). The person takes it back or discards it.
 */
export type RecoveryEntry = Entry & { token?: string; maybeSent?: true }

/** The whole queue, one record so every decision reads one moment. */
export type Queue = {
  /** Bumped by /clear and a resume: work begun before it can't touch the new queue. */
  epoch: number
  nextSeq: number
  /** The main-loop turn running now, by id; null while the main loop is idle. */
  runningTurn: string | null
  /** Waiting entries, oldest first. */
  items: Entry[]
  claim: Claim | null
  /** No automatic release until the person sends or takes back. */
  paused: boolean
  recovery: RecoveryEntry[]
}

/** The 0.1 entry shape, read once to carry a held queue across the upgrade. */
export type DeferredPrompt = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'defer-queue': {
      queue: Shaped<Queue>
      /** 0.1 keys, read once and emptied on session.start. */
      held: DeferredPrompt[]
      runningTurn: string | null
    }
  }
}
