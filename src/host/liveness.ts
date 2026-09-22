/**
 * Liveness analysis for running work.
 *
 * The question this answers is not "how far along is it" - almost nothing here
 * can report that honestly. It is "is it still working, or has it hung", which
 * is what a person actually needs when a command has produced no output for ten
 * minutes and they are deciding whether to keep waiting.
 *
 * Two signals, both measurable rather than guessed:
 *
 *   silence  - how long since the task last produced anything at all
 *   history  - how long comparable work usually takes, from past observations
 *
 * A verdict is deliberately conservative. "Stalled" requires both a long
 * silence AND having already run well past what comparable work takes, because
 * either signal alone is normal: a compile is silent for minutes while working,
 * and a fast task can be slow once without being stuck.
 *
 * @module dsh-command-center/host/liveness
 */

/** Status of the observed task. Mirrors the job registry vocabulary. */
export type TaskStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** What the panel tells the user about one task. */
/**
 * What the panel can honestly say about a task.
 *
 * `unknown` exists because `live` means "it is producing output", and a watcher
 * that does not read output has not observed that. Reporting `live` on the
 * strength of elapsed time alone is the same mistake as reporting `quiet` on it:
 * a conclusion the evidence does not support. The word has to match what was
 * actually measured.
 */
export type Verdict = 'unknown' | 'live' | 'quiet' | 'slow' | 'stalled' | 'done'

/** One past observation of comparable work, in milliseconds. */
export interface Observation {
  /** Stable key for "comparable work": a tool name, a command head, a job kind. */
  key: string
  /** How long that run took, wall clock. */
  durationMs: number
}

/** The live facts about one task, supplied by whatever is watching it. */
export interface TaskFacts {
  id: string
  label: string
  status: TaskStatus
  startedAt: number
  /**
   * Last instant the task was OBSERVED to produce output.
   *
   * Null means nobody has observed any, which is not the same as "it produced
   * none": a watcher that does not read output cannot tell the difference, and
   * treating the two as equal makes the panel report elapsed time as if it were
   * silence. That is a claim it has no evidence for.
   */
  lastOutputAt: number | null
  /** Key into the observation history, or null when nothing comparable is known. */
  historyKey: string | null
}

/** A percentile summary of comparable past runs. */
export interface Baseline {
  samples: number
  p50: number
  p90: number
}

/** The rendered judgement about one task. */
export interface Assessment {
  verdict: Verdict
  /** Milliseconds since the task started. */
  elapsedMs: number
  /** Milliseconds since output was last observed, or null when none was. */
  silenceMs: number | null
  /** Baseline from history, or null when there is nothing comparable. */
  baseline: Baseline | null
  /** 0..1 progress estimate, or null when no baseline exists. Never 1 while running. */
  progress: number | null
  /** One sentence for the panel. */
  summary: string
}

/** Rolling history of how long comparable work takes. */
export class DurationHistory {
  private readonly byKey = new Map<string, number[]>()
  private readonly limit: number

  /**
   * @param limit - how many recent observations to keep per key.
   *
   * Written as a field and an assignment rather than a constructor parameter
   * property: a parameter property is TypeScript that emits code, and the
   * runtime executes these files by stripping types, which cannot express it.
   */
  constructor(limit = 50) {
    this.limit = limit
  }

  /** Record one completed run. */
  record(key: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return
    const rows = this.byKey.get(key) ?? []
    rows.push(durationMs)
    // Keep the most recent window: tooling changes, and an old outlier should
    // not hold a verdict hostage forever.
    if (rows.length > this.limit) rows.splice(0, rows.length - this.limit)
    this.byKey.set(key, rows)
  }

  /** Percentile summary, or null below the sample floor. */
  baseline(key: string | null, minSamples = 3): Baseline | null {
    if (key === null) return null
    const rows = this.byKey.get(key)
    if (rows === undefined || rows.length < minSamples) return null
    const sorted = [...rows].sort((a, b) => a - b)
    return { samples: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) }
  }

  /** Every key with enough samples to be useful. */
  keys(): string[] {
    return [...this.byKey.keys()]
  }
}

/** Nearest-rank percentile over an already sorted array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}

/**
 * How long a task may stay silent before silence itself means something.
 *
 * Scaled to the work: a 2-second task going quiet for 30 seconds is already
 * interesting, while a 10-minute build being quiet for 30 seconds is not.
 */
