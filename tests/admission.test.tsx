// A masking plugin sits above defer-queue here (this file loads it in the
// append tier), so it rewrites a release's text before defer-queue's
// admission check sees it, as a secret-masking mod would.
import { expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

tier('append')

const masker = {
  name: 'masker',
  tier: 'prepend',
  register(on) {
    on('prompt.submit', ($, e, next) =>
      next(e.origin.kind === 'plugin' ? { ...e, text: e.text.replace('secret', '[MASKED]') } : e),
    )
  },
} as const satisfies Plugin

test('a release another plugin rewrites is admitted as the release it is, and the queue moves on', { plugins: [masker] }, async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const typed = (text: string) => ({ text, turnId: 't1', wait: true, origin: { kind: 'composer' } as const })
  const answered = (turnId: string) => ({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.prompt.submit(typed('first secret'))
  await $.prompt.submit(typed('second'))
  await $.turn.complete(answered('t1'))
  await clock.settle()
  expect(sent).toEqual(['first [MASKED]'])
  await $.turn.start({ text: 'first [MASKED]', turnId: 't2' })
  await $.turn.complete(answered('t2'))
  await clock.settle()
  expect(sent).toEqual(['first [MASKED]', 'second'])
  const listed = await $.command.run({ command: 'queue', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(listed.text).not.toMatch(/Not sent/)
})
