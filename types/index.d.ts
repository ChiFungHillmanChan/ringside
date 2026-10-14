// What a running call is blocked on: the person answering a question or
// approving a plan.
// One choice Claude offered: its words, and what choosing it leads to ('' when it says nothing more).
export type Choice = { label: string; detail: string }

// A question Claude asked with choices: one of AskUserQuestion's, or the question its answer ended on.
export type Ask = { question: string; header: string; choices: Choice[]; isMulti: boolean }

export type Need = {
  kind: 'question' | 'plan'
  text: string
  // AskUserQuestion's questions with their choices (absent for a plan, and in older state).
  asks?: Ask[]
}

export type Job = {
  id: string
  tool: string
  detail: string
  startedAt: number
  endedAt: number | null
  isError: boolean
  agentId: string | null
  taskId: string | null
  need: Need | null
}

export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type Goal = { startedAt: number | null; tasks: Task[] }

export type AgentRow = {
  id: string
  label: string
  status: string
  parentId: string | null
  startedAt: number
  endedAt: number | null
}

// What a subagent is for, read off its spawn: which type was called, by whom,
// the role that type plays, the task it was given, what it is doing, what it said.
export type AgentCard = {
  id: string
  type: string
  name: string
  // The Agent call's few words.
  purpose: string
  // The prompt it was given, cut short.
  task: string
  // The agent type's own description: what that kind of agent is for.
  role: string
  // 'Claude', 'you', '<type> agent' for a nested spawn, a plugin's name, 'workflow'.
  calledBy: string
  model: string
  isBackground: boolean
  startedAt: number
  calls: number
  lastStep: string
  // Its final answer, cut short; '' until it ends.
  result: string
  endedAt: number | null
}

// A recurring prompt this session will run: a CronCreate job (/loop with an
// interval) or a self-paced /loop that books its next ScheduleWakeup each turn.
export type Loop = {
  id: string
  kind: 'cron' | 'wakeup'
  // The cron expression ('' for a self-paced loop).
  schedule: string
  // 'Every 5 minutes', 'Self-paced', 'Once'.
  every: string
  prompt: string
  recurring: boolean
  // null: it was running before this mod saw it made.
  startedAt: number | null
  nextAt: number | null
  lastFiredAt: number | null
  fires: number
  // A self-paced loop's last chosen delay and why.
  delaySeconds: number | null
  reason: string
  // A self-paced loop's pending wakeup, by its cron id, so it can be stopped.
  wakeId: string | null
  endedAt: number | null
}

// An agent type or a skill the launcher can start.
export type CatalogEntry = {
  kind: 'agent' | 'skill'
  name: string
  description: string
  source: string
  // What an agent file names: its model ('sonnet') and its colour ('blue').
  model?: string
  color?: string
}

export type Launch = {
  isOpen: boolean
  kind: 'agent' | 'skill'
  query: string
  // The entry chosen to run, by name; its task box shows.
  picked: string | null
  note: string
  // Counts the picks: each pick's task box is a new field, so it opens empty (absent in older state).
  seq?: number
}

// The main loop: working or the person's turn, and what it waits on.
export type MainState = {
  isWorking: boolean
  since: number | null
  // The question Claude ended its last answer with, until the person replies.
  reply: string | null
  // That question with the choices it offered (absent in older state).
  replyAsk?: Ask | null
  // What the engine says the session waits on (a permission prompt, a dialog).
  waiting: string | null
  waitingAt: number | null
}

// A subagent opened from the list: its task and its latest steps.
export type PeekLine = { kind: 'text' | 'running' | 'done' | 'failed'; text: string }

export type Peek = { agentId: string | null; task: string; lines: PeekLine[]; error: string }

// Sessions by what they ask of the person: blocked on them, working, or neither.
export type SessionGroup = 'needs' | 'working' | 'idle'

// Another Claude session on this computer: from the engine's registry, or the sessions mod when it is loaded.
export type SessionRow = {
  sessionId: string
  // A background session's id, what `claude attach` takes; null for one in a terminal.
  jobId: string | null
  name: string
  cwd: string
  pid: number | null
  // The terminal device it runs on (`/dev/ttys001`), found from its pid.
  tty: string | null
  // The engine's own word: busy, idle, waiting (terminal); working, blocked, done, failed, stopped (background).
  state: string
  group: SessionGroup
  since: number
  summary: string
  isSelf: boolean
  usage: { contextPercent: number | null; costUsd: number | null } | null
}

