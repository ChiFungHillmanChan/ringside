import { expect, test } from 'claude-code/testing'

import {
  adaptFlightAgents, adaptFlightLoops, adaptSavvy, asMapNode, autoZoom, buildMap, graphSvg, needsOf, plainStep, plainSummary, selfNodes, stateWord, stuckReason,
  STUCK_QUIET_MS, STUCK_STEP_MS,
} from '../hooks/map'
import type { FleetFile, MapNode, RowLike, SelfSession } from '../hooks/map'
import type { Job, Loop } from '../types'

const job = (over: Partial<Job>): Job => ({
  id: over.id ?? 'j', tool: 'Bash', detail: 'ls', startedAt: 0, endedAt: 1, isError: false, agentId: null, taskId: null, need: null, ...over,
})

test('says what a call does in plain words', () => {
  expect(plainStep('Read', 'agents.ts')).toBe('reading agents.ts')
  expect(plainStep('Grep', 'agent.list')).toBe('searching for agent.list')
  expect(plainStep('Edit', 'map.tsx')).toBe('editing map.tsx')
  expect(plainStep('Bash', 'npx vitest run')).toBe('running tests')
  expect(plainStep('Bash', 'npm test (background)')).toBe('running tests in the background')
  expect(plainStep('Bash', 'npx tsc -p .')).toBe('type-checking')
  expect(plainStep('Bash', 'pnpm install')).toBe('installing packages')
  expect(plainStep('Bash', 'git status --short')).toBe('git status --short')
  expect(plainStep('Bash', 'ls -la')).toBe('listing files')
  expect(plainStep('Bash', 'docker compose up -d')).toBe('running docker compose up -d')
  expect(plainStep('Bash', 'git ls-files | head -100 && grep -rniE "tax|total" --include=*.ts .')).toBe('listing files')
  expect(plainStep('Bash', 'cat -n src/pricing.ts && cat -n src/routes/cart.ts')).toBe('reading pricing.ts')
  expect(plainStep('Bash', "sed -n '1,40p' hooks/map.ts")).toBe('reading map.ts')
  expect(plainStep('Bash', 'grep -rn "coupon" src')).toBe('searching the code')
  expect(plainStep('Bash', 'rg verifyToken')).toBe('searching the code')
  expect(plainStep('Bash', 'cd /w/shop-api/src && cat -n pricing.ts')).toBe('reading pricing.ts')
  expect(plainStep('Bash', 'for f in README.md src/a.ts; do cat -n "$f"; done')).toBe('reading files')
  expect(plainStep('Bash', 'grep -rn "test" src')).toBe('searching the code')
  expect(plainStep('Bash', 'Rebuild the site (background)')).toBe('rebuild the site in the background')
  expect(plainStep('Bash', 'List files in the repo')).toBe('list files in the repo')
  expect(plainStep('WebFetch', 'github.com/a0s/agent-monitor')).toBe('reading github.com')
  expect(plainStep('AskUserQuestion', 'waiting for your answer')).toBe('asking you a question')
  expect(plainStep('hub', 'read')).toBe('hub (read)')
  expect(plainStep('step', 'savvy-progress')).toBe('reporting progress')
  expect(plainStep('SubagentHandback', 'The src directory has 2 files')).toBe('handing back its answer')
})

test('may be stuck: the same call failing three times, a quiet spell, one step running too long', () => {
  const now = 100 * 60_000
  const fail = (i: number) => job({ id: `f${i}`, detail: 'pnpm install', isError: true, startedAt: now - 1000 * (10 - i), endedAt: now - 1000 * (9 - i) })
  expect(stuckReason([fail(1), fail(2), fail(3)], true, now)).toBe('the same Bash failed 3 times in a row: pnpm install')
  expect(stuckReason([fail(1), fail(2)], true, now)).toBe('')
  expect(stuckReason([fail(1), fail(2), fail(3)], false, now)).toBe('')
  // A different call in between resets the count.
  expect(stuckReason([fail(1), job({ id: 'ok', startedAt: now - 3000, endedAt: now - 2500 }), fail(3)], true, now)).toBe('')
  const quiet = job({ startedAt: now - STUCK_QUIET_MS - 5000, endedAt: now - STUCK_QUIET_MS - 1000 })
  expect(stuckReason([quiet], true, now)).toBe('no new step for 10m')
  const long = job({ detail: 'npm run e2e', startedAt: now - STUCK_STEP_MS - 60_000, endedAt: null })
  expect(stuckReason([long], true, now)).toBe('one step has run for 21m: Bash npm run e2e')
  // Background shells, waits on the person and subagents run long on purpose.
  expect(stuckReason([{ ...long, taskId: 'b1' }], true, now)).toBe('')
  expect(stuckReason([{ ...long, need: { kind: 'question', text: 'Pick one' } }], true, now)).toBe('')
  expect(stuckReason([{ ...long, tool: 'Agent' }], true, now)).toBe('')
})

