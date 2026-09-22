/**
 * The panel-facing HTTP surface, as a pure request handler.
 *
 * Kept free of node:http so it can be tested directly: the wiring that turns a
 * real request into these arguments is trivial, and the part that decides what
 * the panel sees is not.
 *
 * @module dsh-command-center/host/api
 */
import type { TaskWatch } from './watch.ts'
import type { QuestionWatch } from './questions.ts'

/** Everything the handler reads. */
export interface Deps {
  watch: TaskWatch | null
  questions: QuestionWatch
  /**
   * 'changed-only' never reads job output; 'read' consumes it to measure
   * silence. Reported to the panel so it can say which one it is looking at.
   */
  observe: string
}

/** One response. */
export interface Reply {
  status: number
  body: unknown
}

/**
 * Answer one panel request.
 * @param deps - the watchers.
 * @param method - HTTP method.
 * @param path - request path, without the mount prefix.
 * @param body - parsed JSON body, if any.
 * @returns the reply.
 */
export function handle(deps: Deps, method: string, path: string, body: unknown): Reply {
  const questions = deps.questions.list()
  if (method === 'GET' && (path === '/tasks' || path === '/state')) {
    const tasks = deps.watch === null ? [] : deps.watch.rows()
    return {
      status: 200,
      body: {
        ok: true,
        // Why the panel is told this: the watcher does not read job output yet,
        // so silence is unknown rather than zero. The panel must be able to say
        // "no activity data" instead of drawing a confident bar over a number
        // nobody measured.
        observe: deps.observe,
        needsYou: questions.length,
        questions,
        tasks,
        jobsWatched: deps.watch !== null,
      },
    }
  }
  if (method === 'GET' && path === '/health') {
    return { status: 200, body: { ok: true, observe: deps.observe, jobsWatched: deps.watch !== null } }
  }
  if (method === 'POST' && path === '/kill') {
    const id = body !== null && typeof body === 'object' ? (body as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id === '') {
      return { status: 400, body: { ok: false, error: 'id is required' } }
    }
    return { status: 501, body: { ok: false, error: 'kill is not wired yet' } }
  }
  return { status: 404, body: { ok: false, error: 'not found' } }
}
