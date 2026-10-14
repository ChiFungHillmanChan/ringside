import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  applyTaskCall, cellWidth, describeCall, elsewhereNeeds, endGoneShells, groupNow, isStale, lastQuestion, mergeAgents, needOf, peekOf, presenceOf, stopOutcomeOf, trimJobs,
} from '../hooks/register'
import type { HubFile } from '../hooks/hub'
import type { AgentRow, HubMessage, Job, MainState } from '../types'

const BAND = {
  plugin: 'ringside',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 110, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  viewport: { columns: 120, rows: 40, isFullscreen: true },
} as const

const PANE = {
  plugin: 'ringside',
  component: 'Pane',
  requestId: 'ringside',
  props: {
    title: 'Ringside',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
  viewport: { columns: 180, rows: 90, isFullscreen: true },
} as const

// What the session would answer beneath the plugin under test.
function host(on: On, over: { agents?: boolean; fs?: boolean; process?: boolean; mac?: boolean; commands?: string[] } = {}): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ringside__${e.name}` } }))
  on('command.list', () => ({ value: (over.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) } as never))
  if (over.process !== false) on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  if (over.agents !== false) on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('classic.Stop', () => ({}))
  // A Mac's, unless the test says otherwise: AppleScript is there, nothing else is.
  if (over.fs !== false) on('fs.exists', ($, e) => ({ value: e.path === '/usr/bin/osascript' && over.mac !== false }))
}

// A file system in memory, for the hub's board files.
function memFs(on: On, files: Map<string, string>, mtime: () => number): void {
  const under = (dir: string): string[] => [...files.keys()].filter(k => k.startsWith(`${dir}/`))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || under(e.path).length > 0 }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of under(e.path)) {
      const [head = '', ...more] = k.slice(e.path.length + 1).split('/')
      names.set(head, more.length > 0 ? 'dir' : (names.get(head) ?? 'file'))
    }
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? (files.get(`${e.path}/${name}`) ?? '').length : 0, mtimeMs: mtime(), isLink: false })),
    }
  })
}

// What the Agent tool hands agent.spawn, around the parts a test cares about.
function spawnInput(over: { prompt: string; description: string; subagentType: string }) {
  return {
    tool_use_id: 'toolu_test', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false,
    ...over,
  }
}

test('describes calls by what they touch', () => {
  expect(describeCall('Bash', { command: 'npm test', description: 'Run tests' })).toBe('Run tests')
  expect(describeCall('Edit', { file_path: '/a/b/login.tsx' })).toBe('login.tsx')
  expect(describeCall('Agent', { subagent_type: 'Explore', description: 'auth flow' })).toBe('Explore: auth flow')
  expect(describeCall('mcp__github__create_issue', { title: 'x' })).toBe('github')
  expect(describeCall('Monitor', { tool: 'Monitor', tool_use_id: 'toolu_1', description: 'watch build' })).toBe('watch build')
  expect(describeCall('AskUserQuestion', { tool: 'AskUserQuestion', questions: [] })).toBe('waiting for your answer')
})

test('tracks a task list as a goal', () => {
  let g = applyTaskCall({ startedAt: null, tasks: [] }, 'TaskCreate', { subject: 'A' }, { task: { id: '1', subject: 'A' } }, 10)
  g = applyTaskCall(g, 'TaskCreate', { subject: 'B' }, { task: { id: '2', subject: 'B' } }, 20)
  g = applyTaskCall(g, 'TaskUpdate', { taskId: '1', status: 'completed' }, {}, 30)
  expect(g.startedAt).toBe(10)
  expect(g.tasks.map(t => t.status)).toEqual(['completed', 'pending'])
  g = applyTaskCall(g, 'TodoWrite', { todos: [{ content: 'X', status: 'in_progress', activeForm: 'Xing' }] }, {}, 40)
  expect(g.tasks).toEqual([{ id: 'todo-0', subject: 'X', status: 'in_progress' }])
})

test('the pane draws the map on both surfaces, and the desktop adds the drawing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'NOW' })).toBeDefined()
  expect(await term.find({ key: 'session:test-session' })).toBeDefined()
  expect(await term.find({ key: 'tab:tasks' })).toBeDefined()
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: 'FILES' })).toBeUndefined()
  expect(await term.find({ type: 'Code' })).toBeUndefined()
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const art = await desk.find({ type: 'Svg' })
  expect(String(art?.props.source)).toContain('<svg')
  expect(String(art?.props.alt)).toMatch(/^Agent map: 1 session, 0 need you/)
  expect(await desk.find({ key: 'session:test-session' })).toBeDefined()
  await desk.unmount()
})

const IDLE: MainState = { isWorking: false, since: null, reply: null, waiting: null, waitingAt: null }

function job(over: Partial<Job> & { id: string }): Job {
  return { tool: 'Bash', detail: 'x', startedAt: 0, endedAt: null, isError: false, agentId: null, taskId: null, need: null, ...over }
}

function agent(over: Partial<AgentRow> & { id: string }): AgentRow {
  return { label: 'Explore: find auth', status: 'running', parentId: null, startedAt: 0, endedAt: null, ...over }
}

test('reads what a call waits on, and the question an answer ends with', () => {
  expect(needOf('AskUserQuestion', { questions: [{ question: 'Which  database?' }] })).toEqual({ kind: 'question', text: 'Which database?' })
  expect(needOf('ExitPlanMode', {})?.kind).toBe('plan')
  expect(needOf('Bash', { command: 'ls' })).toBeNull()
  expect(lastQuestion('Done.\n\nWant me to **commit** this?')).toBe('Want me to commit this?')
  expect(lastQuestion('Fixed it. 要唔要我幫你寫 test？')).toBe('要唔要我幫你寫 test？')
  expect(lastQuestion('Why did it fail? Because X.\n\nThe fix is in.\n\nAll tests pass.')).toBeNull()
  expect(lastQuestion('All green.')).toBeNull()
})

test('orders the main session by what it asks of you; subagents and their calls are left to AGENTS', () => {
  const agents: AgentRow[] = [
    agent({ id: 'a1', label: 'Explore: find auth', status: 'running', startedAt: 100 }),
    agent({ id: 'a2', label: 'Plan: design cache', status: 'waiting', startedAt: 200 }),
    agent({ id: 'a3', label: 'general-purpose: migrate', status: 'failed', startedAt: 50, endedAt: 900 }),
    agent({ id: 'a4', label: 'teammate: reviewer', status: 'idle', startedAt: 10 }),
  ]
  const jobs: Job[] = [
    job({ id: 'j1', tool: 'Agent', detail: 'Explore: find auth', startedAt: 90 }),
    job({ id: 'j2', tool: 'Read', detail: 'auth.ts', agentId: 'a1', startedAt: 300 }),
    job({ id: 'j3', tool: 'AskUserQuestion', detail: 'waiting for your answer', startedAt: 400, need: { kind: 'question', text: 'Which database?' } }),
    job({ id: 'j4', tool: 'Bash', detail: 'npm test', startedAt: 500 }),
    job({ id: 'j5', tool: 'Bash', detail: 'npm run build', startedAt: 0, endedAt: 4_000, isError: true }),
    job({ id: 'j6', tool: 'Grep', detail: 'TODO', startedAt: 600, endedAt: 700 }),
    job({ id: 'j7', tool: 'Bash', detail: 'dev server (background)', startedAt: 0, taskId: 'b1' }),
    job({ id: 'j8', tool: 'Agent', detail: 'agent: broken', startedAt: 0, endedAt: 10, isError: true }),
  ]
  const g = groupNow(jobs, agents, { ...IDLE, reply: 'Ship it?', since: 1_000 })
  expect(g.needs.map(r => r.text)).toEqual(['Which database?', 'Plan: design cache is waiting for you', 'Reply: Ship it?'])
  expect(g.running.map(r => r.text)).toEqual(['Bash npm test', 'Bash dev server (background)'])
  // An Agent call that failed before any agent started stays visible.
  expect(g.ended.map(r => [r.text, r.tone])).toEqual([['Bash npm run build', 'failed'], ['Agent agent: broken', 'failed']])
  expect(g.quick).toBe(1)
  expect(g.idleAgents).toBe(1)
})

test('the engine waiting shows only when no call already says why', () => {
  const waiting: MainState = { ...IDLE, waiting: 'approve Bash', waitingAt: 5 }
  expect(groupNow([], [], waiting).needs.map(r => r.text)).toEqual(['Claude is waiting: approve Bash'])
  const asked = [job({ id: 'q', tool: 'AskUserQuestion', need: { kind: 'question', text: 'Pick one?' } })]
  expect(groupNow(asked, [], waiting).needs.map(r => r.text)).toEqual(['Pick one?'])
})

test('keeps running jobs when trimming, and remembers agents after they end', () => {
  const list = [job({ id: 'bg', startedAt: 0, taskId: 't' }), ...Array.from({ length: 10 }, (_, i) => job({ id: `q${i}`, startedAt: i, endedAt: i + 1 }))]
  expect(trimJobs(list, 4).map(j => j.id)).toEqual(['bg', 'q7', 'q8', 'q9'])
  expect(trimJobs([job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c', endedAt: 1 })], 2).map(j => j.id)).toEqual(['a', 'b'])

  let rows = mergeAgents([], [{ id: 'a1', type: 'Explore', description: 'auth', status: 'running' }], 1_000)
  expect(rows[0]).toMatchObject({ label: 'Explore: auth', startedAt: 1_000, endedAt: null })
  rows = mergeAgents(rows, [{ id: 'a1', type: 'Explore', description: 'auth', status: 'completed' }], 2_000)
  expect(rows[0]).toMatchObject({ status: 'completed', startedAt: 1_000, endedAt: 2_000 })
  rows = mergeAgents(rows, [], 3_000)
  expect(rows[0]?.endedAt).toBe(2_000)
  expect(mergeAgents(rows, [], 2_000 + 11 * 60_000)).toEqual([])
  const gone = mergeAgents(mergeAgents([], [{ id: 'b', type: 'Plan', description: 'x', status: 'running' }], 0), [], 500)
  expect(gone[0]).toMatchObject({ status: 'ended', endedAt: 500 })
})

test('the pane puts a waiting question on top, then the reply Claude ends on', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  let answer: () => void = () => undefined
  const answered = new Promise<void>(resolve => { answer = resolve })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await answered
    return { result: { questions: [], answers: { 'Which database?': 'Postgres' } } }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.turn.start({ text: 'pick a db', turnId: 't1' })
  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'a' }, { label: 'SQLite', description: 'b' }], multiSelect: false }],
  })
  await clock.settle()

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'NEEDS YOU' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Which database\?/ })).toBeDefined()
  await ui.unmount()

  answer()
  await asking
  await $.turn.complete({ answer: 'Using Postgres.\n\nWant me to add the migration?', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage: undefined })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Reply: Want me to add the migration\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Which database/ })).toBeUndefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'yes', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'NEEDS YOU' })).toBeUndefined()
  await ui.unmount()
})

test('cuts a subagent transcript to its task and latest steps', () => {
  const p = peekOf([
    { role: 'user', text: 'Audit  the API', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'npm test' }, result: 'ok' }, { tool: 'Bash', input: { command: 'npm run build' }, isError: true, result: 'fail' }] },
    { role: 'assistant', text: 'Build fails on types.', toolUses: [{ tool: 'Edit', input: { file_path: '/p/a.ts' } }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'SubagentHandback', input: { result: 'Build fails on types.' }, result: 'ok' }] },
  ], 3)
  expect(p.task).toBe('Audit the API')
  expect(p.lines).toEqual([
    { kind: 'failed', text: 'Bash npm run build' },
    { kind: 'text', text: 'Build fails on types.' },
    { kind: 'running', text: 'Edit a.ts' },
  ])
})

test('a subagent is a card under its session saying what it does; opened, its role, task, tool and caller, then its result', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { agents: false })
  let listed: { id: string; type: string; description: string; status: 'running' | 'completed' }[] = []
  on('agent.list', () => ({ value: listed }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  let finish: () => void = () => undefined
  const finished = new Promise<void>(resolve => { finish = resolve })
  on('tool.call', { tool: 'Read' }, async () => {
    await finished
    return { result: { type: 'text', file: { filePath: '/p/auth.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } } as never }
  })
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.agent.spawn(spawnInput({ prompt: 'Find where the session token is validated and list every caller.', description: 'find token checks', subagentType: 'Explore' }))
  listed = [{ id: 'a1', type: 'Explore', description: 'find token checks', status: 'running' }]
  const reading = $.tool.call({ tool: 'Read', file_path: '/p/auth.ts', agentId: 'a1' } as never)
  await clock.advance(2_000)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(String((await ui.find({ key: 'agent:a1' }))?.props.label)).toMatch(/^Explore · find token checks +0:02$/)
  expect(await ui.find({ type: 'Text', text: '  reading auth.ts' })).toBeDefined()
  await ui.press({ key: 'agent:a1' })
  expect(await ui.find({ type: 'Text', text: 'AGENT' })).toBeDefined()
  // The role of its type, what it was asked, its tool line and who called it.
  expect(await ui.find({ type: 'Text', text: /^Fast read-only search agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Find where the session token/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Read auth\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'by Claude · haiku · 1 call · background' })).toBeDefined()
  await ui.unmount()

  finish()
  await reading
  await $.turn.complete({ agentId: 'a1', answer: 'Validated in src/auth.ts:42 by verifyToken().', durationMs: 10, isAborted: false, turnId: 't9', reason: 'answer', usage: undefined })
  listed = [{ id: 'a1', type: 'Explore', description: 'find token checks', status: 'completed' }]
  await clock.advance(2_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /→ Validated in src\/auth\.ts:42/ })).toBeDefined()
  await ui.press({ key: 'use:a1' })
  expect(filled[0]).toContain('Result of the Explore agent (find token checks):\nValidated in src/auth.ts:42')
  await ui.unmount()
})

test('pressing a subagent opens its task and latest steps', async ($, on) => {
  const clock = mock.clock(on, { now: 70_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { agents: false })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'find auth', status: 'running' as const }] }))
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'Find where login is checked', toolUses: [] },
      {
        role: 'assistant' as const,
        text: 'Looking at the middleware.',
        toolUses: [
          { tool_use_id: 't1', tool: 'Grep', input: { pattern: 'session' }, result: 'x' },
          { tool_use_id: 't2', tool: 'Read', input: { file_path: '/p/middleware.ts' } },
        ],
      },
    ],
  }))
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(2_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'agent:a1' })
  expect(await ui.find({ type: 'Text', text: /^AGENT$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Find where login is checked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Grep session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read middleware\.ts/ })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  expect(await ui.find({ type: 'Text', text: /^AGENT$/ })).toBeUndefined()
  await ui.unmount()
})

// Local wall-clock times, so the tests hold in any time zone.
const at = (h: number, m: number, s = 0): number => new Date(2026, 9, 12, h, m, s).getTime()

test('a loop is a node of this session: opened, how often, since when, its next run and its runs; stop takes two presses', async ($, on) => {
  const clock = mock.clock(on, { now: at(14, 2, 30) })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', { tool: 'CronCreate' }, () => ({ result: { id: 'c1', humanSchedule: 'Every 5 minutes', recurring: true, durable: false } }))
  const deleted: string[] = []
  on('tool.call', { tool: 'CronDelete' }, ($, e) => {
    deleted.push(e.id)
    return { result: { id: e.id } }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: '/babysit-prs', recurring: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(String((await ui.find({ key: 'node:self:loop:c1' }))?.props.label)).toMatch(/^loop · Every 5 minutes/)
    await ui.press({ key: 'node:self:loop:c1' })
    expect(await ui.find({ type: 'Text', text: 'LOOP' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Every 5 minutes · since 14:02 (0s)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'next 14:05 (in 3m) · not run yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/babysit-prs/ })).toBeDefined()
    await ui.press({ key: 'peek-close' })
    expect(await ui.find({ type: 'Text', text: 'LOOP' })).toBeUndefined()
    await ui.unmount()
  }

  await clock.advance(at(14, 5, 6) - at(14, 2, 30))
  await $.prompt.submit({ text: '/babysit-prs', wait: false, origin: { kind: 'scheduled-trigger' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'node:self:loop:c1' })
  expect(await ui.find({ type: 'Text', text: 'next 14:10 (in 5m) · ran 1× · last 14:05' })).toBeDefined()
  await ui.press({ key: 'loop-stop:c1' })
  expect(deleted).toEqual([])
  expect(String((await ui.find({ key: 'loop-stop:c1' }))?.props.label)).toBe('Press again to stop')
  await ui.press({ key: 'loop-stop:c1' })
  await clock.settle()
  expect(deleted).toEqual(['c1'])
  expect(await ui.find({ key: 'node:self:loop:c1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'That one has ended or left the map.' })).toBeDefined()
  await ui.unmount()
})

test('a self-paced loop shows its wakeup and leaves the map when a turn books none', async ($, on) => {
  const clock = mock.clock(on, { now: at(9, 0) })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('tool.call', { tool: 'ScheduleWakeup' }, () => ({ result: { scheduledFor: at(9, 20), clampedDelaySeconds: 1200, wasClamped: false } }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1200, reason: 'watching CI run', prompt: '/loop watch CI' })
  await $.classic.Stop({ stop_hook_active: false, session_crons: [{ id: 'w1', schedule: '20 9 12 10 *', recurring: false, prompt: '/loop watch CI' }] })
  await clock.settle()

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const loopKey = String((await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('node:self:loop:'))?.key)
  expect(loopKey).toMatch(/^node:self:loop:/)
  await ui.press({ key: loopKey })
  expect(await ui.find({ type: 'Text', text: 'Self-paced · since 09:00 (0s)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^next 09:20 \(in 20m\) · not run yet · waits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /watching CI run$/ })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  await ui.unmount()

  await $.classic.Stop({ stop_hook_active: false, session_crons: [] })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).some(b => String(b.key).startsWith('node:self:loop:'))).toBe(false)
  await ui.unmount()
})

test('the launcher starts an agent type with a task and runs a skill with args', async ($, on) => {
  const clock = mock.clock(on, { now: 200_000 })
  mock.env(on, { HOME: '/Users/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__ringside__${e.name}` } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('fs.exists', () => ({ value: false }))
  on('command.list', () => ({
    value: [
      { name: 'ship-it', description: 'Ship the branch end to end.', source: 'user' as const },
      { name: 'clear', description: 'Clear the conversation.', source: 'builtin' as const },
      { name: 'ringside', description: 'This pane.', source: 'plugin' as const, plugin: 'ringside' },
    ],
  }))
  const spawned: { prompt: string; description: string; subagentType: string }[] = []
  on('agent.spawn', ($, e) => {
    spawned.push({ prompt: e.prompt, description: e.description, subagentType: e.subagentType })
    return { model: 'claude-opus-5-5', agentId: 'L1' }
  })
  on('session.messages', () => ({ value: [] }))
  const ran: string[] = []
  on('command.run', { command: 'ship-it' }, ($, e) => {
    ran.push(e.args)
    return { text: 'ok' }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The task box's key changes with each pick, so it opens empty.
  const taskBox = async (): Promise<string | undefined> => {
    const box = (await ui.findAll({ type: 'Input' })).find(i => String(i.key).startsWith('launch-task'))
    return box === undefined ? undefined : String(box.key)
  }
  expect(await ui.find({ key: 'pick:agent:Explore' })).toBeUndefined()
  await ui.press({ key: 'tab:launch' })
  // Each agent type is a card with its own run button; no prompt box until one is picked.
  expect(await ui.find({ key: 'lcard:agent:Explore' })).toBeDefined()
  expect(await ui.find({ key: 'run:agent:Explore' })).toBeDefined()
  expect(await taskBox()).toBeUndefined()
  await ui.press({ key: 'run:agent:Explore' })
  const firstBox = await taskBox()
  expect(firstBox).toBeDefined()
  // Picked, cancel takes the run button's place; the box spans the card below the name.
  expect(await ui.find({ key: 'run:agent:Explore' })).toBeUndefined()
  expect(String((await ui.find({ key: 'launch-back' }))?.props.label)).toBe('cancel')
  await ui.press({ key: 'launch-back' })
  expect(await taskBox()).toBeUndefined()
  await ui.press({ key: 'pick:agent:Explore' })
  const secondBox = await taskBox()
  expect(secondBox).toBeDefined()
  expect(secondBox).not.toBe(firstBox)
  await ui.input({ key: String(secondBox), text: 'Map the auth flow end to end' })
  expect(spawned.map(s => [s.prompt, s.description])).toEqual([['Map the auth flow end to end', 'Map the auth flow end to']])
  expect(await ui.find({ type: 'Text', text: /Started Explore/ })).toBeDefined()
  // Running: the card says so where its run button was, and a press opens it on the map.
  expect(String((await ui.find({ key: 'running:agent:Explore' }))?.props.label)).toBe('Explore running')
  await ui.press({ key: 'running:agent:Explore' })
  expect(await ui.find({ type: 'Text', text: /^by you · / })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  // Its card on the map, under the agent's id or, until the engine lists it, a pending one.
  await ui.press({ key: 'tab:map' })
  const card = (await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('agent:') && /^Explore · Map the auth flow end/.test(String(b.props.label)))
  expect(card).toBeDefined()
  // The kit answers a plugin's own spawn without the model: only who called it is sure here.
  await ui.press({ key: String(card?.key) })
  expect(await ui.find({ type: 'Text', text: /^by you · / })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  await ui.press({ key: 'tab:launch' })

  await ui.press({ key: 'launch-kind:skill' })
  expect(await ui.find({ key: 'pick:skill:ship-it' })).toBeDefined()
  expect(await ui.find({ key: 'pick:skill:clear' })).toBeUndefined()
  expect(await ui.find({ key: 'pick:skill:ringside' })).toBeUndefined()
  await ui.input({ key: 'launch-filter', text: 'zzz', kind: 'change' })
  expect(await ui.find({ key: 'pick:skill:ship-it' })).toBeUndefined()
  await ui.input({ key: 'launch-filter', text: 'ship', kind: 'change' })
  await ui.press({ key: 'pick:skill:ship-it' })
  await ui.input({ key: String(await taskBox()), text: 'staging' })
  expect(ran).toEqual(['staging'])
  expect(await ui.find({ type: 'Text', text: 'Queued /ship-it staging' })).toBeDefined()
  await ui.unmount()
})

const HOME = '/Users/test'
const DIR = `${HOME}/.claude/mods-data/ringside/hub/-Users-test-proj`

function boardFile(over: Partial<HubFile> & { sessionId: string }): string {
  const f: HubFile = {
    v: 1, name: over.sessionId, root: '/Users/test/proj', cwd: '/Users/test/proj', branch: 'main', state: 'idle', doing: '', loops: 0,
    nextLoopAt: null, agents: 0, heartbeatAt: 0, ended: false, seenAt: 0, messages: [], ...over,
  }
  return JSON.stringify(f)
}

function note(over: Partial<HubMessage> & { id: string; at: number; text: string }): HubMessage {
  return { fromId: 'peer', fromName: 'api-fix', by: 'claude', to: 'all', ...over }
}

test('the map shows every session on this computer with what each started; the board stays this repo\'s, posts, wakes on request and hands new notes to the model', async ($, on) => {
  const start = 5_000_000
  const clock = mock.clock(on, { now: start })
  mock.env(on, { HOME })
  host(on, { fs: false })
  const files = new Map<string, string>()
  files.set(`${DIR}/peer.json`, boardFile({
    sessionId: 'peer', name: 'api-fix', state: 'working', doing: 'Migrate users table', loops: 1, heartbeatAt: start - 20_000,
    messages: [note({ id: 'p1', at: start - 10_000, text: 'Migration done, tests green' })],
    nodes: [{ id: 'a9', kind: 'agent', title: 'tester · run e2e', status: 'running', now: 'running tests', raw: '', why: '', from: start - 30_000, to: null, progress: null, costUsd: null, tokens: null }],
  }))
  files.set(`${DIR}/gone.json`, boardFile({ sessionId: 'gone', name: 'old-chat', heartbeatAt: start - 60 * 60_000 }))
  files.set(`${HOME}/.claude/mods-data/ringside/hub/-Users-test-elsewhere/far.json`, boardFile({
    sessionId: 'far', name: 'elsewhere', root: '/Users/test/elsewhere', cwd: '/Users/test/elsewhere', heartbeatAt: start, state: 'needs', doing: 'approve Bash',
    messages: [note({ id: 'f1', at: start, fromId: 'far', fromName: 'elsewhere', text: 'not for this repo' })],
  }))
  memFs(on, files, () => start)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  const sent: { to: string; text: string }[] = []
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.advance(5_000)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Every session that runs this mod, in any repo, with what it started; old files are gone.
  expect(await ui.find({ key: 'session:peer' })).toBeDefined()
  expect(String((await ui.find({ key: 'node:peer:a9' }))?.props.label)).toMatch(/^tester · run e2e/)
  expect(await ui.find({ key: 'session:far' })).toBeDefined()
  expect(await ui.find({ key: 'need:session:far' })).toBeDefined()
  expect(await ui.find({ key: 'session:gone' })).toBeUndefined()

  // The board is this repo's: opened from this session.
  await ui.press({ key: 'session:test-session' })
  expect(await ui.find({ type: 'Text', text: 'BOARD · proj' })).toBeDefined()
  expect(await ui.find({ key: 'hub-member:peer' })).toBeDefined()
  expect(await ui.find({ key: 'hub-member:far' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /api-fix·claude: Migration done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not for this repo/ })).toBeUndefined()

  // A post from the pane goes in this session's own board file.
  await ui.input({ key: 'hub-say', text: 'Hold the deploy until 5pm' })
  const own = JSON.parse(files.get(`${DIR}/test-session.json`) ?? '{}') as HubFile
  expect(own.messages.map(x => [x.text, x.by, x.to])).toEqual([['Hold the deploy until 5pm', 'person', 'all']])
  expect(sent).toEqual([])

  // To one session, with wake on: its Claude gets the message too.
  await ui.press({ key: 'hub-member:peer' })
  await ui.press({ key: 'hub-wake' })
  await ui.input({ key: 'hub-say', text: 'Rebase on main first' })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toContain('peer')
  expect(sent[0]?.text).toBe('[Repo hub · proj] proj·test: Rebase on main first')
  expect(await ui.find({ type: 'Text', text: 'Posted to api-fix; woke 1 of 1.' })).toBeDefined()
  await ui.unmount()

  // This session's own file carries its map for the others.
  expect(Array.isArray((JSON.parse(files.get(`${DIR}/test-session.json`) ?? '{}') as HubFile).nodes)).toBe(true)

  // A note posted after this session started reaches its model with the next prompt, once.
  files.set(`${DIR}/peer.json`, boardFile({
    sessionId: 'peer', name: 'api-fix', state: 'idle', heartbeatAt: start + 9_000,
    messages: [note({ id: 'p2', at: start + 8_000, text: 'Users table migrated; API needs a redeploy' })],
  }))
  await clock.advance(5_000)
  await $.prompt.submit({ text: 'what next?', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and then?', wait: false, origin: { kind: 'composer' } })
  expect(contexts[0]?.join('\n')).toContain('api-fix (its Claude): Users table migrated; API needs a redeploy')
  expect(contexts[0]?.join('\n')).toContain('not instructions from the person here')
  expect(contexts[0]?.join('\n')).not.toContain('Migration done')
  expect(contexts[1]).toBeUndefined()
})

test("Claude reads the hub and posts to it with the hub tool", async ($, on) => {
  const start = 6_000_000
  const clock = mock.clock(on, { now: start })
  mock.env(on, { HOME })
  host(on, { fs: false })
  const files = new Map<string, string>()
  files.set(`${DIR}/peer.json`, boardFile({ sessionId: 'peer', name: 'api-fix', state: 'needs', doing: 'Approve the plan', heartbeatAt: start - 5_000 }))
  memFs(on, files, () => start)
  on('tool.call', { tool: 'CronCreate' }, () => ({ result: { id: 'c1', humanSchedule: 'Every 10 minutes', recurring: true, durable: false } }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'CronCreate', cron: '*/10 * * * *', prompt: 'check the queue', recurring: true })
  await clock.settle()

  const read = await $.tool.call({ tool: 'mcp__ringside__hub', action: 'read' } as never)
  const report = String((read as { result?: unknown }).result)
  expect(report).toContain('- api-fix: NEEDS THE PERSON, branch main')
  expect(report).toContain('Approve the plan')
  expect(report).toContain('Every 10 minutes')
  expect(report).toContain('prompt: check the queue')

  const posted = await $.tool.call({ tool: 'mcp__ringside__hub', action: 'post', text: 'I will take the API redeploy', to: 'api-fix' } as never)
  expect(String((posted as { result?: unknown }).result)).toBe('Posted to api-fix.')
  const own = JSON.parse(files.get(`${DIR}/test-session.json`) ?? '{}') as HubFile
  expect(own.messages.map(x => [x.text, x.by, x.to])).toEqual([['I will take the API redeploy', 'claude', 'peer']])
  const nobody = await $.tool.call({ tool: 'mcp__ringside__hub', action: 'post', text: 'x', to: 'nobody' } as never)
  expect(String((nobody as { result?: unknown }).result)).toBe('No session named "nobody" in this repo. Sessions here: api-fix.')
})

test('recording mode masks what a subagent was asked', async ($, on) => {
  mock.clock(on, { now: 9_000 })
  mock.env(on, { HOME: '/Users/test', CLAUDE_MODS_RECORDING: '1', CLAUDE_MODS_RECORDING_TERMS: JSON.stringify(['falcon']) })
  host(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '/Users/test/site', surface: null, isInteractive: false })
  await $.agent.spawn(spawnInput({ prompt: 'Email sales@example.com about Project Falcon pricing', description: 'draft email', subagentType: 'general-purpose' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'agent:a1' })
  expect(await ui.find({ type: 'Text', text: /^Email \[email\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sales@example\.com/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Falcon/ })).toBeUndefined()
  await ui.unmount()
})

test('the same call failing three times may be stuck: under NEEDS YOU, and in the band while the map is not on screen', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'ERR_PNPM_PEER_DEP' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/Users/test/deps', surface: null, isInteractive: false })
  await $.turn.start({ text: 'upgrade the deps', turnId: 't1' })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'pnpm install' })
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(String((await pane.find({ key: 'need:session:test-session' }))?.props.label)).toMatch(/^this session: the same Bash failed 3 +0:00$/)
  // What does not fit goes on a second line, never cut.
  expect(await pane.find({ type: 'Text', text: '  times in a row: pnpm install' })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'May be stuck' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^this session: the same Bash failed 3 times/ })).toBeDefined()
  expect(await band.find({ key: 'map-open' })).toBeDefined()
  await band.unmount()
})

