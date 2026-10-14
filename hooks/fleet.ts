// Every Claude session on this computer, read without any other mod: the engine
// keeps one registry file per running session (~/.claude/sessions/<pid>.json),
// and `ps` says which of those processes still run and on which terminal.
// When the sessions mod is loaded its richer list is used instead (adapted here).
// Pure: no `$` here, so it is tested on its own.

import type { SessionGroup, SessionRow } from '../types'

type Fields = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

// The engine's word for a session's state, sorted by what it asks of the person.
export function groupOf(state: string): SessionGroup {
  if (state === 'waiting' || state === 'blocked') return 'needs'
  if (state === 'busy' || state === 'working') return 'working'
  return 'idle'
}

// `ps -o pid=,tty=` output: pid to terminal device, null for a process with none.
export function parsePs(stdout: string): Map<number, string | null> {
  const found = new Map<number, string | null>()
  for (const line of stdout.split('\n')) {
    const [pid, tty] = line.trim().split(/\s+/)
    if (pid === undefined || !/^\d+$/.test(pid)) continue
    found.set(Number(pid), tty === undefined || tty === '??' || tty === '?' || tty === '' ? null : `/dev/${tty}`)
  }
  return found
}

// Registry files whose process still runs, as rows. Without `ps` (null) nothing can be
// told apart from a file a crashed session left behind, so none is listed: the board
// files of sessions that run this mod still put them on the map.
export function rowsFromRegistry(registry: readonly Fields[], ps: ReadonlyMap<number, string | null> | null, own: string, now: number): SessionRow[] {
  if (ps === null) return []
  const rows: SessionRow[] = []
  const seen = new Set<string>()
  for (const raw of registry) {
    const pid = num(raw.pid)
    const sessionId = str(raw.sessionId)
    if (pid === null || sessionId === '' || !ps.has(pid) || seen.has(sessionId)) continue
    seen.add(sessionId)
    const state = str(raw.status) || 'idle'
    const group = groupOf(state)
    rows.push({
      sessionId,
      jobId: null,
      name: str(raw.name) || base(str(raw.cwd)) || sessionId.slice(0, 8),
      cwd: str(raw.cwd),
      pid,
      tty: ps.get(pid) ?? null,
      state,
      group,
      since: num(raw.statusUpdatedAt) ?? num(raw.startedAt) ?? now,
      summary: group === 'needs' ? oneLine(str(raw.waitingFor)) || 'waiting for you' : '',
      isSelf: sessionId === own,
      usage: null,
    })
  }
  return rows
}

const GROUPS = new Set<SessionGroup>(['needs', 'working', 'idle'])

// The sessions mod's rows, in the shape this mod knows; anything else reads as no rows.
export function adaptSessionRows(v: unknown): SessionRow[] {
  if (!Array.isArray(v)) return []
  const rows: SessionRow[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Fields
    const sessionId = str(o.sessionId)
    const group = o.group as SessionGroup
    if (sessionId === '' || !GROUPS.has(group)) continue
    const u = o.usage as Fields | null
    rows.push({
      sessionId,
      jobId: str(o.jobId) || null,
      name: str(o.name),
      cwd: str(o.cwd),
      pid: num(o.pid),
      tty: str(o.tty) || null,
      state: str(o.state),
      group,
      since: num(o.since) ?? 0,
      summary: str(o.summary),
      isSelf: o.isSelf === true,
      usage: u !== null && typeof u === 'object' ? { contextPercent: num(u.contextPercent), costUsd: num(u.costUsd) } : null,
    })
  }
  return rows
}

export function adaptHidden(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/* ---------- bringing another session's terminal forward ---------- */

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Each window in a `try`: a window with no tabs (Settings) fails the loop otherwise.
// A window minimised to the Dock comes back first; raising it alone leaves it there.
export const FOCUS_TERMINAL = [
  'on run argv',
  'set target to item 1 of argv',
  'if application "Terminal" is not running then return "none"',
  'tell application "Terminal"',
  'repeat with w in windows',
  'try',
  'repeat with t in tabs of w',
  'if tty of t is target then',
  'if miniaturized of w then set miniaturized of w to false',
  'set selected of t to true',
  'set index of w to 1',
  'activate',
  'return "ok"',
  'end if',
  'end repeat',
  'end try',
  'end repeat',
  'end tell',
  'return "none"',
  'end run',
]

export const FOCUS_ITERM = [
  'on run argv',
  'set target to item 1 of argv',
  'if application "iTerm2" is not running then return "none"',
  'tell application "iTerm2"',
  'repeat with w in windows',
  'try',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if tty of s is target then',
  'tell w to select',
  'tell t to select',
  'tell s to select',
  'activate',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end try',
  'end repeat',
  'end tell',
  'return "none"',
  'end run',
]

export const OPEN_ITERM = [
  'on run argv',
  'tell application "iTerm"',
  'activate',
  'set w to (create window with default profile)',
  'tell current session of w to write text (item 1 of argv)',
  'end tell',
  'return "ok"',
  'end run',
]

export const OPEN_TERMINAL = [
  'on run argv',
  'tell application "Terminal"',
  'activate',
  'do script (item 1 of argv)',
  'end tell',
  'return "ok"',
  'end run',
]

// The tmux pane on a terminal device, from `tmux list-panes -a -F` with TMUX_PANES:
// tab-separated, as a session's name may hold spaces.
export const TMUX_PANES = '#{pane_tty}\t#{session_name}\t#{window_id}\t#{pane_id}'

export function tmuxPaneOn(listPanes: string, tty: string): { session: string; windowId: string; paneId: string } | null {
  const hit = listPanes.split('\n').map(l => l.trim().split('\t')).find(p => p[0] === tty)
  if (hit === undefined) return null
  const [, session = '', windowId = '', paneId = ''] = hit
  return session === '' || windowId === '' || paneId === '' ? null : { session, windowId, paneId }
}
