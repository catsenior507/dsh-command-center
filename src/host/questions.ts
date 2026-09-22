/**
 * Tracks questions the agent is waiting on.
 *
 * The harness asks through a waterfall (`user-questions/request`), and the
 * conversation UI is already an answerer on it. This module is an OBSERVER: it
 * records that a question is open so the panel can shout about it, then calls
 * `next()` and lets the existing UI own the interaction. It never answers.
 *
 * That restraint is the whole design. A second answerer racing the first would
 * make the panel a competitor to the interface people already use; an observer
 * cannot break anything, and the thing it fixes - nobody noticing that the turn
 * has stopped - needs observation, not control.
 *
 * @module dsh-command-center/host/questions
 */

/** One question waiting on a human. */
export interface PendingQuestion {
  id: string
  question: string
  header?: string
  /** Option labels, in the order the caller offered them. */
  options: string[]
  /** When it was asked. */
  askedAt: number
}

/** The shape `user-questions/request` carries, as far as this file cares. */
interface RequestLike {
  questions?: { id?: unknown; question?: unknown; header?: unknown; options?: unknown }[]
}

/** Records open questions. */
export class QuestionWatch {
  private readonly open = new Map<string, PendingQuestion>()

  /**
   * Record the questions in one request.
   * @param request - the waterfall payload.
   * @param at - when it arrived.
   * @returns the ids recorded, for clearing later.
   */
  note(request: unknown, at: number): string[] {
    const parsed = parse(request)
    for (const q of parsed) this.open.set(q.id, { ...q, askedAt: at })
    return parsed.map((q) => q.id)
  }

  /** Forget questions that have been answered or abandoned. */
  settle(ids: string[]): void {
    for (const id of ids) this.open.delete(id)
  }

  /** Everything still waiting, oldest first. */
  list(): PendingQuestion[] {
    return [...this.open.values()].sort((a, b) => a.askedAt - b.askedAt)
  }

  /** How many are waiting. */
  get count(): number {
    return this.open.size
  }
}

/**
 * Pull the fields this file needs out of an untyped waterfall payload.
 *
 * Deliberately tolerant: this observes a protocol owned by another package, and
 * an unrecognised extra field must not stop the panel from working. A question
 * with no usable id is skipped rather than recorded under a guess.
 * @param request - the payload.
 * @returns the parsed questions.
 */
function parse(request: unknown): { id: string; question: string; header?: string; options: string[] }[] {
  if (request === null || typeof request !== 'object') return []
  const rows = (request as RequestLike).questions
  if (!Array.isArray(rows)) return []
  const out: { id: string; question: string; header?: string; options: string[] }[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.id !== 'string' || row.id === '') continue
    const options = Array.isArray(row.options)
      ? row.options
          .map((o) => (o !== null && typeof o === 'object' ? (o as { label?: unknown }).label : undefined))
          .filter((l): l is string => typeof l === 'string')
      : []
    out.push({
      id: row.id,
      question: typeof row.question === 'string' ? row.question : '',
      ...(typeof row.header === 'string' ? { header: row.header } : {}),
      options,
    })
  }
  return out
}

/**
 * Wrap the next answerer so open questions are visible while they wait.
 *
 * The returned function is a drop-in waterfall listener: it records, delegates,
 * and clears whatever happens - answered, abandoned, or thrown. Returning the
 * downstream promise unchanged is what keeps this from becoming a second
 * answerer.
 * @param watch - the tracker.
 * @param now - clock, injected for tests.
 * @returns the listener.
 */
export function observeQuestions(
  watch: QuestionWatch,
  now: () => number = () => Date.now(),
): (request: unknown, next: () => Promise<unknown>) => Promise<unknown> {
  return (request, next) => {
    const ids = watch.note(request, now())
    return Promise.resolve()
      .then(next)
      .finally(() => watch.settle(ids))
  }
}
