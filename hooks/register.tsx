import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type {
  AgentCard, AgentRow, Ask, CatalogEntry, Choice, FleetFile, Goal, Hub, HubMessage, HubState, Job, JumpNote, Launch, Loop, MainState, Need, NeedKind, Peek, PeekLine, SessionRow, Task, View,
} from '../types'
import {
  addCard, adoptCards, agentFromMarkdown, callerOf, catalogSections, dotColor, filterCatalog, finishCard, mergeOffer, newCard, noteStep, PENDING_ID, pruneCards, purposeOf,
  replaceSkills, roleFor, skillsFrom, typeOf,
} from './agents'
import { answersOf, asksOfInput, pick as pickChoice, replyAskOf } from './asks'
import { asHubFile, bareMembers, HUB_STALE_MS, hubDir, hubNote, hubReport, newMessage, NODES_MAX, pushOutbox, readHub, resolveRecipient, unread } from './hub'
import type { HubFile } from './hub'
import { adaptHidden, adaptSessionRows, FOCUS_ITERM, FOCUS_TERMINAL, OPEN_ITERM, OPEN_TERMINAL, parsePs, rowsFromRegistry, shellQuote, TMUX_PANES, tmuxPaneOn } from './fleet'
import { activeLoops, addCron, addWakeup, endLoop, fired, pruneLoops, reconcile } from './loops'
import {
  adaptFlightAgents, adaptFlightLoops, adaptSavvy, autoZoom, buildMap, cellWidth, dur, fit, graphSvg, needsOf, plainStep, selfNodes, span, stateWord, stuckReason, wrap,
} from './map'
import type { FleetFile as MapFleetFile, MapNeed, MapNode, MapSession, SelfSession, Zoom } from './map'
import { mask, recordingTerms } from './mask'

export { cellWidth, fit, span, wrap }

const PANE = 'ringside'
const SELF = 'ringside'
const TITLE = 'Ringside'
const HUB_TOOL = 'mcp__ringside__hub'
// Ended work stays listed this long, so you see what finished while you looked away.
const ENDED_KEEP_MS = 10 * 60 * 1000
// A call that succeeded faster than this is counted, not listed.
const QUICK_MS = 3_000
const MAX_JOBS = 80
const SHOWN_RUNNING = 8
const SHOWN_ENDED = 4
const SHOWN_LIVE_AGENTS = 6
const SHOWN_ENDED_AGENTS = 4
const SHOWN_TASKS = 60
const SHOWN_LAUNCH = 12
// A background session done or blocked for longer than this: no longer listed on the map.
const BACKGROUND_DONE_KEEP_MS = 24 * 60 * 60 * 1000
const SHOWN_MESSAGES = 6
// A call still open this long never came back (its turn was cut off): no longer listed.
const LOST_CALL_MS = 3 * 60 * 60 * 1000
const HEARTBEAT_TICKS = 10
const HUB_READ_TICKS = 5
const BRANCH_TICKS = 60
const TIDY_TICKS = 60 * 60
// A board file not written for this many days is a session long gone.
const BOARD_KEEP_DAYS = 7
const REGISTRY_RESCAN_MS = 30_000
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Instant bookkeeping tools: shown as task progress instead of as jobs.
const QUIET = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'])
const ENDED_AGENT = new Set(['completed', 'failed', 'killed', 'ended'])
const IDLE_MAIN: MainState = { isWorking: false, since: null, reply: null, replyAsk: null, waiting: null, waitingAt: null }
const NO_PEEK: Peek = { agentId: null, task: '', lines: [], error: '' }
const NO_LAUNCH: Launch = { isOpen: false, kind: 'agent', query: '', picked: null, note: '' }
const NO_HUB: Hub = { root: '', label: '', branch: '', members: [], messages: [], to: 'all', wake: false, note: '' }
const NO_VIEW: View = { tab: 'map', zoom: 'auto', sel: null, confirm: null }
const SHOWN_PEEK = 8
// Another session blocked longer than this is old news: the map does not list it.
const ELSEWHERE_FRESH_MS = 24 * 60 * 60 * 1000
// What the launcher knows before the engine first lists the agent types for the model.
const BUILTIN_AGENTS: CatalogEntry[] = [
  { kind: 'agent', name: 'general-purpose', description: 'General-purpose agent for researching complex questions and multi-step tasks.', source: 'built-in' },
  { kind: 'agent', name: 'Explore', description: 'Fast read-only search agent for locating code.', source: 'built-in' },
  { kind: 'agent', name: 'Plan', description: 'Software architect agent for designing implementation plans.', source: 'built-in' },
]
const HUB_TOOL_DESCRIPTION = [
  'The repo hub (Ringside): every Claude session working in this same git repository, and a shared board.',
  'action "read": each session here (state, branch, what it is doing, its loops and running subagents), this session\'s own loops,',
  'subagents and tasks, and the board\'s recent messages. Use it to monitor the repo or when the person asks for a status report.',
  'action "post": leave a note on the board for the person and the other sessions ("to": "all" by default, or a session name from read).',
  'Posts never start another session\'s turn. Sessions in other repositories are never included.',
].join(' ')

const jobs = atom({ plugin: 'ringside', key: 'jobs' } as const, [])
const goal = atom({ plugin: 'ringside', key: 'goal' } as const, { startedAt: null, tasks: [] })
const agents = atom({ plugin: 'ringside', key: 'agents' } as const, [])
const cardsAtom = atom({ plugin: 'ringside', key: 'cards' } as const, [])
const loopsAtom = atom({ plugin: 'ringside', key: 'loops' } as const, [])
const catalogAtom = atom({ plugin: 'ringside', key: 'catalog' } as const, BUILTIN_AGENTS)
const launchAtom = atom({ plugin: 'ringside', key: 'launch' } as const, NO_LAUNCH)
const hubAtom = atom({ plugin: 'ringside', key: 'hub' } as const, NO_HUB)
const main = atom({ plugin: 'ringside', key: 'main' } as const, IDLE_MAIN)
const peek = atom({ plugin: 'ringside', key: 'peek' } as const, NO_PEEK)
const cwdAtom = atom({ plugin: 'ringside', key: 'cwd' } as const, '')
// Claude's own folder: CLAUDE_CONFIG_DIR, else ~/.claude ('' until the session starts).
const homeAtom = atom({ plugin: 'ringside', key: 'claudeDir' } as const, '')
const isShown = atom({ plugin: 'ringside', key: 'isShown' } as const, false)
const fleetAtom = atom({ plugin: 'ringside', key: 'fleet' } as const, [])
const viewAtom = atom({ plugin: 'ringside', key: 'view' } as const, NO_VIEW)
// Other mods' state, read only if installed and only in the shape we know (see map.ts adapters).
const savvyAgents = atom({ plugin: 'savvy-progress', key: 'agents' } as never, [] as never)
const flightAgents = atom({ plugin: 'flightdeck', key: 'agents' } as never, [] as never)
const flightLoops = atom({ plugin: 'flightdeck', key: 'loops' } as never, [] as never)
// Every session on this computer as this mod reads it from the engine's registry.
const localSessions = atom({ plugin: 'ringside', key: 'sessions' } as const, [])
// The sessions mod's list and the ones the person hid there, used instead when that mod is loaded.
const sessionsModRows = atom({ plugin: 'sessions', key: 'rows' } as never, [] as never)
const sessionsModHidden = atom({ plugin: 'sessions', key: 'hidden' } as never, [] as never)

type Fields = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

function padEnd(s: string, n: number): string {
  const w = cellWidth(s)
  return w >= n ? s : s + ' '.repeat(n - w)
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m ago`
}

// The local wall clock, HH:MM.
export function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Fields of a tool.call input that name the call rather than its arguments.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId'])

export function toolLabel(tool: string): string {
  const parts = tool.split('__')
  return tool.startsWith('mcp__') && parts.length >= 3 ? (parts[parts.length - 1] ?? tool) : tool
}

export function describeCall(tool: string, input: Fields): string {
  switch (tool) {
    case 'Bash':
      return oneLine(str(input.description) || str(input.command))
    case 'Read':
    case 'Edit':
    case 'Write':
      return base(str(input.file_path))
    case 'NotebookEdit':
      return base(str(input.notebook_path))
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'Agent':
      return `${str(input.subagent_type) || 'agent'}: ${str(input.description)}`
    case 'WebFetch':
      return str(input.url).replace(/^https?:\/\//, '')
    case 'WebSearch':
      return str(input.query)
    case 'Skill':
      return str(input.skill)
    case 'AskUserQuestion':
      return 'waiting for your answer'
    default: {
      if (tool.startsWith('mcp__')) return tool.split('__')[1] ?? ''
      const first = Object.entries(input).find(([k, v]) => !ENVELOPE.has(k) && typeof v === 'string')?.[1]
      return typeof first === 'string' ? oneLine(first) : ''
    }
  }
}

// What a call blocks on until the person acts: a question, or a plan to approve.
export function needOf(tool: string, input: Fields): Need | null {
  if (tool === 'AskUserQuestion') {
    const first = Array.isArray(input.questions) ? (input.questions[0] as Fields | undefined) : undefined
    const question = oneLine(str(first?.question))
    const asks = asksOfInput(input)
    return { kind: 'question', text: question === '' ? "Answer Claude's question" : question, ...(asks.some(a => a.choices.length > 0) ? { asks } : {}) }
  }
  if (tool === 'ExitPlanMode') return { kind: 'plan', text: 'Approve or change the plan' }
  return null
}

// The question an answer ends on (its last two lines), so the person sees it is their turn.
export function lastQuestion(answer: string): string | null {
  const lines = answer.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('```'))
  const tail = lines.slice(-2).join(' ').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim()
  const end = Math.max(tail.lastIndexOf('?'), tail.lastIndexOf('？'))
  if (end < 0) return null
  const sentences = tail.slice(0, end + 1).split(/(?<=[.!。！:：])\s*/)
  const question = (sentences[sentences.length - 1] ?? '').trim()
  return question === '' ? null : question
}

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])

export function applyTaskCall(g: Goal, tool: string, input: Fields, result: Fields, now: number): Goal {
  const wasIdle = g.tasks.length === 0 || g.tasks.every(t => t.status === 'completed')
  let tasks: Task[] = g.tasks
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    tasks = (input.todos as Fields[]).map((t, i) => ({
      id: `todo-${i}`,
      subject: str(t.content),
      status: TASK_STATUSES.has(str(t.status)) ? (str(t.status) as Task['status']) : 'pending',
    }))
  } else if (tool === 'TaskCreate') {
    const created = result.task as Fields | undefined
    const id = str(created?.id)
    if (id !== '') tasks = [...tasks, { id, subject: str(created?.subject) || str(input.subject), status: 'pending' }]
  } else if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    const status = str(input.status)
    tasks = status === 'deleted'
      ? tasks.filter(t => t.id !== id)
      : tasks.map(t => t.id !== id ? t : {
        ...t,
        subject: str(input.subject) || t.subject,
        status: TASK_STATUSES.has(status) ? (status as Task['status']) : t.status,
      })
  } else {
    return g
  }
  const isActive = tasks.some(t => t.status !== 'completed')
  const startedAt = wasIdle && isActive ? now : tasks.length === 0 ? null : g.startedAt
  return { startedAt, tasks }
}

function isRunning(j: Job): boolean {
  return j.endedAt === null
}

// A background shell this session started: it runs until its notification, a
// TaskStop, or a Stop that no longer lists it says otherwise, however long that is.
const isOwnShell = (j: Job): boolean => j.taskId !== null && j.agentId === null

// Ended work leaves after ENDED_KEEP_MS; an open call after LOST_CALL_MS, unless
// it is a shell of this session's still running (a dev server may run all day).
export function isStale(j: Job, at: number): boolean {
  if (j.endedAt !== null) return at - j.endedAt > ENDED_KEEP_MS
  return !isOwnShell(j) && at - j.startedAt > LOST_CALL_MS
}

// A Stop lists the background work the session still holds: a shell of its own
// missing from that list has ended.
export function endGoneShells(list: readonly Job[], held: ReadonlySet<string>, now: number): Job[] {
  return list.map(j => (isOwnShell(j) && j.endedAt === null && !held.has(j.taskId ?? '') ? { ...j, endedAt: now } : j))
}

// Caps the list without dropping anything still running: a long background
// job must not fall off behind a burst of quick calls.
export function trimJobs(list: readonly Job[], max = MAX_JOBS): Job[] {
  if (list.length <= max) return [...list]
  const running = new Set(list.filter(isRunning).map(j => j.id))
  const room = Math.max(0, max - running.size)
  const endedList = list.filter(j => !isRunning(j))
  const kept = new Set((room === 0 ? [] : endedList.slice(-room)).map(j => j.id))
  return list.filter(j => running.has(j.id) || kept.has(j.id))
}

type AgentSeen = { id: string; type: string; description: string; status: string; parentId?: string }

// The engine's agent list folded into rows that remember when each was first
// seen and when it ended; ended rows stay for ENDED_KEEP_MS.
export function mergeAgents(prior: readonly AgentRow[], list: readonly AgentSeen[], now: number): AgentRow[] {
  const byId = new Map(prior.map(a => [a.id, a]))
  const seen = new Set<string>()
  const rows: AgentRow[] = list.map(a => {
    seen.add(a.id)
    const old = byId.get(a.id)
    const isEnded = ENDED_AGENT.has(a.status)
    return {
      id: a.id,
      label: `${a.type}: ${a.description}`,
      status: a.status,
      parentId: a.parentId ?? null,
      startedAt: old?.startedAt ?? now,
      endedAt: isEnded ? (old?.endedAt ?? now) : null,
    }
  })
  // The engine dropped these: whatever they were doing has ended.
  const dropped = prior
    .filter(a => !seen.has(a.id))
    .map(a => (a.endedAt === null ? { ...a, status: 'ended', endedAt: now } : a))
  return [...rows, ...dropped].filter(a => a.endedAt === null || now - a.endedAt < ENDED_KEEP_MS)
}

export type NowTone = 'need' | 'agent' | 'job' | 'ok' | 'failed' | 'stopped'

export type NowRow = {
  key: string
  tone: NowTone
  // '' draws the spinner.
  glyph: string
  text: string
  from: number | null
  to: number | null
  depth: number
  // The subagent a press on the row opens.
  agentId?: string
  // Another session waiting on the person: a press jumps to it.
  sessionId?: string
  // The question's choices, drawn as cards; `callId` is the call a pick answers.
  asks?: Ask[]
  callId?: string
}

export type NowGroups = { needs: NowRow[]; running: NowRow[]; ended: NowRow[]; quick: number; idleAgents: number }

