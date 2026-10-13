// The Agent Map's model: every Claude session on this computer and what each one
// started, drawn from this session's own state, the other sessions' board files and
// the session list (the engine's registry, or the sessions mod). Pure: no `$` here, so it is tested on its own.

import type { FleetFile, Job, Loop, MapNode, NodeKind, NodeStatus, Progress } from '../types'

export type { FleetFile, MapNode, NodeKind, NodeStatus, Progress }
export type SessionStatus = 'running' | 'waiting' | 'stuck' | 'idle'

export type MapSession = {
  sessionId: string
  name: string
  branch: string
  cwd: string
  isSelf: boolean
  // It runs this mod, so it publishes what it started; else only the session list's word.
  hasMap: boolean
  status: SessionStatus
  doing: string
  why: string
  since: number
  contextPercent: number | null
  costUsd: number | null
  nodes: MapNode[]
}

export type MapNeed = {
  sessionId: string
  nodeId: string | null
  where: string
  why: string
  since: number
  kind: 'wait' | 'stuck'
  isSelf: boolean
}

type Fields = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const numOr = (v: unknown, or: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : or)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/* ---------- terminal cells ---------- */

// Terminal cells a character takes: two for CJK, fullwidth forms and emoji, one otherwise.
function cellsOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
  return isWide ? 2 : 1
}

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += cellsOf(ch)
  return n
}

// Cut to n terminal cells, an ellipsis marking the cut.
export function fit(s: string, n: number): string {
  const t = oneLine(s)
  if (n <= 0) return ''
  if (cellWidth(t) <= n) return t
  let out = ''
  let used = 0
  for (const ch of t) {
    if (used + cellsOf(ch) > n - 1) break
    out += ch
    used += cellsOf(ch)
  }
  return `${out}…`
}

// Up to maxLines lines of n cells, broken at spaces where it can; the last one cut with an ellipsis.
export function wrap(s: string, n: number, maxLines: number): string[] {
  let rest = oneLine(s)
  const out: string[] = []
  if (n <= 0) return out
  while (rest !== '' && out.length < maxLines) {
    if (cellWidth(rest) <= n) {
      out.push(rest)
      break
    }
    if (out.length === maxLines - 1) {
      out.push(fit(rest, n))
      break
    }
    let take = ''
    let used = 0
    for (const ch of rest) {
      if (used + cellsOf(ch) > n) break
      take += ch
      used += cellsOf(ch)
    }
    const space = take.lastIndexOf(' ')
    const cut = space > n / 3 ? take.slice(0, space) : take
    out.push(cut.trimEnd())
    rest = rest.slice(cut.length).trimStart()
  }
  return out
}

