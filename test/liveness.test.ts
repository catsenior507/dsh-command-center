/**
 * Tests for the liveness engine.
 *
 * The engine is pure and takes `now` as an argument, so every case here is a
 * fixed instant rather than a race. The cases that matter most are the ones
 * asserting what it will NOT claim: a silent compile is not stalled, and a task
 * with no comparable history is never called stuck.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess, DurationHistory, human, percentile, silenceAllowance, type TaskFacts } from '../src/host/liveness.ts'

const T0 = 1_700_000_000_000

function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    id: 'j1',
    label: 'python train.py',
    status: 'running',
    startedAt: T0,
    lastOutputAt: T0,
    historyKey: 'python',
    ...over,
  }
}

function historyOf(durations: number[], key = 'python'): DurationHistory {
  const h = new DurationHistory()
  for (const d of durations) h.record(key, d)
  return h
}

test('percentile uses nearest rank', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(sorted, 0.5), 5)
  assert.equal(percentile(sorted, 0.9), 9)
  assert.equal(percentile([], 0.5), 0)
})

test('baseline is withheld below the sample floor', () => {
  const h = historyOf([1000, 2000])
  assert.equal(h.baseline('python'), null, 'two samples is not a distribution')
  h.record('python', 3000)
  assert.deepEqual(h.baseline('python'), { samples: 3, p50: 2000, p90: 3000 })
  assert.equal(h.baseline(null), null, 'no key means no baseline')
  assert.equal(h.baseline('never-seen'), null)
})

test('the history window drops the oldest observations', () => {
  const h = new DurationHistory(3)
  for (const d of [10, 20, 30, 40, 50]) h.record('k', d)
  // Kept are [30, 40, 50]; nearest-rank p50 over three samples is the middle one.
  assert.deepEqual(h.baseline('k'), { samples: 3, p50: 40, p90: 50 })
})

test('a silent compile is slow, not stalled', () => {
  // Comparable work takes about a minute. Ninety seconds of silence is normal
  // for a build and must not be reported as a hang - but it HAS overrun the
  // usual time, so it is slow rather than merely quiet.
  const h = historyOf([60_000, 61_000, 59_000])
  const a = assess(facts({ lastOutputAt: T0 }), h, T0 + 90_000)
  assert.notEqual(a.verdict, 'stalled')
  assert.equal(a.verdict, 'slow')
  assert.match(a.summary, /比同类任务慢/)
})

test('a quiet task is quiet once silence passes its allowance', () => {
  // Comparable work takes ~10 minutes, so the allowance is half that. Two
  // minutes of silence is still live; past five minutes it is quiet, and it
  // stays quiet rather than slow because it has not yet overrun the p90.
  const h = historyOf([600_000, 610_000, 590_000])
  assert.equal(assess(facts({ lastOutputAt: T0 }), h, T0 + 120_000).verdict, 'live')
  const a = assess(facts({ lastOutputAt: T0 }), h, T0 + 400_000)
  assert.equal(a.verdict, 'quiet')
  assert.match(a.summary, /没有输出/)
})

test('recent output is live', () => {
  const h = historyOf([60_000, 61_000, 59_000])
  const a = assess(facts({ lastOutputAt: T0 + 80_000 }), h, T0 + 85_000)
  assert.equal(a.verdict, 'live')
  assert.match(a.summary, /运行中/)
})

test('still talking past the p90 stays live, and says it overran', () => {
  // The reader's question is liveness. A task producing output is alive, so
  // overrunning the usual time is reported alongside that, not instead of it.
  const h = historyOf([10_000, 10_000, 10_000])
  const a = assess(facts({ lastOutputAt: T0 + 29_000 }), h, T0 + 30_000)
  assert.equal(a.verdict, 'live')
  assert.match(a.summary, /仍在输出/)
  assert.match(a.summary, /超过上限/)
})

test('long silence AND well past the p90 is stalled', () => {
  const h = historyOf([10_000, 10_000, 10_000])
  // allowance is max(20s, p50/2) = 20s; stalled needs >60s silent and >20s elapsed.
  const a = assess(facts({ lastOutputAt: T0 }), h, T0 + 90_000)
  assert.equal(a.verdict, 'stalled')
  assert.match(a.summary, /很可能卡住/)
})

test('no observation means no verdict about liveness at all', () => {
  // `live` is a claim that output is being produced. Without a read of the
  // output there is no basis for it, and saying it anyway is how the panel came
  // to announce a silence it had never measured.
  const h = historyOf([10_000, 10_000, 10_000])
  const a = assess(facts({ lastOutputAt: null }), h, T0 + 5_000)
  assert.equal(a.verdict, 'unknown')
  assert.equal(a.silenceMs, null)
  assert.match(a.summary, /未采集输出/)
})

test('without comparable history nothing is ever called stuck', () => {
  // The whole point of the baseline is to avoid guessing. With no history the
  // engine may say a task is quiet; it may not say it has hung.
  const empty = new DurationHistory()
  for (const minutes of [1, 30, 600]) {
    const a = assess(facts({ lastOutputAt: T0 }), empty, T0 + minutes * 60_000)
    assert.notEqual(a.verdict, 'stalled', 'claimed a hang with no evidence at ' + minutes + 'm')
    assert.equal(a.progress, null, 'progress without a baseline is a guess')
    assert.match(a.summary, /没有可比较的历史/)
  }
})

test('silence allowance scales with the work', () => {
  assert.equal(silenceAllowance(null), 20_000, 'no baseline is not a licence to stay silent')
  assert.equal(silenceAllowance({ samples: 3, p50: 600_000, p90: 700_000 }), 300_000)
  assert.equal(silenceAllowance({ samples: 3, p50: 1_000, p90: 2_000 }), 20_000, 'never below the floor')
})

test('progress never reaches one while the task is running', () => {
  const h = historyOf([10_000, 10_000, 10_000])
  const a = assess(facts(), h, T0 + 10_000_000)
  assert.ok(a.progress !== null && a.progress <= 0.95, 'a running task is never 100% done')
})

test('a finished task reports done and full progress', () => {
  const h = historyOf([10_000, 10_000, 10_000])
  for (const status of ['completed', 'failed', 'killed'] as const) {
    const a = assess(facts({ status }), h, T0 + 12_000)
    assert.equal(a.verdict, 'done')
    assert.equal(a.progress, 1)
  }
  assert.match(assess(facts({ status: 'failed' }), h, T0 + 1).summary, /已失败/)
  assert.match(assess(facts({ status: 'killed' }), h, T0 + 1).summary, /已停止/)
})

test('human formats durations compactly', () => {
  assert.equal(human(8_000), '8s')
  assert.equal(human(60_000), '1m')
  assert.equal(human(200_000), '3m20s')
  assert.equal(human(3_840_000), '1h04m')
  assert.equal(human(-5), '0s')
})

test('the window drops an old outlier so it cannot hold a verdict hostage', () => {
  const h = new DurationHistory(3)
  h.record('k', 300_000) // one five-minute run, long ago
  for (const d of [5_000, 5_000, 5_000]) h.record('k', d)
  // Only the three recent runs remain, so the baseline is seconds, not minutes.
  assert.deepEqual(h.baseline('k'), { samples: 3, p50: 5_000, p90: 5_000 })
  // With that baseline, ninety silent seconds is past double the p90 and is
  // reported as stalled. Had the five-minute run still counted, it would not be.
  const a = assess(facts({ historyKey: 'k', lastOutputAt: T0 }), h, T0 + 90_000)
  assert.equal(a.verdict, 'stalled')
})

test('one sample is not a distribution', () => {
  const thin = new DurationHistory()
  thin.record('k', 5_000)
  assert.equal(thin.baseline('k'), null)
  // Without a baseline the engine may note the silence; it may not call a hang.
  assert.equal(assess(facts({ historyKey: 'k', lastOutputAt: T0 }), thin, T0 + 600_000).verdict, 'quiet')
})
