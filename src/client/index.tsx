/**
 * dsh-command-center client half.
 *
 * Two contributions:
 *
 * 1. A trigger in `sidebar.footer.action`. The shell renders that slot as a LIST
 *    inside the same bottom-pinned foot area as the `sidebar.settings` seat that
 *    holds the Settings button, so registering there puts this beside Settings
 *    without replacing anything.
 * 2. The panel, mounted on the body by this plugin own root, so the sidebar
 *    collapsing to its rail cannot clip it.
 *
 * The two are separate React trees, so the open/closed flag lives in a module
 * store rather than a context.
 *
 * @module dsh-command-center/client
 */
import type { Context } from '@deepseek-ai/cordis'
import React, { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandPanel, readState } from './panel'
import { badge, sidebarButton } from './styles'

/**
 * Client services this plugin needs.
 *
 * Declaring `slots` is what makes the sidebar seat reachable; without it cordis
 * refuses the `ctx.slots` access with `cannot get property "slots" without inject`.
 */
export const inject = ['slots']

const SIDEBAR_SLOT = 'sidebar.footer.action'

/** Minimal external store for the open flag, shared by both trees. */
let open = false
const listeners = new Set<() => void>()

/** @returns whether the panel is open. */
function isOpen(): boolean {
  return open
}

/**
 * Subscribe to the open flag.
 * @param listener - called on change.
 * @returns the unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Open or close the panel.
 * @param next - the new value.
 */
function setOpen(next: boolean): void {
  open = next
  for (const listener of listeners) listener()
}

/**
 * The sidebar trigger, with a count when something is waiting on a human.
 * @returns the button element.
 */
function CenterButton(): React.ReactElement {
  const isOpenNow = useSyncExternalStore(subscribe, isOpen, isOpen)
  const [waiting, setWaiting] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const state = await readState()
      if (alive && state !== null) setWaiting(state.needsYou)
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const label = waiting > 0 ? '指挥台 · ' + String(waiting) + ' 项待处理' : '指挥台'
  const style = isOpenNow ? { ...sidebarButton, opacity: 1 } : sidebarButton
  return React.createElement('button', {
    style,
    title: label,
    'aria-label': label,
    onClick: () => setOpen(!isOpenNow),
  },
    React.createElement('span', { 'aria-hidden': 'true' }, '🧭'),
    waiting > 0 ? React.createElement('span', { style: badge }, String(waiting)) : null,
    React.createElement('span', null, '指挥台'),
  )
}

interface SlotsLike {
  inject(slot: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/**
 * Mount the client half.
 * @param ctx - the cordis context.
 */
export function apply(ctx: Context): void {
  const mount = document.createElement('div')
  mount.setAttribute('data-dsh-command-center', '')
  document.body.append(mount)
  let root: Root | null = null
  try {
    root = createRoot(mount)
    root.render(React.createElement(CommandPanel, { open, onClose: () => setOpen(false) }))
  } catch {
    mount.remove()
    return
  }
  // Re-render the panel tree whenever the store changes. The button has its own
  // subscription; this one only drives the panel root.
  subscribe(() => {
    root?.render(React.createElement(CommandPanel, { open, onClose: () => setOpen(false) }))
  })

  const slots = (ctx as unknown as { slots?: SlotsLike }).slots
  if (slots === undefined || typeof slots.inject !== 'function') return
  let registered: (() => void) | undefined
  ctx.effect(() => {
    const outer = slots.inject(SIDEBAR_SLOT, () => {
      registered = slots.register(
        { name: SIDEBAR_SLOT, id: 'command-center', order: 21 },
        CenterButton,
      ) as (() => void) | undefined
      return registered
    }) as (() => void) | undefined
    return () => {
      outer?.()
      registered?.()
    }
  }, 'command-center: sidebar trigger')
}
