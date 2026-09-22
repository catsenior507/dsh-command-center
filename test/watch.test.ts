/** Tests for the job watcher, against a fake registry. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DurationHistory } from '../src/host/liveness.ts'
import { historyKey, TaskWatch, type JobView } from '../src/host/watch.ts'

const T0 = 1_700_000_000_000

/** A registry whose contents the test drives directly. */
function fakeRegistry(initial: JobView[]) {
  let jobs = initial
  const listeners = new Set<() => void>()
  return {
    list: () => jobs,
    onJobsChanged: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next: JobView[]) {
      jobs = next
      for (const fn of listeners) fn()
    },
    listenerCount: () => listeners.size,
  }
}

function job(over: Partial<JobView> = {}): JobView {
  return { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: T0, ...over }
}

test('start subscribes once and is idempotent', () => {
  const reg = fakeRegistry([job()])
  const w = new TaskWatch(reg, { now: () => T0 })
  const off = w.start()
  assert.equal(reg.listenerCount(), 1)
  w.start()
  assert.equal(reg.listenerCount(), 1, 'a second start must not double-subscribe')
  off()
  assert.equal(reg.listenerCount(), 0)
})

test('a job that just spoke is live', () => {
  const reg = fakeRegistry([job()])
  let now = T0 + 5_000
  const w = new TaskWatch(reg, { now: () => now })
  w.start()
  w.noteActivity('bash-1', T0 + 4_000)
  assert.equal(w.rows()[0].verdict, 'live')
})

test('with no observed output the watcher reports no silence at all', () => {
  // Regression: rows() used to fall back to startedAt for lastOutputAt, so a
  // changed-only watcher - which never reads output - announced "no output for
  // 90s" on the strength of the elapsed time alone. That is a claim it has no
  // evidence for, and the panel printed it as fact.
  const reg = fakeRegistry([job()])
  const now = T0 + 90_000
  const w = new TaskWatch(reg, { now: () => now })
  w.start()
  assert.equal(w.rows()[0].observedSilenceMs, null, 'nobody has observed output yet')
  const row = w.rows()[0]
  assert.equal(row.silenceMs, null, 'silence must stay unmeasured, not become the elapsed time')
  assert.equal(row.verdict, 'unknown', 'live means producing output, which was never observed')
  assert.notEqual(row.verdict, 'quiet', 'quiet means silent, and silence was never observed')
  assert.notEqual(row.verdict, 'stalled')
  assert.match(row.summary, /未采集输出/, 'the summary must say why it cannot judge')
})

test('once activity is observed, silence is measured from it', () => {
  const reg = fakeRegistry([job()])
  let now = T0 + 5_000
  const w = new TaskWatch(reg, { now: () => now })
  w.start()
  w.noteActivity('bash-1', T0 + 4_000)
  assert.equal(w.rows()[0].observedSilenceMs, 1_000)
  now = T0 + 90_000
  assert.equal(w.rows()[0].observedSilenceMs, 86_000, 'measured silence follows the observation')
  assert.equal(w.rows()[0].verdict, 'quiet', 'and then quiet is a claim with evidence behind it')
})

test('comparable past runs produce a baseline and a progress estimate', () => {
  const h = new DurationHistory()
  const w = new TaskWatch(fakeRegistry([]), { now: () => T0, history: h })
  for (const d of [10_000, 12_000, 11_000]) h.record('bash|pytest', d)
  const reg = fakeRegistry([job()])
  const w2 = new TaskWatch(reg, { now: () => T0 + 6_000, history: h })
  w2.start()
  w2.noteActivity('bash-1', T0 + 5_500)
  const row = w2.rows()[0]
  assert.equal(row.verdict, 'live')
  assert.ok(row.progress !== null && row.progress > 0.4 && row.progress < 0.6)
  assert.equal(row.baseline?.samples, 3)
  void w
})

test('a finished job is folded into history exactly once', () => {
  const h = new DurationHistory()
  const reg = fakeRegistry([job({ status: 'completed', finishedAt: T0 + 7_000 })])
  const w = new TaskWatch(reg, { now: () => T0 + 8_000, history: h })
  w.start()
  w.reconcile()
  w.reconcile()
  assert.deepEqual(h.baseline('bash|pytest', 1)?.samples, 1, 'recorded twice would give two samples')
})

test('the history key groups work by command head, not by exact command', () => {
  assert.equal(historyKey(job({ label: 'pytest tests/a -q' })), historyKey(job({ label: 'pytest tests/b -q' })))
  assert.notEqual(historyKey(job({ label: 'pytest -q' })), historyKey(job({ label: 'python train.py' })))
  assert.equal(historyKey(job({ kind: 'subagent', label: '   ' })), 'subagent|subagent')
})

test('rows follow the registry as it changes', () => {
  const reg = fakeRegistry([job()])
  const w = new TaskWatch(reg, { now: () => T0 + 1_000 })
  w.start()
  assert.equal(w.rows().length, 1)
  reg.set([job(), job({ id: 'bash-2', label: 'python train.py' })])
  assert.equal(w.rows().length, 2)
  assert.equal(w.rows()[1].kind, 'bash')
})
