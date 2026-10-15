/**
 * Records the shape of a request that failed, so the next investigation starts
 * from facts instead of hypotheses.
 *
 * Why this exists: a session on this machine failed every retry - five attempts
 * in one turn, five in the next - and all ten died with STREAM_CLOSED. Ten
 * identical failures mean the request itself is the trigger, not the network.
 * But the session log records only the error, never what was sent, so finding
 * the trigger meant reading the whole log by hand and guessing. Twice those
 * guesses were wrong.
 *
 * This writes down what was in flight: how many messages, how many tool calls,
 * how large, and what the tail looked like. That is the evidence the log lacked.
 *
 * @module dsh-command-center/host/failures
 */

/** One recorded failure. */
export interface FailureRecord {
  at: number
  code: string
  message: string
  /** Shape of the conversation at the moment of failure. */
  shape: {
    messages: number
    toolCalls: number
    characters: number
    /** Content kinds of the last few messages, oldest first. */
    tailKinds: string[]
  }
}

/**
 * Describe a conversation without recording its contents.
 *
 * Counts only. The conversation is the user's private data; the shape is what
 * answers "what was different about this request", and it is safe to keep.
 * @param messages - the message list, in whatever shape the caller has.
 * @returns the shape summary.
 */
export function describe(messages: unknown): FailureRecord['shape'] {
  const list = Array.isArray(messages) ? messages : []
  let toolCalls = 0
  let characters = 0
  const tailKinds: string[] = []
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
  for (const m of list.slice(-4)) {
    const msg = m as { role?: unknown; content?: unknown }
    const kinds = Array.isArray(msg?.content)
      ? msg.content.map((p) => String((p as { type?: unknown })?.type ?? '?'))
      : [typeof msg?.content]
    tailKinds.push(String(msg?.role ?? '?') + ':' + kinds.join('+'))
  }
  return { messages: list.length, toolCalls, characters, tailKinds }
}

/**
 * Tracks consecutive failures that share a code.
 *
 * The point is to tell "the network hiccupped" from "this request cannot
 * succeed". The first deserves patience; the second deserves to be reported
 * early, because repeating an identical request has no chance of a different
 * outcome and only makes the failure slower.
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