test('with savvy-progress loaded, a subagent card shows the steps it reported; without it, nothing breaks', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { agents: false })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'find data', status: 'running' as const }] }))
  on('state.get', { plugin: 'savvy-progress', key: 'agents' } as never, () => ({
    value: { value: [{ agentId: 'a1', description: 'find data', stepDone: 2, stepTotal: 5, stepNote: 'reading', costUsd: 0.1 }], version: 1 },
  }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ {2}▰▰▱▱▱ 2\/5/ })).toBeDefined()
  await ui.unmount()
})

type SessionRow = Parameters<typeof elsewhereNeeds>[0][number]
const session = (over: Partial<SessionRow> & { sessionId: string }): SessionRow => ({
  jobId: null, name: over.sessionId, cwd: '/p', pid: 1, tty: '/dev/ttys001', state: 'idle', group: 'idle', since: 0, summary: '',
  isSelf: false, usage: null, ...over,
})

test('other sessions waiting on you: not this one, not hidden, not a day old; longest waiting first', () => {
  const now = 100_000_000
  const rows = [
    session({ sessionId: 'me', isSelf: true, state: 'waiting', group: 'needs', since: now - 5_000 }),
    session({ sessionId: 'new', name: 'blog', state: 'waiting', group: 'needs', since: now - 10_000, summary: 'approve Bash' }),
    session({ sessionId: 'old', name: 'shop', state: 'blocked', group: 'needs', since: now - 60_000 }),
    session({ sessionId: 'hid', state: 'waiting', group: 'needs', since: now - 1_000 }),
    session({ sessionId: 'stale', state: 'waiting', group: 'needs', since: now - 25 * 60 * 60 * 1000 }),
    session({ sessionId: 'busy', state: 'busy', group: 'working', since: now - 1_000 }),
  ]
  const shown = elsewhereNeeds(rows, ['hid'], now)
  expect(shown.map(r => r.text)).toEqual(['shop: blocked', 'blog: approve Bash'])
  expect(shown.map(r => r.sessionId)).toEqual(['old', 'new'])
  expect(shown[0]).toMatchObject({ tone: 'need', glyph: '!', from: now - 60_000, to: null, depth: 0 })
  expect(elsewhereNeeds([], [], now)).toEqual([])
})