test('reads savvy-progress and flightdeck state only when it has the shape we know', () => {
  expect(adaptSavvy(undefined)).toEqual([])
  expect(adaptSavvy({ agents: [] })).toEqual([])
  expect(adaptSavvy([null, 3, { nothing: true }, { agentId: 'a1', description: 'find data', stepDone: 2, stepTotal: 5, stepNote: 'reading', costUsd: 0.12 }])).toEqual([
    { agentId: 'a1', description: 'find data', done: 2, total: 5, note: 'reading', costUsd: 0.12 },
  ])
  expect(adaptFlightAgents([{ id: 'a1', ctx: 12400 }, { ctx: 3 }])).toEqual([{ id: 'a1', tokens: 12400 }])
  expect(adaptFlightLoops([{ id: 'w1', steps: 4, firstAt: 1, lastAt: 2, isDone: false }, { id: 'bad' }])).toEqual([
    { id: 'w1', steps: 4, firstAt: 1, lastAt: 2, isDone: false },
  ])
})

test("this session's nodes: subagents with their step, waits and progress; background shells; loops; workflow agents", () => {
  const now = 1_000_000
  const jobs: Job[] = [
    job({ id: 'r1', tool: 'Read', detail: 'agents.ts', agentId: 'a1', startedAt: now - 5000, endedAt: null }),
    job({ id: 'q1', tool: 'AskUserQuestion', detail: 'waiting for your answer', agentId: 'a2', startedAt: now - 4000, endedAt: null, need: { kind: 'question', text: 'Which repo?' } }),
    job({ id: 'b1', tool: 'Bash', detail: 'npm test --watch (background)', taskId: 't1', startedAt: now - 60_000, endedAt: null }),
  ]
  const loops: Loop[] = [{
    id: 'c1', kind: 'cron', schedule: '*/7 * * * *', every: 'Every 7 minutes', prompt: 'check CI', recurring: true, startedAt: now - 600_000,
    nextAt: now + 180_000, lastFiredAt: null, fires: 0, delaySeconds: null, reason: '', wakeId: null, endedAt: null,
  }]
  const nodes = selfNodes({
    agents: [
      { id: 'a1', type: 'Explore', purpose: 'find data', status: 'running', isLive: true, from: now - 63_000, to: null, step: '', result: '' },
      { id: 'a2', type: 'general-purpose', purpose: 'research', status: 'running', isLive: true, from: now - 90_000, to: null, step: '', result: '' },
      { id: 'a3', type: 'Plan', purpose: 'layout', status: 'completed', isLive: false, from: now - 400_000, to: now - 200_000, step: '', result: 'Three zoom levels.' },
    ],
    jobs, loops,
    savvy: [{ agentId: '', description: 'find data', done: 2, total: 5, note: 'reading', costUsd: 0.04 }],
    flightAgents: [{ id: 'a1', tokens: 12400 }],
    flightLoops: [{ id: 'w1', steps: 3, firstAt: now - 30_000, lastAt: now - 1000, isDone: false }],
    now,
  })
  expect(nodes.map(n => [n.id, n.kind, n.status])).toEqual([
    ['a1', 'agent', 'running'], ['a2', 'agent', 'waiting'], ['a3', 'agent', 'done'], ['job:b1', 'job', 'running'], ['loop:c1', 'loop', 'idle'], ['workflow:w1', 'workflow', 'running'],
  ])
  const [a1, a2, a3, b1, c1] = nodes
  expect(a1?.now).toBe('reading agents.ts')
  expect(a1?.progress).toEqual({ done: 2, total: 5, note: 'reading' })
  expect(a1?.tokens).toBe(12400)
  expect(a2?.why).toBe('Which repo?')
  expect(a3?.why).toBe('Three zoom levels.')
  expect(b1?.title).toBe('shell · npm test --watch')
  expect(c1?.now).toBe('next run in 3m')
})

