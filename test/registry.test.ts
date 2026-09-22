/** Tests for the cross-agent registry view. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unionRegistry, type JobsLike } from '../src/host/registry.ts'
import type { JobView } from '../src/host/watch.ts'

const T0 = 1_700_000_000_000
function job(id: string): JobView {
  return { id, kind: 'pwsh', label: 'python x.py', status: 'running', startedAt: T0 }
}

/** A registry that answers differently per caller, like the real fenced one. */
function fenced(byCaller: Map<unknown, JobView[]>) {
  return {
    list: (caller?: unknown) => byCaller.get(caller) ?? [],
    onJobsChanged: () => () => {},
  } as JobsLike
}

test('jobs owned by several agents are all visible', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const jobs = fenced(new Map<unknown, JobView[]>([[a, [job('pwsh-1')]], [b, [job('pwsh-2')]]]))
  const view = unionRegistry(jobs, { list: () => [a, b] })
  assert.deepEqual(view.list().map((j) => j.id).sort(), ['pwsh-1', 'pwsh-2'])
})

test('a job visible through two callers is listed once', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const jobs = fenced(new Map<unknown, JobView[]>([[a, [job('pwsh-1')]], [b, [job('pwsh-1')]]]))
  const view = unionRegistry(jobs, { list: () => [a, b] })
  assert.equal(view.list().length, 1, 'a duplicated row would look like two jobs')
})

test('the callerless read is still included, for unowned jobs', () => {
  const jobs = fenced(new Map<unknown, JobView[]>([[undefined, [job('bash-9')]]]))
  const view = unionRegistry(jobs, { list: () => [] })
  assert.deepEqual(view.list().map((j) => j.id), ['bash-9'])
})

test('a caller that throws does not blind the panel to the others', () => {
  const bad = { id: 'bad' }
  const good = { id: 'good' }
  const jobs = {
    list: (caller?: unknown) => {
      if (caller === bad) throw new Error('gone')
      return caller === good ? [job('pwsh-3')] : []
    },
    onJobsChanged: () => () => {},
  } as JobsLike
  const view = unionRegistry(jobs, { list: () => [bad, good] })
  assert.deepEqual(view.list().map((j) => j.id), ['pwsh-3'])
})

test('no agents and no unowned jobs is an empty list, not an error', () => {
  const view = unionRegistry(fenced(new Map()), { list: () => [] })
  assert.deepEqual(view.list(), [])
})