// The main session's own calls, by what they ask of the person: blocked on them,
// running, then ended. Subagents have their own section; their calls are theirs.
export function groupNow(jobList: readonly Job[], agentList: readonly AgentRow[], m: MainState): NowGroups {
  const needs: NowRow[] = []
  const running: NowRow[] = []
  const ended: NowRow[] = []
  let quick = 0

  const agentIds = new Set(agentList.map(a => a.id))
  const labelOf = new Map(agentList.map(a => [a.id, a.label]))
  // The Agent call that started a subagent: the AGENTS section speaks for it.
  const isAgentCall = (j: Job): boolean => j.tool === 'Agent' && !j.isError
  const isInsideAgent = (j: Job): boolean => j.agentId !== null && agentIds.has(j.agentId)

  for (const j of jobList) {
    if (j.endedAt !== null || j.need === null) continue
    const owner = j.agentId === null ? '' : `${labelOf.get(j.agentId) ?? 'agent'}: `
    needs.push({
      key: `need:${j.id}`, tone: 'need', glyph: j.need.kind === 'plan' ? '!' : '?',
      text: `${owner}${j.need.text}`, from: j.startedAt, to: null, depth: 0,
      ...(j.agentId === null ? {} : { agentId: j.agentId }),
      ...(j.need.asks === undefined || j.need.asks.length === 0 ? {} : { asks: j.need.asks, callId: j.id }),
    })
  }
  for (const a of agentList) {
    if (a.endedAt !== null || a.status !== 'waiting') continue
    needs.push({ key: `need:agent:${a.id}`, tone: 'need', glyph: '!', text: `${a.label} is waiting for you`, from: a.startedAt, to: null, depth: 0, agentId: a.id })
  }
  // The engine's own word, for what no call shows (a permission prompt, a dialog).
  if (m.waiting !== null && needs.length === 0) {
    needs.push({ key: 'need:waiting', tone: 'need', glyph: '!', text: `Claude is waiting: ${m.waiting}`, from: m.waitingAt, to: null, depth: 0 })
  }
  if (!m.isWorking && m.reply !== null) {
    const ask = m.replyAsk ?? null
    needs.push({ key: 'need:reply', tone: 'need', glyph: '>', text: `Reply: ${m.reply}`, from: m.since, to: null, depth: 0, ...(ask === null ? {} : { asks: [ask] }) })
  }

  for (const j of jobList) {
    if (j.endedAt !== null || j.need !== null || isAgentCall(j) || isInsideAgent(j)) continue
    running.push({
      key: `job:${j.id}`, tone: 'job', glyph: '', text: `${j.tool} ${j.detail}`,
      from: j.startedAt, to: null, depth: j.agentId === null ? 0 : 1,
    })
  }

  for (const j of jobList) {
    if (j.endedAt === null || isAgentCall(j) || isInsideAgent(j)) continue
    const isNotable = j.isError || j.taskId !== null || j.endedAt - j.startedAt >= QUICK_MS
    if (!isNotable) {
      quick += 1
      continue
    }
    ended.push({
      key: `job:${j.id}`, tone: j.isError ? 'failed' : 'ok', glyph: j.isError ? 'x' : '✓',
      text: `${j.tool} ${j.detail}`, from: j.startedAt, to: j.endedAt, depth: 0,
    })
  }
  ended.sort((x, y) => (y.to ?? 0) - (x.to ?? 0))

  const idleAgents = agentList.filter(a => a.endedAt === null && a.status === 'idle').length
  return { needs, running, ended, quick, idleAgents }
}

// One subagent as the AGENTS section draws it: the engine's row joined with what its spawn said.
export type AgentView = {
  id: string
  type: string
  purpose: string
  status: string
  isLive: boolean
  from: number
  to: number | null
  card: AgentCard | null
  // What it is doing now: its newest running call, else its last one.
  step: string
}

export function agentViews(rows: readonly AgentRow[], cardList: readonly AgentCard[], jobList: readonly Job[]): AgentView[] {
  const cardOf = new Map(cardList.map(c => [c.id, c]))
  const stepOf = (id: string, card: AgentCard | null): string => {
    const live = jobList.filter(j => j.agentId === id && j.endedAt === null)
    const last = live[live.length - 1]
    return last === undefined ? (card?.lastStep ?? '') : `${last.tool} ${last.detail}`
  }
  const views: AgentView[] = rows.map(r => {
    const card = cardOf.get(r.id) ?? null
    const [type = 'agent', ...rest] = r.label.split(': ')
    return {
      id: r.id, type: card?.type ?? type, purpose: card?.purpose || rest.join(': '), status: r.status,
      isLive: r.endedAt === null, from: card?.startedAt ?? r.startedAt, to: r.endedAt, card, step: stepOf(r.id, card),
    }
  })
  // Spawned a moment ago and not listed yet, or ended and already dropped by the engine.
  const listed = new Set(rows.map(r => r.id))
  for (const c of cardList) {
    if (listed.has(c.id)) continue
    views.push({
      id: c.id, type: c.type, purpose: c.purpose, status: c.endedAt === null ? 'pending' : 'completed',
      isLive: c.endedAt === null, from: c.startedAt, to: c.endedAt, card: c, step: stepOf(c.id, c),
    })
  }
  const live = views.filter(v => v.isLive).sort((a, b) => a.from - b.from)
  const done = views.filter(v => !v.isLive).sort((a, b) => (b.to ?? 0) - (a.to ?? 0))
  return [...live, ...done]
}

// Other sessions on this computer waiting on the person, longest waiting first.
export function elsewhereNeeds(rows: readonly SessionRow[], hidden: readonly string[], now: number): NowRow[] {
  const skip = new Set(hidden)
  return rows
    .filter(r => !r.isSelf && r.group === 'needs' && !skip.has(r.sessionId) && now - r.since < ELSEWHERE_FRESH_MS)
    .slice()
    .sort((x, y) => x.since - y.since)
    .map(r => ({
      key: `need:session:${r.sessionId}`, tone: 'need' as const, glyph: '!', text: `${r.name}: ${r.summary || stateWord(r.state)}`,
      from: r.since, to: null, depth: 0, sessionId: r.sessionId,
    }))
}

// A loop in two lines: how often and since when; when next, how many runs, why it waits.
export function loopLines(l: Loop, now: number, isWorking: boolean): { head: string; detail: string } {
  const since = l.startedAt === null ? 'running' : `since ${clockOf(l.startedAt)} (${span(now - l.startedAt)})`
  const head = `${l.every || 'Loop'} · ${since}`
  const next = l.endedAt !== null
    ? `stopped ${ago(now - l.endedAt)}`
    : l.nextAt === null
      ? (l.kind === 'wakeup' ? (isWorking ? 'booking the next run…' : 'no next run booked') : 'no next run')
      : l.nextAt <= now
        ? 'due now (runs when Claude is idle)'
        : `next ${clockOf(l.nextAt)} (in ${span(l.nextAt - now)})`
  const parts = [
    next,
    l.fires > 0 ? `ran ${l.fires}×` : 'not run yet',
    l.lastFiredAt === null ? '' : `last ${clockOf(l.lastFiredAt)}`,
    l.kind === 'wakeup' && l.delaySeconds !== null && l.endedAt === null
      ? `waits ${span(l.delaySeconds * 1000)}${l.reason === '' ? '' : `: ${l.reason}`}`
      : '',
  ]
  return { head, detail: parts.filter(p => p !== '').join(' · ') }
}

// What this session tells the rest of the repo it is doing.
export function presenceOf(m: MainState, jobList: readonly Job[], g: Goal, agentList: readonly AgentRow[]): { state: HubState; doing: string; needKind?: NeedKind; asks?: Ask[] } {
  const groups = groupNow(jobList, agentList, m)
  const need = groups.needs[0]
  // The other maps draw its choices as cards; only the question an answer ended on is a 'reply'.
  if (need !== undefined) return { state: 'needs', doing: need.text, needKind: need.key === 'need:reply' ? 'reply' : 'ask', asks: need.asks ?? [] }
  const task = g.tasks.find(t => t.status === 'in_progress')
  if (m.isWorking || groups.running.length > 0 || agentList.some(a => a.endedAt === null && a.status === 'running')) {
    // In the same plain words as the session's own card ("running tests", "reading auth.ts").
    const job = jobList.filter(j => j.endedAt === null && j.need === null && j.agentId === null && j.tool !== 'Agent').slice(-1)[0]
    const agentsLive = agentList.filter(a => a.endedAt === null && a.status === 'running').length
    const doing = job !== undefined ? plainStep(job.tool, job.detail)
      : m.isWorking ? 'thinking'
        : `${agentsLive} agent${agentsLive === 1 ? '' : 's'} working in the background`
    return { state: 'working', doing: task?.subject ?? doing }
  }
  return { state: 'idle', doing: task === undefined ? '' : `paused on: ${task.subject}` }
}

// This session's own loops, subagents and tasks, for the hub tool's read.
export function selfSummary(loopList: readonly Loop[], views: readonly AgentView[], g: Goal, now: number): string {
  const lines: string[] = []
  const live = activeLoops(loopList)
  lines.push(live.length === 0 ? 'Loops: none.' : 'Loops:')
  for (const l of live) {
    const t = loopLines(l, now, false)
    lines.push(`- ${t.head}; ${t.detail}; prompt: ${fit(l.prompt, 160)}`)
  }
  lines.push(views.length === 0 ? 'Subagents: none recently.' : 'Subagents:')
  for (const v of views) {
    const by = v.card === null ? '' : `, called by ${v.card.calledBy}`
    const out = v.card !== null && v.card.result !== '' ? `; result: ${fit(v.card.result, 200)}` : v.step === '' ? '' : `; now: ${v.step}`
    lines.push(`- ${v.type} (${v.status}${by}): ${v.purpose}${out}`)
  }
  const done = g.tasks.filter(t => t.status === 'completed').length
  const doing = g.tasks.find(t => t.status === 'in_progress')
  lines.push(g.tasks.length === 0 ? 'Tasks: none.' : `Tasks: ${done}/${g.tasks.length} done${doing === undefined ? '' : `; in progress: ${doing.subject}`}.`)
  return lines.join('\n')
}

async function runQuiet($: EngineInterface, argv: readonly string[], timeoutMs = 10_000): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await $.process.run(argv, { timeoutMs })
    return { code: r.exitCode, out: r.stdout, err: r.stderr }
  } catch (error) {
    return { code: -1, out: '', err: String(error) }
  }
}

let hasOsa: boolean | undefined

// AppleScript, on macOS; 'none' elsewhere, so tmux's answer stands.
async function osa($: EngineInterface, lines: readonly string[], args: readonly string[]): Promise<string> {
  hasOsa ??= await $.fs.exists('/usr/bin/osascript').catch(() => false)
  if (!hasOsa) return 'none'
  const r = await runQuiet($, ['/usr/bin/osascript', ...lines.flatMap(l => ['-e', l]), ...args], 15_000)
  return r.code === 0 ? r.out.trim() : `error: ${oneLine(r.err)}`
}

let tmuxBin: string | null | undefined

// A new window running `command`, in iTerm2 when that is the person's terminal, else Terminal.
async function openWindow($: EngineInterface, command: string): Promise<string> {
  const isIterm = (await $.env.get('TERM_PROGRAM')) === 'iTerm.app'
  return osa($, isIterm ? OPEN_ITERM : OPEN_TERMINAL, [command])
}

async function findTmux($: EngineInterface): Promise<string | null> {
  if (tmuxBin !== undefined) return tmuxBin
  tmuxBin = null
  for (const path of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    if (await $.fs.exists(path).catch(() => false)) {
      tmuxBin = path
      break
    }
  }
  if (tmuxBin === null && (await runQuiet($, ['tmux', '-V'])).code === 0) tmuxBin = 'tmux'
  return tmuxBin
}

async function focusTty($: EngineInterface, tty: string): Promise<string> {
  const viaTerminal = await osa($, FOCUS_TERMINAL, [tty])
  if (viaTerminal === 'ok') return 'ok'
  if (await $.fs.exists('/Applications/iTerm.app').catch(() => false)) {
    const viaIterm = await osa($, FOCUS_ITERM, [tty])
    if (viaIterm === 'ok') return 'ok'
  }
  return viaTerminal
}

// A session inside tmux: show its pane, then bring forward the terminal the
// tmux client is in (or open one attached to it).
async function focusTmux($: EngineInterface, tty: string): Promise<string> {
  const tmux = await findTmux($)
  if (tmux === null) return 'none'
  const panes = await runQuiet($, [tmux, 'list-panes', '-a', '-F', TMUX_PANES])
  const hit = panes.code === 0 ? tmuxPaneOn(panes.out, tty) : null
  if (hit === null) return 'none'
  const isShown = (await runQuiet($, [tmux, 'select-window', '-t', hit.windowId])).code === 0 &&
    (await runQuiet($, [tmux, 'select-pane', '-t', hit.paneId])).code === 0
  const clients = await runQuiet($, [tmux, 'list-clients', '-t', hit.session, '-F', '#{client_tty}'])
  const clientTty = clients.out.split('\n')[0]?.trim() ?? ''
  if (clientTty === '') return openWindow($, `${tmux} attach -t ${shellQuote(hit.session)}`)
  const raised = await focusTty($, clientTty)
  // Shown in its tmux window even where no terminal app can be brought forward (Linux, other terminals).
  return raised === 'ok' ? 'ok' : isShown ? 'tmux' : raised
}

// Brings another session's terminal forward: Terminal or iTerm2 by its tty, a tmux pane, or
// `claude attach` for a background session. What it did shows in that session's card; a
// failure is also a toast, for a jump pressed from NEEDS YOU.
async function jumpTo($: EngineInterface, sessionId: string): Promise<void> {
  const row = (await sessionRowsNow($)).find(r => r.sessionId === sessionId)
  if (row?.isSelf === true) {
    $.ui.toast('That is this session.', { timeoutMs: 3_000 })
    return
  }
  await update($, viewAtom, v => ({ ...v, jump: { sessionId, at: 0, isOk: true, text: 'Bringing it forward…' } }))
  let result = 'none'
  if (row !== undefined && row.jobId !== null) {
    result = await openWindow($, `claude attach ${shellQuote(row.jobId)}`)
  } else if (row !== undefined && row.tty !== null) {
    result = await focusTty($, row.tty)
    if (result !== 'ok') {
      const viaTmux = await focusTmux($, row.tty)
      if (viaTmux === 'ok' || viaTmux === 'tmux' || result === 'none') result = viaTmux
    }
  }
  const at = await $.clock.now()
  const name = row?.name || 'that session'
  const why = result.startsWith('error:') ? `: ${fit(result.slice(7), 160)}`
    : row === undefined ? ': it is no longer in the session list'
      : row.jobId === null && row.tty === null ? ': no terminal is known for it'
        : row.jobId !== null && hasOsa === false ? ': opening a new terminal window works on macOS only'
          : ': its terminal window was not found (Terminal, iTerm2 and tmux were checked)'
  const note: JumpNote = result === 'ok'
    ? { sessionId, at, isOk: true, text: row?.jobId != null ? `Opened ${name} in a new window` : `Switched to ${name}'s terminal (${(row?.tty ?? '').replace('/dev/', '')})` }
    : result === 'tmux'
      ? { sessionId, at, isOk: true, text: `Showed ${name}'s pane in its tmux window` }
      : { sessionId, at, isOk: false, text: `Could not bring ${name} forward${why}` }
  await update($, viewAtom, v => ({ ...v, jump: note }))
  if (!note.isOk) await notify($, note.text, { width: 160, timeoutMs: 8_000 })
}

// A press runs only as long as the drawing it was pressed on: the pane redraws (a spinner, the
// jump's own note) and aborts what the press still waits on, osascript included. So the jump runs
// on a timer of its own, outside the press.
function startJump($: EngineInterface, sessionId: string): void {
  $.clock.after(0, () => {
    void jumpTo($, sessionId).catch(async (err: unknown) => {
      const at = await $.clock.now()
      await update($, viewAtom, v => ({ ...v, jump: { sessionId, at, isOk: false, text: `Could not bring it forward: ${fit(oneLine(String(err)), 120)}` } }))
    })
  })
}

type MessageLike = {
  role: string
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; result?: unknown; isError?: true }[]
}

// A subagent's transcript cut down to its task and its latest steps.
export function peekOf(messages: readonly MessageLike[], max = SHOWN_PEEK): { task: string; lines: PeekLine[] } {
  const task = oneLine(messages.find(msg => msg.role === 'user')?.text ?? '')
  const lines: PeekLine[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const text = oneLine(msg.text)
    if (text !== '') lines.push({ kind: 'text', text })
    for (const u of msg.toolUses) {
      // Its hand-back is the answer, shown on its own below the steps.
      if (u.tool === 'SubagentHandback') continue
      const kind = u.isError === true ? 'failed' : u.result === undefined ? 'running' : 'done'
      lines.push({ kind, text: `${toolLabel(u.tool)} ${describeCall(u.tool, u.input)}` })
    }
  }
  return { task, lines: lines.slice(-max) }
}

let registryPath: string | null = null
let registryScannedAt = 0
// The hub's own outbox and how far this session has read the board; both are
// kept in the session's board file, so a reload reads them back.
let outbox: HubMessage[] = []
let seenAt = 0
let toastedAt = 0
let offerSeen = new Set<string>()