const node = (over: Partial<MapNode>): MapNode => ({
  id: 'n', kind: 'agent', title: 'Explore · x', status: 'running', now: '', raw: '', why: '', from: 0, to: null, progress: null, costUsd: null, tokens: null, ...over,
})

test('the map: this session first, then by what each asks of the person; files win over the sessions list', () => {
  const now = 10_000_000
  const self: SelfSession = { sessionId: 'me', name: 'mods', cwd: '/r/mods', branch: 'main', status: 'running', doing: 'editing map.tsx', why: '', since: now - 250_000, nodes: [node({ id: 'a1' })] }
  const files: FleetFile[] = [
    { sessionId: 'bug', name: 'bug-tracker', cwd: '/r/bug-tracker', branch: 'feat', state: 'needs', doing: 'approve Bash', stuck: '', heartbeatAt: now - 5000, nodes: [node({ id: 't1' })] },
    { sessionId: 'old', name: 'gone', cwd: '/r/gone', branch: 'main', state: 'working', doing: '', stuck: '', heartbeatAt: now - 10 * 60_000, nodes: [] },
    { sessionId: 'deps', name: 'deps', cwd: '/r/deps', branch: 'chore', state: 'working', doing: 'pnpm install', stuck: 'the same Bash failed 4 times in a row', heartbeatAt: now - 3000, nodes: [] },
  ]
  const rows: RowLike[] = [
    { sessionId: 'me', name: 'mods', cwd: '/r/mods', group: 'working', state: 'busy', since: now, summary: '', isSelf: true, usage: { contextPercent: 41, costUsd: 2.5 } },
    { sessionId: 'bug', name: 'bug-tracker', cwd: '/r/bug-tracker', group: 'needs', state: 'waiting', since: now - 134_000, summary: 'approve Bash', isSelf: false, usage: null },
    { sessionId: 'web', name: 'docs-web', cwd: '/r/web', group: 'idle', state: 'idle', since: now - 720_000, summary: '', isSelf: false, usage: null },
    { sessionId: 'hid', name: 'hidden one', cwd: '/r/h', group: 'needs', state: 'waiting', since: now, summary: 'x', isSelf: false, usage: null },
  ]
  const map = buildMap(self, files, rows, ['hid'], now, 5 * 60_000)
  expect(map.map(s => [s.sessionId, s.status, s.hasMap])).toEqual([
    ['me', 'running', true], ['bug', 'waiting', true], ['deps', 'stuck', true], ['web', 'idle', false],
  ])
  expect(map[0]?.contextPercent).toBe(41)
  expect(map[1]?.name).toBe('bug-tracker')
  expect(map[1]?.nodes.map(n => n.id)).toEqual(['t1'])
  expect(map[2]?.why).toBe('the same Bash failed 4 times in a row')
})

test('needs across the map: waits before what may be stuck, oldest first', () => {
  const map = buildMap(
    { sessionId: 'me', name: 'mods', cwd: '/m', branch: 'main', status: 'running', doing: '', why: '', since: 0, nodes: [node({ id: 'a2', title: 'general-purpose · research', status: 'waiting', why: 'approve WebFetch', from: 50 })] },
    [{ sessionId: 's4', name: 'deps', cwd: '/d', branch: '', state: 'working', doing: '', stuck: 'failed 4 times', heartbeatAt: 100, nodes: [] }],
    [{ sessionId: 's2', name: 'bug-tracker', cwd: '/b', group: 'needs', state: 'waiting', since: 10, summary: 'approve Bash', isSelf: false, usage: null }],
    [], 100, 60_000)
  expect(needsOf(map).map(n => [n.where, n.kind, n.why])).toEqual([
    ['bug-tracker', 'wait', 'approve Bash'], ['general-purpose', 'wait', 'approve WebFetch'], ['deps', 'stuck', 'failed 4 times'],
  ])
})

test('reads a node off another session\'s file, refusing what is not one', () => {
  expect(asMapNode({ id: 'x', kind: 'agent', status: 'running', title: 'Explore · y', from: 5, progress: { done: 1, total: 3, note: '' } })?.progress).toEqual({ done: 1, total: 3, note: '' })
  expect(asMapNode({ id: 'x', kind: 'robot', status: 'running' })).toBe(null)
  expect(asMapNode({ id: '', kind: 'agent', status: 'running' })).toBe(null)
  expect(asMapNode('nope')).toBe(null)
})

