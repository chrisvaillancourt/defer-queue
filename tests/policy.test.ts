import { describe, expect, test } from 'claude-code/testing'

import { joinForBox, parseQueueShorthand, splitQueuedMessages } from '../hooks/policy'

describe('the -> and => shorthand', () => {
  test('takes the body after either prefix', () => {
    expect(parseQueueShorthand('-> then run the tests')).toBe('then run the tests')
    expect(parseQueueShorthand('=>review')).toBe('review')
    expect(parseQueueShorthand('  -> leading space')).toBe('leading space')
    expect(parseQueueShorthand('->')).toBe('')
  })

  test('ignores an arrow anywhere but the start', () => {
    expect(parseQueueShorthand('a -> b')).toBeUndefined()
    expect(parseQueueShorthand('plain prompt')).toBeUndefined()
  })
})

describe('splitting a queued list', () => {
  test('splits numbered, Roman-numeral and lettered sequences', () => {
    expect(splitQueuedMessages('1. a\n2. b\n3. c')).toEqual(['a', 'b', 'c'])
    expect(splitQueuedMessages('i. a\nii. b\niii. c')).toEqual(['a', 'b', 'c'])
    expect(splitQueuedMessages('IV) a\nV) b')).toEqual(['a', 'b'])
    expect(splitQueuedMessages('a) x\nb) y')).toEqual(['x', 'y'])
    expect(splitQueuedMessages('A. x\nB. y')).toEqual(['x', 'y'])
  })

  test('keeps lines under an item with it', () => {
    expect(splitQueuedMessages('1. a\n   more about a\n- note\n2. b')).toEqual(['a\n   more about a\n- note', 'b'])
    expect(splitQueuedMessages('1. a\n  1. nested\n  2. nested\n2. b')).toEqual(['a\n  1. nested\n  2. nested', 'b'])
  })

  test('keeps a gap, mixed punctuation, mixed case or one item as one prompt', () => {
    expect(splitQueuedMessages('1. a\n3. b')).toEqual(['1. a\n3. b'])
    expect(splitQueuedMessages('1. a\n2) b')).toEqual(['1. a\n2) b'])
    expect(splitQueuedMessages('a. x\nB. y')).toEqual(['a. x\nB. y'])
    expect(splitQueuedMessages('1. only one')).toEqual(['1. only one'])
    expect(splitQueuedMessages('no list here\n1. a\n2. b')).toEqual(['no list here\n1. a\n2. b'])
  })

  test('keeps a list with an empty item inside it as one prompt', () => {
    expect(splitQueuedMessages('1. a\n2.\n3. c')).toEqual(['1. a\n2.\n3. c'])
  })

  test('drops an unfinished trailing item', () => {
    expect(splitQueuedMessages('1. a\n2. b\n3.')).toEqual(['a', 'b'])
  })

  test('gives nothing for empty text', () => {
    expect(splitQueuedMessages('   \n ')).toEqual([])
  })
})

describe('the prompt box text', () => {
  test('joins entries and the draft with blank lines, skipping an empty draft', () => {
    expect(joinForBox(['a', 'b'], 'draft')).toBe('a\n\nb\n\ndraft')
    expect(joinForBox(['a'], '')).toBe('a')
  })
})
