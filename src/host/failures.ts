/**
 * Records what a failed model request was, so the next investigation starts from
 * facts instead of hypotheses.
 *
 * Why this exists: a session on this machine lost all twelve of its attempts -
 * five in one turn, five in the next, two in a third - every one STREAM_CLOSED.
 * Twelve identical failures say the request is the trigger, not the network.
 * The session log keeps only the error, never what was sent.
 *
 * The payload shape is taken from the harness declaration rather than guessed:
 * `dsh-agent/lib/types/runtime-types.d.ts` declares `agent/request-error` as
 * { agent, turn, step, provider, failure, retryPolicy, signal }. The first
 * version of this file looked for `messages` there, found nothing, and recorded
 * a shape of all zeros. Read the type first.
 *
 * @module dsh-command-center/host/failures
 */

/** One recorded failure. */
export interface FailureRecord {
  at: number
  code: string
  message: string
  turn: number | null
  step: number | null
  provider: string | null
  /**
   * The complete failure object as the adapter normalized it.
   *
   * Recorded whole rather than picked apart: the fields worth having are the
   * ones nobody thought to name, and an HTTP status hiding in here would say
   * more about the cause than anything already known.
   */
  failure: unknown
  /** The retry policy in force, which also proves which config was loaded. */
  retryPolicy: unknown
  /** Conversation size, when the agent could be read. */
  shape: {
    messages: number
    toolCalls: number
    characters: number
  }
  /**
   * Key names of the agent and its session.
   *
   * Recorded so an unknown shape becomes known after one failure instead of
   * after another round of guessing at where the conversation lives.
   */
  agentKeys: string[]
  sessionKeys: string[]
}

/**
 * Read a numeric field without trusting its shape.
 * @param value - the candidate.
 * @returns the number, or null.
 */
export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read a string field without trusting its shape.
 * @param value - the candidate.
 * @returns the string, or null.
 */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Count a conversation without keeping any of it.
 *
 * The conversation is the user's private data; the size is what answers "was
 * this request unusually large", and it is safe to store.
 * @param messages - the message list, in whatever shape the caller has.
 * @returns the counts.
 */
export function describe(messages: unknown): FailureRecord['shape'] {
  const list = Array.isArray(messages) ? messages : []
  let toolCalls = 0
  let characters = 0
  for (const m of list) {
    const msg = m as { content?: unknown }
    const parts = Array.isArray(msg?.content) ? msg.content : []
    for (const p of parts) {
      const part = p as { type?: unknown; text?: unknown }
      if (part?.type === 'tool-call') toolCalls += 1
      if (typeof part?.text === 'string') characters += part.text.length
    }
    if (typeof msg?.content === 'string') characters += msg.content.length
  }
  return { messages: list.length, toolCalls, characters }
}

/**
 * Tracks consecutive failures that share a code.
 *
 * The point is to tell "the network hiccupped" from "this request cannot
 * succeed". The first deserves patience; the second deserves to be reported
 * early, because repeating an identical request cannot have a different outcome
 * and only makes the failure slower.
 */
export class FailureStreak {
  private code: string | null = null
  private count = 0

  /**
   * Record one failure.
   * @param code - the failure code.
   * @returns how many times this code has now failed in a row.
   */
  note(code: string): number {
    if (code === this.code) this.count += 1
    else { this.code = code; this.count = 1 }
    return this.count
  }

  /** Forget the streak; call this after any success. */
  reset(): void {
    this.code = null
    this.count = 0
  }

  /**
   * Whether repeated identical failures make further retries pointless.
   * @param threshold - how many in a row count as deterministic.
   * @returns true when the streak reached the threshold.
   */
  looksDeterministic(threshold: number): boolean {
    return this.count >= threshold
  }
}