test('with the sessions mod loaded, its list fills NEEDS YOU; pressing one brings that terminal forward', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { process: false })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const isOsa = e.argv[0] === '/usr/bin/osascript'
    return { value: { exitCode: isOsa ? 0 : 128, stdout: isOsa ? 'ok\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows = [
    session({ sessionId: 'w-id', name: 'legal-notes', state: 'waiting', group: 'needs', since: 1_000_000 - 120_000, summary: '第 3 條：追溯效力' }),
    session({ sessionId: 'self-id', isSelf: true, state: 'waiting', group: 'needs', since: 1_000_000 - 1_000 }),
  ]
  on('state.get', { plugin: 'sessions', key: 'rows' } as never, () => ({ value: { value: rows, version: 1 } }))
  on('state.get', { plugin: 'sessions', key: 'hidden' } as never, () => ({ value: { value: [], version: 1 } }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'NEEDS YOU' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 in other sessions/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 need you/ })).toBeDefined()
    const row = await ui.find({ key: 'need:session:w-id' })
    expect(String(row?.props.label)).toMatch(/^legal-notes: 第 3 條：追溯效力 +2:00$/)
    // Padded by terminal cells: wide characters count two, so the time sits at the pane's edge.
    expect(cellWidth(String(row?.props.label))).toBe(PANE.props.bodyColumns - 2)
    expect(await ui.find({ key: 'need:session:self-id' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'need:session:w-id' })
  // The jump runs on a timer of its own, outside the press.
  await clock.settle()
  const osa = ran.filter(a => a[0] === '/usr/bin/osascript')
  expect(osa.length).toBe(1)
  expect(osa[0]?.[osa[0].length - 1]).toBe('/dev/ttys001')
  await ui.unmount()
  // The sessions mod's own band says who waits: this one does not say it twice.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'Waiting on you' })).toBeUndefined()
  await band.unmount()
})