// How long, for a clock beside a row: 0:42 and 12:05 under an hour, then 1h05m, then 2d.
export function dur(ms: number): string {
  if (ms < 60 * 60_000) {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  return span(ms)
}

// A span in words: 45s, 12m, 1h05m, 2d.
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d`
}

/* ---------- plain words ---------- */

const TEST_RE = /\b(test|tests|vitest|jest|pytest|playwright|mocha|rspec|phpunit)\b/i
const LINT_RE = /\b(lint|eslint|prettier|ruff|clippy|stylelint)\b/i
const TYPECHECK_RE = /\b(tsc|mypy|pyright|type-?check)\b/i
const BUILD_RE = /\b(build|compile|webpack|esbuild|make)\b/i
const INSTALL_RE = /\b(npm (i|install|ci)|pnpm (i|install|add)|yarn( add| install)?|bun (i|install|add)|pip3? install|brew install|cargo add)\b/i

const READ_CMDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'wc'])
const SEARCH_CMDS = new Set(['grep', 'egrep', 'rg', 'ag', 'ack'])
const LIST_CMDS = new Set(['ls', 'find', 'fd', 'tree'])

// A shell command that only looks at the code, by its first command: "reading pricing.ts",
// "searching the code", "listing files". Anything else is null.
export function lookStep(command: string): string | null {
  // The first real command: past a `cd` and a loop's head (`cd src && for f in a b; do cat $f; done`).
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map(p => p.replace(/^(do|then)\s+/, ''))
  const first = parts.find(p => !/^(for|while|if|until|cd|pushd)\s/.test(p)) ?? ''
  const [cmd = '', ...args] = first.trim().split(/\s+/)
  const name = cmd.split('/').pop() ?? cmd
  if (name === 'git' && args[0] === 'ls-files') return 'listing files'
  if (name === 'git' && (args[0] === 'grep' || args[0] === 'log' && args.includes('-S'))) return 'searching the code'
  if (LIST_CMDS.has(name)) return 'listing files'
  if (SEARCH_CMDS.has(name)) return 'searching the code'
  if (READ_CMDS.has(name) || (name === 'sed' && args.includes('-n'))) {
    // Not an option, a line range, a quoted script or a shell variable.
    const file = args.filter(a => !a.startsWith('-') && !/^\d+(,\d+)?p?$/.test(a) && !a.startsWith("'") && !a.replace(/"/g, '').startsWith('$')).pop()
    return file === undefined ? 'reading files' : `reading ${file.replace(/["']/g, '').split('/').pop() ?? file}`
  }
  return null
}

// What a call is doing, the way a person would say it.
export function plainStep(tool: string, detail: string): string {
  const d = oneLine(detail)
  switch (tool) {
    case 'Read':
      return d === '' ? 'reading a file' : `reading ${d}`
    case 'Grep':
    case 'Glob':
      return d === '' ? 'searching the code' : `searching for ${d}`
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return d === '' ? 'editing a file' : `editing ${d}`
    case 'Bash': {
      const isBackground = d.endsWith('(background)')
      const core = d.replace(/\s*\(background\)$/, '')
      // Looking at the code first: `grep -rn "test" src` searches, it does not run tests.
      const what = lookStep(core) ?? (TEST_RE.test(core) ? 'running tests'
        : LINT_RE.test(core) ? 'checking style'
          : TYPECHECK_RE.test(core) ? 'type-checking'
            : INSTALL_RE.test(core) ? 'installing packages'
              : BUILD_RE.test(core) ? 'building'
                : /^git\s/.test(core) ? `git ${core.replace(/^git\s+/, '')}`
                  : core === '' ? 'running a command'
                    // A description the model wrote ("Rebuild the site") reads as it is; a bare command gets "running".
                    : /^[A-Z][a-z]+\s/.test(core) ? `${core.charAt(0).toLowerCase()}${core.slice(1)}`
                      : `running ${core}`)
      return isBackground ? `${what} in the background` : what
    }
    case 'WebFetch':
      return `reading ${d.split('/')[0] || 'a web page'}`
    case 'WebSearch':
      return d === '' ? 'searching the web' : `searching the web for ${d}`
    case 'Agent':
      return d === '' ? 'starting an agent' : `starting ${d}`
    case 'Skill':
      return d === '' ? 'using a skill' : `using /${d}`
    case 'AskUserQuestion':
      return 'asking you a question'
    case 'ExitPlanMode':
      return 'waiting for you to approve a plan'
    case 'SendMessage':
      return 'messaging a teammate'
    case 'SubagentHandback':
      return 'handing back its answer'
    case 'TaskOutput':
      return 'reading a background task'
    default:
      // savvy-progress's own report tool: the bar already says it.
      if (tool === 'step' && d === 'savvy-progress') return 'reporting progress'
      return d === '' ? tool : `${tool} (${d})`
  }
}

/* ---------- stuck ---------- */

// Working with no new step this long: maybe stuck (a long think stays under it).
export const STUCK_QUIET_MS = 10 * 60_000
// One foreground step running this long: maybe stuck.
export const STUCK_STEP_MS = 20 * 60_000
export const REPEAT_FAILS = 3

type Step = Pick<Job, 'tool' | 'detail' | 'startedAt' | 'endedAt' | 'isError' | 'taskId' | 'need'>

// Why one worker (the main loop or a subagent) may be stuck, from its own calls in order; '' when it looks fine.
export function stuckReason(steps: readonly Step[], isWorking: boolean, now: number): string {
  if (!isWorking) return ''
  const ended = steps.filter(s => s.endedAt !== null)
  const last = ended[ended.length - 1]
  if (last !== undefined && last.isError) {
    let n = 0
    for (let i = ended.length - 1; i >= 0; i--) {
      const s = ended[i]
      if (s === undefined || !s.isError || s.tool !== last.tool || s.detail !== last.detail) break
      n += 1
    }
    if (n >= REPEAT_FAILS) return `the same ${last.tool} failed ${n} times in a row: ${last.detail}`
  }
  // Background shells, waits on the person and subagents run long on purpose.
  const live = steps.filter(s => s.endedAt === null && s.taskId === null && s.need === null && s.tool !== 'Agent')
  const oldest = live.reduce<Step | null>((a, s) => (a === null || s.startedAt < a.startedAt ? s : a), null)
  if (oldest !== null) {
    return now - oldest.startedAt > STUCK_STEP_MS ? `one step has run for ${span(now - oldest.startedAt)}: ${oldest.tool} ${oldest.detail}` : ''
  }
  if (steps.some(s => s.endedAt === null)) return ''
  const lastAt = steps.reduce((a, s) => Math.max(a, s.endedAt ?? s.startedAt), 0)
  if (lastAt > 0 && now - lastAt > STUCK_QUIET_MS) return `no new step for ${span(now - lastAt)}`
  return ''
}

/* ---------- other mods' state, read only if it has the shape we know ---------- */

export type SavvyRun = { agentId: string; description: string; done: number | null; total: number | null; note: string; costUsd: number | null }

// savvy-progress's `agents`: each worker's own step reports and an estimated cost.
export function adaptSavvy(raw: unknown): SavvyRun[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    if (v === null || typeof v !== 'object') return []
    const o = v as Fields
    const agentId = str(o.agentId) || str(o.id)
    const description = str(o.description)
    if (agentId === '' && description === '') return []
    return [{ agentId, description, done: numOr(o.stepDone, null), total: numOr(o.stepTotal, null), note: str(o.stepNote), costUsd: numOr(o.costUsd, null) }]
  })
}

