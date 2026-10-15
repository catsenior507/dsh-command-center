/**
 * Tests for the plugin entry itself.
 *
 * This file exists because of a real bug: the wiring in `apply()` referenced a
 * variable that had been deleted, and the plugin died with `ReferenceError`
 * while every other test stayed green. The other suites test the pieces;
 * nothing tested that the pieces are actually wired together, which is exactly
 * where the mistake was made.
 *
 * `apply` is loaded and run for real here. A fake context supplies the two
 * things it needs, and the carrier is asked a question over HTTP so the check
 * covers the wiring rather than the fact that a function was called.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Diagnostics go to a scratch directory. Without this the suite appends to the
// real log, and the real log then claims the live host applied with no services.
process.env.DSH_COMMAND_CENTER_DATA = mkdtempSync(join(tmpdir(), 'cc-test-'))

const TEST_PORT = 4823

/** The smallest context that can carry this plugin. */
function fakeContext() {
  const disposers: (() => void)[] = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const ctx = {
    disposers,
    handlers,
    /** No jobs registry: this is what apply() sees, since the registry is
     * registered after this plugin runs. */
    get: () => undefined,
    effect(callback: () => (() => void) | void) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    // Both of these were missing, which is why this suite went red the moment
    // apply() started using them: the observer hooks events and waits for the
    // services it needs, and a stub that cannot do either is not a context.
    on(event: string, listener: (...args: never[]) => unknown) {
      handlers.set(event, listener)
    },
    inject(_names: string[], callback: (ctx: unknown) => void) {
      callback(ctx)
    },
    logger: { info: () => {} },
  }
  return ctx
}

/** Ask the carrier a question, trying the fallback ports it may have taken. */
async function ask(path: string, attempts = 20): Promise<{ port: number; body: unknown } | null> {
  // apply() starts listening asynchronously, so a single sweep can run before
  // the socket is bound and report "no port answered" for a carrier that is
  // about to. Poll the whole range for a moment instead of once.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (let port = TEST_PORT; port < TEST_PORT + 10; port += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        if (res.ok) return { port, body: await res.json() }
      } catch {
        // Not this port; the carrier may have fallen back to the next one.
      }
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

test('apply wires up without throwing, and its disposer frees the port', async () => {
  const ctx = fakeContext()
  assert.doesNotThrow(() => { apply(ctx as never, { port: TEST_PORT }) })
  // Let the listen callback run before disposing, so this asserts something
  // real: a disposer that only works after the callback would pass a
  // synchronous test while still leaking the handle.
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const dispose of ctx.disposers) dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const after = await ask('/health')
  assert.equal(after, null, 'the carrier still answers after disposal')
})

test('the carrier answers once apply has run', async () => {
  const ctx = fakeContext()
  apply(ctx as never, { port: TEST_PORT })
  try {
    const health = await ask('/health')
    assert.ok(health !== null, 'no port in the range answered /health')
    const body = health.body as { ok: boolean; observe: string }
    assert.equal(body.ok, true)
    assert.equal(body.observe, 'changed-only')
    const tasks = await ask('/tasks')
    assert.ok(tasks !== null)
    assert.equal((tasks.body as { needsYou: number }).needsYou, 0)
  } finally {
    for (const dispose of ctx.disposers) dispose()
  }
})