test('without the sessions mod, other sessions come from the engine registry; pressing one brings its terminal forward', async ($, on) => {
  const now = 5_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { process: false, fs: false })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const files = new Map<string, string>([
    ['/Users/test/.claude/sessions/4242.json', JSON.stringify({ pid: 4242, sessionId: 'other-1', cwd: '/Users/test/shop', status: 'waiting', waitingFor: 'approve Bash', statusUpdatedAt: now - 90_000 })],
    ['/Users/test/.claude/sessions/4343.json', JSON.stringify({ pid: 4343, sessionId: 'gone', cwd: '/Users/test/old', status: 'waiting', statusUpdatedAt: now - 90_000 })],
    ['/usr/bin/osascript', ''],
  ])
  memFs(on, files, () => now)
  const ran: string[][] = []
  const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    // `ps -p` exits 1 when one of the pids is gone, and still lists the live ones.
    if (e.argv[0] === 'ps') return out(1, ' 4242 ttys004\n')
    if (e.argv[0] === '/usr/bin/osascript') return out(0, 'ok\n')
    return out(128, '')
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(String((await ui.find({ key: 'need:session:other-1' }))?.props.label)).toMatch(/^shop: approve Bash +1:35$/)
  expect(await ui.find({ key: 'need:session:gone' })).toBeUndefined()
  await ui.press({ key: 'need:session:other-1' })
  await clock.settle()
  const osa = ran.filter(a => a[0] === '/usr/bin/osascript')
  expect(osa.length).toBe(1)
  expect(osa[0]?.[osa[0].length - 1]).toBe('/dev/ttys004')
  await ui.unmount()
  // With no sessions mod to say so, the band names the other session waiting on the person.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'Waiting on you' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^shop: approve Bash/ })).toBeDefined()
  await band.unmount()
})