export type FlightRun = { id: string; tokens: number | null }
export type FlightLoop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

// flightdeck's `agents`: each subagent's live context size.
export function adaptFlightAgents(raw: unknown): FlightRun[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    if (v === null || typeof v !== 'object') return []
    const o = v as Fields
    const id = str(o.id)
    return id === '' ? [] : [{ id, tokens: numOr(o.ctx, null) }]
  })
}

// flightdeck's `loops`: model loops no subagent card claims, workflow agents among them.
export function adaptFlightLoops(raw: unknown): FlightLoop[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    if (v === null || typeof v !== 'object') return []
    const o = v as Fields
    const id = str(o.id)
    const firstAt = numOr(o.firstAt, null)
    const lastAt = numOr(o.lastAt, null)
    if (id === '' || firstAt === null || lastAt === null) return []
    return [{ id, steps: numOr(o.steps, 0) ?? 0, firstAt, lastAt, isDone: o.isDone === true }]
  })
}

/* ---------- this session's nodes ---------- */

export type AgentLike = {
  id: string
  type: string
  purpose: string
  status: string
  isLive: boolean
  from: number
  to: number | null
  step: string
  result: string
}

const AGENT_STATUS: Record<string, NodeStatus> = {
  running: 'running', pending: 'running', waiting: 'waiting', idle: 'idle',
  completed: 'done', ended: 'done', failed: 'failed', killed: 'failed',
}

export type SelfInput = {
  agents: readonly AgentLike[]
  jobs: readonly Job[]
  loops: readonly Loop[]
  savvy: readonly SavvyRun[]
  flightAgents: readonly FlightRun[]
  flightLoops: readonly FlightLoop[]
  now: number
}

