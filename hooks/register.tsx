import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentCard, AgentRow, CatalogEntry, FleetFile, Goal, Hub, HubMessage, HubState, Job, Launch, Loop, MainState, Need, Peek, PeekLine, SessionRow, Task, View,
} from '../types'
import {
  addCard, adoptCards, agentFromMarkdown, callerOf, filterCatalog, finishCard, mergeOffer, newCard, noteStep, PENDING_ID, pruneCards, purposeOf,
  replaceSkills, roleFor, skillsFrom, typeOf,
} from './agents'
import { asHubFile, bareMembers, HUB_STALE_MS, hubDir, hubNote, hubReport, newMessage, NODES_MAX, pushOutbox, readHub, resolveRecipient, unread } from './hub'
import type { HubFile } from './hub'
import { adaptHidden, adaptSessionRows, FOCUS_ITERM, FOCUS_TERMINAL, OPEN_TERMINAL, parsePs, rowsFromRegistry, shellQuote, tmuxPaneOn } from './fleet'
import { activeLoops, addCron, addWakeup, endLoop, fired, pruneLoops, reconcile } from './loops'
import {
  adaptFlightAgents, adaptFlightLoops, adaptSavvy, autoZoom, buildMap, cellWidth, dur, fit, graphSvg, needsOf, plainStep, selfNodes, span, stateWord, stuckReason, wrap,
} from './map'
import type { FleetFile as MapFleetFile, MapNeed, MapNode, MapSession, SelfSession, Zoom } from './map'
import { mask, recordingTerms } from './mask'

export { cellWidth, fit, span, wrap }

const PANE = 'agent-map'
const SELF = 'agent-map'
const TITLE = 'Agent Map'
const HUB_TOOL = 'mcp__agent-map__hub'
// Ended work stays listed this long, so you see what finished while you looked away.
const ENDED_KEEP_MS = 10 * 60 * 1000
// A call that succeeded faster than this is counted, not listed.
const QUICK_MS = 3_000
const MAX_JOBS = 80
const SHOWN_RUNNING = 8
const SHOWN_ENDED = 4
const SHOWN_LIVE_AGENTS = 6
const SHOWN_ENDED_AGENTS = 4
const SHOWN_TASKS = 8
const SHOWN_LAUNCH = 8
const SHOWN_MESSAGES = 6
const BACKGROUND_EXPIRY_MS = 3 * 60 * 60 * 1000
const HEARTBEAT_TICKS = 10
const HUB_READ_TICKS = 5
const BRANCH_TICKS = 60
const REGISTRY_RESCAN_MS = 30_000
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Instant bookkeeping tools: shown as task progress instead of as jobs.
const QUIET = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'])
const ENDED_AGENT = new Set(['completed', 'failed', 'killed', 'ended'])
const IDLE_MAIN: MainState = { isWorking: false, since: null, reply: null, waiting: null, waitingAt: null }
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
  'The repo hub (Agent Map): every Claude session working in this same git repository, and a shared board.',
  'action "read": each session here (state, branch, what it is doing, its loops and running subagents), this session\'s own loops,',
  'subagents and tasks, and the board\'s recent messages. Use it to monitor the repo or when the person asks for a status report.',
  'action "post": leave a note on the board for the person and the other sessions ("to": "all" by default, or a session name from read).',
  'Posts never start another session\'s turn. Sessions in other repositories are never included.',
].join(' ')

