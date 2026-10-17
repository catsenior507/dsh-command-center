/** Tests for the registry adapter. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptRegistry } from '../src/host/registry.ts'

const T0 = 1_700_000_000_000

/** One running job, shaped like the fields the watcher reads. */
function job(over: Record<string, unknown> = {}) {
  return { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: T0, ...over }
}

test('lists every job the registry returns, in one call', () => {
  let calls = 0
  const view = adaptRegistry({
    list: () => { calls += 1; return [job()] },
  })
  assert.equal(view.list().length, 1)
  assert.equal(calls, 1, 'one unfenced call, not one per agent')
})

test('a list that throws yields an empty board, not an exception', () => {
  const view = adaptRegistry({
    list: () => { throw new Error('registry exploded') },
  })
  // The watcher polls this on a timer: throwing here would take down the
  // interval and leave the panel frozen at whatever it last showed.
  assert.deepEqual(view.list(), [])
})