// What this session started: its subagents, background shells, loops and workflow agents.
export function selfNodes(input: SelfInput): MapNode[] {
  const { now } = input
  const nodes: MapNode[] = []
  const savvyOf = (a: AgentLike): SavvyRun | undefined =>
    input.savvy.find(r => r.agentId !== '' && r.agentId === a.id) ?? input.savvy.find(r => r.agentId === '' && r.description !== '' && r.description === a.purpose)
  for (const a of input.agents) {
    const own = input.jobs.filter(j => j.agentId === a.id)
    const live = own.filter(j => j.endedAt === null)
    const current = live[live.length - 1] ?? own[own.length - 1]
    const baseStatus = AGENT_STATUS[a.status] ?? (a.isLive ? 'running' : 'done')
    const stuck = baseStatus === 'running' ? stuckReason(own, true, now) : ''
    const waitJob = live.find(j => j.need !== null)
    const status: NodeStatus = waitJob !== undefined ? 'waiting' : stuck !== '' ? 'stuck' : baseStatus
    const s = savvyOf(a)
    const f = input.flightAgents.find(r => r.id === a.id)
    const now0 = current === undefined ? (a.step === '' ? '' : a.step) : plainStep(current.tool, current.detail)
    nodes.push({
      id: a.id,
      kind: 'agent',
      title: `${a.type} · ${a.purpose || 'subagent'}`,
      status,
      now: status === 'idle' ? 'waiting for its next task' : status === 'done' ? 'finished' : status === 'failed' ? 'failed' : now0,
      raw: current === undefined ? a.step : `${current.tool} ${current.detail}`,
      why: waitJob?.need?.text ?? (status === 'waiting' ? 'waiting for you' : stuck !== '' ? stuck : a.result),
      from: a.from,
      to: a.to,
      progress: s !== undefined && s.total !== null && s.total > 0 ? { done: Math.min(s.done ?? 0, s.total), total: s.total, note: s.note } : null,
      costUsd: s?.costUsd ?? null,
      tokens: f?.tokens ?? null,
    })
  }
  for (const j of input.jobs) {
    if (j.taskId === null || j.endedAt !== null || j.agentId !== null) continue
    const command = j.detail.replace(/\s*\(background\)$/, '')
    nodes.push({
      id: `job:${j.id}`, kind: 'job', title: `shell · ${command}`, status: 'running',
      now: plainStep(j.tool, j.detail), raw: `${j.tool} ${j.detail}`, why: '', from: j.startedAt, to: null,
      progress: null, costUsd: null, tokens: null,
    })
  }
  for (const l of input.loops) {
    if (l.endedAt !== null) continue
    const next = l.nextAt === null ? 'no next run booked' : l.nextAt <= now ? 'due now' : `next run in ${span(l.nextAt - now)}`
    nodes.push({
      id: `loop:${l.id}`, kind: 'loop', title: `loop · ${l.every || 'repeats'}`, status: 'idle',
      now: next, raw: l.prompt, why: l.prompt, from: l.startedAt ?? now, to: null, progress: null, costUsd: null, tokens: null,
    })
  }
  for (const w of input.flightLoops) {
    if (w.isDone || now - w.lastAt > 10 * 60_000) continue
    nodes.push({
      id: `workflow:${w.id}`, kind: 'workflow', title: 'workflow agent', status: 'running',
      now: `${w.steps} model step${w.steps === 1 ? '' : 's'} so far`, raw: '', why: 'seen by flightdeck', from: w.firstAt, to: null,
      progress: null, costUsd: null, tokens: null,
    })
  }
  return nodes
}

/* ---------- every session ---------- */

// A session list row, as far as the map needs.
export type RowLike = {
  sessionId: string
  name: string
  cwd: string
  group: 'needs' | 'working' | 'idle'
  state: string
  since: number
  summary: string
  isSelf: boolean
  usage: { contextPercent: number | null; costUsd: number | null } | null
}

// The engine's word for a session's state, in plain words.
const STATE_WORDS: Record<string, string> = { busy: 'working', working: 'working', waiting: 'waiting for you', blocked: 'blocked', idle: 'idle', done: 'finished', failed: 'failed', stopped: 'stopped' }
export function stateWord(state: string): string {
  return STATE_WORDS[state] ?? state
}

const NODE_KINDS = new Set<NodeKind>(['agent', 'job', 'loop', 'workflow'])
const NODE_STATUSES = new Set<NodeStatus>(['running', 'waiting', 'stuck', 'idle', 'done', 'failed'])

// A node as read off another session's file, shaped or refused.
export function asMapNode(v: unknown): MapNode | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Fields
  const id = str(o.id)
  const kind = o.kind as NodeKind
  const status = o.status as NodeStatus
  if (id === '' || !NODE_KINDS.has(kind) || !NODE_STATUSES.has(status)) return null
  const p = o.progress as Fields | null
  const total = p !== null && typeof p === 'object' ? numOr(p.total, null) : null
  return {
    id, kind, status,
    title: str(o.title), now: str(o.now), raw: str(o.raw), why: str(o.why),
    from: numOr(o.from, 0) ?? 0, to: numOr(o.to, null),
    progress: total !== null && total > 0 && p !== null ? { done: numOr(p.done, 0) ?? 0, total, note: str(p.note) } : null,
    costUsd: numOr(o.costUsd, null), tokens: numOr(o.tokens, null),
  }
}

export type SelfSession = {
  sessionId: string
  name: string
  cwd: string
  branch: string
  status: SessionStatus
  doing: string
  why: string
  since: number
  nodes: MapNode[]
}

const RANK: Record<SessionStatus, number> = { waiting: 0, stuck: 1, running: 2, idle: 3 }
const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