test('with CLAUDE_CONFIG_DIR set, the registry and the board files live in that folder', async ($, on) => {
  const now = 6_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/Users/test', CLAUDE_CONFIG_DIR: '/Users/test/alt-claude' })
  host(on, { process: false, fs: false })
  const files = new Map<string, string>([
    ['/Users/test/alt-claude/sessions/77.json', JSON.stringify({ pid: 77, sessionId: 'alt-1', cwd: '/Users/test/api', status: 'waiting', waitingFor: 'approve Edit', statusUpdatedAt: now - 30_000 })],
    ['/Users/test/.claude/sessions/78.json', JSON.stringify({ pid: 78, sessionId: 'default-dir', cwd: '/Users/test/web', status: 'waiting', statusUpdatedAt: now - 30_000 })],
  ])
  memFs(on, files, () => now)
  on('process.run', ($, e) => {
    const isPs = e.argv[0] === 'ps'
    return { value: { exitCode: isPs ? 0 : 128, stdout: isPs ? ' 77 ttys002\n 78 ttys003\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'need:session:alt-1' })).toBeDefined()
  expect(await ui.find({ key: 'need:session:default-dir' })).toBeUndefined()
  await ui.unmount()
  const boards = [...files.keys()].filter(k => k.includes('/ringside/hub/'))
  expect(boards.length).toBeGreaterThan(0)
  expect(boards.every(k => k.startsWith('/Users/test/alt-claude/'))).toBe(true)
})

test('what a session tells the other maps it is doing reads in plain words', () => {
  const main: MainState = { isWorking: true, since: 1, reply: null, waiting: null, waitingAt: null }
  const job = (over: Partial<Job>): Job => ({ id: 'j1', tool: 'Bash', detail: 'pnpm test', startedAt: 1, endedAt: null, isError: false, agentId: null, taskId: null, need: null, ...over })
  const noGoal = { startedAt: null, tasks: [] }
  expect(presenceOf(main, [job({})], noGoal, [])).toEqual({ state: 'working', doing: 'running tests' })
  expect(presenceOf({ ...main, isWorking: false }, [job({ detail: 'Rebuild the site (background)' })], noGoal, []).doing).toBe('rebuild the site in the background')
  expect(presenceOf(main, [], noGoal, []).doing).toBe('thinking')
  expect(presenceOf(main, [job({})], { startedAt: 1, tasks: [{ id: '1', subject: 'Fix login', status: 'in_progress' }] }, []).doing).toBe('Fix login')
  expect(presenceOf({ ...main, isWorking: false }, [], noGoal, [])).toEqual({ state: 'idle', doing: '' })
})

test('this session offers Replay Theater when it is loaded, and says the replay opens in its own tab', async ($, on) => {
  const clock = mock.clock(on, { now: 7_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { commands: ['replay'] })
  const ran: string[] = []
  on('command.run', { command: 'replay' }, ($, e) => {
    ran.push(e.command)
    return { text: 'Replay Theater: 1 edits' }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'session:test-session' })
  await ui.press({ key: 'replay' })
  expect(ran).toEqual(['replay'])
  expect(await ui.find({ type: 'Text', text: /^Opened in the Replay Theater tab/ })).toBeDefined()
  await ui.unmount()
})

test('the tabs are cards, the shown one in the accent colour; the task list keeps what is done, ticked, in its own order', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  let made = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(++made), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: {} }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  for (const subject of ['Read the code', 'Build the cards', 'Check it live']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject } as never)
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const id of ['map', 'tasks', 'launch']) {
    const tab = await ui.find({ key: `tabcard:${id}` })
    expect(tab?.props.borderStyle).toBe('round')
    expect(tab?.props.borderColor).toBe(id === 'map' ? 'claude' : 'gray')
  }
  // A narrow pane: the card keeps the short count.
  expect(await ui.find({ type: 'Text', text: ' 1/3' })).toBeDefined()
  await ui.press({ key: 'tab:tasks' })
  expect((await ui.find({ key: 'tabcard:tasks' }))?.props.borderColor).toBe('claude')
  expect(await ui.find({ type: 'Text', text: /^ {2}1 of 3 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 in progress · 1 to do · 1 done' })).toBeDefined()
  // The finished task is still listed, first, as it was made.
  const drawn = JSON.stringify(await ui.drawn())
  const at = (s: string) => drawn.indexOf(s)
  expect(at('Read the code')).toBeGreaterThan(-1)
  expect(at('Read the code')).toBeLessThan(at('Build the cards'))
  expect(at('Build the cards')).toBeLessThan(at('Check it live'))
  expect(await ui.find({ type: 'Text', text: '✓ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' now' })).toBeDefined()
  await ui.unmount()
})

test('the launcher lists agent files by where they come from, each card with its model and colour', async ($, on) => {
  const now = 2_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { fs: false })
  const files = new Map<string, string>([
    ['/Users/test/proj/.claude/agents/code-reviewer.md', '---\nname: code-reviewer\ndescription: Reviews the current diff for correctness bugs.\nmodel: sonnet\ncolor: blue\n---\nYou review.'],
    ['/Users/test/.claude/agents/docs-writer.md', '---\nname: docs-writer\ndescription: Keeps README in sync.\nmodel: haiku\n---\nYou write.'],
  ])
  memFs(on, files, () => now)
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  // The engine's later offer of the same type does not lose what the file said.
  await $.agent.offer({ agent: 'code-reviewer', description: 'Reviews the current diff for correctness bugs.', source: 'projectSettings' } as never).catch(() => undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:launch' })
  const drawn = JSON.stringify(await ui.drawn())
  const at = (s: string) => drawn.indexOf(s)
  for (const k of ['lsec:project', 'lsec:user', 'lsec:builtin']) expect(at(k)).toBeGreaterThan(-1)
  expect(at('lsec:project')).toBeLessThan(at('lsec:user'))
  expect(at('lsec:user')).toBeLessThan(at('lsec:builtin'))
  expect(at('lcard:agent:code-reviewer')).toBeLessThan(at('lsec:user'))
  expect(await ui.find({ type: 'Text', text: 'PROJECT' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  sonnet' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  haiku' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => t.props.color === '#61afef' && String(t.props.children ?? t.text ?? '').includes('●'))).toBe(true)
  await ui.unmount()
})

test('a session opens right under its own row, says how it is reached, and what Jump there did', async ($, on) => {
  const now = 3_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/Users/test' })
  host(on, { process: false })
  on('ui.toast', () => ({ value: undefined }))
  let osaAnswer = 'ok\n'
  on('process.run', ($, e) => {
    const isOsa = e.argv[0] === '/usr/bin/osascript'
    return { value: { exitCode: isOsa ? 0 : 128, stdout: isOsa ? osaAnswer : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const day = 24 * 60 * 60 * 1000
  const rows = [
    session({ sessionId: 'self-id', isSelf: true, since: now - 1_000 }),
    session({ sessionId: 'a-id', name: 'alpha', cwd: '/Users/test/alpha', tty: '/dev/ttys004', since: now - 60_000, summary: 'Merged the branch.' }),
    session({ sessionId: 'z-id', name: 'zeta', cwd: '/Users/test/zeta', tty: '/dev/ttys005', since: now - 60_000 }),
    session({ sessionId: 'bg-old', jobId: 'job-old', name: 'old audit', tty: null, pid: null, state: 'done', since: now - 2 * day }),
    session({ sessionId: 'bg-stuck', jobId: 'job-stuck', name: 'old cost check', tty: null, pid: null, state: 'blocked', group: 'needs', since: now - 40 * day }),
    session({ sessionId: 'bg-new', jobId: 'job-new', name: 'fresh audit', tty: null, pid: null, state: 'done', since: now - 60 * 60_000 }),
  ]
  on('state.get', { plugin: 'sessions', key: 'rows' } as never, () => ({ value: { value: rows, version: 1 } }))
  on('state.get', { plugin: 'sessions', key: 'hidden' } as never, () => ({ value: { value: [], version: 1 } }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // A background session that ended days ago is history: not on the map. One from an hour ago is.
  expect(await ui.find({ key: 'session:bg-old' })).toBeUndefined()
  expect(await ui.find({ key: 'session:bg-stuck' })).toBeUndefined()
  expect(await ui.find({ key: 'session:bg-new' })).toBeDefined()
  // No "(no map)" tag in the row itself.
  expect(String((await ui.find({ key: 'session:a-id' }))?.props.label)).not.toMatch(/no map/)
  await ui.press({ key: 'session:a-id' })
  const drawn = JSON.stringify(await ui.drawn())
  const at = (s: string) => drawn.indexOf(s)
  expect(at('peek:session:a-id')).toBeGreaterThan(at('"session:a-id"'))
  expect(at('peek:session:a-id')).toBeLessThan(at('"session:z-id"'))
  expect(await ui.find({ type: 'Text', text: 'Merged the branch.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/alpha' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ttys004' })).toBeDefined()
  await ui.press({ key: 'jump:a-id' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^✓ Switched to alpha's terminal \(ttys004\)/ })).toBeDefined()
  osaAnswer = 'none\n'
  await ui.press({ key: 'jump:a-id' })
  await clock.settle()
  const said = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).join(' ').replace(/\s+/g, ' ')
  expect(said).toMatch(/✗ Could not bring alpha forward: its terminal window was not found/)
  // A background session opens with claude attach instead.
  await ui.press({ key: 'session:bg-new' })
  expect(String((await ui.find({ key: 'jump:bg-new' }))?.props.label)).toBe('Open in Terminal')
  await ui.unmount()
})

// A background shell as the Bash tool answers one: its task id, nothing waited for.
const BACKGROUND = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }

async function shellKey(ui: { findAll: (q: { type: string }) => Promise<{ key: unknown }[]> }): Promise<string | undefined> {
  const found = (await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('node:self:job:'))
  return found === undefined ? undefined : String(found.key)
}

test('recording mode masks the desktop drawing too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test', CLAUDE_MODS_RECORDING: '1', CLAUDE_MODS_RECORDING_TERMS: JSON.stringify(['falcon']) })
  host(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: BACKGROUND }))
  await $.session.start({ cwd: '/Users/test/falcon-site', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Serve falcon', run_in_background: true })
  await clock.settle()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await desk.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('[hidden]')
  expect(source).not.toMatch(/falcon/i)
  await desk.unmount()
})

test('a stop the engine refuses leaves the loop and the shell on the map, and says so', async ($, on) => {
  const clock = mock.clock(on, { now: at(14, 2, 30) })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'CronCreate' }, () => ({ result: { id: 'c1', humanSchedule: 'Every 5 minutes', recurring: true, durable: false } }))
  on('tool.call', { tool: 'CronDelete' }, () => ({ deny: 'The user declined' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: BACKGROUND }))
  on('tool.call', { tool: 'TaskStop' }, () => ({ deny: 'The user declined' }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: '/babysit-prs', recurring: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'node:self:loop:c1' })
  await ui.press({ key: 'loop-stop:c1' })
  await ui.press({ key: 'loop-stop:c1' })
  await clock.settle()
  expect(await ui.find({ key: 'node:self:loop:c1' })).toBeDefined()
  expect(toasts.some(t => /^Could not stop the loop: The user declined/.test(t))).toBe(true)
  await ui.press({ key: 'peek-close' })

  const key = await shellKey(ui)
  expect(key).toBeDefined()
  await ui.press({ key: String(key) })
  const stopKey = `job-stop:${String(key).replace(/^node:self:/, '')}`
  await ui.press({ key: stopKey })
  await ui.press({ key: stopKey })
  await clock.settle()
  expect(await shellKey(ui)).toBe(key)
  expect(toasts.some(t => /^Could not stop the shell: The user declined/.test(t))).toBe(true)
  await ui.unmount()
})

test('a TaskStop of Claude\'s that fails leaves the shell running', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: BACKGROUND }))
  let isAllowed = false
  on('tool.call', { tool: 'TaskStop' }, ($, e) =>
    isAllowed ? { result: { message: 'stopped', task_id: e.task_id ?? '', task_type: 'shell' } } : { deny: 'The user declined' })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shellKey(ui)).toBeDefined()
  await ui.unmount()
  isAllowed = true
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shellKey(ui)).toBeUndefined()
  await ui.unmount()
})

test('a background shell of this session is never timed out; a call that never came back is, after three hours', () => {
  const hour = 60 * 60 * 1000
  const at = 10 * hour
  expect(isStale(job({ id: 'dev', taskId: 'b1', startedAt: 0 }), at)).toBe(false)
  expect(isStale(job({ id: 'sub', taskId: 'b2', agentId: 'a1', startedAt: 0 }), at)).toBe(true)
  expect(isStale(job({ id: 'lost', startedAt: 0 }), at)).toBe(true)
  expect(isStale(job({ id: 'fresh', startedAt: at - hour }), at)).toBe(false)
  expect(isStale(job({ id: 'done', startedAt: 0, endedAt: at - 60_000 }), at)).toBe(false)
  expect(isStale(job({ id: 'old', startedAt: 0, endedAt: at - hour }), at)).toBe(true)
  const list = [job({ id: 'dev', taskId: 'b1' }), job({ id: 'gone', taskId: 'b2' }), job({ id: 'sub', taskId: 'b3', agentId: 'a1' })]
  expect(endGoneShells(list, new Set(['b1']), 5).map(j => j.endedAt)).toEqual([null, 5, null])
})

test('a background shell leaves the map once a Stop no longer lists it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: BACKGROUND }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Start the dev server', command: 'npm run dev' }] })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shellKey(ui)).toBeDefined()
  await ui.unmount()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shellKey(ui)).toBeUndefined()
  await ui.unmount()
})

