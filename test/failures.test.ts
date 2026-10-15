/** Tests for the failure recorder. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FailureStreak, describe, num, str } from '../src/host/failures.ts'

test('describe counts messages, tool calls and characters', () => {
  const shape = describe([
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a' }, { type: 'tool-call', toolCallId: 'b' }] },
    { role: 'tool', content: [{ type: 'tool-result', text: 'xyz' }] },
  ])
  assert.equal(shape.messages, 3)
  assert.equal(shape.toolCalls, 2)
  assert.equal(shape.characters, 'hello there'.length + 'xyz'.length)
})

test('describe survives whatever it is handed', () => {
  assert.equal(describe(undefined).messages, 0)
  assert.equal(describe({}).messages, 0)
  assert.equal(describe([null, 1, 'x']).messages, 3, 'counts what it cannot inspect')
})

test('field readers refuse the wrong shape instead of coercing it', () => {
  assert.equal(num(3), 3)
  assert.equal(num('3'), null, 'a numeric string is not a number')
  assert.equal(num(NaN), null)
  assert.equal(str('x'), 'x')
  assert.equal(str(''), null, 'an empty string is not a value')
  assert.equal(str(7), null)
})

test('a repeated code builds a streak, a different code starts over', () => {
  const s = new FailureStreak()
  assert.equal(s.note('STREAM_CLOSED'), 1)
  assert.equal(s.note('STREAM_CLOSED'), 2)
  assert.equal(s.note('TIMEOUT'), 1, 'a different failure is a different question')
})

test('the streak separates deterministic from transient', () => {
  const s = new FailureStreak()
  s.note('STREAM_CLOSED')
  assert.equal(s.looksDeterministic(2), false, 'one failure proves nothing')
  s.note('STREAM_CLOSED')
  assert.equal(s.looksDeterministic(2), true, 'two identical failures is the signal')
  s.reset()
  assert.equal(s.looksDeterministic(2), false, 'a success clears it')
})