// The whole map: this session first, then the rest by what they ask of the person, then by name.
// Files are trusted for sessions that run this mod; the session list fills in the rest.
// A wait the session list has seen for longer than `freshMs` is old news (a dead background job): idle here.
export function buildMap(self: SelfSession, files: readonly FleetFile[], rows: readonly RowLike[], hidden: readonly string[], now: number, staleMs: number, freshMs = 24 * 60 * 60 * 1000): MapSession[] {
  const skip = new Set(hidden)
  const rowOf = new Map(rows.map(r => [r.sessionId, r]))
  const selfRow = rowOf.get(self.sessionId) ?? rows.find(r => r.isSelf)
  const out: MapSession[] = [{
    sessionId: self.sessionId, name: self.name, branch: self.branch, cwd: self.cwd, isSelf: true, hasMap: true,
    status: self.status, doing: self.doing, why: self.why, since: self.since,
    contextPercent: selfRow?.usage?.contextPercent ?? null, costUsd: selfRow?.usage?.costUsd ?? null, nodes: self.nodes,
  }]
  const seen = new Set([self.sessionId])
  const others: MapSession[] = []
  for (const f of files) {
    if (seen.has(f.sessionId) || skip.has(f.sessionId) || now - f.heartbeatAt > staleMs) continue
    seen.add(f.sessionId)
    const r = rowOf.get(f.sessionId)
    const status: SessionStatus = f.state === 'needs' ? 'waiting' : f.stuck !== '' ? 'stuck' : f.state === 'working' ? 'running' : 'idle'
    others.push({
      sessionId: f.sessionId, name: r?.name || f.name || base(f.cwd), branch: f.branch, cwd: f.cwd, isSelf: false, hasMap: true,
      status, doing: f.doing, why: status === 'waiting' ? f.doing : status === 'stuck' ? f.stuck : '', since: r?.since ?? f.heartbeatAt,
      contextPercent: r?.usage?.contextPercent ?? null, costUsd: r?.usage?.costUsd ?? null, nodes: f.nodes,
    })
  }
  for (const r of rows) {
    if (seen.has(r.sessionId) || skip.has(r.sessionId) || r.isSelf) continue
    seen.add(r.sessionId)
    const isOld = r.group === 'needs' && now - r.since > freshMs
    const status: SessionStatus = r.group === 'needs' && !isOld ? 'waiting' : r.group === 'working' ? 'running' : 'idle'
    others.push({
      sessionId: r.sessionId, name: r.name || base(r.cwd), branch: '', cwd: r.cwd, isSelf: false, hasMap: false,
      status, doing: isOld ? `${r.summary || stateWord(r.state)} (old)` : r.summary || stateWord(r.state), why: status === 'waiting' ? (r.summary || stateWord(r.state)) : '', since: r.since,
      contextPercent: r.usage?.contextPercent ?? null, costUsd: r.usage?.costUsd ?? null, nodes: [],
    })
  }
  others.sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name))
  return [...out, ...others]
}

// Everything that needs the person, across the map: waits first, then what may be stuck; oldest first.
export function needsOf(map: readonly MapSession[]): MapNeed[] {
  const list: MapNeed[] = []
  for (const s of map) {
    if (s.status === 'waiting' || s.status === 'stuck') {
      list.push({ sessionId: s.sessionId, nodeId: null, where: s.isSelf ? 'this session' : s.name, why: s.why || s.doing, since: s.since, kind: s.status === 'waiting' ? 'wait' : 'stuck', isSelf: s.isSelf })
    }
    for (const n of s.nodes) {
      if (n.status !== 'waiting' && n.status !== 'stuck') continue
      list.push({ sessionId: s.sessionId, nodeId: n.id, where: `${s.isSelf ? '' : `${s.name} › `}${n.title.split(' · ')[0] ?? n.title}`, why: n.why || n.now, since: n.from, kind: n.status === 'waiting' ? 'wait' : 'stuck', isSelf: s.isSelf })
    }
  }
  return list.sort((a, b) => (a.kind === b.kind ? a.since - b.since : a.kind === 'wait' ? -1 : 1))
}

export type Zoom = 'cards' | 'lines' | 'dots'

