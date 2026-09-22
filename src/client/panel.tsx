/**
 * The command-center panel.
 *
 * It reports what is running, what the agent is waiting on, and how long each has
 * been going - all facts. How far along a long silence is, is not a fact: the
 * watcher runs in changed-only mode, so the panel prints that it has no activity
 * data rather than drawing a progress bar over a number nobody measured.
 *
 * @module dsh-command-center/client/panel
 */
import React, { useEffect, useState } from 'react'
import { badge, body, header, muted, panel, pill, row } from './styles'

const PORTS = [4811, 4812, 4813, 4814, 4815, 4816, 4817, 4818]

/** One task as the panel receives it. */
export interface TaskRow {
  id: string
  kind: string
  label: string
  status: string
  verdict: string
  summary: string
  elapsedMs: number
  progress: number | null
}

/** One question waiting on a human. */
export interface QuestionRow {
  id: string
  question: string
  header?: string
  options: string[]
  askedAt: number
}

/** Everything one poll returns. */
export interface PanelState {
  observe: string
  needsYou: number
  questions: QuestionRow[]
  tasks: TaskRow[]
  jobsWatched: boolean
}

/** Verdict word in the panel language. A raw english word here is a bug. */
const VERDICT_LABEL: Record<string, string> = {
  unknown: '无数据',
  live: '活跃',
  quiet: '安静',
  slow: '偏慢',
  stalled: '疑似卡住',
  done: '结束',
}

const VERDICT_COLOUR: Record<string, string> = {
  unknown: '#8a93a3',
  live: '#1f8a4c',
  quiet: '#a9761a',
  slow: '#a9761a',
  stalled: '#d93f3f',
  done: '#666e7d',
}

/**
 * Find the carrier and read its state.
 *
 * The port is tried in order because the host walks upward when the base port is
 * taken; a panel hard-coded to one port would show nothing on a machine where
 * something else reached it first.
 * @returns the state, or null when nothing answered.
 */
export async function readState(): Promise<PanelState | null> {
  for (const port of PORTS) {
    try {
      const res = await fetch('http://127.0.0.1:' + String(port) + '/state', {
        signal: AbortSignal.timeout(2500),
      })
      if (!res.ok) continue
      const payload = (await res.json()) as { ok?: boolean } & PanelState
      if (payload.ok === true) return payload
    } catch {
      // Try the next port.
    }
  }
  return null
}

/**
 * Compact duration: 8s, 3m20s, 1h04m.
 * @param ms - milliseconds.
 * @returns the text.
 */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return String(s) + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return String(m) + 'm' + String(s % 60).padStart(2, '0') + 's'
  return String(Math.floor(m / 60)) + 'h' + String(m % 60).padStart(2, '0') + 'm'
}

const h = React.createElement

/**
 * The panel.
 * @param props - open state and a close handler.
 * @returns the element, or null when closed.
 */
export function CommandPanel(props: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const [state, setState] = useState<PanelState | null>(null)
  const [failed, setFailed] = useState(false)
  const { open, onClose } = props

  useEffect(() => {
    if (!open) return
    let alive = true
    const poll = async (): Promise<void> => {
      const next = await readState()
      if (!alive) return
      setState(next)
      setFailed(next === null)
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const tasks = state === null ? [] : state.tasks
  const questions = state === null ? [] : state.questions
  const children: React.ReactNode[] = []

  children.push(h('div', { style: header, key: 'h' },
    h('strong', { key: 't' }, '指挥台'),
    questions.length > 0 ? h('span', { style: badge, key: 'b' }, String(questions.length)) : null,
    h('span', { style: { flex: 1 }, key: 's' }),
    h('button', {
      key: 'x',
      onClick: onClose,
      title: '关闭',
      style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '15px', color: 'inherit' },
    }, '✕'),
  ))

  const inner: React.ReactNode[] = []
  if (failed) {
    inner.push(h('div', { style: muted, key: 'f' }, '连不上插件端口（4811-4818）。宿主可能刚重启，稍后再试。'))
  }

  if (questions.length > 0) {
    inner.push(h('div', { style: { ...muted, marginBottom: '4px' }, key: 'qh' }, '在等你回答'))
    for (const q of questions) {
      inner.push(h('div', { style: row, key: q.id },
        h('div', { style: { fontWeight: 600, marginBottom: '3px' } }, q.header ?? '提问'),
        h('div', null, q.question),
        q.options.length > 0 ? h('div', { style: { ...muted, marginTop: '4px' } }, '可选：' + q.options.join(' / ')) : null,
        h('div', { style: { ...muted, marginTop: '4px' } }, '请到对话里回答 —— 本面板只负责提醒。'),
      ))
    }
  }

  inner.push(h('div', { style: { ...muted, marginBottom: '4px' }, key: 'th' }, '运行中的任务'))
  if (tasks.length === 0) {
    inner.push(h('div', { style: muted, key: 'tn' }, '当前没有后台任务。'))
  }
  for (const t of tasks) {
    inner.push(h('div', { style: row, key: t.id },
      h('div', null,
        h('span', { style: { ...pill, color: VERDICT_COLOUR[t.verdict] ?? '#8a93a3' } }, VERDICT_LABEL[t.verdict] ?? t.verdict),
        h('span', { style: { fontWeight: 600 } }, t.id),
        h('span', { style: { ...muted, marginLeft: '6px' } }, duration(t.elapsedMs)),
      ),
      h('div', { style: { ...muted, marginTop: '3px', wordBreak: 'break-all' } }, t.label),
      h('div', { style: { marginTop: '3px' } }, t.summary),
      t.progress === null
        ? h('div', { style: { ...muted, marginTop: '3px' } }, '（无活动数据：观察模式 ' + (state === null ? '?' : state.observe) + '，未采集输出）')
        : null,
    ))
  }

  children.push(h('div', { style: body, key: 'b' }, ...inner))
  return h('div', { style: panel, role: 'dialog', 'aria-label': '指挥台' }, ...children)
}
