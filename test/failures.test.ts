/** Tests for the failure recorder. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FailureStreak, describe } from '../src/host/failures.ts'

test('describe counts messages, tool calls and characters', () => {
  const shape = describe([
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a' }, { type: 'tool-call', toolCallId: 'b' }] },
    { role: 'tool', content: [{ type: 'tool-result', text: 'xyz' }] },
  ])
  assert.equal(shape.messages, 3)
  assert.equal(shape.toolCalls, 2)
  assert.equal(shape.characters, 'hello there'.length + 'xyz'.length)
  assert.equal(shape.tailKinds.length, 3, 'keeps the tail, not everything')
})

test('describe survives whatever it is handed', () => {
  assert.equal(describe(undefined).messages, 0)
  assert.equal(describe({}).messages, 0)
  assert.equal(describe([null, 1, 'x']).messages, 3, 'counts what it cannot inspect')
})

test('a repeated code builds a streak, a different code starts over', () => {
  const s = new FailureStreak()
  assert.equal(s.note('STREAM_CLOSED'), 1)
  assert.equal(s.note('STREAM_CLOSED'), 2)
  assert.equal(s.note('STREAM_CLOSED'), 3)
  assert.equal(s.note('TIMEOUT'), 1, 'a different failure is a different question')
  assert.equal(s.note('TIMEOUT'), 2)
})

test('the streak is what separates deterministic from transient', () => {
  const s = new FailureStreak()
  s.note('STREAM_CLOSED')
  assert.equal(s.looksDeterministic(2), false, 'one failure proves nothing')
  s.note('STREAM_CLOSED')
  assert.equal(s.looksDeterministic(2), true, 'two identical failures is the signal')
  s.reset()
  assert.equal(s.looksDeterministic(2), false, 'a success clears it')
})