async function refreshAgents($: EngineInterface, now: number): Promise<void> {
  const list = await $.agent.list()
  const prior = await read($, agents)
  const next = mergeAgents(prior, list, now)
  if (JSON.stringify(next) !== JSON.stringify(prior)) await update($, agents, () => next)
  const rowIds = new Set(next.map(a => a.id))
  const cardList = await read($, cardsAtom)
  const kept = pruneCards(adoptCards(cardList, next), rowIds, now, ENDED_KEEP_MS)
  if (JSON.stringify(kept) !== JSON.stringify(cardList)) await update($, cardsAtom, () => kept)
}

async function refreshPeek($: EngineInterface): Promise<void> {
  const current = await read($, peek)
  const agentId = current.agentId
  if (agentId === null) return
  // A finished subagent's transcript no longer changes: read once, not every few seconds.
  const row = (await read($, agents)).find(a => a.id === agentId)
  if (row !== undefined && row.endedAt !== null && (current.task !== '' || current.lines.length > 0 || current.error !== '')) return
  const found = await $.session.messages({ agentId })
  const next: Peek = 'deny' in found
    ? { ...current, error: 'Its transcript cannot be read from here.' }
    : { agentId, ...peekOf(found), error: '' }
  // Closed or switched while the transcript was read.
  if ((await read($, peek)).agentId !== agentId) return
  if (JSON.stringify(next) !== JSON.stringify(current)) await update($, peek, () => next)
}

async function togglePeek($: EngineInterface, agentId: string): Promise<void> {
  const isOpen = (await read($, peek)).agentId === agentId
  await update($, peek, () => (isOpen ? NO_PEEK : { ...NO_PEEK, agentId }))
  if (!isOpen) await refreshPeek($)
}

async function readJson($: EngineInterface, path: string): Promise<Fields | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as Fields
  } catch {
    return null
  }
}

// The engine keeps one registry file per running session; its `status` turns
// `waiting` while a permission prompt or a dialog waits on the person.
async function refreshWaiting($: EngineInterface, now: number): Promise<void> {
  const home = await read($, homeAtom)
  if (home === '') return
  const own = await $.session.id()
  let raw = registryPath === null ? null : await readJson($, registryPath)
  if (raw === null || raw.sessionId !== own) {
    raw = null
    registryPath = null
    if (now - registryScannedAt < REGISTRY_RESCAN_MS) return
    registryScannedAt = now
    const dir = `${home}/sessions`
    if (!(await $.fs.exists(dir))) return
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const found = await readJson($, `${dir}/${entry.name}`)
      if (found?.sessionId === own) {
        registryPath = `${dir}/${entry.name}`
        raw = found
        break
      }
    }
    if (raw === null) return
  }
  const waiting = raw.status === 'waiting' ? str(raw.waitingFor) || 'your input' : null
  const waitingAt = waiting === null ? null : Number(raw.statusUpdatedAt) || now
  const m = await read($, main)
  if (m.waiting !== waiting || m.waitingAt !== waitingAt) await update($, main, s => ({ ...s, waiting, waitingAt }))
}

// The repository this session works in (its git root, else its folder) and the branch.
async function refreshRepo($: EngineInterface, cwd: string): Promise<void> {
  let root = cwd
  let branch = ''
  // Bounded: the first run is part of the session's start, which the first prompt waits on.
  const ran = await runQuiet($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], 3_000)
  if (ran.code === 0) {
    const [top = '', head = ''] = ran.out.trim().split('\n')
    if (top !== '') root = top
    branch = head === 'HEAD' ? 'detached' : head
  }
  const h = await read($, hubAtom)
  if (h.root !== root || h.branch !== branch) await update($, hubAtom, s => ({ ...s, root, label: base(root), branch }))
}

async function boardPath($: EngineInterface): Promise<string | null> {
  const home = await read($, homeAtom)
  const h = await read($, hubAtom)
  if (home === '' || h.root === '') return null
  return `${hubDir(home, h.root)}/${await $.session.id()}.json`
}

// What this session goes by on the board: its name in the session list, made unique in the repo.
async function selfName($: EngineInterface): Promise<string> {
  const own = await $.session.id()
  const cwd = await read($, cwdAtom)
  const row = (await sessionRowsNow($)).find(r => r.isSelf)
  const name = row?.name ?? ''
  return name !== '' && name !== base(cwd) ? name : `${base(cwd) || 'session'}·${own.slice(0, 4)}`
}

// Another mod's state when it is loaded; anything else (not installed, refused) reads as nothing.
async function readOther($: EngineInterface, which: 'savvy' | 'flightAgents' | 'flightLoops' | 'sessionsRows' | 'sessionsHidden'): Promise<unknown> {
  try {
    if (which === 'savvy') return await read($, savvyAgents)
    if (which === 'flightAgents') return await read($, flightAgents)
    if (which === 'flightLoops') return await read($, flightLoops)
    if (which === 'sessionsRows') return await read($, sessionsModRows)
    return await read($, sessionsModHidden)
  } catch {
    return []
  }
}

// Every session on this computer: the sessions mod's list when it is loaded, else this mod's own.
async function sessionRowsNow($: EngineInterface): Promise<SessionRow[]> {
  const fromMod = adaptSessionRows(await readOther($, 'sessionsRows'))
  return fromMod.length > 0 ? fromMod : await read($, localSessions)
}

async function hiddenNow($: EngineInterface): Promise<string[]> {
  return adaptHidden(await readOther($, 'sessionsHidden'))
}

// The engine's registry, one file per running session, checked against `ps`. Skipped
// while the sessions mod is loaded: it reads the same files and more.
async function refreshSessions($: EngineInterface, now: number): Promise<void> {
  if (adaptSessionRows(await readOther($, 'sessionsRows')).length > 0) return
  const home = await read($, homeAtom)
  if (home === '') return
  const dir = `${home}/sessions`
  const registry: Fields[] = []
  if (await $.fs.exists(dir)) {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const raw = await readJson($, `${dir}/${entry.name}`)
      if (raw !== null) registry.push(raw)
    }
  }
  const pids = registry.flatMap(r => (typeof r.pid === 'number' ? [r.pid] : []))
  // `ps -p` exits 1 when some pids are gone but still lists the live ones; no output at all means no `ps`.
  const ps = pids.length === 0
    ? new Map<number, string | null>()
    : await runQuiet($, ['ps', '-o', 'pid=,tty=', '-p', pids.join(',')]).then(r => (r.code === 0 || r.out.trim() !== '' ? parsePs(r.out) : r.code === 1 ? new Map<number, string | null>() : null))
  const rows = rowsFromRegistry(registry, ps, await $.session.id(), now)
  if (JSON.stringify(rows) !== JSON.stringify(await read($, localSessions))) await update($, localSessions, () => rows)
}

// This session as the map shows it: what it asks of the person, may be stuck on, or is doing; what it started.
async function selfSession($: EngineInterface, now: number): Promise<SelfSession> {
  const m = await read($, main)
  const jobList = await read($, jobs)
  const agentList = await read($, agents)
  const cardList = await read($, cardsAtom)
  const g = await read($, goal)
  const h = await read($, hubAtom)
  const cwd = await read($, cwdAtom)
  const row = (await sessionRowsNow($)).find(r => r.isSelf)
  const views = agentViews(agentList, cardList, jobList)
  const nodes = selfNodes({
    agents: views.map(v => ({ id: v.id, type: v.type, purpose: v.purpose, status: v.status, isLive: v.isLive, from: v.from, to: v.to, step: v.step, result: v.card?.result ?? '' })),
    jobs: jobList,
    loops: await read($, loopsAtom),
    savvy: adaptSavvy(await readOther($, 'savvy')),
    flightAgents: adaptFlightAgents(await readOther($, 'flightAgents')),
    flightLoops: adaptFlightLoops(await readOther($, 'flightLoops')),
    now,
  })
  const groups = groupNow(jobList, agentList, m)
  const own = jobList.filter(j => j.agentId === null)
  const stuck = stuckReason(own, m.isWorking, now)
  const firstNeed = groups.needs[0]
  const task = g.tasks.find(t => t.status === 'in_progress')
  const liveJob = own.filter(j => j.endedAt === null && j.tool !== 'Agent' && j.taskId === null).slice(-1)[0]
  const isBusy = m.isWorking || nodes.some(n => n.status === 'running' && n.kind === 'agent')
  const status = firstNeed !== undefined ? 'waiting' as const : stuck !== '' ? 'stuck' as const : isBusy ? 'running' as const : 'idle' as const
  const runningAgents = nodes.filter(n => n.kind === 'agent' && n.status === 'running').length
  // The Agent calls this turn is blocked on (foreground subagents).
  const waitingOn = own.filter(j => j.tool === 'Agent' && j.endedAt === null).length
  const doing = status === 'idle'
    ? (m.since === null ? 'ready' : `your turn · replied ${ago(now - m.since)}`)
    : liveJob !== undefined ? plainStep(liveJob.tool, liveJob.detail)
      : m.isWorking && waitingOn > 0 ? `waiting for ${waitingOn} agent${waitingOn === 1 ? '' : 's'}`
        : m.isWorking ? task?.subject ?? 'thinking'
        : `${runningAgents} agent${runningAgents === 1 ? '' : 's'} working in the background`
  return {
    sessionId: await $.session.id(),
    name: row?.name || base(cwd) || 'this session',
    cwd,
    branch: h.branch,
    status,
    doing,
    why: firstNeed?.text ?? stuck,
    since: firstNeed?.from ?? m.since ?? now,
    nodes,
  }
}

// Every board file on this computer, in every repo's folder, that is still fresh: the other sessions' maps.
async function refreshFleet($: EngineInterface, now: number): Promise<void> {
  const home = await read($, homeAtom)
  if (home === '') return
  const top = hubDir(home, '').replace(/\/[^/]*$/, '')
  if (!(await $.fs.exists(top))) return
  const own = await $.session.id()
  const found: FleetFile[] = []
  for (const dir of await $.fs.list(top)) {
    if (dir.kind !== 'dir') continue
    for (const entry of await $.fs.list(`${top}/${dir.name}`).catch(() => [])) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || now - entry.mtimeMs > HUB_STALE_MS) continue
      const f = asHubFile(await readJson($, `${top}/${dir.name}/${entry.name}`))
      if (f === null || f.ended || f.sessionId === own || now - f.heartbeatAt > HUB_STALE_MS) continue
      found.push({
        sessionId: f.sessionId, name: f.name, cwd: f.cwd, branch: f.branch, state: f.state, doing: f.doing, stuck: f.stuck ?? '', heartbeatAt: f.heartbeatAt, nodes: f.nodes ?? [],
        ...(f.needKind === undefined ? {} : { needKind: f.needKind }),
        ...(f.asks === undefined ? {} : { asks: f.asks }),
      })
    }
  }
  found.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  if (JSON.stringify(found) !== JSON.stringify(await read($, fleetAtom))) await update($, fleetAtom, () => found)
}

// The whole map as it stands: this session, every other one, what each started.
async function currentMap($: EngineInterface, now: number): Promise<MapSession[]> {
  // A background session that ended, or has sat blocked, for over a day is history, not something to look at now.
  const live = (await sessionRowsNow($)).filter(r => !(r.jobId !== null && r.group !== 'working' && now - r.since > BACKGROUND_DONE_KEEP_MS))
  const rows = live.map(r => ({
    sessionId: r.sessionId, name: r.name, cwd: r.cwd, group: r.group, state: r.state, since: r.since, summary: r.summary, isSelf: r.isSelf,
    usage: r.usage === null ? null : { contextPercent: r.usage.contextPercent, costUsd: r.usage.costUsd },
  }))
  const files: MapFleetFile[] = await read($, fleetAtom)
  return buildMap(await selfSession($, now), files, rows, await hiddenNow($), now, HUB_STALE_MS)
}

// What other sessions read about this one: its own nodes, cut to keep the file small.
function publishNodes(nodes: readonly MapNode[]): MapNode[] {
  return nodes.slice(0, NODES_MAX).map(n => ({ ...n, title: fit(n.title, 120), now: fit(n.now, 160), raw: fit(n.raw, 160), why: fit(n.why, 200) }))
}

// This session's board file: who it is, what it is doing, its loops and agents, its posts.
async function writePresence($: EngineInterface, now: number, isEnded = false): Promise<void> {
  const path = await boardPath($)
  if (path === null) return
  const h = await read($, hubAtom)
  const presence = presenceOf(await read($, main), await read($, jobs), await read($, goal), await read($, agents))
  const live = activeLoops(await read($, loopsAtom))
  const nexts = live.flatMap(l => (l.nextAt === null ? [] : [l.nextAt]))
  const file: HubFile = {
    v: 1,
    sessionId: await $.session.id(),
    name: await selfName($),
    root: h.root,
    cwd: await read($, cwdAtom),
    branch: h.branch,
    state: presence.state,
    doing: presence.doing,
    ...(presence.needKind === undefined ? {} : { needKind: presence.needKind, asks: presence.asks ?? [] }),
    loops: live.length,
    nextLoopAt: nexts.length === 0 ? null : Math.min(...nexts),
    agents: (await read($, agents)).filter(a => a.endedAt === null && a.status !== 'idle').length,
    heartbeatAt: now,
    ended: isEnded,
    seenAt,
    messages: outbox,
  }
  try {
    const self = await selfSession($, now)
    file.stuck = self.status === 'stuck' ? self.why : ''
    file.nodes = publishNodes(self.nodes)
  } catch {
    // The map's part is extra: the board file goes out without it.
  }
  await $.fs.write(path, JSON.stringify(file))
}

// Reads every board file of this repo: the members, and the messages for this session.
async function refreshHub($: EngineInterface, now: number): Promise<void> {
  const home = await read($, homeAtom)
  const h = await read($, hubAtom)
  if (home === '' || h.root === '') return
  const dir = hubDir(home, h.root)
  const files: HubFile[] = []
  if (await $.fs.exists(dir)) {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      // A file nobody touched for a day holds nothing the board still shows.
      if (now - entry.mtimeMs > 24 * 60 * 60 * 1000) continue
      const f = asHubFile(await readJson($, `${dir}/${entry.name}`))
      if (f !== null && f.root === h.root) files.push(f)
    }
  }
  const own = await $.session.id()
  const board = readHub(files, own, now)
  const members = [...board.members, ...bareMembers(await sessionRowsNow($), h.root, new Set(files.map(f => f.sessionId)))]
  if (JSON.stringify(members) !== JSON.stringify(h.members) || JSON.stringify(board.messages) !== JSON.stringify(h.messages)) {
    await update($, hubAtom, s => ({ ...s, members, messages: board.messages }))
  }
  // A new note from another session: a toast, once.
  const fresh = unread(board.messages, own, Math.max(toastedAt, seenAt))
  const last = fresh[fresh.length - 1]
  if (last !== undefined) {
    toastedAt = last.at
    await notify($, `Hub · ${last.fromName}: ${last.text}`)
  }
}

// A toast, masked while recording, then cut to `width` when given.
async function notify($: EngineInterface, text: string, opts: { width?: number; timeoutMs?: number } = {}): Promise<void> {
  const isRecording = (await $.env.get('CLAUDE_MODS_RECORDING')) === '1'
  const masked = isRecording ? mask(text, recordingTerms(await $.env.get('CLAUDE_MODS_RECORDING_TERMS'))) : text
  const shown = opts.width === undefined ? masked : fit(masked, opts.width)
  try {
    await $.ui.toast(shown, opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs })
  } catch {
    // Nothing draws toasts here (headless): the pane still shows the state.
  }
}

// What a stop came to: it stopped; it had already ended (the tool's own error
// says it is not running or not found); or it was refused or failed, so it still
// runs. A deny is always a refusal: a hook or the person said no.
export type StopOutcome = { kind: 'stopped' } | { kind: 'gone' } | { kind: 'refused'; why: string }

