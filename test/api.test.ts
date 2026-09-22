/** Tests for the panel-facing handler. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DurationHistory } from '../src/host/liveness.ts'
import { TaskWatch, type JobView } from '../src/host/watch.ts'
import { QuestionWatch } from '../src/host/questions.ts'
import { handle, type Deps } from '../src/host/api.ts'

const T0 = 1_700_000_000_000

function deps(jobs: JobView[] = [], nowMs = T0 + 5_000): Deps {
  const reg = { list: () => jobs, onJobsChanged: () => () => {} }
  const watch = new TaskWatch(reg, { now: () => nowMs, history: new DurationHistory() })
  watch.start()
  return { watch, questions: new QuestionWatch(), observe: 'changed-only' }
}

const running: JobView = { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: T0 }

test('GET /tasks returns rows and declares what it cannot see', () => {
  const r = handle(deps([running]), 'GET', '/tasks', null)
  assert.equal(r.status, 200)
  const b = r.body as { ok: boolean; observe: string; tasks: unknown[]; needsYou: number; jobsWatched: boolean }
  assert.equal(b.ok, true)
  assert.equal(b.observe, 'changed-only', 'the panel must know silence is unmeasured')
  assert.equal(b.tasks.length, 1)
  assert.equal(b.needsYou, 0)
  assert.equal(b.jobsWatched, true)
})

test('a waiting question is what makes needsYou non-zero', () => {
  const d = deps([])
  d.questions.note({ questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }] }, T0)
  const b = handle(d, 'GET', '/state', null).body as { needsYou: number; questions: { question: string }[] }
  assert.equal(b.needsYou, 1)
  assert.equal(b.questions[0].question, 'Continue?')
})

test('with no jobs registry the panel still works and says so', () => {
  const b = handle({ watch: null, questions: new QuestionWatch(), observe: 'changed-only' }, 'GET', '/tasks', null).body as { tasks: unknown[]; jobsWatched: boolean }
  assert.deepEqual(b.tasks, [])
  assert.equal(b.jobsWatched, false)
})

test('a job with no observed activity reports null silence, not zero', () => {
  const r = handle(deps([running]), 'GET', '/tasks', null)
  const row = (r.body as { tasks: { observedSilenceMs: number | null }[] }).tasks[0]
  assert.equal(row.observedSilenceMs, null)
})

test('health says what mode it is in', () => {
  assert.equal((handle(deps([]), 'GET', '/health', null).body as { observe: string }).observe, 'changed-only')
})

test('kill refuses an empty id before it refuses the feature', () => {
  assert.equal(handle(deps([]), 'POST', '/kill', {}).status, 400)
  assert.equal(handle(deps([]), 'POST', '/kill', null).status, 400)
  assert.equal(handle(deps([]), 'POST', '/kill', { id: 'bash-1' }).status, 501)
})

test('the handler reads watch at request time, not at construction', () => {
  // Regression: the plugin wires `watch` as a getter because the jobs service
  // is waited for. Copying the value into Deps froze null forever, and the
  // symptom was a diagnostic log saying jobs=watched while the API said
  // jobsWatched=false. A plain property here would reproduce that exactly.
  let watch: TaskWatch | null = null
  const live: Deps = { get watch() { return watch }, questions: new QuestionWatch(), observe: 'changed-only' }
  const read = () => (handle(live, 'GET', '/tasks', null).body as { jobsWatched: boolean }).jobsWatched
  assert.equal(read(), false)
  const reg = { list: () => [], onJobsChanged: () => () => {} }
  watch = new TaskWatch(reg, { now: () => T0, history: new DurationHistory() })
  watch.start()
  assert.equal(read(), true, 'a frozen copy of watch would still report false')
})

test('the mode the panel is told is the mode the watcher runs in', () => {
  // The panel decides whether it may draw a progress bar from this field, so
  // reporting a constant here would let it draw one over unmeasured silence.
  const d = deps([])
  d.observe = 'read'
  assert.equal((handle(d, 'GET', '/state', null).body as { observe: string }).observe, 'read')
  assert.equal((handle(d, 'GET', '/health', null).body as { observe: string }).observe, 'read')
})

test('unknown paths are 404', () => {
  assert.equal(handle(deps([]), 'GET', '/nope', null).status, 404)
  assert.equal(handle(deps([]), 'DELETE', '/tasks', null).status, 404)
})