export function silenceAllowance(baseline: Baseline | null): number {
  // Without a baseline the allowance is still modest. It would be easy to fall
  // back to something large so that "quiet" never fires, but that would report
  // "live" for a task that stopped speaking forty seconds ago - and live means
  // it is producing output. Saying "running, nothing said yet, and I cannot
  // judge whether that is normal" is the honest report; claiming it is alive is
  // not. Only the "stalled" verdict requires a baseline.
  if (baseline === null) return 20_000
  return Math.max(20_000, baseline.p50 * 0.5)
}

/**
 * Judge one task.
 * @param facts - the live facts about the task.
 * @param history - comparable past runs.
 * @param now - current instant, injected so the result is testable.
 * @returns the assessment the panel renders.
 */
export function assess(facts: TaskFacts, history: DurationHistory, now: number): Assessment {
  const elapsedMs = Math.max(0, now - facts.startedAt)
  const silenceMs = facts.lastOutputAt === null ? null : Math.max(0, now - facts.lastOutputAt)
  const baseline = history.baseline(facts.historyKey)

  if (facts.status !== 'running' && facts.status !== 'stopping') {
    return {
      verdict: 'done',
      elapsedMs,
      silenceMs,
      baseline,
      progress: 1,
      summary: STATUS_WORDS[facts.status] + '，用时 ' + human(elapsedMs),
    }
  }

  const allowance = silenceAllowance(baseline)
  const progress = baseline === null ? null : Math.min(0.95, elapsedMs / Math.max(1, baseline.p90))

  // Nothing about liveness can be said without an observation. This is the
  // honest verdict for changed-only mode, and it is the reason the panel can
  // safely be looked at before read mode is trusted.
  if (facts.lastOutputAt === null) {
    return {
      verdict: 'unknown',
      elapsedMs,
      silenceMs: null,
      baseline,
      progress,
      summary: '运行中，已 ' + human(elapsedMs) + '（未采集输出，无法判断是否卡住）',
    }
  }

  // Everything below that judges SILENCE requires an observation. Unobserved
  // silence is not evidence, and a verdict built on it is a guess dressed as a
  // measurement - which is the one thing this engine exists not to do.
  const observed = silenceMs !== null

  // Stalled needs both: long silence, and already well past the p90. Either
  // alone is ordinary, and crying wolf here would make the verdict worthless.
  if (observed && silenceMs > allowance * 3 && baseline !== null && elapsedMs > baseline.p90 * 2) {
    return {
      verdict: 'stalled',
      elapsedMs,
      silenceMs,
      baseline,
      progress,
      summary: '已 ' + human(silenceMs) + ' 没有任何输出，且已超过同类任务的 ' + human(baseline.p90) + '，很可能卡住了',
    }
  }

  // Liveness is answered first and answers it fully. A task that is still
  // producing output is alive, whatever the clock says; overrunning the usual
  // time is worth saying, but it must not displace the verdict the reader is
  // actually looking for.
  if (!observed || silenceMs <= allowance) {
    const overrun = baseline !== null && elapsedMs > baseline.p90
    return {
      verdict: 'live',
      elapsedMs,
      silenceMs,
      baseline,
      progress,
      summary: baseline === null
        ? '运行中，已 ' + human(elapsedMs) + '（没有可比较的历史）'
        : '运行中，已 ' + human(elapsedMs) + '，同类通常 ' + human(baseline.p50) +
          (overrun ? '，已经超过上限 ' + human(baseline.p90) + ' 但仍在输出' : ''),
    }
  }

  if (baseline !== null && elapsedMs > baseline.p90) {
    return {
      verdict: 'slow',
      elapsedMs,
      silenceMs,
      baseline,
      progress,
      summary: '比同类任务慢：已 ' + human(elapsedMs) + '，同类通常 ' +
        human(baseline.p50) + '（上限 ' + human(baseline.p90) + '）',
    }
  }

  return {
    verdict: 'quiet',
    elapsedMs,
    silenceMs,
    baseline,
    progress,
    summary: '运行中，但已 ' + human(silenceMs) + ' 没有输出' +
      (baseline === null
        ? '，且没有可比较的历史，无法判断这算不算正常'
        : '（同类通常 ' + human(baseline.p50) + '）'),
  }
}

const STATUS_WORDS: Record<string, string> = {
  completed: '已完成',
  killed: '已停止',
  failed: '已失败',
  stopping: '正在停止',
  running: '运行中',
}

/** Compact duration: 8s, 3m20s, 1h04m. */
export function human(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? minutes + 'm' : minutes + 'm' + String(seconds).padStart(2, '0') + 's'
  const hours = Math.floor(minutes / 60)
  return hours + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}