const GONE = /not running|not found|no (?:such |scheduled )?(?:task|job|cron|shell)|does ?n[o']t exist|already (?:stopped|ended|completed|finished|exited)|unknown (?:task|job|id)/i

// A tool error in plain words, without the tags it reaches the model in.
const plainError = (text: string): string => oneLine(text.replace(/<\/?tool_use_error>/g, ''))

export function stopOutcomeOf(ran: { deny?: string; isError?: true; text?: string }): StopOutcome {
  if (ran.deny !== undefined) return { kind: 'refused', why: plainError(ran.deny) || 'refused' }
  if (ran.isError !== true) return { kind: 'stopped' }
  const why = plainError(ran.text ?? '')
  return GONE.test(why) ? { kind: 'gone' } : { kind: 'refused', why: why || 'the tool reported an error' }
}

async function stopOutcome(call: Promise<{ deny?: string; isError?: true; text?: string }>): Promise<StopOutcome> {
  try {
    return stopOutcomeOf(await call)
  } catch (err) {
    return { kind: 'refused', why: oneLine(err instanceof Error ? err.message : String(err)) || 'it failed' }
  }
}

// Ringside's own folder: the person's alone (the board files say what each session works on,
// which a shared computer's other users must not read), keeping a week of board files.
async function tidyBoard($: EngineInterface, claudeDir: string): Promise<void> {
  if (claudeDir === '') return
  const dir = `${claudeDir}/mods-data/ringside`
  if (!(await $.fs.exists(dir).catch(() => false))) return
  await runQuiet($, ['chmod', '700', dir], 3_000)
  const hub = `${dir}/hub`
  if (!(await $.fs.exists(hub).catch(() => false))) return
  await runQuiet($, ['find', hub, '-type', 'f', '-name', '*.json', '-mtime', `+${BOARD_KEEP_DAYS}`, '-delete'], 10_000)
  await runQuiet($, ['find', hub, '-mindepth', '1', '-type', 'd', '-empty', '-delete'], 10_000)
}

// Claude's questions waiting on the person, by call: a card pressed in the pane answers one.
const askWaiters = new Map<string, (answers: Record<string, string>) => void>()

async function dialogOrPane(id: string, input: Fields, dialog: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const shown = dialog()
  const picked = new Promise<Record<string, string>>(resolve => askWaiters.set(id, resolve))
  try {
    const won = await Promise.race([shown.then(r => ({ r })), picked.then(answers => ({ answers }))])
    if ('r' in won) return won.r
    // Answered from the pane: returning now closes the dialog, its call cut off beneath.
    shown.catch(() => undefined)
    return { result: { questions: input.questions, answers: won.answers } }
  } finally {
    askWaiters.delete(id)
  }
}

// Stops sent and not answered yet, by node: a second press sends no second stop.
const stopping = new Set<string>()

// A stop runs on a timer of its own, outside the press: the press's own redraw
// would cut off a call still waiting (house rule 6).
function startStop($: EngineInterface, key: string, run: () => Promise<void>): void {
  if (stopping.has(key)) return
  stopping.add(key)
  $.clock.after(0, () => {
    void run().catch(() => undefined).finally(() => stopping.delete(key))
  })
}

// A post to the board; from the person, it can also wake the recipients' Claude.
async function postHub($: EngineInterface, text: string, by: HubMessage['by'], to: string): Promise<string> {
  const body = text.trim()
  if (body === '') return 'Nothing to post.'
  const h = await read($, hubAtom)
  if (h.root === '') return 'The hub is not ready yet.'
  const now = await $.clock.now()
  const fromName = await selfName($)
  const msg = newMessage({ fromId: await $.session.id(), fromName, by, to, text: body, at: now, nonce: Math.random().toString(36).slice(2, 8) })
  outbox = pushOutbox(outbox, msg, now)
  await writePresence($, now)
  await update($, hubAtom, s => ({ ...s, messages: [...s.messages, msg].slice(-60) }))
  const recipient = to === 'all' ? 'everyone here' : (h.members.find(m => m.sessionId === to)?.name ?? 'one session')
  if (by !== 'person' || !h.wake) return `Posted to ${recipient}.`
  const targets = h.members.filter(m => !m.isSelf && (to === 'all' || m.sessionId === to))
  let woken = 0
  for (const m of targets) {
    const sent = await $.session.send({ to: { sessionId: m.sessionId }, text: `[Repo hub · ${h.label}] ${fromName}: ${body}` }).catch(() => undefined)
    if (sent?.isDelivered === true) woken += 1
  }
  return `Posted to ${recipient}; woke ${woken} of ${targets.length}.`
}

async function hubSay($: EngineInterface, text: string): Promise<void> {
  const h = await read($, hubAtom)
  const to = h.to === 'all' || h.members.some(m => m.sessionId === h.to) ? h.to : 'all'
  const note = await postHub($, text, 'person', to)
  await update($, hubAtom, s => ({ ...s, note }))
}

async function reportHub($: EngineInterface): Promise<void> {
  await update($, hubAtom, s => ({ ...s, note: 'Asked Claude for a report.' }))
  await $.prompt.submit({
    text: `Give me a short status report of this repo from the Ringside hub (call ${HUB_TOOL} with action "read"): each session, what it is doing, its loops and subagents, anything blocked or waiting on me, and board notes nobody answered.`,
  })
}

// The skills and commands the launcher lists, read off the session's own command list.
async function refreshSkills($: EngineInterface): Promise<void> {
  const commands = await $.command.list().catch(() => [])
  if (commands.length === 0) return
  hasReplay = commands.some(c => c.name === 'replay')
  const skills = skillsFrom(commands, SELF)
  await update($, catalogAtom, l => replaceSkills(l, skills))
}

// Agent files in the person's and the project's .claude/agents: listed before the engine offers them.
async function seedAgentFiles($: EngineInterface, claudeDir: string, root: string): Promise<void> {
  const found: CatalogEntry[] = []
  for (const [dir, source] of [[claudeDir === '' ? '' : `${claudeDir}/agents`, 'userSettings'], [root === '' ? '' : `${root}/.claude/agents`, 'projectSettings']] as const) {
    if (dir === '' || !(await $.fs.exists(dir))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
      const agent = agentFromMarkdown(text, entry.name.replace(/\.md$/, ''), source)
      if (agent !== null) found.push(agent)
    }
  }
  if (found.length === 0) return
  await update($, catalogAtom, l => found.reduce((acc, a) => mergeOffer(acc, {
    agent: a.name, description: a.description, source: a.source, ...(a.model === undefined ? {} : { model: a.model }), ...(a.color === undefined ? {} : { color: a.color }),
  }), l))
}

async function launchAgent($: EngineInterface, type: string, task: string): Promise<void> {
  const prompt = task.trim()
  if (prompt === '') {
    await update($, launchAtom, l => ({ ...l, note: 'Type the task for the agent, then Enter.' }))
    return
  }
  const purpose = purposeOf(prompt)
  const started = await $.agent.spawn({ prompt, description: purpose, subagentType: type }).catch((err: unknown) => ({ deny: String(err) }))
  if (started.deny !== undefined) {
    const reason = started.deny
    await update($, launchAtom, l => ({ ...l, note: `Not started: ${reason}` }))
    return
  }
  const now = await $.clock.now()
  // No id back yet: the card waits under a pending id until the engine lists the agent.
  const answer = { model: started.model, agentId: started.agentId ?? `${PENDING_ID}${now}` }
  const card = newCard({ prompt, description: purpose, subagentType: type }, answer, 'you', roleFor(await read($, catalogAtom), type, ''), now)
  if (card !== null) await update($, cardsAtom, l => addCard(l, card))
  await update($, launchAtom, l => ({ ...l, picked: null, query: '', note: `Started ${type}: ${purpose}` }))
  await refreshAgents($, now)
}

async function runSkill($: EngineInterface, name: string, args: string): Promise<void> {
  await update($, launchAtom, l => ({ ...l, picked: null, query: '', note: `Queued /${name}${args.trim() === '' ? '' : ` ${args.trim()}`}` }))
  // Runs as if typed, once the session is idle; its turn shows in the transcript.
  void $.command.run({ command: name, args: args.trim() }).catch((err: unknown) =>
    update($, launchAtom, l => ({ ...l, note: `Could not run /${name}: ${String(err)}` })))
}

async function stopLoop($: EngineInterface, loop: Loop): Promise<void> {
  const id = loop.kind === 'cron' ? loop.id : loop.wakeId
  // A self-paced loop's next run is known by id once Claude's turn ends: until then there is nothing to delete.
  if (id === null) return notify($, 'Could not stop the loop yet: its next run is booked when Claude\'s turn ends. Try again then.', { width: 160, timeoutMs: 8_000 })
  const now = await $.clock.now()
  const done = await stopOutcome($.tool.call({ tool: 'CronDelete', id }))
  // Refused or failed, the loop still runs: it stays on the map.
  if (done.kind === 'refused') return notify($, `Could not stop the loop: ${done.why}`, { width: 160, timeoutMs: 8_000 })
  if (done.kind === 'gone') await notify($, 'That loop had already ended.', { timeoutMs: 8_000 })
  await update($, loopsAtom, l => endLoop(l, loop.id, now))
}

async function stopShell($: EngineInterface, shell: Job): Promise<void> {
  if (shell.taskId === null) return
  const now = await $.clock.now()
  const done = await stopOutcome($.tool.call({ tool: 'TaskStop', task_id: shell.taskId } as never))
  // Refused or failed, the shell still runs: it stays on the map.
  if (done.kind === 'refused') return notify($, `Could not stop the shell: ${done.why}`, { width: 160, timeoutMs: 8_000 })
  if (done.kind === 'gone') await notify($, 'That shell had already ended.', { timeoutMs: 8_000 })
  await update($, jobs, l => l.map(j => (j.id === shell.id && j.endedAt === null ? { ...j, endedAt: now } : j)))
}

async function useResult($: EngineInterface, card: AgentCard): Promise<void> {
  await $.prompt.fill({ text: `Result of the ${card.type} agent (${card.purpose}):\n${card.result}\n\n`, mode: 'insert' })
}

async function reset($: EngineInterface): Promise<void> {
  await update($, jobs, () => [])
  await update($, goal, () => ({ startedAt: null, tasks: [] }))
  await update($, agents, () => [])
  await update($, cardsAtom, () => [])
  await update($, main, () => IDLE_MAIN)
  await update($, peek, () => NO_PEEK)
  await update($, launchAtom, () => NO_LAUNCH)
}

const TONE_COLOR: Record<NowTone, string> = {
  need: 'yellow',
  agent: 'magenta',
  job: 'cyan',
  ok: 'green',
  failed: 'red',
  stopped: 'gray',
}

const PEEK_GLYPH: Record<PeekLine['kind'], string> = { text: '>', running: '', done: '✓', failed: 'x' }
const PEEK_COLOR: Record<PeekLine['kind'], string> = { text: 'white', running: 'cyan', done: 'green', failed: 'red' }
const AGENT_GLYPH: Record<string, string> = { pending: '…', waiting: '!', idle: '·', completed: '✓', ended: '✓', failed: 'x', killed: '-' }
const AGENT_COLOR: Record<string, string> = { waiting: 'yellow', idle: 'gray', completed: 'green', ended: 'green', failed: 'red', killed: 'gray' }
const HUB_GLYPH: Record<HubState, string> = { working: '●', idle: '○', needs: '!' }
const STATUS_GLYPH: Record<string, string> = { waiting: '!', stuck: '?', idle: '○', done: '✓', failed: '✗' }
const STATUS_COLOR: Record<string, string> = { running: 'cyan', waiting: 'yellow', stuck: '#ff8700', idle: 'gray', done: 'green', failed: 'red' }
const STATUS_WORD: Record<string, string> = { running: 'working', waiting: 'waiting on you', stuck: 'may be stuck', idle: 'idle', done: 'finished', failed: 'failed' }
const STUCK_COLOR = '#ff8700'
// Replay Theater is loaded: a session's Peek offers its /replay.
let hasReplay = false
// Set at session start: the pane opens itself once a drawing says the transcript is fullscreen.
let opensUnasked = false
let bandCache: { at: number; items: MapNeed[] } = { at: 0, items: [] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwdAtom, () => e.cwd)
    const home = (await $.env.get('HOME')) ?? ''
    const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home === '' ? '' : `${home}/.claude`)
    await update($, homeAtom, () => claudeDir)
    // A reload keeps $.state: bring rows an older version of this mod saved up to shape.
    await update($, jobs, l => l.map(j => ({ ...j, need: j.need ?? null })))
    await update($, agents, l => l.filter(a => typeof a.startedAt === 'number' && a.endedAt !== undefined))
    await update($, launchAtom, l => ({ ...NO_LAUNCH, ...l, note: '' }))
    offerSeen = new Set()
    hasOsa = undefined
    tmuxBin = undefined
    await $.command.register({
      name: 'ringside',
      description: 'Ringside: every Claude session on this computer and what each started, what needs you, tasks, launcher',
      argumentHint: '[map|tasks|launch|zoom auto|cards|lines|dots|close|clear|say <text>|report]',
    })
    try {
      await $.tool.register({ name: 'hub', description: HUB_TOOL_DESCRIPTION, inputSchema: HUB_SCHEMA })
    } catch {
      // A host with no tools (a test, an SDK run that refuses it): the pane still works.
    }
    opensUnasked = e.isInteractive

    const now = await $.clock.now()
    toastedAt = now
    try {
      await refreshRepo($, e.cwd)
      const path = await boardPath($)
      const prior = path === null || !(await $.fs.exists(path)) ? null : asHubFile(await readJson($, path))
      outbox = prior?.messages ?? []
      seenAt = prior?.seenAt ?? now
      await seedAgentFiles($, claudeDir, (await read($, hubAtom)).root)
      await refreshSkills($)
      await writePresence($, now)
      await refreshHub($, now)
    } catch {
      // The board or the catalog could not be read; the next ticks try again.
    }
    // Ringside's folder kept private and tidy, off the start's path.
    $.clock.after(0, () => void tidyBoard($, claudeDir).catch(() => undefined))

    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const at = await $.clock.now()
        const list = await read($, jobs)
        const stale = list.filter(j => isStale(j, at))
        if (stale.length > 0) {
          const gone = new Set(stale.map(j => j.id))
          await update($, jobs, l => l.filter(j => !gone.has(j.id)))
        }
        if (ticks % 2 === 0) {
          await refreshAgents($, at)
          await refreshWaiting($, at)
        }
        if (ticks % 3 === 0) await refreshPeek($)
        if (ticks % HUB_READ_TICKS === 0) await refreshHub($, at)
        if (ticks % HUB_READ_TICKS === 0) await refreshFleet($, at).catch(() => undefined)
        if (ticks % HUB_READ_TICKS === 0) await refreshSessions($, at).catch(() => undefined)
        if (ticks % HEARTBEAT_TICKS === 0) await writePresence($, at)
        if (ticks % BRANCH_TICKS === 0) await refreshRepo($, await read($, cwdAtom))
        if (ticks % TIDY_TICKS === 0) await tidyBoard($, await read($, homeAtom)).catch(() => undefined)
        const loopList = await read($, loopsAtom)
        if (ticks % 30 === 0 && pruneLoops(loopList, at).length !== loopList.length) await update($, loopsAtom, l => pruneLoops(l, at))
        const shown = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE && p.isShown && p.isPlaced)
        if (shown !== (await read($, isShown))) await update($, isShown, () => shown)
        const m = await read($, main)
        const isLoopSoon = activeLoops(loopList).some(l => l.nextAt !== null && l.nextAt - at < 2 * 60_000)
        const isBusy = list.some(isRunning) || m.isWorking || m.waiting !== null || isLoopSoon ||
          (await read($, goal)).startedAt !== null || (await read($, agents)).some(a => a.endedAt === null) ||
          (await read($, fleetAtom)).some(f => f.state !== 'idle' || f.nodes.some(n => n.status === 'running'))
        // Spinners and clocks tick each second; "replied 3m ago" and loop countdowns each half minute.
        if (isBusy || ticks % 30 === 0) $.ui.invalidate('ui.render')
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writePresence($, await $.clock.now(), true).catch(() => undefined)
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  on('command.run', { command: 'ringside' }, async ($, e) => {
    const arg = e.args.trim()
    const [verb = '', ...rest] = arg.split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Ringside closed. /ringside opens it again.' }
    }
    if (verb === 'clear') {
      await reset($)
      return { text: 'Ringside cleared.' }
    }
    if (verb === 'say') {
      const note = await postHub($, rest.join(' '), 'person', 'all')
      return { text: `Hub: ${note}` }
    }
    if (verb === 'report') {
      await reportHub($)
      return { text: 'Asked Claude for a repo hub report.' }
    }
    if (verb === 'launch') {
      await refreshSkills($)
      await update($, launchAtom, l => ({ ...l, isOpen: true }))
      await update($, viewAtom, v => ({ ...v, tab: 'launch' as const }))
    }
    if (verb === 'map' || verb === 'tasks') {
      const tab: View['tab'] = verb === 'map' ? 'map' : 'tasks'
      await update($, viewAtom, v => ({ ...v, tab }))
    }
    if (verb === 'zoom') {
      const z = rest[0] ?? 'auto'
      const zoomTo: View['zoom'] | null = z === 'auto' || z === 'cards' || z === 'lines' || z === 'dots' ? z : null
      if (zoomTo === null) return { text: 'Zoom is one of: auto, cards, lines, dots.' }
      await update($, viewAtom, v => ({ ...v, tab: 'map' as const, zoom: zoomTo }))
    }
    // Asked for by name: raise it over the other tabs (Filetree, Flightdeck) when the prompt is empty.
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: opened.isPlaced ? 'Ringside open.' : 'Ringside opens once the window is wide enough.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    // A task notification ends the background job it reports on.
    if (e.origin.kind === 'task-notification') {
      await update($, jobs, l => l.map(j =>
        j.taskId !== null && j.endedAt === null && e.text.includes(j.taskId) ? { ...j, endedAt: now } : j))
    }
    // A loop's prompt is running: count it and work out the next run.
    if (e.origin.kind === 'scheduled-trigger') await update($, loopsAtom, l => fired(l, e.text, now))
    // The person answered: the question Claude ended on is no longer theirs to answer.
    if (e.origin.kind === 'composer' && (await read($, main)).reply !== null) {
      await update($, main, s => ({ ...s, reply: null, replyAsk: null }))
    }
    // Board notes from other sessions in this repo the model has not read: handed over with this prompt.
    const h = await read($, hubAtom)
    const own = await $.session.id().catch(() => '')
    const notes = unread(h.messages, own, seenAt).filter(m => !e.text.includes(m.text))
    const newest = unread(h.messages, own, seenAt).slice(-1)[0]
    if (newest !== undefined) {
      seenAt = newest.at
      void writePresence($, now).catch(() => undefined)
    }
    if (notes.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), hubNote(notes, h.label)] })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, main, s => ({ ...s, isWorking: true, since: now, reply: null, replyAsk: null }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const isAnswer = e.reason === 'answer' && !e.isAborted
      // The question it ended on, and the choices it offered: drawn as cards under it.
      const replyAsk = isAnswer ? replyAskOf(e.answer) : null
      const reply = isAnswer ? replyAsk?.question ?? lastQuestion(e.answer) : null
      await update($, main, s => ({ ...s, isWorking: false, since: now, reply, replyAsk }))
    } else {
      const agentId = e.agentId
      if ((await read($, cardsAtom)).some(c => c.id === agentId)) {
        await update($, cardsAtom, l => finishCard(l, agentId, e.reason === 'answer' ? e.answer : '', now))
      }
      void writePresence($, now).catch(() => undefined)
    }
    return next(e)
  })

  // What every subagent is for: its type, who called it, the role of that type, its task.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.agentId === undefined) return ran
    const input = e as unknown as Fields
    const by = next.origin.plugin === 'engine' ? undefined : next.origin.plugin
    const card = newCard(input, ran as unknown as Fields, callerOf(input, await read($, cardsAtom), by), roleFor(await read($, catalogAtom), typeOf(input), e.name ?? ''), await $.clock.now())
    if (card !== null) await update($, cardsAtom, l => addCard(l, card))
    // Other sessions' maps learn of it now, not at the next heartbeat.
    void writePresence($, await $.clock.now()).catch(() => undefined)
    return ran
  })

  // The agent types the model is offered: the launcher's list, with what each is for.
  on('agent.offer', async ($, e, next) => {
    const key = `${e.agent}\n${e.source}\n${e.description}`
    if (!offerSeen.has(key)) {
      offerSeen.add(key)
      const list = await read($, catalogAtom)
      const merged = mergeOffer(list, e)
      if (merged.length !== list.length || JSON.stringify(merged) !== JSON.stringify(list)) await update($, catalogAtom, () => merged)
    }
    return next(e)
  })

  // At the end of each turn the engine lists what will wake this session: the loops, as they stand.
  on('classic.Stop', async ($, e, next) => {
    const now = await $.clock.now()
    const crons = e.session_crons
    if (crons !== undefined) await update($, loopsAtom, l => reconcile(l, crons, now))
    const tasks = e.background_tasks
    if (tasks !== undefined) {
      const held = new Set(tasks.map(t => t.id))
      await update($, jobs, l => endGoneShells(l, held, now))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Fields
    if (tool === HUB_TOOL) return serveHubTool($, input)
    const startedAt = await $.clock.now()
    const id = e.tool_use_id
    const isQuiet = QUIET.has(tool)

    if (!isQuiet) {
      const job: Job = {
        id,
        tool: toolLabel(tool),
        detail: describeCall(tool, input),
        startedAt,
        endedAt: null,
        isError: false,
        agentId: e.agentId ?? null,
        taskId: null,
        need: needOf(tool, input),
      }
      await update($, jobs, l => trimJobs([...l.filter(j => j.id !== id), job]))
      const agentId = e.agentId
      if (agentId !== undefined && (await read($, cardsAtom)).some(c => c.id === agentId)) {
        await update($, cardsAtom, l => noteStep(l, agentId, `${job.tool} ${job.detail}`))
      }
    }

    // Claude's question: answered in its dialog, or from a card in the pane, whichever comes first.
    const ran = tool === 'AskUserQuestion' && !isQuiet ? await dialogOrPane(id, input, () => next(e)) : await next(e)
    const endedAt = await $.clock.now()
    const isError = ran.deny !== undefined || ran.isError === true
    const result = (ran.deny === undefined && ran.isError !== true ? (ran.result ?? {}) : {}) as Fields

    if (!isQuiet) {
      const taskId = tool === 'Bash' ? str(result.backgroundTaskId) : ''
      // A TaskStop that went through, or found the shell already gone, ends it; a refused one does not.
      if (tool === 'TaskStop' && stopOutcomeOf(ran).kind !== 'refused') {
        const stopped = str(input.task_id) || str(input.shell_id)
        await update($, jobs, l => l.map(j => (j.taskId === stopped && j.endedAt === null ? { ...j, endedAt } : j)))
      }
      await update($, jobs, l => l.map(j => j.id !== id ? j : taskId !== ''
        ? { ...j, taskId, detail: `${j.detail} (background)` }
        : { ...j, endedAt, isError, need: null }))
    }

    if (!isError) {
      if (isQuiet) await update($, goal, g => applyTaskCall(g, tool, input, result, endedAt))
      if (tool === 'CronCreate') await update($, loopsAtom, l => addCron(l, input, result, endedAt))
      if (tool === 'ScheduleWakeup') await update($, loopsAtom, l => addWakeup(l, input, result, endedAt))
      if (tool === 'CronDelete') await update($, loopsAtom, l => endLoop(l, str(input.id), endedAt))
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Mobile draws no text fields: there the board and the launcher show without their boxes.
    const Input = 'Input' in table ? table.Input : null
    // Only remote surfaces (the desktop) draw vector art; the terminal gets the tree alone.
    const Svg = 'Svg' in table ? table.Svg : null
    const width = Math.max(24, e.props.bodyColumns)
    const bodyRows = Math.max(20, e.props.scroll.bodyRows)
    const now = await $.clock.now()
    const jobList = await read($, jobs)
    const g = await read($, goal)
    const agentList = await read($, agents)
    const cardList = await read($, cardsAtom)
    const loopList = await read($, loopsAtom)
    const catalogList = await read($, catalogAtom)
    const launch = await read($, launchAtom)
    const hb = await read($, hubAtom)
    const m0 = await read($, main)
    const peekState = await read($, peek)
    const view = await read($, viewAtom)
    // Recording mode (its own mod) sets this flag; mask before cutting to width.
    const isRecording = (await $.env.get('CLAUDE_MODS_RECORDING')) === '1'
    const terms = recordingTerms(await $.env.get('CLAUDE_MODS_RECORDING_TERMS'))
    const m = (text: string): string => (isRecording ? mask(text, terms) : text)
    const spin = SPIN[Math.floor(now / 1000) % SPIN.length] ?? '*'

    const map = await currentMap($, now)
    const self = map[0]
    // How each session is reached (its terminal, or a background job), for its opened card.
    const rowsNow = await sessionRowsNow($)
    const homeDir = (await $.env.get('HOME')) ?? ''
    const views = agentViews(agentList, cardList, jobList)
    const groups = groupNow(jobList, agentList, m0)

    const heading = (title: string, right: string, color?: string) => (
      <Box>
        <Text bold color={color}>{title}</Text>
        <Text dimColor>{right === '' ? '' : `  ${right}`}</Text>
      </Box>
    )
    // A labelled detail line: "   role  Read-only search…", wrapped; inside a card, to the card's width.
    const detail = (key: string, label: string, text: string, lines: number, color?: string, w = width) => {
      const indent = `   ${label === '' ? '' : `${label.padEnd(5)} `}`
      return wrap(m(text), w - indent.length, lines).map((line, i) => (
        <Box key={`${key}:${i}`}>
          <Text dimColor>{i === 0 ? indent : ' '.repeat(indent.length)}</Text>
          <Text color={color} dimColor={color === undefined}>{line}</Text>
        </Box>
      ))
    }
    const glyphOf = (status: string, kind: string): string =>
      kind === 'loop' ? '↻' : status === 'running' ? spin : (STATUS_GLYPH[status] ?? '·')
    const colorOf = (status: string, kind: string): string =>
      status === 'running' && kind === 'agent' ? 'magenta' : (STATUS_COLOR[status] ?? 'gray')
    const nodeKey = (s: MapSession, n: MapNode): string =>
      s.isSelf ? (n.kind === 'agent' ? `agent:${n.id}` : `node:self:${n.id}`) : `node:${s.sessionId}:${n.id}`
    const timeOf = (n: MapNode): string => n.kind === 'loop' ? '' : dur((n.to ?? now) - n.from)
    const bar = (p: MapNode['progress']): string =>
      p === null ? '' : `${'▰'.repeat(Math.min(p.done, 10))}${'▱'.repeat(Math.max(0, Math.min(p.total, 10) - Math.min(p.done, 10)))} ${p.done}/${p.total}`
    const lineTwo = (n: MapNode): string => {
      if (n.status === 'waiting' || n.status === 'stuck') return n.why || n.now
      if (n.status === 'done' || n.status === 'failed') return n.why === '' ? n.now : `→ ${n.why}`
      const p = bar(n.progress)
      return p === '' ? n.now : `${p}${n.now === '' ? '' : ` · ${n.now}`}`
    }

    // Opening one thing below the map: this session's subagents read their transcript; anything else is the view's.
    const openNode = async (s: MapSession, n: MapNode): Promise<void> => {
      if (s.isSelf && n.kind === 'agent') {
        await update($, viewAtom, v => ({ ...v, sel: null, confirm: null }))
        await togglePeek($, n.id)
        return
      }
      const sel = `node:${s.sessionId}:${n.id}`
      await update($, peek, () => NO_PEEK)
      await update($, viewAtom, v => ({ ...v, sel: v.sel === sel ? null : sel, confirm: null }))
    }
    const openSession = async (s: MapSession): Promise<void> => {
      const sel = `session:${s.sessionId}`
      await update($, peek, () => NO_PEEK)
      await update($, viewAtom, v => ({ ...v, sel: v.sel === sel ? null : sel, confirm: null }))
    }
    const setView = (patch: Partial<View>) => () => update($, viewAtom, v => ({ ...v, ...patch }))

    // ---- what needs the person: this session's own asks, then other sessions', then what may be stuck ----
    // `asks` are drawn as cards: a pick answers Claude ('answer'), goes in the prompt ('prompt'), or jumps there ('jump').
    type NeedRow = {
      key: string; glyph: string; color: string; text: string; from: number | null; onPress: (() => Promise<unknown>) | null
      asks?: Ask[]; mode?: 'answer' | 'prompt' | 'jump'; callId?: string; sessionId?: string
    }
    const needRows: NeedRow[] = []
    for (const r of groups.needs) {
      const agentId = r.agentId
      needRows.push({
        key: r.key, glyph: r.glyph, color: 'yellow', text: r.text, from: r.from,
        onPress: agentId === undefined ? null : () => togglePeek($, agentId),
        ...(r.asks === undefined ? {} : r.callId !== undefined ? { asks: r.asks, mode: 'answer' as const, callId: r.callId } : { asks: r.asks, mode: 'prompt' as const }),
      })
    }
    const mapNeeds: MapNeed[] = needsOf(map)
    let elsewhere = 0
    for (const n of mapNeeds) {
      if (n.isSelf && n.kind === 'wait') continue
      const s = map.find(x => x.sessionId === n.sessionId)
      if (s === undefined) continue
      if (!n.isSelf) elsewhere += 1
      const node = n.nodeId === null ? undefined : s.nodes.find(x => x.id === n.nodeId)
      needRows.push({
        key: n.nodeId === null ? `need:session:${n.sessionId}` : `need:node:${n.isSelf ? 'self' : n.sessionId}:${n.nodeId}`,
        glyph: n.kind === 'wait' ? '!' : '?',
        color: n.kind === 'wait' ? 'yellow' : STUCK_COLOR,
        text: `${n.where}: ${n.why}`,
        from: n.since,
        onPress: node !== undefined ? () => openNode(s, node) : !s.isSelf ? async () => startJump($, s.sessionId) : () => openSession(s),
        ...(n.asks === undefined || s.isSelf ? {} : { asks: n.asks, mode: 'jump' as const, sessionId: s.sessionId }),
      })
    }

    // ---- Claude's choices as cards ----
    const clearPicks = (callId: string) => update($, viewAtom, v => ({ ...v, picks: Object.fromEntries(Object.entries(v.picks ?? {}).filter(([k]) => !k.startsWith(`${callId}:`))) }))
    // The person's answer to a question of this session's Claude, handed to the call that waits on it.
    const sendAnswers = async (callId: string, asks: readonly Ask[], byIndex: Record<number, readonly string[]>): Promise<void> => {
      const answers = answersOf(asks, byIndex)
      if (answers === null) return
      const answer = askWaiters.get(callId)
      await clearPicks(callId)
      if (answer === undefined) return notify($, 'That question was already answered.', { timeoutMs: 4_000 })
      answer(answers)
    }
    const pressChoice = (r: NeedRow, qi: number, c: Choice, chosen: readonly string[]) => async (): Promise<void> => {
      const ask = r.asks?.[qi]
      if (ask === undefined) return
      if (r.mode === 'prompt') {
        await $.prompt.fill({ text: c.label, mode: 'insert' }).catch(() => undefined)
        return
      }
      if (r.mode === 'jump' && r.sessionId !== undefined) return startJump($, r.sessionId)
      if (r.mode !== 'answer' || r.callId === undefined) return
      const callId = r.callId
      const next = pickChoice(chosen, c.label, ask.isMulti)
      // One question, one choice: the press is the answer.
      if ((r.asks?.length ?? 0) === 1 && !ask.isMulti) return sendAnswers(callId, r.asks ?? [], { 0: next })
      await update($, viewAtom, v => ({ ...v, picks: { ...(v.picks ?? {}), [`${callId}:${qi}`]: next } }))
    }
    // Each question's choices as cards, two to a row where there is room: the label, then what it leads to.
    const choiceCards = (r: NeedRow) => {
      const asks = r.asks ?? []
      if (asks.length === 0 || r.mode === undefined) return null
      const inner = width - 2
      const cols = inner >= 60 ? 2 : 1
      const cardW = Math.floor((inner - (cols - 1)) / cols)
      const room = cardW - 4
      const picksOf = (qi: number): string[] => (r.callId === undefined ? [] : view.picks?.[`${r.callId}:${qi}`] ?? [])
      const byIndex: Record<number, readonly string[]> = Object.fromEntries(asks.map((_, qi) => [qi, picksOf(qi)]))
      const needsSend = r.mode === 'answer' && (asks.length > 1 || asks.some(a => a.isMulti))
      const isReady = answersOf(asks, byIndex) !== null
      const hint = r.mode === 'answer'
        ? (needsSend ? 'Pick for each question, then send.' : 'Press one to answer, or answer in the dialog.')
        : r.mode === 'prompt' ? 'Press one to put it in your prompt.' : 'Jump there to answer.'
      const callId = r.callId
      return (
        <Box key={`asks:${r.key}`} flexDirection="column" marginLeft={2}>
          {asks.map((a, qi) => {
            const rows: Choice[][] = []
            for (let i = 0; i < a.choices.length; i += cols) rows.push(a.choices.slice(i, i + cols))
            const chosen = picksOf(qi)
            const head = asks.length > 1 ? a.question : ''
            return (
              <Box key={`ask:${r.key}:${qi}`} flexDirection="column">
                {(head !== '' || a.header !== '' || a.isMulti) && (
                  <Box>
                    {a.header !== '' && <Text color="yellow">{`${fit(m(a.header), 14)} `}</Text>}
                    {head !== '' && <Text>{fit(m(head), Math.max(8, inner - (a.header === '' ? 0 : Math.min(cellWidth(a.header), 14) + 1) - (a.isMulti ? 12 : 0)))}</Text>}
                    {a.isMulti && <Text dimColor>{' (pick any)'}</Text>}
                  </Box>
                )}
                {a.choices.length === 0 && <Text dimColor>{fit('Answer this one in the dialog.', inner)}</Text>}
                {rows.map((row, ri) => (
                  <Box key={`askrow:${r.key}:${qi}:${ri}`} gap={1}>
                    {row.map((c, ci) => {
                      const n = ri * cols + ci + 1
                      const isOn = chosen.includes(c.label)
                      const lines = c.detail === '' ? [] : wrap(m(c.detail), room, 2)
                      return (
                        <Box key={`choice:${r.key}:${qi}:${n}`} width={cardW} flexDirection="column" borderStyle="round" borderColor={isOn ? 'claude' : 'gray'} borderDimColor={!isOn} hover={{ borderColor: 'claude', borderDimColor: false }} paddingX={1}>
                          <Button key={`pick:${r.key}:${qi}:${n}`} plain label={fit(`${isOn ? '✓' : `${n}.`} ${m(c.label)}`, room)} onPress={pressChoice(r, qi, c, chosen)} />
                          {lines.map((l, i) => <Text key={`choiced:${r.key}:${qi}:${n}:${i}`} dimColor>{l}</Text>)}
                        </Box>
                      )
                    })}
                  </Box>
                ))}
              </Box>
            )
          })}
          <Box gap={1}>
            {needsSend && callId !== undefined && (
              <Button key={`send:${r.key}`} variant={isReady ? 'primary' : undefined} dimColor={!isReady} label="Send answers" onPress={() => (isReady ? sendAnswers(callId, asks, byIndex) : Promise.resolve())} />
            )}
            <Text dimColor>{fit(hint, needsSend ? Math.max(8, inner - 16) : inner)}</Text>
          </Box>
        </Box>
      )
    }
    const needRow = (r: NeedRow) => {
      const time = r.from === null ? '' : dur(now - r.from)
      const room = width - time.length - 3
      const [first = '', second] = wrap(m(r.text), room, 2)
      const label = `${padEnd(first, room)} ${time}`
      return (
        <Box key={`wrap:${r.key}`} flexDirection="column">
          <Box>
            <Text color={r.color}>{r.glyph} </Text>
            {r.onPress === null
              ? <Text bold>{label}</Text>
              : <Button key={r.key} plain label={label} onPress={r.onPress} />}
          </Box>
          {second !== undefined && <Text dimColor>{`  ${second}`}</Text>}
          {choiceCards(r)}
        </Box>
      )
    }

    // ---- the tabs: three cards, the one shown in the accent colour ----
    const done = g.tasks.filter(t => t.status === 'completed').length
    const total = g.tasks.length
    const agentCount = catalogList.filter(c => c.kind === 'agent').length
    const skillCount = catalogList.filter(c => c.kind === 'skill').length
    const tabW = Math.max(10, Math.floor((width - 2) / 3))
    // `long` when it fits the card, else `short`, else the name alone.
    const tabCard = (id: View['tab'], name: string, long: string, short: string, color?: string) => {
      const isOn = view.tab === id
      const inner = tabW - 4
      const extra = [long, short].find(x => x !== '' && cellWidth(name) + 1 + cellWidth(x) <= inner) ?? ''
      const pad = ' '.repeat(Math.max(0, inner - cellWidth(name) - (extra === '' ? 0 : cellWidth(extra) + 1)))
      return (
        <Box key={`tabcard:${id}`} width={tabW} borderStyle="round" borderColor={isOn ? 'claude' : 'gray'} borderDimColor={!isOn} hover={{ borderColor: 'claude', borderDimColor: false }} paddingX={1}>
          <Button key={`tab:${id}`} plain label={name} onPress={setView({ tab: id, confirm: null })}>
            <Text bold color={isOn ? 'claude' : undefined}>{name}</Text>
            {extra === '' ? '' : <Text color={color} dimColor={color === undefined}>{` ${extra}`}</Text>}
            {pad}
          </Button>
        </Box>
      )
    }
    const tabs = (
      <Box gap={1}>
        {needRows.length > 0
          ? tabCard('map', 'Map', `${needRows.length} need you`, `${needRows.length}!`, 'yellow')
          : tabCard('map', 'Map', `${map.length} session${map.length === 1 ? '' : 's'}`, String(map.length))}
        {tabCard('tasks', 'Tasks', total === 0 ? '' : `${done}/${total} done`, total === 0 ? '' : `${done}/${total}`, total > 0 && done === total ? 'green' : undefined)}
        {tabCard('launch', 'Launch', `${agentCount} agents`, String(agentCount))}
      </Box>
    )

    // ---- the map ----
    const working = map.reduce((n, s) => n + s.nodes.filter(x => x.kind === 'agent' && x.status === 'running').length, 0)
    const counts = [
      `${map.length} session${map.length === 1 ? '' : 's'}`,
      needRows.length > 0 ? `${needRows.length} need you` : '',
      working > 0 ? `${working} agent${working === 1 ? '' : 's'} working` : '',
    ].filter(x => x !== '').join(' · ')
    // Other sessions with nothing running fold into one line each under IDLE.
    const quiet = map.filter(s => !s.isSelf && s.status === 'idle' && !s.nodes.some(n => n.status === 'running' || n.status === 'waiting' || n.status === 'stuck'))
    const active = map.filter(s => !quiet.includes(s))
    const isPeekOpen = peekState.agentId !== null || view.sel !== null
    const isDesktopGraph = Svg !== null && e.surface === 'desktop'
    const zoom: Zoom = isDesktopGraph ? 'lines' : view.zoom === 'auto' ? autoZoom(active, needRows.length + quiet.length, bodyRows - (isPeekOpen ? 16 : 0)) : view.zoom

    const sessionTitle = (s: MapSession): string =>
      `${s.name}${s.branch === '' ? '' : ` · ${s.branch}`}${s.isSelf ? ' · here' : ''}`
    // The session whose block holds what is opened, so it opens right under it, not at the map's end.
    const openSid: string | null = peekState.agentId !== null
      ? (self !== undefined && self.nodes.some(n => n.id === peekState.agentId) ? self.sessionId : null)
      : view.sel === null ? null
        : view.sel.startsWith('session:') ? (map.some(s => `session:${s.sessionId}` === view.sel) ? view.sel.slice('session:'.length) : null)
          : map.find(s => s.nodes.some(n => view.sel === `node:${s.sessionId}:${n.id}`))?.sessionId ?? null
    const openedIn = (s: MapSession) => (openSid === s.sessionId ? opened() : null)
    const sessionLine = (s: MapSession): string => s.status === 'waiting' || s.status === 'stuck' ? s.why || s.doing : s.doing

    const card = (s: MapSession) => {
      const inner = width - 4
      const time = dur(now - s.since)
      const room = inner - time.length - 3
      // One line: NEEDS YOU above carries the whole wait.
      const second = wrap(m(sessionLine(s)), inner - 2, 1)
      const kids = s.nodes
      return (
        <Box key={`card:${s.sessionId}`} flexDirection="column">
          <Box borderStyle="round" borderColor={s.status === 'idle' ? 'gray' : colorOf(s.status, 'session')} flexDirection="column" paddingX={1}>
            <Box>
              <Text color={colorOf(s.status, 'session')}>{glyphOf(s.status, 'session')} </Text>
              <Button key={`session:${s.sessionId}`} plain label={`${padEnd(fit(m(sessionTitle(s)), room), room)} ${time}`} onPress={() => openSession(s)} />
            </Box>
            {second.map((l, i) => <Text key={`card2:${s.sessionId}:${i}`} dimColor={s.status === 'idle'} color={s.status === 'waiting' ? 'yellow' : s.status === 'stuck' ? STUCK_COLOR : undefined}>{`  ${l}`}</Text>)}
          </Box>
          {kids.length > 0 && (
            <Box flexDirection="column" marginLeft={1}>
              {kids.map((n, i) => nodeCard(s, n, i === kids.length - 1))}
            </Box>
          )}
          {openedIn(s)}
        </Box>
      )
    }
    const nodeCard = (s: MapSession, n: MapNode, isLast: boolean) => {
      const inner = width - 9
      const time = timeOf(n)
      const room = inner - (time === '' ? 0 : time.length + 1) - 2
      const isAttention = n.status === 'waiting' || n.status === 'stuck'
      const second = wrap(m(lineTwo(n)), inner - 2, isAttention ? 2 : 1).filter(l => l !== '')
      const height = 3 + second.length
      const prefix = Array.from({ length: height }, (_, i) => (i === 1 ? (isLast ? '└─▸' : '├─▸') : i === 0 || !isLast ? '│' : ' '))
      const key = nodeKey(s, n)
      return (
        <Box key={`row:${key}`}>
          <Box flexDirection="column" width={4}>
            {prefix.map((p, i) => <Text key={`pre:${key}:${i}`} dimColor>{p}</Text>)}
          </Box>
          <Box borderStyle="round" borderColor={n.status === 'done' || n.status === 'idle' ? 'gray' : colorOf(n.status, n.kind)} flexDirection="column" paddingX={1} flexGrow={1}>
            <Box>
              <Text color={colorOf(n.status, n.kind)}>{glyphOf(n.status, n.kind)} </Text>
              <Button key={key} plain dimColor={n.status === 'done'} label={time === '' ? fit(m(n.title), room + 1) : `${padEnd(fit(m(n.title), room), room)} ${time}`} onPress={() => openNode(s, n)} />
            </Box>
            {second.map((l, i) => <Text key={`two:${key}:${i}`} dimColor={!isAttention && n.progress === null} color={n.status === 'waiting' ? 'yellow' : n.status === 'stuck' ? STUCK_COLOR : n.progress !== null && i === 0 ? 'magenta' : undefined}>{`  ${l}`}</Text>)}
          </Box>
        </Box>
      )
    }
    const lineRow = (s: MapSession, n: MapNode | null, prefix: string) => {
      const status = n === null ? s.status : n.status
      const kind = n === null ? 'session' : n.kind
      const time = n === null ? dur(now - s.since) : timeOf(n)
      const lead = cellWidth(prefix) + 2
      const room = width - lead - (time === '' ? 0 : time.length + 1)
      const words = n === null
        ? `${sessionTitle(s)}${s.status === 'waiting' || s.status === 'stuck' ? ` — ${s.why}` : ''}`
        : `${n.title}${n.status === 'waiting' || n.status === 'stuck' ? ` — ${n.why}` : n.progress === null ? '' : ` ${n.progress.done}/${n.progress.total}`}`
      const key = n === null ? `session:${s.sessionId}` : nodeKey(s, n)
      return (
        <Box key={`line:${key}`}>
          {prefix !== '' && <Text dimColor>{prefix}</Text>}
          <Text color={colorOf(status, kind)}>{glyphOf(status, kind)} </Text>
          <Button key={key} plain dimColor={status === 'done'} label={time === '' ? fit(m(words), room) : `${padEnd(fit(m(words), room), room)} ${time}`} onPress={() => (n === null ? openSession(s) : openNode(s, n))} />
        </Box>
      )
    }
    const lines = (s: MapSession) => (
      <Box key={`lines:${s.sessionId}`} flexDirection="column">
        {lineRow(s, null, '')}
        {s.nodes.map((n, i) => lineRow(s, n, i === s.nodes.length - 1 ? '└─▸ ' : '├─▸ '))}
        {openedIn(s)}
      </Box>
    )
    const dots = (s: MapSession) => (
      <Box key={`dotsrow:${s.sessionId}`} flexDirection="column">
        <Box key={`dots:${s.sessionId}`} gap={1}>
          <Text color={colorOf(s.status, 'session')}>{glyphOf(s.status, 'session')}</Text>
          <Button key={`session:${s.sessionId}`} plain label={padEnd(fit(m(s.name), 16), 16)} onPress={() => openSession(s)} />
          {s.nodes.slice(0, Math.max(1, Math.floor((width - 21) / 2))).map(n => (
            <Button key={nodeKey(s, n)} plain label={glyphOf(n.status, n.kind)} onPress={() => openNode(s, n)} />
          ))}
        </Box>
        {openedIn(s)}
      </Box>
    )
    // An idle session folded into one line; opened, its card follows the line.
    const quietRow = (s: MapSession) => (
      <Box key={`quiet:${s.sessionId}`} flexDirection="column">
        {zoom === 'dots' ? dots(s) : lineRow(s, null, '')}
        {zoom === 'dots' ? null : openedIn(s)}
      </Box>
    )

    // ---- what is opened below the map ----
    const closeRow = (
      <Box gap={1} marginTop={1}>
        <Button key="peek-close" hotkey="x" plain label="[close]" onPress={async () => {
          await update($, peek, () => NO_PEEK)
          await update($, viewAtom, v => ({ ...v, sel: null, confirm: null }))
        }} />
      </Box>
    )
    // What is opened is a card of its own, its border in the colour of what it is.
    const peekW = width - 4
    const peekCard = (key: string, color: string, children: unknown[]) => (
      <Box key={`peek:${key}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginLeft={0}>
        {children as never}
      </Box>
    )
    const agentPeek = () => {
      const agentId = peekState.agentId
      if (agentId === null) return null
      const v = views.find(x => x.id === agentId)
      const c = v?.card ?? null
      const n = self?.nodes.find(x => x.id === agentId)
      const by = c === null ? '' : [`by ${c.calledBy}`, c.model, `${c.calls} call${c.calls === 1 ? '' : 's'}`, c.isBackground ? 'background' : ''].filter(x => x !== '').join(' · ')
      const extra = n === undefined ? '' : [n.costUsd === null ? '' : `~$${n.costUsd.toFixed(2)}`, n.tokens === null ? '' : `context ${Math.round(n.tokens / 1000)}k`].filter(x => x !== '').join(' · ')
      return peekCard(`agent:${agentId}`, 'magenta', [
        <Box key={`agent-head:${agentId}`}>
          <Text bold color="magenta">AGENT</Text>
          <Text bold>{`  ${fit(m(v === undefined ? 'subagent' : `${v.type} · ${v.purpose}`), peekW - 7)}`}</Text>
        </Box>,
        n !== undefined && (n.status === 'waiting' || n.status === 'stuck') && detail(`why:${agentId}`, n.status === 'waiting' ? 'waits' : 'stuck', n.why, 2, n.status === 'waiting' ? 'yellow' : STUCK_COLOR, peekW),
        c !== null && c.role !== '' && detail(`role:${agentId}`, 'role', c.role, 2, undefined, peekW),
        (c?.task || peekState.task) !== '' && detail(`task:${agentId}`, 'task', c?.task || peekState.task, 2, 'white', peekW),
        n !== undefined && n.now !== '' && detail(`now:${agentId}`, 'now', n.now, 1, 'cyan', peekW),
        n !== undefined && n.raw !== '' && n.status !== 'done' && n.status !== 'failed' && detail(`raw:${agentId}`, 'tool', n.raw, 1, undefined, peekW),
        n !== undefined && n.progress !== null && detail(`prog:${agentId}`, 'steps', `${bar(n.progress)}${n.progress.note === '' ? '' : ` · ${n.progress.note}`} (savvy-progress)`, 1, 'magenta', peekW),
        by !== '' && detail(`by:${agentId}`, '', by, 1, undefined, peekW),
        extra !== '' && detail(`cost:${agentId}`, '', extra, 1, undefined, peekW),
        peekState.error !== '' && <Text key={`agent-err:${agentId}`} color="red">{fit(m(peekState.error), peekW)}</Text>,
        ...peekState.lines.map((l, i) => (
          <Box key={`step:${agentId}:${i}`}>
            <Text color={PEEK_COLOR[l.kind]}>{l.kind === 'running' ? spin : PEEK_GLYPH[l.kind]} </Text>
            <Text dimColor={l.kind === 'done'}>{fit(m(l.text), peekW - 2)}</Text>
          </Box>
        )),
        c !== null && c.result !== '' && detail(`result:${agentId}`, '→', c.result, 3, undefined, peekW),
        c !== null && c.result !== '' && (
          <Box key={`agent-use:${agentId}`} gap={1}>
            <Text>{'   '}</Text>
            <Button key={`use:${agentId}`} plain label="[use in prompt]" onPress={() => useResult($, c)} />
          </Box>
        ),
        closeRow,
      ])
    }
    const sessionPeek = (s: MapSession) => {
      const usage = [s.contextPercent === null ? '' : `context ${Math.round(s.contextPercent)}%`, s.costUsd === null ? '' : `$${s.costUsd.toFixed(2)}`].filter(x => x !== '').join(' · ')
      const others = hb.members.filter(x => !x.isSelf)
      const toMember = hb.members.find(x => x.sessionId === hb.to && !x.isSelf)
      const row = rowsNow.find(r => r.sessionId === s.sessionId)
      const folder = homeDir !== '' && s.cwd.startsWith(homeDir) ? `~${s.cwd.slice(homeDir.length)}` : s.cwd
      const terminal = row === undefined ? '' : row.jobId !== null ? 'background session · opens with claude attach' : row.tty === null ? 'no terminal known' : row.tty.replace('/dev/', '')
      const said = sessionLine(s)
      const tone = s.status === 'waiting' ? 'yellow' : s.status === 'stuck' ? STUCK_COLOR : s.status === 'running' ? 'cyan' : 'gray'
      const jump = view.jump != null && view.jump.sessionId === s.sessionId && (view.jump.at === 0 || now - view.jump.at < 60_000) ? view.jump : null
      const runs = s.nodes.length > 0 ? s.nodes.map(n => n.title.split(' · ')[0]).join(', ')
        : s.hasMap ? 'nothing started'
          : 'not shared: that session does not run Ringside yet (a session started now will)'
      return (
        <Box key={`peek:session:${s.sessionId}`} flexDirection="column" borderStyle="round" borderColor={s.isSelf ? 'claude' : tone === 'gray' ? 'blue' : tone} paddingX={1}>
          <Box>
            <Text color={colorOf(s.status, 'session')}>{`${glyphOf(s.status, 'session')} `}</Text>
            <Text bold>{fit(m(sessionTitle(s)), peekW - 2)}</Text>
          </Box>
          <Text color={tone === 'gray' ? undefined : tone} dimColor={tone === 'gray'}>{fit(`${STATUS_WORD[s.status]} · ${dur(now - s.since)}`, peekW)}</Text>
          {said !== '' && wrap(m(said), peekW, 3).map((l, i) => <Text key={`said:${s.sessionId}:${i}`}>{l}</Text>)}
          <Box flexDirection="column" marginTop={1}>
            {detail(`where:${s.sessionId}`, 'where', folder, 1, undefined, peekW)}
            {terminal !== '' && !s.isSelf && detail(`tty:${s.sessionId}`, 'term', terminal, 1, undefined, peekW)}
            {usage !== '' && detail(`usage:${s.sessionId}`, 'usage', usage, 1, undefined, peekW)}
            {detail(`nodes:${s.sessionId}`, 'runs', runs, 2, undefined, peekW)}
          </Box>
          {!s.isSelf && (
            <Box gap={1} marginTop={1}>
              <Button key={`jump:${s.sessionId}`} label={row?.jobId != null ? 'Open in Terminal' : 'Jump there'} variant="primary" autoFocus onPress={() => startJump($, s.sessionId)} />
              <Text dimColor>{fit(row?.jobId != null ? 'claude attach in a new window' : 'brings its terminal window to the front', Math.max(0, peekW - 16))}</Text>
            </Box>
          )}
          {jump !== null && wrap(`${jump.at === 0 ? spin : jump.isOk ? '✓' : '✗'} ${m(jump.text)}${jump.at === 0 ? '' : ` · ${clockOf(jump.at)}`}`, peekW, 4).map((l, i) => (
            <Text key={`jumped:${s.sessionId}:${i}`} color={jump.at === 0 ? 'cyan' : jump.isOk ? 'green' : 'red'}>{i === 0 ? l : `  ${l}`}</Text>
          ))}
          {s.isSelf && hasReplay && (
            <Box gap={1} marginTop={1}>
              <Button key="replay" plain label="[replay the last turn's edits]" onPress={async () => {
                await runSkill($, 'replay', '')
                const at = await $.clock.now()
                await update($, viewAtom, v => ({ ...v, replayAt: at }))
              }} />
            </Box>
          )}
          {/* A pane cannot take the keys from one the person is pressing in, so Replay Theater opens as a tab behind. */}
          {s.isSelf && hasReplay && view.replayAt != null && now - view.replayAt < 30_000 && (
            <Text dimColor>{fit('Opened in the Replay Theater tab. Esc, then /replay brings it to the front.', peekW)}</Text>
          )}
          {s.isSelf && hb.root !== '' && (
            <Box flexDirection="column" marginTop={1}>
              {heading(`BOARD · ${fit(m(hb.label), Math.max(6, peekW - 28))}`, `${others.length} other session${others.length === 1 ? '' : 's'} in this repo`, 'blue')}
              <Box gap={1}>
                <Text dimColor>to</Text>
                <Button key="hub-to-all" plain dimColor={hb.to !== 'all'} label={hb.to === 'all' ? '[all]' : 'all'} onPress={() => update($, hubAtom, x => ({ ...x, to: 'all' }))} />
                {others.slice(0, 6).map(x => (
                  <Button key={`hub-member:${x.sessionId}`} plain dimColor={hb.to !== x.sessionId} label={hb.to === x.sessionId ? `[${fit(m(x.name), 16)}]` : fit(m(x.name), 16)} onPress={() => update($, hubAtom, y => ({ ...y, to: y.to === x.sessionId ? 'all' : x.sessionId }))} />
                ))}
              </Box>
              {hb.messages.slice(-SHOWN_MESSAGES).map(msg => {
                const who = `${msg.fromName}${msg.by === 'claude' ? '·claude' : ''}${msg.to === 'all' ? '' : `→${msg.to === hb.to ? (toMember?.name ?? 'one') : (hb.members.find(x => x.sessionId === msg.to)?.name ?? 'one session')}`}`
                return (
                  <Box key={`hub-msg:${msg.id}`} flexDirection="column">
                    {wrap(m(`${clockOf(msg.at)} ${who}: ${msg.text}`), peekW - 1, 2).map((line, i) => (
                      <Text key={`hub-msg:${msg.id}:${i}`} dimColor={i > 0}>{`${i === 0 ? '' : '  '}${line}`}</Text>
                    ))}
                  </Box>
                )
              })}
              {Input !== null && <Input key="hub-say" label={`to ${fit(m(toMember?.name ?? 'all'), 14)} › `} placeholder="note for this repo, Enter posts" submitLabel="post" onSubmit={value => hubSay($, value)} />}
              <Box gap={1}>
                <Button key="hub-wake" plain dimColor={!hb.wake} label={hb.wake ? '[wake: on]' : '[wake: off]'} onPress={() => update($, hubAtom, x => ({ ...x, wake: !x.wake }))} />
                <Button key="hub-report" plain label="[report]" onPress={() => reportHub($)} />
              </Box>
              {hb.note !== '' && <Text dimColor>{fit(m(hb.note), peekW)}</Text>}
            </Box>
          )}
          {closeRow}
        </Box>
      )
    }
    const nodePeek = (s: MapSession, n: MapNode) => {
      const loop = s.isSelf && n.kind === 'loop' ? loopList.find(l => `loop:${l.id}` === n.id) : undefined
      const shell = s.isSelf && n.kind === 'job' ? jobList.find(j => `job:${j.id}` === n.id) : undefined
      const confirmKey = `stop:${n.id}`
      const isConfirming = view.confirm === confirmKey
      const title = loop !== undefined ? 'LOOP' : shell !== undefined ? 'SHELL' : n.kind === 'workflow' ? 'WORKFLOW' : n.kind === 'agent' ? 'AGENT' : 'NODE'
      const stop = async () => {
        if (!isConfirming) {
          await update($, viewAtom, v => ({ ...v, confirm: confirmKey }))
          return
        }
        await update($, viewAtom, v => ({ ...v, confirm: null }))
        if (loop !== undefined) startStop($, n.id, () => stopLoop($, loop))
        if (shell !== undefined) startStop($, n.id, () => stopShell($, shell))
      }
      const lt = loop === undefined ? null : loopLines(loop, now, m0.isWorking)
      return (
        <Box key={`peek:node:${n.id}`} flexDirection="column" borderStyle="round" borderColor={loop !== undefined ? 'cyan' : 'magenta'} paddingX={1}>
          <Box>
            <Text bold color={loop !== undefined ? 'cyan' : 'magenta'}>{title}</Text>
            <Text bold>{`  ${fit(m(s.isSelf ? n.title : `${s.name} › ${n.title}`), peekW - title.length - 2)}`}</Text>
          </Box>
          {lt !== null && <Text>{fit(m(lt.head), peekW)}</Text>}
          {lt !== null && wrap(m(lt.detail), peekW, 3).map((l, i) => <Text key={`loopd:${n.id}:${i}`} dimColor>{l}</Text>)}
          {lt === null && detail(`state:${n.id}`, 'state', `${STATUS_WORD[n.status]}${n.status === 'waiting' || n.status === 'stuck' ? ` · ${n.why}` : ''}`, 3, n.status === 'waiting' ? 'yellow' : n.status === 'stuck' ? STUCK_COLOR : undefined, peekW)}
          {lt === null && n.now !== '' && detail(`now:${n.id}`, 'now', n.now, 2, 'cyan', peekW)}
          {n.raw !== '' && (loop !== undefined || (n.status !== 'done' && n.status !== 'failed')) && detail(`raw:${n.id}`, loop !== undefined ? 'prompt' : 'tool', n.raw, 2, undefined, peekW)}
          {n.progress !== null && detail(`prog:${n.id}`, 'steps', bar(n.progress), 1, 'magenta', peekW)}
          {n.status === 'done' && n.why !== '' && detail(`res:${n.id}`, '→', n.why, 3, undefined, peekW)}
          {(loop !== undefined || (shell !== undefined && shell.taskId !== null)) && (
            <Box gap={1} marginTop={1}>
              <Button key={loop !== undefined ? `loop-stop:${loop.id}` : `job-stop:${n.id}`} label={isConfirming ? 'Press again to stop' : 'Stop'} onPress={stop} />
              {isConfirming && <Button key="stop-cancel" plain dimColor label="[keep it]" onPress={setView({ confirm: null })} />}
            </Box>
          )}
          {!s.isSelf && (
            <Box gap={1} marginTop={1}>
              <Button key={`jump:${s.sessionId}`} label={`Jump to ${fit(m(s.name), 20)}`} variant="primary" onPress={() => startJump($, s.sessionId)} />
            </Box>
          )}
          {!s.isSelf && view.jump != null && view.jump.sessionId === s.sessionId && (view.jump.at === 0 || now - view.jump.at < 60_000) && (
            <Text color={view.jump.at === 0 ? 'cyan' : view.jump.isOk ? 'green' : 'red'}>{wrap(`${view.jump.at === 0 ? spin : view.jump.isOk ? '✓' : '✗'} ${m(view.jump.text)}`, peekW, 3).join('\n  ')}</Text>
          )}
          {closeRow}
        </Box>
      )
    }
    const opened = () => {
      if (peekState.agentId !== null) return agentPeek()
      if (view.sel === null) return null
      if (view.sel.startsWith('session:')) {
        const s = map.find(x => `session:${x.sessionId}` === view.sel)
        return s === undefined ? null : sessionPeek(s)
      }
      for (const s of map) {
        const n = s.nodes.find(x => view.sel === `node:${s.sessionId}:${x.id}`)
        if (n !== undefined) return nodePeek(s, n)
      }
      // Closed or ended meanwhile: say so instead of drawing nothing.
      return (
        <Box key="peek:gone" flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>That one has ended or left the map.</Text>
          {closeRow}
        </Box>
      )
    }

    const zoomRow = isDesktopGraph ? null : (
      <Box gap={1}>
        <Text dimColor>view</Text>
        {(['auto', 'cards', 'lines', 'dots'] as const).map(z => (
          <Button key={`zoom:${z}`} plain dimColor={view.zoom !== z} label={view.zoom === z ? `[${z === 'auto' ? `auto: ${zoom}` : z}]` : z} onPress={setView({ zoom: z })} />
        ))}
      </Box>
    )
    const board = hb.messages.length === 0 || self === undefined ? null : (
      <Box gap={1}>
        <Text dimColor>{fit(`board · ${hb.messages.length} message${hb.messages.length === 1 ? '' : 's'} today`, width - 8)}</Text>
        <Button key="open-board" plain label="[open]" onPress={() => openSession(self)} />
      </Box>
    )
    const graph = !isDesktopGraph || Svg === null ? null : (() => {
      // About 8 CSS pixels a column on the desktop surfaces.
      const art = graphSvg(map, now, width * 8, m)
      return <Svg source={art.source} alt={`Agent map: ${map.length} session${map.length === 1 ? '' : 's'}, ${needRows.length} need you, ${working} agent${working === 1 ? '' : 's'} working`} />
    })()
    const mapTab = (
      <Box flexDirection="column">
        {heading('NOW', counts, needRows.length > 0 ? 'yellow' : undefined)}
        {m0.isWorking
          ? <Text color="cyan">{fit(`${spin} Claude working ${m0.since === null ? '' : elapsed(now - m0.since)}${self === undefined || self.doing === '' ? '' : ` · ${m(self.doing)}`}`, width)}</Text>
          : m0.since === null ? <Text dimColor>Claude ready</Text> : <Text color="green">{fit(`Your turn · Claude replied ${ago(now - m0.since)}`, width)}</Text>}
        {needRows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {heading('NEEDS YOU', elsewhere > 0 ? `${elsewhere} in other sessions` : '', 'yellow')}
            {needRows.map(needRow)}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {zoomRow}
          {graph}
          {active.map(s => (zoom === 'cards' ? card(s) : zoom === 'lines' ? lines(s) : dots(s)))}
          {quiet.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {heading('IDLE', `${quiet.length} other session${quiet.length === 1 ? '' : 's'}, nothing running · press to open`)}
              {quiet.map(quietRow)}
            </Box>
          )}
          {board}
        </Box>
        {/* Opened but in no session's block (ended, or left the map): said at the end. */}
        {openSid === null && (peekState.agentId !== null || view.sel !== null) && <Box flexDirection="column" marginTop={1}>{opened()}</Box>}
      </Box>
    )

    // ---- tasks: the whole list in its own order, what is done kept and ticked ----
    const goalTime = g.startedAt === null ? '' : elapsed(now - g.startedAt)
    const taskW = width - 4
    const barCells = Math.max(4, Math.min(24, taskW - 8))
    const filled = total === 0 ? 0 : Math.round((done / total) * barCells)
    const doingCount = g.tasks.filter(t => t.status === 'in_progress').length
    const todoCount = total - done - doingCount
    const taskRow = (t: Task, i: number) => {
      const isNow = t.status === 'in_progress'
      const isDone = t.status === 'completed'
      const lead = `${String(i + 1).padStart(String(Math.min(total, SHOWN_TASKS)).length)} `
      const room = taskW - lead.length - 2 - (isNow ? 4 : 0)
      const [first = '', second] = wrap(m(t.subject), room, 2)
      return (
        <Box key={`task:${t.id}`} flexDirection="column">
          <Box>
            <Text dimColor>{lead}</Text>
            <Text color={isDone ? 'green' : isNow ? 'yellow' : 'gray'}>{`${isDone ? '✓' : isNow ? spin : '○'} `}</Text>
            <Text bold={isNow} color={isNow ? 'yellow' : undefined} dimColor={isDone}>{first}</Text>
            {isNow && <Text color="yellow">{' now'}</Text>}
          </Box>
          {second !== undefined && <Text dimColor={!isNow}>{`${' '.repeat(lead.length + 2)}${second}`}</Text>}
        </Box>
      )
    }
    const tasksTab = (
      <Box flexDirection="column">
        <Box key="tasks-card" flexDirection="column" borderStyle="round" borderColor={total > 0 && done === total ? 'green' : total > 0 ? 'claude' : 'gray'} paddingX={1}>
          <Box>
            <Text bold>Tasks</Text>
            <Text dimColor>{total === 0 ? '  none yet' : `  ${done} of ${total} done${goalTime === '' ? '' : ` · ${goalTime}`}`}</Text>
          </Box>
          {total === 0
            ? wrap('Claude has no task list in this session yet. When it makes one, every task shows here, the finished ones ticked.', taskW, 3).map((l, i) => <Text key={`tasks-none:${i}`} dimColor>{l}</Text>)
            : (
              <Box flexDirection="column">
                <Box>
                  <Text color="green">{'▰'.repeat(filled)}</Text>
                  <Text dimColor>{`${'▱'.repeat(barCells - filled)} ${Math.round((done / total) * 100)}%`}</Text>
                </Box>
                <Text dimColor>{fit([doingCount > 0 ? `${doingCount} in progress` : '', todoCount > 0 ? `${todoCount} to do` : '', done > 0 ? `${done} done` : ''].filter(x => x !== '').join(' · '), taskW)}</Text>
                <Box flexDirection="column" marginTop={1}>
                  {g.tasks.slice(0, SHOWN_TASKS).map(taskRow)}
                  {total > SHOWN_TASKS && <Text dimColor>{`+${total - SHOWN_TASKS} more`}</Text>}
                </Box>
              </Box>
            )}
        </Box>
      </Box>
    )

    // ---- launch: every agent type and skill as a card, the name on the left, its prompt on the right ----
    const matches = filterCatalog(catalogList, launch.kind, launch.query)
    const cardInner = width - 4
    const rightW = Math.max(11, Math.round(cardInner * 0.3))
    const leftW = cardInner - rightW
    const liveOf = (name: string) => views.filter(v => v.isLive && v.type === name)
    const liveCount = views.filter(v => v.isLive).length
    const skillFrom = (source: string): string => (source === 'user' ? 'yours' : source === 'builtin' ? 'built-in' : source)
    // Each pick's task box is a field of its own, so it opens empty, not with what was typed last time.
    const taskKey = (seq: number | undefined): string => `launch-task:${seq ?? 0}`
    // The task box takes the keys (the pane asks for them first: a click leaves them with the prompt).
    const focusTask = async () => {
      await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined)
      await $.ui.focus({ requestId: PANE, key: taskKey((await read($, launchAtom)).seq) }).catch(() => undefined)
    }
    // Picked, its task box opens; picked again, it closes.
    const pick = (c: CatalogEntry) => async () => {
      await update($, launchAtom, l => ({ ...l, picked: l.picked === c.name ? null : c.name, seq: (l.seq ?? 0) + 1, note: '' }))
      if ((await read($, launchAtom)).picked === c.name) await focusTask()
    }
    const unpick = () => update($, launchAtom, l => ({ ...l, picked: null, note: '' }))
    const openRun = (agentId: string) => async () => {
      await update($, viewAtom, v => ({ ...v, tab: 'map' as const, sel: null, confirm: null }))
      if ((await read($, peek)).agentId !== agentId) await togglePeek($, agentId)
    }
    const entryCard = (c: CatalogEntry) => {
      const key = `${c.kind}:${c.name}`
      const isPicked = launch.picked === c.name
      const live = c.kind === 'agent' ? liveOf(c.name) : []
      const first = live[0]
      const tag = c.kind === 'agent' ? (c.model ?? '') : skillFrom(c.source)
      const nameRoom = Math.max(6, leftW - 3 - (tag === '' ? 0 : cellWidth(tag) + 2))
      // At rest the description sits in the left 70%; picked, it and the task box take the card's whole width.
      const desc = wrap(m(c.description || 'No description given.'), isPicked ? cardInner - 2 : leftW - 3, isPicked ? 4 : 2)
      const descLines = desc.map((l, i) => <Text key={`ldesc:${key}:${i}`} dimColor>{`  ${l}`}</Text>)
      const border = isPicked ? 'green' : first !== undefined ? 'magenta' : 'gray'
      return (
        <Box key={`lcard:${key}`} flexDirection="column" borderStyle="round" borderColor={border} borderDimColor={border === 'gray'} hover={{ borderColor: 'claude', borderDimColor: false }} paddingX={1}>
          <Box>
            <Box flexDirection="column" width={leftW}>
              <Box>
                <Text color={c.kind === 'agent' ? dotColor(c) : 'claude'}>{c.kind === 'agent' ? '● ' : '/ '}</Text>
                <Button key={`pick:${key}`} plain label={c.name} onPress={pick(c)}>
                  <Text bold>{fit(m(c.name), nameRoom)}</Text>
                  {tag === '' ? '' : <Text dimColor>{`  ${fit(tag, 14)}`}</Text>}
                </Button>
              </Box>
              {!isPicked && descLines}
            </Box>
            <Box width={rightW} justifyContent="flex-end">
              {isPicked
                ? <Button key="launch-back" label="cancel" onPress={unpick} />
                : first !== undefined
                  ? (
                    <Button key={`running:${key}`} plain label={`${m(c.name)} running`} onPress={openRun(first.id)}>
                      <Text color="magenta">{fit(`${spin} ${live.length > 1 ? `${live.length} running` : `running · ${dur(now - first.from)}`}`, rightW)}</Text>
                    </Button>
                  )
                  : <Button key={`run:${key}`} label="▶ run" onPress={pick(c)} />}
            </Box>
          </Box>
          {isPicked && descLines}
          {isPicked && Input !== null && (
            <Box marginTop={1}>
              {c.kind === 'agent'
                ? <Input key={taskKey(launch.seq)} label="task" placeholder="what it should do, Enter starts it" submitLabel="start" autoFocus onSubmit={value => launchAgent($, c.name, value)} />
                : <Input key={taskKey(launch.seq)} label="args" placeholder="optional, Enter runs it" submitLabel="run" autoFocus onSubmit={value => runSkill($, c.name, value)} />}
            </Box>
          )}
          {isPicked && (
            <Box gap={1}>
              <Text>{' '}</Text>
              {c.kind === 'skill' && <Button key="launch-run" plain label="[run now]" onPress={() => runSkill($, c.name, '')} />}
              <Button key="launch-fill" plain label="[to prompt]" onPress={() => $.prompt.fill({ text: c.kind === 'skill' ? `/${c.name} ` : `Use the ${c.name} agent to `, mode: 'insert' }).then(unpick)} />
            </Box>
          )}
        </Box>
      )
    }
    const sectionHead = (key: string, label: string, hint: string, count: number) => {
      const text = `${label}  ${hint} · ${count} `
      return (
        <Box key={`lsec:${key}`} marginTop={1}>
          <Text bold color="#87afd7">{label}</Text>
          <Text dimColor>{`  ${hint} · ${count} ${'─'.repeat(Math.max(0, width - cellWidth(text)))}`}</Text>
        </Box>
      )
    }
    const kindCard = (kind: CatalogEntry['kind'], label: string) => {
      const isOn = launch.kind === kind
      return (
        <Box key={`kindcard:${kind}`} borderStyle="round" borderColor={isOn ? 'claude' : 'gray'} borderDimColor={!isOn} hover={{ borderColor: 'claude', borderDimColor: false }} paddingX={1}>
          <Button key={`launch-kind:${kind}`} plain label={label} onPress={() => update($, launchAtom, l => ({ ...l, kind, picked: null, query: '', note: '' }))}>
            <Text bold={isOn} color={isOn ? 'claude' : undefined}>{label}</Text>
          </Button>
        </Box>
      )
    }
    const launchTab = (
      <Box flexDirection="column">
        <Box key="launch-head" justifyContent="space-between">
          <Box>
            <Text color="claude">{'◆ '}</Text>
            <Text bold>{launch.kind === 'agent' ? 'Agents' : 'Skills'}</Text>
            <Text dimColor>{launch.kind === 'agent' ? ' you can start from here' : ' you can run from here'}</Text>
          </Box>
          {liveCount > 0 && <Text color="magenta">{`${spin} ${liveCount} running`}</Text>}
        </Box>
        <Box gap={1}>
          {kindCard('agent', `Agents ${agentCount}`)}
          {kindCard('skill', `Skills ${skillCount}`)}
        </Box>
        {Input !== null && <Input key="launch-filter" label="find" placeholder="type to filter, Enter picks the first" value={launch.query} onInput={value => update($, launchAtom, l => ({ ...l, query: value }))} onSubmit={async value => {
          const firstMatch = filterCatalog(catalogList, launch.kind, value)[0]
          if (firstMatch === undefined) return
          await update($, launchAtom, l => ({ ...l, query: value, picked: firstMatch.name, seq: (l.seq ?? 0) + 1 }))
          await focusTask()
        }} />}
        {launch.note !== '' && <Text color={launch.note.startsWith('Not started') || launch.note.startsWith('Could not') ? 'red' : 'green'}>{fit(m(launch.note), width)}</Text>}
        {launch.kind === 'agent'
          ? catalogSections(matches).map(sec => (
            <Box key={`lsecbox:${sec.key}`} flexDirection="column">
              {sectionHead(sec.key, sec.label, sec.hint, sec.entries.length)}
              {sec.entries.map(entryCard)}
            </Box>
          ))
          : (
            <Box flexDirection="column" marginTop={1}>
              {matches.slice(0, SHOWN_LAUNCH).map(entryCard)}
              {matches.length > SHOWN_LAUNCH && <Text dimColor>{fit(`  +${matches.length - SHOWN_LAUNCH} more · type to narrow`, width)}</Text>}
            </Box>
          )}
        {matches.length === 0 && <Text dimColor>{fit(launch.query === '' ? `No ${launch.kind === 'agent' ? 'agent types' : 'skills'} found yet.` : `Nothing matches "${launch.query}".`, width)}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {tabs}
        <Box flexDirection="column" marginTop={1}>
          {view.tab === 'tasks' ? tasksTab : view.tab === 'launch' ? launchTab : mapTab}
        </Box>
      </Box>
    )
  })

  // One row, only while the map is not on screen and only when something needs the person: another
  // session waiting on them, or anything that may be stuck. With the sessions mod loaded, its own band
  // already says who waits, so this one keeps to what may be stuck.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Unasked, the pane opens only beside a fullscreen transcript: on the main
    // screen (tmux's default) it would sit above the prompt, so it waits for /ringside.
    const isFullscreen = e.viewport?.isFullscreen
    if (opensUnasked && isFullscreen !== undefined) {
      opensUnasked = false
      if (isFullscreen) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }
    if (e.props.hasSurvey || (await read($, isShown))) return next(e)
    const now = await $.clock.now()
    // The band draws often; the map behind it is worked out at most once a second.
    if (now - bandCache.at > 1000) {
      const hasSessionsMod = adaptSessionRows(await readOther($, 'sessionsRows')).length > 0
      // Another session's question at the end of its answer is the pane's to list, not the band's: only what blocks it shows here.
      const items = needsOf(await currentMap($, now)).filter(n => n.kind === 'stuck' || (!hasSessionsMod && n.kind === 'wait' && !n.isSelf && n.isReply !== true))
      bandCache = { at: now, items }
    }
    const items = bandCache.items
    const first = items[0]
    if (first === undefined) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRecording = (await $.env.get('CLAUDE_MODS_RECORDING')) === '1'
    const terms = recordingTerms(await $.env.get('CLAUDE_MODS_RECORDING_TERMS'))
    const text = `${first.where}: ${first.why}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}`
    const isWait = first.kind === 'wait'
    const room = Math.max(10, e.props.bodyColumns - (isWait ? 28 : 26))
    return (
      <Box flexDirection="column">
        {below}
        <Box key="map-stuck" gap={1}>
          <Text color={isWait ? 'yellow' : STUCK_COLOR}>{isWait ? 'Waiting on you' : 'May be stuck'}</Text>
          <Text>{fit(isRecording ? mask(text, terms) : text, room)}</Text>
          <Button key="map-open" label="Open map" onPress={() => $.ui.open({ id: PANE, title: TITLE, focus: true }).then(() => undefined)} />
        </Box>
      </Box>
    )
  })
}

const HUB_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read', 'post'], description: 'read the hub, or post a note to its board' },
    text: { type: 'string', description: 'post: the note' },
    to: { type: 'string', description: 'post: "all" (default) or a session name from read' },
  },
  required: ['action'],
}

// The model's own way into the hub: read it, or leave a note on the board.
async function serveHubTool($: EngineInterface, input: Fields): Promise<{ result: string }> {
  const now = await $.clock.now()
  if (str(input.action) === 'post') {
    const h = await read($, hubAtom)
    const to = resolveRecipient(str(input.to), h.members)
    if (to === null) {
      const names = h.members.filter(x => !x.isSelf).map(x => x.name).join(', ') || 'none'
      return { result: `No session named "${str(input.to)}" in this repo. Sessions here: ${names}.` }
    }
    return { result: await postHub($, str(input.text), 'claude', to) }
  }
  await refreshHub($, now)
  const h = await read($, hubAtom)
  const own = await $.session.id()
  const newest = unread(h.messages, own, seenAt).slice(-1)[0]
  if (newest !== undefined) seenAt = newest.at
  const self = selfSummary(await read($, loopsAtom), agentViews(await read($, agents), await read($, cardsAtom), await read($, jobs)), await read($, goal), now)
  return { result: hubReport({ label: h.label, root: h.root, members: h.members, messages: h.messages, selfId: own, now, self }) }
}
