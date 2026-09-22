/**
 * A registry view that can see every agent's jobs.
 *
 * `JobRegistry.list(caller)` is fenced by the calling agent: called with no
 * caller it returns no owned jobs at all, which is why a panel wired that way
 * reported `tasks: 0` while a job was plainly running. The panel is supposed to
 * show the user what is running, and the user is not an agent, so the view has
 * to be assembled from every live agent instead.
 *
 * @module dsh-command-center/host/registry
 */
import type { JobView, RegistryLike } from './watch.ts'

/** The slice of `ctx.jobs` used here. */
export interface JobsLike {
  list(caller?: unknown): JobView[]
  /** Returns the consuming delta since the previous read for this caller. */
  read?(id: string, caller?: unknown): { text: string }
  onJobsChanged(listener: () => void): () => void
}

/** The slice of `ctx.agents` used here. */
export interface AgentsLike {
  list(): unknown[]
}

/**
 * Note activity for every running job by consuming its output delta.
 *
 * This is the risky half of `read` mode: `JobRegistry.read` returns a consuming
 * delta, so if the cursor turns out to be per-job rather than per-caller, this
 * takes output away from the agent own `job_output`. It is therefore opt-in, and
 * the first thing to do after enabling it is to check that `job_output` still
 * returns output while a task runs.
 *
 * A read that throws is skipped: one unreadable job must not stop the clock that
 * measures every other one.
 * @param jobs - the job registry.
 * @param agents - the agent registry.
 * @param watch - the watcher to notify.
 * @param now - clock, injected for tests.
 * @returns how many jobs reported activity.
 */
export function sampleActivity(
  jobs: JobsLike,
  agents: AgentsLike,
  watch: { noteActivity(id: string, at?: number): void; rows(): { id: string; status: string }[] },
  now: () => number = () => Date.now(),
): number {
  if (typeof jobs.read !== 'function') return 0
  const running = watch.rows().filter((r) => r.status === 'running' || r.status === 'stopping')
  let seen = 0
  for (const row of running) {
    const callers: unknown[] = [undefined, ...agents.list()]
    for (const caller of callers) {
      try {
        const read = jobs.read(row.id, caller)
        if (read.text !== '') {
          watch.noteActivity(row.id, now())
          seen += 1
        }
        break
      } catch {
        // Not visible to this caller; try the next.
      }
    }
  }
  return seen
}

/**
 * Union the jobs visible to every live agent, plus unowned jobs.
 *
 * Deduplicated by id: the same job can be visible through more than one caller
 * when agents are nested, and a job listed twice would appear twice in the
 * panel. A caller that throws is skipped rather than failing the whole read,
 * because one dead agent must not blind the panel to everyone else.
 * @param jobs - the job registry.
 * @param agents - the agent registry.
 * @returns a registry view the watcher can use.
 */
export function unionRegistry(jobs: JobsLike, agents: AgentsLike): RegistryLike {
  return {
    list(): JobView[] {
      const byId = new Map<string, JobView>()
      const collect = (caller?: unknown): void => {
        try {
          for (const job of jobs.list(caller)) byId.set(job.id, job)
        } catch {
          // One unreadable caller must not hide every other agent's work.
        }
      }
      collect()
      for (const agent of agents.list()) collect(agent)
      return [...byId.values()]
    },
    onJobsChanged: (listener: () => void) => jobs.onJobsChanged(listener),
  }
}