test('a stop reads as refused, already ended, or done; a deny is always a refusal', () => {
  expect(stopOutcomeOf({ text: 'stopped' })).toEqual({ kind: 'stopped' })
  expect(stopOutcomeOf({ deny: 'The user declined' })).toEqual({ kind: 'refused', why: 'The user declined' })
  expect(stopOutcomeOf({ deny: 'No such task' })).toEqual({ kind: 'refused', why: 'No such task' })
  expect(stopOutcomeOf({ deny: '' })).toEqual({ kind: 'refused', why: 'refused' })
  expect(stopOutcomeOf({ isError: true, text: '<tool_use_error>Task b1 is not running (status: completed)</tool_use_error>' })).toEqual({ kind: 'gone' })
  expect(stopOutcomeOf({ isError: true, text: 'No task found with ID: b1' })).toEqual({ kind: 'gone' })
  expect(stopOutcomeOf({ isError: true, text: '<tool_use_error>kill failed: EPERM</tool_use_error>' })).toEqual({ kind: 'refused', why: 'kill failed: EPERM' })
  expect(stopOutcomeOf({ isError: true })).toEqual({ kind: 'refused', why: 'the tool reported an error' })
})

test('stopping a shell that had already ended takes it off the map and says so; so does Claude\'s own TaskStop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BACKGROUND, backgroundTaskId: `b${(n += 1)}` } }))
  on('tool.call', { tool: 'TaskStop' }, ($, e) => ({ isError: true as const, result: undefined, text: `<tool_use_error>Task ${e.task_id ?? ''} is not running (status: completed)</tool_use_error>` }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const key = String(await shellKey(ui))
  await ui.press({ key })
  const stopKey = `job-stop:${key.replace(/^node:self:/, '')}`
  await ui.press({ key: stopKey })
  await ui.press({ key: stopKey })
  await clock.settle()
  expect(await shellKey(ui)).toBeUndefined()
  expect(toasts).toContain('That shell had already ended.')
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'npm run watch', description: 'Watch the files', run_in_background: true })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b2' })
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shellKey(after)).toBeUndefined()
  await after.unmount()
})