const jobs = atom({ plugin: 'agent-map', key: 'jobs' } as const, [])
const goal = atom({ plugin: 'agent-map', key: 'goal' } as const, { startedAt: null, tasks: [] })
const agents = atom({ plugin: 'agent-map', key: 'agents' } as const, [])
const cardsAtom = atom({ plugin: 'agent-map', key: 'cards' } as const, [])
const loopsAtom = atom({ plugin: 'agent-map', key: 'loops' } as const, [])
const catalogAtom = atom({ plugin: 'agent-map', key: 'catalog' } as const, BUILTIN_AGENTS)
const launchAtom = atom({ plugin: 'agent-map', key: 'launch' } as const, NO_LAUNCH)
const hubAtom = atom({ plugin: 'agent-map', key: 'hub' } as const, NO_HUB)
const main = atom({ plugin: 'agent-map', key: 'main' } as const, IDLE_MAIN)
const peek = atom({ plugin: 'agent-map', key: 'peek' } as const, NO_PEEK)
const cwdAtom = atom({ plugin: 'agent-map', key: 'cwd' } as const, '')
// Claude's own folder: CLAUDE_CONFIG_DIR, else ~/.claude ('' until the session starts).
const homeAtom = atom({ plugin: 'agent-map', key: 'claudeDir' } as const, '')
const isShown = atom({ plugin: 'agent-map', key: 'isShown' } as const, false)
const fleetAtom = atom({ plugin: 'agent-map', key: 'fleet' } as const, [])
const viewAtom = atom({ plugin: 'agent-map', key: 'view' } as const, NO_VIEW)
// Other mods' state, read only if installed and only in the shape we know (see map.ts adapters).
const savvyAgents = atom({ plugin: 'savvy-progress', key: 'agents' } as never, [] as never)
const flightAgents = atom({ plugin: 'flightdeck', key: 'agents' } as never, [] as never)
const flightLoops = atom({ plugin: 'flightdeck', key: 'loops' } as never, [] as never)
// Every session on this computer as this mod reads it from the engine's registry.
const localSessions = atom({ plugin: 'agent-map', key: 'sessions' } as const, [])
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
    return { kind: 'question', text: question === '' ? "Answer Claude's question" : question }
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
    needs.push({ key: 'need:reply', tone: 'need', glyph: '>', text: `Reply: ${m.reply}`, from: m.since, to: null, depth: 0 })
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
export function presenceOf(m: MainState, jobList: readonly Job[], g: Goal, agentList: readonly AgentRow[]): { state: HubState; doing: string } {
  const groups = groupNow(jobList, agentList, m)
  const need = groups.needs[0]
  if (need !== undefined) return { state: 'needs', doing: need.text }
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

async function osa($: EngineInterface, lines: readonly string[], args: readonly string[]): Promise<string> {
  const r = await runQuiet($, ['/usr/bin/osascript', ...lines.flatMap(l => ['-e', l]), ...args], 15_000)
  return r.code === 0 ? r.out.trim() : `error: ${oneLine(r.err)}`
}

let tmuxBin: string | null | undefined

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
  const panes = await runQuiet($, [tmux, 'list-panes', '-a', '-F', '#{pane_tty} #{session_name} #{window_id} #{pane_id}'])
  const hit = panes.code === 0 ? tmuxPaneOn(panes.out, tty) : null
  if (hit === null) return 'none'
  await runQuiet($, [tmux, 'select-window', '-t', hit.windowId])
  await runQuiet($, [tmux, 'select-pane', '-t', hit.paneId])
  const clients = await runQuiet($, [tmux, 'list-clients', '-t', hit.session, '-F', '#{client_tty}'])
  const clientTty = clients.out.split('\n')[0]?.trim() ?? ''
  if (clientTty === '') return osa($, OPEN_TERMINAL, [`${tmux} attach -t ${shellQuote(hit.session)}`])
  return focusTty($, clientTty)
}

