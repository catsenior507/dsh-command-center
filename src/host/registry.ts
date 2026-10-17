/**
 * The registry view the watcher consumes.
 *
 * dsh 0.2.x's `JobRegistry.list()` takes an optional SessionId and, called with
 * no caller, is not fenced to a single agent — a plugin can simply ask for the
 * jobs and receive all of them.
 *
 * Earlier versions fenced by Agent: `list()` with no caller returned no owned
 * jobs at all, which is why a panel wired that way once reported `tasks: 0`
 * while a job was plainly running. The workaround was to ask once per live agent
 * and union the answers. Both the workaround and the API generation it served
 * are gone now; keeping the union would mean passing an agent where a session id
 * is expected, which asks a question the registry cannot answer.
 *
 * The read-mode sampler that lived here is gone for a related reason. It used
 * `read()`, whose cursor is per-job, so sampling could take output away from the
 * agent's own `job_output` — measured, 2026-09-22. dsh 0.2.x added
 * `readAt(id, from)`, which reads at an absolute offset without consuming; when
 * the silence signal is turned back on it should be built on that, not on this.
 *
 * @module dsh-command-center/host/registry
 */
import type { JobView, RegistryLike } from './watch.ts'

/** The slice of `ctx.jobs` used here. */
export interface JobsLike {
  /** All jobs visible to a plugin; no caller means no session fence. */
  list(caller?: unknown): JobView[]
}

/**
 * Adapt the registry to the shape the watcher uses.
 *
 * A list that throws yields an empty board rather than an exception on a timer:
 * the panel showing nothing is recoverable, a crashing interval is not.
 * @param jobs - the job registry.
 * @returns a registry view the watcher can use.
 */
export function adaptRegistry(jobs: JobsLike): RegistryLike {
  return {
    list(): JobView[] {
      try { return jobs.list() } catch { return [] }
    },
  }
}
