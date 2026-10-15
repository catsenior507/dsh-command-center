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
import { join } from 'node:path'
import { handle, type Deps } from './host/api.ts'
import { describe, FailureStreak, num, str, type FailureRecord } from './host/failures.ts'
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

/**
 * Reach the conversation through the agent, if the shape allows it.
 *
 * The declaration says the payload carries an `agent`, not a message list, so
 * the messages have to be found through it - and its layout is not declared
 * here. Every path is tried defensively and undefined is a valid answer: the
 * caller records zeroes and, more usefully, the key names it did see, so the
 * next failure says where to look instead of failing silently.
 * @param agent - the agent from the payload.
 * @returns the message list when one could be found.
 */
function readMessages(agent: unknown): unknown {
  const a = agent as { session?: unknown; messages?: unknown } | null
  if (a === null || typeof a !== 'object') return undefined
  const s = a.session as { messages?: unknown; history?: unknown; state?: unknown } | undefined
  if (Array.isArray(s?.messages)) return s.messages
  if (Array.isArray(s?.history)) return s.history
  const state = s?.state as { messages?: unknown } | undefined
  if (Array.isArray(state?.messages)) return state.messages
  if (Array.isArray(a.messages)) return a.messages
  return undefined
}

/**
 * List the key names of whatever an object exposes.
 *
 * Recorded so an unknown shape becomes known after one failure rather than
 * after another round of guessing.
 * @param value - the object to inspect.
 * @returns its own key names, capped.
 */
function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  return Object.keys(value as Record<string, unknown>).slice(0, 24)
}

/**
 * Append one failure record as a JSON line.
 *
 * Append-only on purpose: the interesting pattern is the sequence, and a file
 * rewritten per event would lose exactly that.
 * @param record - the record to write.
 */
/**
 * Where diagnostics are written.
 *
 * Overridable, because a test that calls apply() would otherwise append to the
 * real log - and then the log reads as though the live host had restarted with
 * no services at all, which happened and cost a round of confusion: the last
 * two lines said `jobs=false agents=false api=4823`, and 4823 is a test port.
 * @returns the directory diagnostics belong in.
 */
function dataDir(): string {
  const override = process.env.DSH_COMMAND_CENTER_DATA
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.dsh', 'command-center')
}

function appendFailure(record: unknown): void {
  try {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'llm-failures.jsonl'), JSON.stringify(record) + '\n')
  } catch {
    // Diagnostics must never break the path they are diagnosing.
  }
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
export function apply(ctx: Context, config?: { port?: number }): void {
  // Named port wins. A caller that asks for a port and is ignored scans a range
  // nothing is listening on, which is exactly how this surfaced.
  const basePort = config?.port ?? PORT_BASE
  const notes: string[] = []
  const questions = new QuestionWatch()
  ctx.on('user-questions/request', observeQuestions(questions) as never)
  notes.push('questions=observed')

  // Records what was in flight whenever a model request fails. Measured
  // 2026-10-15: one session lost all twelve of its attempts to STREAM_CLOSED -
  // five in one turn, five in the next, two in a third, with no success between
  // them. Twelve identical failures mean the request is the trigger, but the
  // session log keeps only the error, so what was sent has to be captured here.
  //
  // Fields are read by name from the declaration, not guessed:
  // dsh-agent/lib/types/runtime-types.d.ts declares this event as
  // { agent, turn, step, provider, failure, retryPolicy, signal }. The first
  // version looked for `messages` in it, found nothing, and wrote a shape of
  // all zeros for twelve consecutive failures.
  const streak = new FailureStreak()
  ctx.on('agent/request-error', ((payload: unknown, next: () => unknown) => {
    try {
      const p = (payload ?? {}) as {
        agent?: unknown
        turn?: unknown
        step?: unknown
        provider?: unknown
        failure?: { code?: unknown; message?: unknown }
        retryPolicy?: unknown
      }
      const code = str(p.failure?.code) ?? 'UNKNOWN'
      const count = streak.note(code)
      const record: FailureRecord & { streak: number; deterministic: boolean } = {
        at: Date.now(),
        code,
        message: str(p.failure?.message) ?? '',
        turn: num(p.turn),
        step: num(p.step),
        provider: str(p.provider),
        // The whole failure object rather than the two fields already known: a
        // field nobody thought to name may be the one that identifies the cause.
        failure: p.failure ?? null,
        retryPolicy: p.retryPolicy ?? null,
        shape: describe(readMessages(p.agent)),
        // Self-diagnosing: if the conversation could not be reached, these say
        // where it actually lives, so the next failure needs no new guesswork.
        agentKeys: keysOf(p.agent),
        sessionKeys: keysOf((p.agent as { session?: unknown } | undefined)?.session),
        streak: count,
        // Two in a row is the threshold: one failure is noise, two identical
        // ones mean repeating the request is very unlikely to help.
        deterministic: streak.looksDeterministic(2),
      }
      appendFailure(record)
    } catch {
      // Observation must never be the reason a request fails.
    }
    return next()
  }) as never)
  notes.push('failures=observed')

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
      server.listen(basePort + offset, '127.0.0.1', () => {
        listening = basePort + offset
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
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(dir + '\\startup.log', line + "\n")
  } catch {
    // Diagnostics must never be the reason a plugin fails to load.
  }
}
