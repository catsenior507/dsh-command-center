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


test('the 0.2.x API is detected by get(), and the union is skipped', () => {
  // A registry shaped like dsh 0.2.x: get() exists, and list() takes a session
  // id rather than an agent.
  const calls: unknown[] = []
  const newApi = {
    get: () => ({ id: 'bash-1' }),
    list(caller?: unknown) {
      calls.push(caller)
      return [{ id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: T0 }]
    },
  }
  // If the union ran, it would call this and pollute the caller list.
  const agents = { list: () => [{ id: 'agent-a' }] }
  const view = unionRegistry(newApi as never, agents as never)
  const jobs = view.list()
  assert.equal(jobs.length, 1)
  assert.deepEqual(calls, [undefined], 'exactly one unfenced call, not one per agent')
})

test('without get(), the union still runs per agent', () => {
  const calls: unknown[] = []
  const oldApi = {
    list(caller?: unknown) {
      calls.push(caller)
      return caller === undefined
        ? []
        : [{ id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: T0 }]
    },
  }
  const agents = { list: () => [{ id: 'agent-a' }] }
  const view = unionRegistry(oldApi as never, agents as never)
  assert.equal(view.list().length, 1, 'found through the agent, not through the unfenced call')
  assert.equal(calls.length, 2, 'one unfenced plus one per agent')
})