export type HubState = 'working' | 'idle' | 'needs'

// One Claude session working in this repository, as its own Ringside publishes it.
export type HubMember = {
  sessionId: string
  name: string
  branch: string
  state: HubState
  doing: string
  loops: number
  nextLoopAt: number | null
  agents: number
  at: number
  isSelf: boolean
  // Seen in the session list only: it does not run Ringside, so it cannot read the board.
  isBare: boolean
}

export type HubMessage = {
  id: string
  at: number
  fromId: string
  fromName: string
  by: 'person' | 'claude'
  // 'all', or one session's id.
  to: string
  text: string
}

// The repo hub: every session in this git repository and their shared board.
export type Hub = {
  root: string
  label: string
  branch: string
  members: HubMember[]
  messages: HubMessage[]
  // Who a post goes to: 'all' or a session id.
  to: string
  // Also wake the recipients' Claude with the post (as a message to that session).
  wake: boolean
  note: string
}


// ---- Ringside ----

export type NodeStatus = 'running' | 'waiting' | 'stuck' | 'idle' | 'done' | 'failed'
export type NodeKind = 'agent' | 'job' | 'loop' | 'workflow'
export type Progress = { done: number; total: number; note: string }

// One thing a session started: a subagent, a background shell, a loop, a workflow agent.
export type MapNode = {
  id: string
  kind: NodeKind
  // "Explore · find where agents are read"
  title: string
  status: NodeStatus
  // What it is doing, in plain words ("reading agents.ts"); the tool line is `raw`.
  now: string
  raw: string
  // What it waits on, why it may be stuck, or what it answered.
  why: string
  from: number
  to: number | null
  progress: Progress | null
  costUsd: number | null
  tokens: number | null
}

// What another session running this mod publishes about itself, as far as the map needs.
export type FleetFile = {
  sessionId: string
  name: string
  cwd: string
  branch: string
  state: HubState
  doing: string
  // Why it may be stuck; '' when it looks fine.
  stuck: string
  heartbeatAt: number
  nodes: MapNode[]
  // What it waits on the person for: 'ask' blocks it (a question, a plan), 'reply' is
  // the question its answer ended on; absent when nothing, or in an older file.
  needKind?: NeedKind
  // That question's choices, for cards on the other maps.
  asks?: Ask[]
}

export type NeedKind = 'ask' | 'reply'

// The pane's own view: which tab, how dense, and what is opened below the map.
export type View = {
  tab: 'map' | 'tasks' | 'launch'
  zoom: 'auto' | 'cards' | 'lines' | 'dots'
  // 'session:<id>', 'node:<sessionId>:<nodeId>', or null; this session's subagents open through `peek`.
  sel: string | null
  // A stop pressed once, waiting for the second press.
  confirm: string | null
  // When the replay button was last pressed (absent in older state).
  replayAt?: number | null
  // What the last Jump did, shown in that session's card (absent in older state).
  jump?: JumpNote | null
  // Cards picked for a question of Claude's not sent yet: '<call id>:<question index>' to labels.
  picks?: Record<string, string[]>
}

export type JumpNote = { sessionId: string; at: number; isOk: boolean; text: string }

declare module 'claude-code' {
  interface PluginState {
    'ringside': {
      jobs: Job[]
      goal: Goal
      agents: AgentRow[]
      cards: AgentCard[]
      loops: Loop[]
      catalog: CatalogEntry[]
      launch: Launch
      hub: Hub
      main: MainState
      peek: Peek
      cwd: string
      // Claude's own folder: CLAUDE_CONFIG_DIR, else ~/.claude.
      claudeDir: string
      // Every Claude session on this computer, read from the engine's registry (used when the sessions mod is not loaded).
      sessions: SessionRow[]
      // The pane is placed and is the one shown (not a tab behind another), for other mods
      // that keep their own band quiet while the map is on screen.
      isShown: boolean
      // Every session on this computer that runs this mod, from their board files.
      fleet: FleetFile[]
      view: View
    }
  }
}
