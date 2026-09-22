/**
 * Proves every cordis service reached by property access is declared in inject.
 *
 * Written after the client half shipped without `export const inject =
 * ['slots']` and the whole browser bundle failed to load with `cannot get
 * property "slots" without inject`. A cast made TypeScript accept it; cordis
 * checks at runtime and does not care about casts.
 *
 * The distinction this encodes: `ctx.get(name)` is a METHOD and may miss
 * harmlessly, so it is allowed. `ctx.name` is a PROPERTY access and cordis
 * refuses it unless `name` is in the plugin inject list. Only the second kind is
 * policed here, because only the second kind throws.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Context members that are methods on the prototype, not injected services. */
const METHODS = new Set([
  'get', 'set', 'on', 'off', 'once', 'emit', 'inject', 'effect',
  'logger', 'scope', 'root', 'fiber', 'plugin', 'parallel', 'waterfall', 'bail',
])

/**
 * Service names reached by property access.
 * @param source - the file text.
 * @returns the names, deduplicated.
 */
function propertyServices(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    if (!METHODS.has(name)) found.add(name)
  }
  return [...found].sort()
}

/**
 * The inject list exported by a module source.
 * @param source - the file text.
 * @returns the declared names, or null when the export is missing.
 */
function declaredInject(source: string): string[] | null {
  const match = source.match(/export const inject[^=]*=\s*\[([^\]]*)\]/s)
  if (match === null) return null
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()
}

/**
 * Check one plugin entry file.
 * @param relative - path under src/.
 * @param needsInject - whether this half must export an inject list at all.
 */
function checkEntry(relative: string, needsInject: boolean): void {
  const source = readFileSync(new URL('../' + relative, import.meta.url), 'utf8')
  const used = propertyServices(source)
  const declared = declaredInject(source)
  if (used.length === 0) return
  if (declared === null) {
    if (needsInject) {
      assert.fail(
        relative + ' reaches ' + used.join(', ') + ' by property access but exports no inject list. ' +
        'cordis will refuse the access at runtime with \'cannot get property ... without inject\'.',
      )
    }
    return
  }
  const missing = used.filter((name) => !declared.includes(name))
  assert.deepEqual(
    missing,
    [],
    relative + ' reaches ' + missing.join(', ') + ' without declaring it in inject',
  )
}

test('the host half declares every service it reaches', () => {
  checkEntry('src/index.ts', false)
})

test('the client half declares every service it reaches', () => {
  checkEntry('src/client/index.tsx', true)
})

test('the client inject list is not empty, because it uses slots', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.deepEqual(declaredInject(source), ['slots'])
})

test('the checker would have caught the shipped bug', () => {
  // The regression that matters: a source that reaches ctx.slots with no inject
  // export must be rejected. If this test ever stops failing, the checker has
  // gone blind and every other test in this file is worthless.
  const broken = "export function apply(ctx) { const s = ctx.slots; void s }"
  const used = propertyServices(broken)
  assert.deepEqual(used, ['slots'])
  assert.equal(
    declaredInject(broken),
    null,
    'a source with no inject export must be detected as undeclared',
  )
})

test('ctx.get is not mistaken for an injected service', () => {
  // The host half legitimately uses ctx.get, which returns undefined instead of
  // throwing. Flagging it would make the checker cry wolf and get ignored.
  const source = "export function apply(ctx) { const j = ctx.get('jobs'); void j }"
  assert.deepEqual(propertyServices(source), [])
})