test('a self-paced loop whose next run is not booked yet is not claimed stopped', async ($, on) => {
  const clock = mock.clock(on, { now: at(9, 0) })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const deleted: string[] = []
  on('tool.call', { tool: 'CronDelete' }, ($, e) => {
    deleted.push(e.id)
    return { result: { id: e.id } }
  })
  on('tool.call', { tool: 'ScheduleWakeup' }, () => ({ result: { scheduledFor: at(9, 20), clampedDelaySeconds: 1200, wasClamped: false } }))
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1200, reason: 'watching CI run', prompt: '/loop watch CI' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const loopKey = String((await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('node:self:loop:'))?.key)
  await ui.press({ key: loopKey })
  const stopKey = String((await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('loop-stop:'))?.key)
  await ui.press({ key: stopKey })
  await ui.press({ key: stopKey })
  await clock.settle()
  expect(deleted).toEqual([])
  expect(await ui.find({ key: loopKey })).toBeDefined()
  expect(toasts.some(t => /^Could not stop the loop yet/.test(t))).toBe(true)
  await ui.unmount()
})

test('recording mode hides a hidden word everywhere the pane draws it, toasts included', async ($, on) => {
  const clock = mock.clock(on, { now: at(9, 0) })
  mock.env(on, { HOME: '/Users/test', CLAUDE_MODS_RECORDING: '1', CLAUDE_MODS_RECORDING_TERMS: JSON.stringify(['falcon']) })
  host(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: BACKGROUND }))
  on('tool.call', { tool: 'TaskStop' }, () => ({ deny: 'falcon is protected' }))
  on('tool.call', { tool: 'ScheduleWakeup' }, () => ({ result: { scheduledFor: at(9, 20), clampedDelaySeconds: 1200, wasClamped: false } }))
  await $.session.start({ cwd: '/Users/test/falcon-site', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Serve falcon', run_in_background: true })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1200, reason: 'watching falcon deploy', prompt: '/loop watch falcon' })
  await $.classic.Stop({ stop_hook_active: false, session_crons: [{ id: 'w1', schedule: '20 9 12 10 *', recurring: false, prompt: '/loop watch falcon' }] })
  await clock.settle()

  const leaks = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<unknown>; findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }): Promise<string[]> => [
    ...((await ui.find({ type: 'Text', text: /falcon/i })) === undefined ? [] : ['a Text']),
    ...(await ui.findAll({ type: 'Button' })).map(b => String(b.props.label ?? '')).filter(l => /falcon/i.test(l)),
    ...(await ui.findAll({ type: 'Svg' })).map(x => String(x.props.source ?? '')).filter(x => /falcon/i.test(x)).map(() => 'the drawing'),
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await leaks(ui)).toEqual([])
    for (const prefix of ['node:self:loop:', 'node:self:job:', 'session:']) {
      const key = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).find(k => k.startsWith(prefix))
      if (key === undefined) continue
      await ui.press({ key })
      expect(await leaks(ui)).toEqual([])
      await ui.press({ key: 'peek-close' }).catch(() => undefined)
    }
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const key = String(await shellKey(ui))
  await ui.press({ key })
  const stopKey = `job-stop:${key.replace(/^node:self:/, '')}`
  await ui.press({ key: stopKey })
  await ui.press({ key: stopKey })
  await clock.settle()
  expect(toasts.some(t => t.startsWith('Could not stop the shell: [hidden] is protected'))).toBe(true)
  expect(toasts.some(t => /falcon/i.test(t))).toBe(false)
  await ui.unmount()
})

