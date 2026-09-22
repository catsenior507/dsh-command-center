/** Tests for the opt-in activity sampler. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleActivity } from '../src/host/registry.ts'

const T0 = 1_700_000_000_000

/** A watcher stub recording what it was told. */
function watcher(rows: { id: string; status: string }[]) {
  const noted: string[] = []
  return {
    rows: () => rows,
    noteActivity: (id: string) => { noted.push(id) },
    noted,
  }
}

test('a non-empty delta counts as activity', () => {
  const jobs = { list: () => [], read: () => ({ text: 'TICK' }), onJobsChanged: () => () => {} }
  const w = watcher([{ id: 'j1', status: 'running' }])
  assert.equal(sampleActivity(jobs, { list: () => [] }, w, () => T0), 1)
  assert.deepEqual(w.noted, ['j1'])
})

test('an empty delta is not activity', () => {
  const jobs = { list: () => [], read: () => ({ text: '' }), onJobsChanged: () => () => {} }
  const w = watcher([{ id: 'j1', status: 'running' }])
  assert.equal(sampleActivity(jobs, { list: () => [] }, w, () => T0), 0)
  assert.deepEqual(w.noted, [], 'a silent job must not look like a talking one')
})

test('a caller that cannot read is skipped for the next', () => {
  const agent = { id: 'a' }
  const jobs = {
    list: () => [],
    read: (_id: string, caller?: unknown) => {
      if (caller === undefined) throw new Error('fenced')
      return { text: 'TICK' }
    },
    onJobsChanged: () => () => {},
  }
  const w = watcher([{ id: 'j1', status: 'running' }])
  assert.equal(sampleActivity(jobs, { list: () => [agent] }, w, () => T0), 1)
})

test('a read that always throws does not stop the sweep', () => {
  const jobs = {
    list: () => [],
    read: () => { throw new Error('nope') },
    onJobsChanged: () => () => {},
  }
  const w = watcher([{ id: 'j1', status: 'running' }, { id: 'j2', status: 'running' }])
  assert.equal(sampleActivity(jobs, { list: () => [] }, w, () => T0), 0)
})

test('finished jobs are not sampled', () => {
  let reads = 0
  const jobs = {
    list: () => [],
    read: () => { reads += 1; return { text: 'TICK' } },
    onJobsChanged: () => () => {},
  }
  const w = watcher([{ id: 'j1', status: 'completed' }])
  assert.equal(sampleActivity(jobs, { list: () => [] }, w, () => T0), 0)
  assert.equal(reads, 0, 'reading a finished job would consume output nobody asked to lose')
})

test('a registry with no read method is left alone', () => {
  const w = watcher([{ id: 'j1', status: 'running' }])
  assert.equal(sampleActivity({ list: () => [], onJobsChanged: () => () => {} }, { list: () => [] }, w), 0)
})