test('picks the densest zoom that still fits the pane', () => {
  const map = buildMap({ sessionId: 'me', name: 'm', cwd: '/', branch: '', status: 'idle', doing: '', why: '', since: 0, nodes: [node({}), node({ id: 'b' })] }, [], [], [], 0, 1)
  expect(autoZoom(map, 0, 40)).toBe('cards')
  expect(autoZoom(map, 0, 12)).toBe('lines')
  expect(autoZoom(map, 0, 9)).toBe('dots')
})

test('the desktop drawing keeps every label inside its box and clear of its clock', () => {
  const now = 1_000_000
  const map = buildMap(
    { sessionId: 'me', name: 'a-session-with-a-very-long-name-indeed', cwd: '/', branch: 'main', status: 'running', doing: 'editing a file with a long path', why: '', since: now - 3_600_000, nodes: [node({ title: 'general-purpose · 研究一個好長好長好長好長嘅題目', from: now - 4_000_000 })] },
    [], [], [], now, 1)
  const svg = graphSvg(map, now)
  expect(svg.source.startsWith('<svg')).toBe(true)
  expect(svg.source.includes('…')).toBe(true)
  // The cut leaves the clock its own room on the first line.
  expect(svg.source.includes('1h00m')).toBe(true)
  expect(svg.source.includes('<script')).toBe(false)
  expect(graphSvg(map, now).source.includes('&lt;')).toBe(false)
})

test('the desktop drawing takes the pane width it is given, and a progress bar sits below the text', () => {
  const now = 1_000_000
  const map = buildMap(
    { sessionId: 'me', name: 'shop-api', cwd: '/', branch: 'main', status: 'running', doing: 'working', why: '', since: now - 20_000, nodes: [node({ progress: { done: 2, total: 4, note: '' } })] },
    [], [], [], now, 1)
  expect(graphSvg(map, now, 600).width).toBe(600)
  expect(graphSvg(map, now, 200).width).toBe(380)
  expect(graphSvg(map, now, 2000).width).toBe(760)
  const source = graphSvg(map, now, 600).source
  // The node box is 46 tall when it carries a bar; the second line's baseline is 32 down, the bar 39 down.
  const box = /<rect x="([\d.]+)" y="([\d.]+)" width="[\d.]+" height="46"/.exec(source)
  expect(box).not.toBeNull()
  const top = Number(box?.[2])
  const bar = new RegExp(`<rect x="[\\d.]+" y="${top + 39}" width="[\\d.]+" height="3"`).exec(source)
  expect(bar).not.toBeNull()
})

test('a wait the sessions mod has held for over a day is old news: idle, not a need', () => {
  const now = 100 * 24 * 60 * 60 * 1000
  const map = buildMap(
    { sessionId: 'me', name: 'm', cwd: '/', branch: '', status: 'idle', doing: '', why: '', since: now, nodes: [] }, [],
    [
      { sessionId: 'old', name: 'audit', cwd: '/a', group: 'needs', state: 'blocked', since: now - 98 * 24 * 60 * 60 * 1000, summary: 'start the P0 fixes?', isSelf: false, usage: null },
      { sessionId: 'new', name: 'blog', cwd: '/b', group: 'needs', state: 'waiting', since: now - 60_000, summary: 'approve Bash', isSelf: false, usage: null },
    ], [], now, 60_000)
  expect(map.map(s => [s.sessionId, s.status])).toEqual([['me', 'idle'], ['new', 'waiting'], ['old', 'idle']])
  expect(map[2]?.doing).toBe('start the P0 fixes? (old)')
  expect(needsOf(map).map(n => n.where)).toEqual(['blog'])
})

test("the engine's words for a session's state read as plain words; unknown words pass through", () => {
  expect(['busy', 'waiting', 'blocked', 'idle', 'done', 'paused'].map(stateWord)).toEqual(['working', 'waiting for you', 'blocked', 'idle', 'finished', 'paused'])
})

test("a session list's tool lines read in plain words; other text stays as it is", () => {
  expect(plainSummary('Read: hero-en.webp')).toBe('reading hero-en.webp')
  expect(plainSummary('Bash: Wait for the CI run to finish')).toBe('wait for the CI run to finish')
  expect(plainSummary('TaskUpdate')).toBe('updating its task list')
  expect(plainSummary('Agent: Explore: find the auth flow')).toBe('starting Explore: find the auth flow')
  expect(plainSummary('Note: the build is green')).toBe('Note: the build is green')
  expect(plainSummary('Which color theme should the blog use?')).toBe('Which color theme should the blog use?')
})