// Brings another session's terminal forward: Terminal or iTerm2 by its tty, a tmux pane, or
// `claude attach` for a background session. Says so in a toast when it cannot.
async function jumpTo($: EngineInterface, sessionId: string): Promise<void> {
  const row = (await sessionRowsNow($)).find(r => r.sessionId === sessionId)
  if (row?.isSelf === true) {
    $.ui.toast('That is this session.', { timeoutMs: 3_000 })
    return
  }
  let result = 'none'
  if (row !== undefined && row.jobId !== null) {
    result = await osa($, OPEN_TERMINAL, [`claude attach ${row.jobId}`])
  } else if (row !== undefined && row.tty !== null) {
    result = await focusTty($, row.tty)
    if (result !== 'ok') {
      const viaTmux = await focusTmux($, row.tty)
      if (viaTmux === 'ok' || result === 'none') result = viaTmux
    }
  }
  if (result === 'ok') return
  const why = result.startsWith('error:') ? ` (${fit(result.slice(7), 60)})` : row === undefined || row.tty === null ? ' (no terminal is known for it)' : ''
  $.ui.toast(fit(`Could not bring ${row?.name || 'that session'} forward${why}`, 160), { timeoutMs: 8_000 })
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
  const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']).catch(() => undefined)
  if (ran !== undefined && ran.exitCode === 0) {
    const [top = '', head = ''] = ran.stdout.trim().split('\n')
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
      found.push({ sessionId: f.sessionId, name: f.name, cwd: f.cwd, branch: f.branch, state: f.state, doing: f.doing, stuck: f.stuck ?? '', heartbeatAt: f.heartbeatAt, nodes: f.nodes ?? [] })
    }
  }
  found.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  if (JSON.stringify(found) !== JSON.stringify(await read($, fleetAtom))) await update($, fleetAtom, () => found)
}

