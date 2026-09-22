/**
 * Styles as plain objects, with hard-coded colours.
 *
 * Deliberately not a CSS module, and deliberately not the theme variables. The
 * first version used `var(--dsw-alias-bg-base, #ffffff)`; the panel came out
 * fully transparent, which means that variable IS defined and its value is
 * transparent - so the fallback never applied and nothing was painted behind the
 * text. A panel that floats over the conversation has to carry its own surface.
 *
 * The same lesson as the calendar plugin: it declared its colour variables on a
 * class that was never applied to anything and also came out invisible. Inline
 * objects cannot be forgotten into invisibility.
 *
 * @module dsh-command-center/client/styles
 */
import type { CSSProperties } from 'react'

const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'

/** Panel surface. Centred, opaque, with no overlay behind it. */
export const panel: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 2147483000,
  width: 'min(560px, calc(100vw - 32px))',
  maxHeight: 'min(88vh, 820px)',
  display: 'flex',
  flexDirection: 'column',
  background: '#1b1e24',
  color: '#e8eaee',
  border: '1px solid #3a4150',
  borderRadius: '14px',
  boxShadow: '0 18px 48px rgba(0, 0, 0, 0.55)',
  fontFamily: UI_FONT,
  fontSize: '13px',
  overflow: 'hidden',
}

/** Title bar. Pinned; the body below it is the only scroller. */
export const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 12px',
  background: '#242832',
  borderBottom: '1px solid #3a4150',
  flex: 'none',
}

/** The single scrolling region. minHeight 0 is what lets it shrink. */
export const body: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  padding: '10px 12px',
}

/** Sidebar trigger: transparent at rest, like the sibling plugins. */
export const sidebarButton: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  minHeight: '28px',
  padding: '0 10px',
  whiteSpace: 'nowrap',
  border: '1px solid transparent',
  borderRadius: '6px',
  background: 'transparent',
  color: 'inherit',
  fontFamily: UI_FONT,
  fontSize: '12px',
  cursor: 'pointer',
}

/** The count of things waiting on a human. */
export const badge: CSSProperties = {
  minWidth: '15px',
  height: '15px',
  padding: '0 4px',
  borderRadius: '999px',
  background: '#d93f3f',
  color: '#ffffff',
  fontSize: '10px',
  lineHeight: '15px',
  textAlign: 'center',
  fontWeight: 700,
}

/** One row per task or question. */
export const row: CSSProperties = {
  border: '1px solid #3a4150',
  borderRadius: '9px',
  padding: '8px 10px',
  marginBottom: '6px',
  background: '#22262f',
}

/** A short status word. */
export const pill: CSSProperties = {
  display: 'inline-block',
  padding: '0 6px',
  borderRadius: '999px',
  fontSize: '10px',
  border: '1px solid currentColor',
  whiteSpace: 'nowrap',
  marginRight: '5px',
}

/** Small secondary text. */
export const muted: CSSProperties = {
  color: '#98a1b0',
  fontSize: '11px',
}
