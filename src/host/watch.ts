/**
 * Watches background jobs and reports how alive each one looks.
 *
 * The registry is injected as a narrow interface rather than imported, so this
 * file has no dependency on the harness and can be tested against a fake.
 *
 * @module dsh-command-center/host/watch
 */
import { assess, DurationHistory, type Assessment } from './liveness.ts'

/** The slice of a job snapshot this watcher uses. */
export interface JobView {
  id: string
  kind: string
  label: string
  status: string
  startedAt: number
  finishedAt?: number
}

/**
 * The slice of the job registry this watcher uses.
 *
 * No change subscription, deliberately. dsh 0.2.x removed `onJobsChanged` from
 * `JobRegistry`, so anything that subscribes is written against exactly one
 * version. Polling `list()` works on both, and a task board that refreshes
 * every couple of seconds is indistinguishable to the person reading it.
 */
export interface RegistryLike {
  list(): JobView[]
}

/** One row the panel renders. */
export interface TaskRow extends Assessment {
  id: string
  kind: string
  label: string
  status: string
  startedAt: number
  /** Milliseconds since the last observed activity, or null when unknown. */
  observedSilenceMs: number | null
}

/** Options for {@link TaskWatch}. */
export interface WatchOptions {
  /** Clock, injected so tests are deterministic. */
  now?: () => number
  /** Shared history of how long comparable work takes. */
  history?: DurationHistory
  /** How often to re-read the registry, in milliseconds. */
  pollMs?: number
}

/**
 * Tracks live jobs and judges each one.
 *
 * It deliberately does NOT read job output. `JobRegistry.read` returns the
 * consuming delta since the previous read, so a watcher that polls it may take
 * output away from the agent's own `job_output` call. Until that is settled,
 * activity arrives through {@link noteActivity} instead, called by whatever
 * observes output without consuming it.
 */
export class TaskWatch {
  private readonly registry: RegistryLike
  private readonly now: () => number
  private readonly history: DurationHistory
  private readonly pollMs: number
  private readonly lastActivity = new Map<string, number>()
  private readonly startedAt = new Map<string, number>()
  private disposed: (() => void) | null = null

  constructor(registry: RegistryLike, options: WatchOptions = {}) {
    this.registry = registry
    this.now = options.now ?? (() => Date.now())
    this.history = options.history ?? new DurationHistory()
    this.pollMs = options.pollMs ?? 2000
  }

  /** Begin refreshing from the registry. Returns the disposer. */
  start(): () => void {
    if (this.disposed !== null) return this.disposed
    this.reconcile()
    const timer = setInterval(() => {
      try { this.reconcile() } catch { /* one bad read must not stop the clock */ }
    }, this.pollMs)
    // Node keeps the process alive for a referenced interval; this plugin must
    // not be the reason a host cannot shut down.
    if (typeof timer.unref === 'function') timer.unref()
    this.disposed = () => {
      clearInterval(timer)
      this.disposed = null
    }
    return this.disposed
  }

  /**
   * Note that a job produced something, without consuming it.
   * @param id - the job id.
   * @param at - when it happened; defaults to now.
   */
  noteActivity(id: string, at?: number): void {
    this.lastActivity.set(id, at ?? this.now())
  }

  /** Fold finished jobs into the duration history, newest window only. */
  reconcile(): void {
    const now = this.now()
    for (const job of this.registry.list()) {
      if (!this.startedAt.has(job.id)) this.startedAt.set(job.id, job.startedAt)
      // lastActivity is deliberately NOT seeded here. Its absence means "no one
      // has observed output yet", which is different from "no output has
      // happened"; the assessment falls back to startedAt on its own.
      if (job.status === 'running' || job.status === 'stopping') continue
      const finished = job.finishedAt ?? now
      const key = historyKey(job)
      if (!this.recorded.has(job.id)) {
        this.recorded.add(job.id)
        this.history.record(key, finished - job.startedAt)
      }
    }
  }

  private readonly recorded = new Set<string>()

  /** Judge every visible job. */
  rows(): TaskRow[] {
    const now = this.now()
    return this.registry.list().map((job) => {
      // Null, never startedAt. Falling back to the start time is what made the
      // panel announce "no output for 1m09s" while running in a mode that never
      // reads output: it turned elapsed time into an invented silence.
      const lastActivity = this.lastActivity.get(job.id) ?? null
      const a = assess(
        {
          id: job.id,
          label: job.label,
          status: job.status as never,
          startedAt: job.startedAt,
          lastOutputAt: lastActivity,
          historyKey: historyKey(job),
        },
        this.history,
        now,
      )
      return {
        ...a,
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        startedAt: job.startedAt,
        observedSilenceMs: lastActivity === null ? null : now - lastActivity,
      }
    })
  }
}

/**
 * Key under which a job's duration is remembered.
 *
 * The program, not the whole command: `pytest tests/a` and `pytest tests/b` are
 * the same kind of work, and taking the first two words would file them
 * separately because the path differs.
 * @param job - the job.
 * @returns the history key.
 */
export function historyKey(job: JobView): string {
  const head = job.label.trim().split(/\s+/)[0] ?? ''
  return job.kind + '|' + (head === '' ? job.kind : head)
}