test('the pane opens itself beside a fullscreen transcript, once', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: true })
  for (let i = 0; i < 2; i += 1) {
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.unmount()
  }
  expect(opened).toEqual(['ringside'])
})

test('on the main screen (tmux\'s default) the pane does not open itself above the prompt', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: true })
  const band = await $.ui.mount({ ...BAND, viewport: { ...BAND.viewport, isFullscreen: false }, surface: 'terminal' })
  await band.unmount()
  expect(opened).toEqual([])
})

test('without AppleScript (Linux), Jump shows the pane in its tmux window, and says a new window needs macOS', async ($, on) => {
  const now = 3_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/home/test' })
  host(on, { process: false, mac: false })
  on('ui.toast', () => ({ value: undefined }))
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const [bin = '', verb = ''] = e.argv
    const stdout = bin !== 'tmux' ? '' : verb === '-V' ? 'tmux 3.4\n' : verb === 'list-panes' ? '/dev/pts/4\twork\t@1\t%3\n' : verb === 'list-clients' ? '/dev/pts/1\n' : ''
    return { value: { exitCode: bin === 'tmux' ? 0 : 128, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const rows = [
    session({ sessionId: 'self-id', isSelf: true, since: now - 1_000 }),
    session({ sessionId: 'a-id', name: 'alpha', cwd: '/home/test/alpha', tty: '/dev/pts/4', since: now - 60_000 }),
    session({ sessionId: 'bg-new', jobId: 'job-new', name: 'fresh audit', tty: null, pid: null, state: 'done', since: now - 60 * 60_000 }),
  ]
  on('state.get', { plugin: 'sessions', key: 'rows' } as never, () => ({ value: { value: rows, version: 1 } }))
  on('state.get', { plugin: 'sessions', key: 'hidden' } as never, () => ({ value: { value: [], version: 1 } }))
  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'session:a-id' })
  await ui.press({ key: 'jump:a-id' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^✓ Showed alpha's pane in its tmux window/ })).toBeDefined()
  expect(ran).toContainEqual(['tmux', 'select-pane', '-t', '%3'])
  expect(ran.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)

  await ui.press({ key: 'session:bg-new' })
  await ui.press({ key: 'jump:bg-new' })
  await clock.settle()
  const said = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).join(' ').replace(/\s+/g, ' ')
  expect(said).toMatch(/✗ Could not bring fresh audit forward: opening a new terminal window works on macOS only/)
  await ui.unmount()
})

test('[to prompt] puts its words in at the cursor and keeps what the person had typed', async ($, on) => {
  const clock = mock.clock(on, { now: 200_000 })
  mock.env(on, { HOME: '/Users/test' })
  host(on)
  on('session.messages', () => ({ value: [] }))
  const fills: { text: string; mode: string }[] = []
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/Users/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:launch' })
  await ui.press({ key: 'run:agent:Explore' })
  await ui.press({ key: 'launch-fill' })
  expect(fills).toEqual([{ text: 'Use the Explore agent to ', mode: 'insert' }])
  await ui.unmount()
})