// The whole map as it stands: this session, every other one, what each started.
async function currentMap($: EngineInterface, now: number): Promise<MapSession[]> {
  const rows = (await sessionRowsNow($)).map(r => ({
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
    const isRecording = (await $.env.get('CLAUDE_MODS_RECORDING')) === '1'
    const text = `Hub · ${last.fromName}: ${last.text}`
    try {
      await $.ui.toast(isRecording ? mask(text, recordingTerms(await $.env.get('CLAUDE_MODS_RECORDING_TERMS'))) : text)
    } catch {
      // Nothing draws toasts here (headless): the pane still lists it.
    }
  }
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
    text: `Give me a short status report of this repo from the Agent Map hub (call ${HUB_TOOL} with action "read"): each session, what it is doing, its loops and subagents, anything blocked or waiting on me, and board notes nobody answered.`,
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
  await update($, catalogAtom, l => found.reduce((acc, a) => mergeOffer(acc, { agent: a.name, description: a.description, source: a.source }), l))
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
  const now = await $.clock.now()
  if (id !== null) await $.tool.call({ tool: 'CronDelete', id }).catch(() => undefined)
  await update($, loopsAtom, l => endLoop(l, loop.id, now))
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
    await $.command.register({
      name: 'agent-map',
      description: 'Agent Map: every Claude session on this computer and what each started, what needs you, tasks, launcher',
      argumentHint: '[map|tasks|launch|zoom auto|cards|lines|dots|close|clear|say <text>|report]',
    })
    try {
      await $.tool.register({ name: 'hub', description: HUB_TOOL_DESCRIPTION, inputSchema: HUB_SCHEMA })
    } catch {
      // A host with no tools (a test, an SDK run that refuses it): the pane still works.
    }
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })

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

    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        const at = await $.clock.now()
        const list = await read($, jobs)
        const stale = list.filter(j =>
          (j.endedAt !== null && at - j.endedAt > ENDED_KEEP_MS) ||
          (j.endedAt === null && at - j.startedAt > BACKGROUND_EXPIRY_MS))
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

  on('command.run', { command: 'agent-map' }, async ($, e) => {
    const arg = e.args.trim()
    const [verb = '', ...rest] = arg.split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Agent Map closed. /agent-map opens it again.' }
    }
    if (verb === 'clear') {
      await reset($)
      return { text: 'Agent Map cleared.' }
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
    return { text: opened.isPlaced ? 'Agent Map open.' : 'Agent Map opens once the window is wide enough.' }
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
      await update($, main, s => ({ ...s, reply: null }))
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
    await update($, main, s => ({ ...s, isWorking: true, since: now, reply: null }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const reply = e.reason === 'answer' && !e.isAborted ? lastQuestion(e.answer) : null
      await update($, main, s => ({ ...s, isWorking: false, since: now, reply }))
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
    const crons = e.session_crons
    if (crons !== undefined) {
      const now = await $.clock.now()
      await update($, loopsAtom, l => reconcile(l, crons, now))
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

    const ran = await next(e)
    const endedAt = await $.clock.now()
    const isError = ran.deny !== undefined || ran.isError === true
    const result = (ran.deny === undefined && ran.isError !== true ? (ran.result ?? {}) : {}) as Fields

    if (!isQuiet) {
      const taskId = tool === 'Bash' ? str(result.backgroundTaskId) : ''
      if (tool === 'TaskStop') {
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
    const views = agentViews(agentList, cardList, jobList)
    const groups = groupNow(jobList, agentList, m0)

    const heading = (title: string, right: string, color?: string) => (
      <Box>
        <Text bold color={color}>{title}</Text>
        <Text dimColor>{right === '' ? '' : `  ${right}`}</Text>
      </Box>
    )
    // A labelled detail line: "   role  Read-only search…", wrapped.
    const detail = (key: string, label: string, text: string, lines: number, color?: string) => {
      const indent = `   ${label === '' ? '' : `${label.padEnd(5)} `}`
      return wrap(m(text), width - indent.length, lines).map((line, i) => (
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
    type NeedRow = { key: string; glyph: string; color: string; text: string; from: number | null; onPress: (() => Promise<unknown>) | null }
    const needRows: NeedRow[] = []
    for (const r of groups.needs) {
      const agentId = r.agentId
      needRows.push({
        key: r.key, glyph: r.glyph, color: 'yellow', text: r.text, from: r.from,
        onPress: agentId === undefined ? null : () => togglePeek($, agentId),
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
        onPress: node !== undefined ? () => openNode(s, node) : !s.isSelf ? () => jumpTo($, s.sessionId) : () => openSession(s),
      })
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
        </Box>
      )
    }

    // ---- the tabs ----
    const done = g.tasks.filter(t => t.status === 'completed').length
    const total = g.tasks.length
    const tab = (id: View['tab'], label: string) => (view.tab === id
      ? <Button key={`tab:${id}`} variant="primary" label={label} onPress={setView({ tab: id, confirm: null })} />
      : <Button key={`tab:${id}`} plain dimColor label={label} onPress={setView({ tab: id, confirm: null })} />)
    const tabs = (
      <Box gap={1}>
        {tab('map', needRows.length > 0 ? `Map ${needRows.length}!` : 'Map')}
        {tab('tasks', total === 0 ? 'Tasks' : `Tasks ${done}/${total}`)}
        {tab('launch', 'Launch')}
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
      `${s.name}${s.branch === '' ? '' : ` · ${s.branch}`}${s.isSelf ? ' · here' : ''}${s.hasMap ? '' : ' · (no map)'}`
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
      </Box>
    )
    const dots = (s: MapSession) => (
      <Box key={`dots:${s.sessionId}`} gap={1}>
        <Text color={colorOf(s.status, 'session')}>{glyphOf(s.status, 'session')}</Text>
        <Button key={`session:${s.sessionId}`} plain label={padEnd(fit(m(s.name), 16), 16)} onPress={() => openSession(s)} />
        {s.nodes.slice(0, Math.max(1, Math.floor((width - 21) / 2))).map(n => (
          <Button key={nodeKey(s, n)} plain label={glyphOf(n.status, n.kind)} onPress={() => openNode(s, n)} />
        ))}
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
    const agentPeek = () => {
      const agentId = peekState.agentId
      if (agentId === null) return null
      const v = views.find(x => x.id === agentId)
      const c = v?.card ?? null
      const n = self?.nodes.find(x => x.id === agentId)
      const by = c === null ? '' : [`by ${c.calledBy}`, c.model, `${c.calls} call${c.calls === 1 ? '' : 's'}`, c.isBackground ? 'background' : ''].filter(x => x !== '').join(' · ')
      const extra = n === undefined ? '' : [n.costUsd === null ? '' : `~$${n.costUsd.toFixed(2)}`, n.tokens === null ? '' : `context ${Math.round(n.tokens / 1000)}k`].filter(x => x !== '').join(' · ')
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="magenta">AGENT</Text>
            <Text>{`  ${fit(m(v === undefined ? 'subagent' : `${v.type} · ${v.purpose}`), width - 7)}`}</Text>
          </Box>
          {n !== undefined && (n.status === 'waiting' || n.status === 'stuck') && detail(`why:${agentId}`, n.status === 'waiting' ? 'waits' : 'stuck', n.why, 2, n.status === 'waiting' ? 'yellow' : STUCK_COLOR)}
          {c !== null && c.role !== '' && detail(`role:${agentId}`, 'role', c.role, 2)}
          {(c?.task || peekState.task) !== '' && detail(`task:${agentId}`, 'task', c?.task || peekState.task, 2, 'white')}
          {n !== undefined && n.now !== '' && detail(`now:${agentId}`, 'now', n.now, 1, 'cyan')}
          {n !== undefined && n.raw !== '' && n.status !== 'done' && n.status !== 'failed' && detail(`raw:${agentId}`, 'tool', n.raw, 1)}
          {n !== undefined && n.progress !== null && detail(`prog:${agentId}`, 'steps', `${bar(n.progress)}${n.progress.note === '' ? '' : ` · ${n.progress.note}`} (savvy-progress)`, 1, 'magenta')}
          {by !== '' && detail(`by:${agentId}`, '', by, 1)}
          {extra !== '' && detail(`cost:${agentId}`, '', extra, 1)}
          {peekState.error !== '' && <Text color="red">{fit(peekState.error, width)}</Text>}
          {peekState.lines.map((l, i) => (
            <Box key={`step:${agentId}:${i}`}>
              <Text color={PEEK_COLOR[l.kind]}>{l.kind === 'running' ? spin : PEEK_GLYPH[l.kind]} </Text>
              <Text dimColor={l.kind === 'done'}>{fit(m(l.text), width - 2)}</Text>
            </Box>
          ))}
          {c !== null && c.result !== '' && detail(`result:${agentId}`, '→', c.result, 3)}
          {c !== null && c.result !== '' && (
            <Box gap={1}>
              <Text>{'   '}</Text>
              <Button key={`use:${agentId}`} plain label="[use in prompt]" onPress={() => useResult($, c)} />
            </Box>
          )}
          {closeRow}
        </Box>
      )
    }
    const sessionPeek = (s: MapSession) => {
      const usage = [s.contextPercent === null ? '' : `context ${Math.round(s.contextPercent)}%`, s.costUsd === null ? '' : `$${s.costUsd.toFixed(2)}`].filter(x => x !== '').join(' · ')
      const others = hb.members.filter(x => !x.isSelf)
      const toMember = hb.members.find(x => x.sessionId === hb.to && !x.isSelf)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="blue">SESSION</Text>
            <Text>{`  ${fit(m(sessionTitle(s)), width - 9)}`}</Text>
          </Box>
          {detail(`where:${s.sessionId}`, 'where', s.cwd, 1)}
          {detail(`state:${s.sessionId}`, 'state', `${STATUS_WORD[s.status]}${sessionLine(s) === '' ? '' : ` · ${sessionLine(s)}`}`, 3, s.status === 'waiting' ? 'yellow' : s.status === 'stuck' ? STUCK_COLOR : undefined)}
          {usage !== '' && detail(`usage:${s.sessionId}`, 'usage', usage, 1)}
          {detail(`nodes:${s.sessionId}`, 'runs', s.nodes.length === 0 ? (s.hasMap ? 'nothing started' : 'no map from that session (it does not run Agent Map)') : s.nodes.map(n => n.title.split(' · ')[0]).join(', '), 2)}
          {!s.isSelf && (
            <Box gap={1} marginTop={1}>
              <Button key={`jump:${s.sessionId}`} label="Jump there" variant="primary" onPress={() => jumpTo($, s.sessionId)} />
            </Box>
          )}
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
            <Text dimColor>{fit('Opened in the Replay Theater tab. Esc, then /replay brings it to the front.', width)}</Text>
          )}
          {s.isSelf && hb.root !== '' && (
            <Box flexDirection="column" marginTop={1}>
              {heading(`BOARD · ${fit(m(hb.label), Math.max(6, width - 28))}`, `${others.length} other session${others.length === 1 ? '' : 's'} in this repo`, 'blue')}
              <Box gap={1}>
                <Text dimColor>to</Text>
                <Button key="hub-to-all" plain dimColor={hb.to !== 'all'} label={hb.to === 'all' ? '[all]' : 'all'} onPress={() => update($, hubAtom, x => ({ ...x, to: 'all' }))} />
                {others.slice(0, 6).map(x => (
                  <Button key={`hub-member:${x.sessionId}`} plain dimColor={hb.to !== x.sessionId} label={hb.to === x.sessionId ? `[${fit(x.name, 16)}]` : fit(x.name, 16)} onPress={() => update($, hubAtom, y => ({ ...y, to: y.to === x.sessionId ? 'all' : x.sessionId }))} />
                ))}
              </Box>
              {hb.messages.slice(-SHOWN_MESSAGES).map(msg => {
                const who = `${msg.fromName}${msg.by === 'claude' ? '·claude' : ''}${msg.to === 'all' ? '' : `→${msg.to === hb.to ? (toMember?.name ?? 'one') : (hb.members.find(x => x.sessionId === msg.to)?.name ?? 'one session')}`}`
                return (
                  <Box key={`hub-msg:${msg.id}`} flexDirection="column">
                    {wrap(m(`${clockOf(msg.at)} ${who}: ${msg.text}`), width - 1, 2).map((line, i) => (
                      <Text key={`hub-msg:${msg.id}:${i}`} dimColor={i > 0}>{`${i === 0 ? '' : '  '}${line}`}</Text>
                    ))}
                  </Box>
                )
              })}
              {Input !== null && <Input key="hub-say" label={`to ${fit(toMember?.name ?? 'all', 14)} › `} placeholder="note for this repo, Enter posts" submitLabel="post" onSubmit={value => hubSay($, value)} />}
              <Box gap={1}>
                <Button key="hub-wake" plain dimColor={!hb.wake} label={hb.wake ? '[wake: on]' : '[wake: off]'} onPress={() => update($, hubAtom, x => ({ ...x, wake: !x.wake }))} />
                <Button key="hub-report" plain label="[report]" onPress={() => reportHub($)} />
              </Box>
              {hb.note !== '' && <Text dimColor>{fit(hb.note, width)}</Text>}
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
        if (loop !== undefined) await stopLoop($, loop)
        if (shell !== undefined && shell.taskId !== null) {
          const ranAt = await $.clock.now()
          await $.tool.call({ tool: 'TaskStop', task_id: shell.taskId } as never).catch(() => undefined)
          await update($, jobs, l => l.map(j => (j.id === shell.id ? { ...j, endedAt: ranAt } : j)))
        }
      }
      const lt = loop === undefined ? null : loopLines(loop, now, m0.isWorking)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color={loop !== undefined ? 'cyan' : 'magenta'}>{title}</Text>
            <Text>{`  ${fit(m(s.isSelf ? n.title : `${s.name} › ${n.title}`), width - title.length - 2)}`}</Text>
          </Box>
          {lt !== null && <Text>{fit(lt.head, width)}</Text>}
          {lt !== null && wrap(lt.detail, width, 3).map((l, i) => <Text key={`loopd:${n.id}:${i}`} dimColor>{l}</Text>)}
          {lt === null && detail(`state:${n.id}`, 'state', `${STATUS_WORD[n.status]}${n.status === 'waiting' || n.status === 'stuck' ? ` · ${n.why}` : ''}`, 3, n.status === 'waiting' ? 'yellow' : n.status === 'stuck' ? STUCK_COLOR : undefined)}
          {lt === null && n.now !== '' && detail(`now:${n.id}`, 'now', n.now, 2, 'cyan')}
          {n.raw !== '' && (loop !== undefined || (n.status !== 'done' && n.status !== 'failed')) && detail(`raw:${n.id}`, loop !== undefined ? 'prompt' : 'tool', n.raw, 2)}
          {n.progress !== null && detail(`prog:${n.id}`, 'steps', bar(n.progress), 1, 'magenta')}
          {n.status === 'done' && n.why !== '' && detail(`res:${n.id}`, '→', n.why, 3)}
          {(loop !== undefined || (shell !== undefined && shell.taskId !== null)) && (
            <Box gap={1} marginTop={1}>
              <Button key={loop !== undefined ? `loop-stop:${loop.id}` : `job-stop:${n.id}`} label={isConfirming ? 'Press again to stop' : 'Stop'} onPress={stop} />
              {isConfirming && <Button key="stop-cancel" plain dimColor label="[keep it]" onPress={setView({ confirm: null })} />}
            </Box>
          )}
          {!s.isSelf && (
            <Box gap={1} marginTop={1}>
              <Button key={`jump:${s.sessionId}`} label={`Jump to ${fit(s.name, 20)}`} variant="primary" onPress={() => jumpTo($, s.sessionId)} />
            </Box>
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
        <Box flexDirection="column" marginTop={1}>
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
      const art = graphSvg(map, now, width * 8)
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
              {heading('IDLE', `${quiet.length} other session${quiet.length === 1 ? '' : 's'}, nothing running`)}
              {quiet.map(s => (zoom === 'dots' ? dots(s) : lineRow(s, null, '')))}
            </Box>
          )}
          {board}
        </Box>
        {opened()}
      </Box>
    )

    // ---- tasks ----
    const barWidth = Math.max(4, Math.min(16, width - 26))
    const filled = total === 0 ? 0 : Math.round((done / total) * barWidth)
    const meter = `[${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}]`
    const goalTime = g.startedAt === null ? '' : elapsed(now - g.startedAt)
    const openTasks = g.tasks.filter(t => t.status !== 'completed')
    const tasksTab = (
      <Box flexDirection="column">
        {heading('TASKS', total === 0 ? 'none yet' : `${done}/${total} ${meter} ${goalTime}`)}
        {total === 0 && <Text dimColor>{fit('Claude has no task list in this session.', width)}</Text>}
        {[...openTasks.filter(t => t.status === 'in_progress'), ...openTasks.filter(t => t.status === 'pending')].slice(0, SHOWN_TASKS * 2).map(t => (t.status === 'in_progress'
          ? <Text color="yellow" bold>{fit(m(`[>] ${t.subject}`), width)}</Text>
          : <Text>{fit(m(`[ ] ${t.subject}`), width)}</Text>))}
        {done > 0 && <Text dimColor>{`[x] ${done} done`}</Text>}
      </Box>
    )

    // ---- launch: start a subagent type or run a skill by hand ----
    const pickedEntry = launch.picked === null ? undefined : catalogList.find(c => c.kind === launch.kind && c.name === launch.picked)
    const matches = filterCatalog(catalogList, launch.kind, launch.query)
    const agentCount = catalogList.filter(c => c.kind === 'agent').length
    const skillCount = catalogList.filter(c => c.kind === 'skill').length
    const entryRow = (c: CatalogEntry) => {
      const nameCol = Math.min(22, Math.max(10, Math.floor(width * 0.4)))
      const label = `${padEnd(fit(c.name, nameCol), nameCol)} ${fit(c.description, width - nameCol - 2)}`
      return <Button key={`pick:${c.kind}:${c.name}`} plain label={label} onPress={() => update($, launchAtom, l => ({ ...l, picked: c.name, note: '' }))} />
    }
    const launchTab = (
      <Box flexDirection="column">
        {heading('LAUNCH', `${agentCount} agents · ${skillCount} skills`, 'green')}
        {pickedEntry !== undefined ? (
          <Box flexDirection="column">
            <Text bold color="green">{fit(`▶ ${pickedEntry.kind === 'agent' ? 'agent' : 'skill /'}${pickedEntry.kind === 'agent' ? ' ' : ''}${pickedEntry.name}`, width)}</Text>
            {detail('picked-role', '', pickedEntry.description, 3)}
            {Input === null ? null : pickedEntry.kind === 'agent'
              ? <Input key="launch-task" label="task › " placeholder="what the agent should do" submitLabel="start" autoFocus onSubmit={value => launchAgent($, pickedEntry.name, value)} />
              : <Input key="launch-task" label="args › " placeholder="optional, Enter runs" submitLabel="run" autoFocus onSubmit={value => runSkill($, pickedEntry.name, value)} />}
            <Box gap={1}>
              {pickedEntry.kind === 'skill' && <Button key="launch-run" plain label="[run now]" onPress={() => runSkill($, pickedEntry.name, '')} />}
              {pickedEntry.kind === 'skill' && <Button key="launch-fill" plain label="[to prompt]" onPress={() => $.prompt.fill({ text: `/${pickedEntry.name} ` }).then(() => update($, launchAtom, l => ({ ...l, picked: null, note: '' })))} />}
              <Button key="launch-back" plain dimColor label="[back]" onPress={() => update($, launchAtom, l => ({ ...l, picked: null, note: '' }))} />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box gap={1}>
              <Button key="launch-kind:agent" plain dimColor={launch.kind !== 'agent'} label={`[agents ${agentCount}]`} onPress={() => update($, launchAtom, l => ({ ...l, kind: 'agent' as const, picked: null, query: '', note: '' }))} />
              <Button key="launch-kind:skill" plain dimColor={launch.kind !== 'skill'} label={`[skills ${skillCount}]`} onPress={() => update($, launchAtom, l => ({ ...l, kind: 'skill' as const, picked: null, query: '', note: '' }))} />
            </Box>
            {Input !== null && <Input key="launch-filter" label="find › " placeholder="type to filter" value={launch.query} onInput={value => update($, launchAtom, l => ({ ...l, query: value }))} onSubmit={value => {
              const first = filterCatalog(catalogList, launch.kind, value)[0]
              if (first !== undefined) void update($, launchAtom, l => ({ ...l, query: value, picked: first.name }))
            }} />}
            {matches.slice(0, SHOWN_LAUNCH).map(entryRow)}
            {matches.length === 0 && <Text dimColor>{fit(`No ${launch.kind} matches "${launch.query}".`, width)}</Text>}
            {matches.length > SHOWN_LAUNCH && <Text dimColor>{fit(`  +${matches.length - SHOWN_LAUNCH} more · type to narrow`, width)}</Text>}
          </Box>
        )}
        {launch.note !== '' && <Text dimColor>{fit(m(launch.note), width)}</Text>}
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
    if (e.props.hasSurvey || (await read($, isShown))) return next(e)
    const now = await $.clock.now()
    // The band draws often; the map behind it is worked out at most once a second.
    if (now - bandCache.at > 1000) {
      const hasSessionsMod = adaptSessionRows(await readOther($, 'sessionsRows')).length > 0
      const items = needsOf(await currentMap($, now)).filter(n => n.kind === 'stuck' || (!hasSessionsMod && n.kind === 'wait' && !n.isSelf))
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
