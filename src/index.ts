/**
 * dsh-command-center, host half.
 *
 * Two observers, one panel:
 *
 *   jobs       - what is running, from the job registry. State only: `read`
 *                returns a consuming delta, so polling it might take output
 *                away from the agent own `job_output`.
 *   questions  - what the agent is waiting on. Observation only, never
 *                answering, so the existing conversation UI keeps working.
 *
 * @module @dsh-external/dsh-client-plugin-command-center
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { handle, type Deps } from './host/api.ts'
import { DurationHistory } from './host/liveness.ts'
import { observeQuestions, QuestionWatch } from './host/questions.ts'
import { sampleActivity, unionRegistry, type AgentsLike, type JobsLike } from './host/registry.ts'
import { TaskWatch } from './host/watch.ts'

export const name = '@dsh-external/dsh-client-plugin-command-center'

/**
 * Nothing is injected, so the plugin loads even in a composition with no jobs.
 * The registry is picked up through `inject` below when it is not there yet.
 */
export const inject: string[] = []

interface Context {
  get(name: string): unknown
  inject(names: string[], callback: (ctx: Context) => void): void
  effect(callback: () => (() => void) | void, label?: string): void
  on(event: string, listener: (...args: never[]) => unknown): void
}

/** The slice of the context this file uses after the jobs service appears. */
type Wired = Context

const PORT_BASE = 4811
const PORT_ATTEMPTS = 8

/**
 * Whether the watcher may consume job output to measure silence.
 *
 * MEASURED, 2026-09-22: it may not. With this flag on, a background task that was
 * plainly printing produced an EMPTY `job_output` for the agent - the consuming
 * cursor in `JobRegistry.read` belongs to the job, not to the caller, so a second
 * reader takes the delta away from the first. The mode was reverted the same day.
 *
 * The gate name was changed from DSH_COMMAND_CENTER_OBSERVE after the revert did
 * not stick: the watchdog re-captures the host environment on every restart, so a
 * value written into its snapshot is copied back from the live host and re-armed
 * the theft. A new name that nothing sets cannot be resurrected that way.
 *
 * Do not turn this on again without a way to read output that does not consume it.
 */
const OBSERVE = process.env.DSH_COMMAND_CENTER_READ_OUTPUT === 'i-have-verified-this-is-safe' ? 'read' : 'changed-only'

/**
 * Mount the plugin.
 * @param ctx - the cordis context.
 */
export function apply(ctx: Context): void {
  const notes: string[] = []
  const questions = new QuestionWatch()
  ctx.on('user-questions/request', observeQuestions(questions) as never)
  notes.push('questions=observed')

  let watch: TaskWatch | null = null
  // Waited for rather than read now. Reading synchronously is a race, and the
  // winner is decided by roster order - the earlier build reported jobs=missing
  // purely because it happened to apply before the registry did. `agents` is
  // needed for the same reason `jobs` is: see unionRegistry.
  ctx.inject(['jobs', 'agents'], (ready: Wired) => {
    const jobs = ready.get('jobs') as JobsLike | undefined
    const agents = ready.get('agents') as AgentsLike | undefined
    if (jobs === undefined || agents === undefined) {
      notes.push('jobs=' + String(jobs !== undefined) + ' agents=' + String(agents !== undefined))
      record(notes)
      return
    }
    watch = new TaskWatch(unionRegistry(jobs, agents), { history: new DurationHistory() })
    watch.start()
    notes.push('jobs=watched')
    notes.push('observe=' + OBSERVE)
    if (OBSERVE === 'read') {
      // Sampling is what turns elapsed time into a measured silence. Until this
      // runs, the panel says it has no activity data - which is the truth.
      const timer = setInterval(() => {
        try { sampleActivity(jobs, agents, watch as never) } catch { /* keep ticking */ }
      }, 2000)
      ctx.effect(() => () => { clearInterval(timer) }, 'command-center: activity sampler')
    }
    record(notes)
  })
  record(notes)

  const start = (): void => {
    // A getter, not a value. The watcher is created later - the jobs service is
    // waited for - so copying `watch` here would freeze `null` into the request
    // handler forever. The diagnostic log said jobs=watched while the API said
    // jobsWatched=false; that contradiction is what pointed here.
      const deps: Deps = {
      get watch() { return watch },
      questions,
      observe: OBSERVE,
    }
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const path = (req.url ?? '/').split('?')[0]
        let body: unknown = null
        if (chunks.length > 0) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
        }
        const reply = handle(deps, req.method ?? 'GET', path, body)
        res.writeHead(reply.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify(reply.body))
      })
    })
    let listening = 0
    const attempt = (offset: number): void => {
      if (offset >= PORT_ATTEMPTS) { notes.push('api=failed'); record(notes); return }
      server.once('error', () => attempt(offset + 1))
      server.listen(PORT_BASE + offset, '127.0.0.1', () => {
        listening = PORT_BASE + offset
        notes.push('api=' + String(listening))
        record(notes)
      })
    }
    attempt(0)
    ctx.effect(() => () => {
      if (listening !== 0) server.close()
    }, 'command-center: carrier')
  }
  start()
}

/**
 * Append one diagnostic line.
 *
 * The harness logger output is not readable from outside a running host, and an
 * earlier plugin in this series failed to register a tool because the only
 * evidence was a warning nobody could read. This file is that lesson: it names
 * each part and can be read from disk while the host runs.
 * @param notes - what happened during apply.
 */
function record(notes: string[]): void {
  const line = new Date().toISOString() + ' apply: ' + notes.join(' ')
  try {
    const dir = homedir() + '\\.dsh\\command-center'
    mkdirSync(dir, { recursive: true })
    appendFileSync(dir + '\\startup.log', line + "\n")
  } catch {
    // Diagnostics must never be the reason a plugin fails to load.
  }
}
