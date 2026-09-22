/** Tests for the pending-question observer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeQuestions, QuestionWatch } from '../src/host/questions.ts'

const T0 = 1_700_000_000_000

const request = { questions: [
  { id: 'q1', question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes' }, { label: 'No' }] },
] }

test('a request is recorded while it waits and cleared when it settles', async () => {
  const w = new QuestionWatch()
  let resolve: (v: unknown) => void = () => {}
  const downstream = new Promise((r) => { resolve = r })
  const listener = observeQuestions(w, () => T0)
  const pending = listener(request, () => downstream)
  assert.equal(w.count, 1)
  assert.equal(w.list()[0].question, 'Continue?')
  assert.deepEqual(w.list()[0].options, ['Yes', 'No'])
  assert.equal(w.list()[0].askedAt, T0)
  resolve({ answers: [{ id: 'q1', selected: ['Yes'] }] })
  await pending
  assert.equal(w.count, 0, 'an answered question must stop being pending')
})

test('the downstream answer is passed through untouched', async () => {
  const w = new QuestionWatch()
  const answer = { answers: [{ id: 'q1', selected: ['Yes'] }] }
  const listener = observeQuestions(w)
  const got = await listener(request, () => Promise.resolve(answer))
  assert.deepEqual(got, answer, 'the observer must not rewrite the answer')
})

test('a downstream throw still clears the question', async () => {
  const w = new QuestionWatch()
  const listener = observeQuestions(w)
  await assert.rejects(listener(request, () => Promise.reject(new Error('no answerer'))))
  assert.equal(w.count, 0, 'a failed question must not stay pending forever')
})

test('next is always called, so the existing UI keeps working', async () => {
  const w = new QuestionWatch()
  let called = 0
  const listener = observeQuestions(w)
  await listener(request, () => { called += 1; return Promise.resolve(null) })
  assert.equal(called, 1)
})

test('malformed payloads are ignored instead of throwing', () => {
  const w = new QuestionWatch()
  for (const bad of [null, undefined, 7, "x", {}, { questions: null }, { questions: [null] }, { questions: [{}] }, { questions: [{ id: "" }] }]) {
    assert.deepEqual(w.note(bad, T0), [])
  }
  assert.equal(w.count, 0)
})

test('options are read leniently and a header is optional', () => {
  const w = new QuestionWatch()
  w.note({ questions: [{ id: 'a', question: 'Q' }, { id: 'b', options: [{ label: 'L' }, {}, { nope: 1 }] }] }, T0)
  assert.equal(w.count, 2)
  assert.equal(w.list()[0].header, undefined)
  assert.deepEqual(w.list()[1].options, ['L'])
})

test('several questions in one request are all tracked', () => {
  const w = new QuestionWatch()
  w.note({ questions: [{ id: 'a', question: 'A' }, { id: 'b', question: 'B' }] }, T0)
  assert.equal(w.count, 2)
  w.settle(['a'])
  assert.equal(w.count, 1)
  assert.equal(w.list()[0].id, 'b')
})