// The densest view that still fits: a card is about three rows, a line one, a session of dots one.
export function autoZoom(map: readonly MapSession[], needs: number, rows: number): Zoom {
  const nodes = map.reduce((n, s) => n + s.nodes.length, 0)
  const head = 8 + Math.min(needs, 6)
  if (head + (map.length + nodes) * 3 <= rows) return 'cards'
  if (head + map.length + nodes <= rows) return 'lines'
  return 'dots'
}

/* ---------- the desktop's drawing ---------- */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const STROKE: Record<NodeStatus, string> = { running: '#4a8fd6', waiting: '#c99a16', stuck: '#d47a2a', idle: '#9aa5b1', done: '#4f9a66', failed: '#c0473b' }
const MARK: Record<NodeStatus, string> = { running: '●', waiting: '!', stuck: '?', idle: '○', done: '✓', failed: '✗' }

// Sessions left, what each started right, joined by curves: one picture of the whole map.
// A self-contained card look (its own fills) so it reads on a light or a dark desktop.
// `maxWidth` is the pane's width in CSS pixels; the drawing takes it (within 380 to 760) so labels get the room there is.
export function graphSvg(map: readonly MapSession[], now: number, maxWidth = 434): { source: string; height: number; width: number } {
  const ROW = 54
  const GAP = 44
  const W = Math.max(380, Math.min(760, Math.round(maxWidth)))
  const SW = Math.round((W - GAP - 4) * 0.4)
  const CW = W - GAP - 4 - SW
  const PX = 7 // a terminal cell's worth of a 12px label, a little generous so labels never run into the clock
  const parts: string[] = []
  const wires: string[] = []
  let y = 4
  const box = (x: number, top: number, w: number, h: number, status: NodeStatus, line1: string, line2: string, clock: string, isSelf: boolean, progress: Progress | null): string => {
    const clockCells = clock === '' ? 0 : cellWidth(clock) + 1
    const room = Math.floor((w - 22) / PX)
    const t1 = fit(`${MARK[status]} ${line1}`, room - clockCells)
    const t2 = fit(line2, room)
    const fill = status === 'waiting' ? '#fff7dd' : isSelf ? '#eef4fb' : '#ffffff'
    let bar = ''
    if (progress !== null) {
      const bw = w - 24
      const fw = Math.round((bw * progress.done) / progress.total)
      // Below the second line's descenders, inside the box: the box is taller when it has a bar.
      bar = `<rect x="${x + 12}" y="${top + h - 7}" width="${bw}" height="3" rx="1.5" fill="#e3e7ec"/><rect x="${x + 12}" y="${top + h - 7}" width="${fw}" height="3" rx="1.5" fill="#9b59b6"/>`
    }
    return `<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${STROKE[status]}" stroke-width="${status === 'waiting' || status === 'stuck' ? 2 : 1.2}"/>` +
      `<text x="${x + 10}" y="${top + 17}" font-family="-apple-system, Segoe UI, sans-serif" font-size="12" font-weight="600" fill="#1d2329">${esc(t1)}</text>` +
      (clock === '' ? '' : `<text x="${x + w - 9}" y="${top + 17}" text-anchor="end" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#5b6670">${esc(clock)}</text>`) +
      `<text x="${x + 10}" y="${top + 32}" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#5b6670">${esc(t2)}</text>` + bar
  }
  for (const s of map) {
    const block = Math.max(1, s.nodes.length) * ROW
    const sy = y + block / 2 - 21
    const sClock = span(now - s.since)
    parts.push(box(2, sy, SW, 42, s.status, s.isSelf ? `${s.name} (here)` : s.name, s.why || s.doing || s.branch, sClock, s.isSelf, null))
    s.nodes.forEach((n, j) => {
      const cy = y + j * ROW + 4
      wires.push(`<path d="M${2 + SW},${sy + 21} C${SW + 24},${sy + 21} ${SW + GAP - 20},${cy + 20} ${SW + GAP},${cy + 20}" fill="none" stroke="${n.status === 'running' ? '#4a8fd6' : '#b4bcc6'}" stroke-width="1.5"${n.status === 'running' ? ' stroke-dasharray="4 3"' : ''}/>`)
      parts.push(box(SW + GAP, cy, CW, n.progress === null ? 40 : 46, n.status, n.title, n.status === 'waiting' || n.status === 'stuck' ? n.why : n.now, n.to !== null ? '' : n.kind === 'loop' ? '' : span(now - n.from), false, n.progress))
    })
    y += block + 12
  }
  const height = Math.max(y, 60)
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">${wires.join('')}${parts.join('')}</svg>`, height, width: W }
}
