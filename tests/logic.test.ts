import { expect, test } from 'claude-code/testing'

import { agentFromMarkdown, catalogSections, dotColor, filterCatalog, mergeOffer, pruneCards, roleOf, skillsFrom } from '../hooks/agents'
import { bareMembers, readHub, resolveRecipient, unread } from '../hooks/hub'
import type { HubFile } from '../hooks/hub'
import { addCron, addWakeup, endLoop, fired, humanCron, nextFire, reconcile } from '../hooks/loops'
import { loopLines, wrap } from '../hooks/register'
import type { AgentCard, CatalogEntry, HubMessage } from '../types'

// Local wall-clock times, so the tests hold in any time zone.
const at = (h: number, m: number, s = 0): number => new Date(2026, 9, 12, h, m, s).getTime()

test('works out the next run of a cron expression in local time', () => {
  expect(nextFire('*/5 * * * *', at(14, 2, 30))).toBe(at(14, 5))
  expect(nextFire('*/5 * * * *', at(14, 5))).toBe(at(14, 10))
  expect(nextFire('0 * * * *', at(14, 2))).toBe(at(15, 0))
  expect(nextFire('30 9 * * *', at(14, 2))).toBe(new Date(2026, 9, 13, 9, 30).getTime())
  // 12 Oct 2026 is a Monday: the next Saturday is the 17th.
  expect(nextFire('0 10 * * 6', at(14, 2))).toBe(new Date(2026, 9, 17, 10, 0).getTime())
  expect(nextFire('not a cron', at(14, 2))).toBeNull()
  expect(nextFire('0 0 31 2 *', at(14, 2))).toBeNull()
})

test('names the common schedules in words', () => {
  expect(humanCron('*/5 * * * *')).toBe('Every 5 minutes')
  expect(humanCron('* * * * *')).toBe('Every minute')
  expect(humanCron('0 */2 * * *')).toBe('Every 2 hours')
  expect(humanCron('15 * * * *')).toBe('Every hour at :15')
  expect(humanCron('0 9 * * *')).toBe('Daily at 09:00')
  expect(humanCron('0 9 * * 1-5')).toBe('Weekdays at 09:00')
  expect(humanCron('0 9 1 * *')).toBe('0 9 1 * *')
})

test('a cron loop: made, run, its next run worked out, deleted', () => {
  let loops = addCron([], { cron: '*/5 * * * *', prompt: '/babysit-prs', recurring: true }, { id: 'c1', humanSchedule: 'Every 5 minutes', recurring: true }, at(14, 2, 30))
  expect(loops[0]).toMatchObject({ id: 'c1', kind: 'cron', every: 'Every 5 minutes', startedAt: at(14, 2, 30), nextAt: at(14, 5), fires: 0 })
  loops = fired(loops, '/babysit-prs', at(14, 5, 8))
  expect(loops[0]).toMatchObject({ fires: 1, lastFiredAt: at(14, 5, 8), nextAt: at(14, 10), endedAt: null })
  loops = endLoop(loops, 'c1', at(14, 6))
  expect(loops[0]).toMatchObject({ endedAt: at(14, 6), nextAt: null })
  // A one-shot reminder ends when it runs.
  const once = fired(addCron([], { cron: '30 15 12 10 *', prompt: 'call Sam', recurring: false }, { id: 'r1', humanSchedule: 'Once', recurring: false }, at(14, 0)), 'call Sam', at(15, 30))
  expect(once[0]).toMatchObject({ every: 'Once', fires: 1, endedAt: at(15, 30) })
})

test('a self-paced loop: each wakeup books the next run; the Stop list keeps or ends it', () => {
  let loops = addWakeup([], { delaySeconds: 1200, reason: 'watching CI', prompt: '/loop check CI' }, { scheduledFor: at(14, 22), clampedDelaySeconds: 1200 }, at(14, 2))
  expect(loops[0]).toMatchObject({ kind: 'wakeup', every: 'Self-paced', nextAt: at(14, 22), delaySeconds: 1200, reason: 'watching CI', startedAt: at(14, 2) })
  const id = loops[0]?.id ?? ''
  // The engine lists the pending wakeup as a one-shot cron: its id is kept, to stop it.
  loops = reconcile(loops, [{ id: 'w1', schedule: '22 14 12 10 *', recurring: false, prompt: '/loop check CI' }], at(14, 3))
  expect(loops[0]).toMatchObject({ id, wakeId: 'w1', endedAt: null })
  loops = fired(loops, '/loop check CI', at(14, 22, 5))
  expect(loops[0]).toMatchObject({ fires: 1, nextAt: null, wakeId: null })
  loops = addWakeup(loops, { delaySeconds: 600, reason: 'still red', prompt: '/loop check CI' }, { scheduledFor: at(14, 33), clampedDelaySeconds: 600 }, at(14, 23))
  expect(loops).toHaveLength(1)
  expect(loops[0]).toMatchObject({ id, nextAt: at(14, 33), delaySeconds: 600, reason: 'still red', fires: 1 })
  // The turn ended with no wakeup booked: the loop is over.
  loops = reconcile(loops, [], at(14, 24))
  expect(loops[0]?.endedAt).toBe(at(14, 24))
  // stop: true ends it at once.
  const stopped = addWakeup(addWakeup([], { delaySeconds: 60, prompt: 'p' }, { scheduledFor: at(14, 3) }, at(14, 2)), { stop: true }, { stopped: true }, at(14, 2, 30))
  expect(stopped[0]?.endedAt).toBe(at(14, 2, 30))
})

test('the Stop list ends deleted crons and adds ones made before this mod saw them', () => {
  const loops = addCron([], { cron: '*/5 * * * *', prompt: 'a' }, { id: 'c1', humanSchedule: 'Every 5 minutes' }, at(14, 0))
  const next = reconcile(loops, [{ id: 'c2', schedule: '0 * * * *', recurring: true, prompt: 'hourly sweep' }], at(14, 1))
  expect(next.map(l => [l.id, l.endedAt === null])).toEqual([['c1', false], ['c2', true]])
  expect(next[1]).toMatchObject({ every: 'Every hour at :00', startedAt: null, nextAt: at(15, 0) })
  // Ten minutes after it ended, an ended loop is no longer listed.
  expect(reconcile(next, [{ id: 'c2', schedule: '0 * * * *', recurring: true, prompt: 'hourly sweep' }], at(14, 12)).map(l => l.id)).toEqual(['c2'])
})

test('a loop reads in two lines', () => {
  const [loop] = addCron([], { cron: '*/5 * * * *', prompt: 'x' }, { id: 'c1', humanSchedule: 'Every 5 minutes' }, at(14, 2, 30))
  if (loop === undefined) throw new Error('no loop')
  expect(loopLines(loop, at(14, 25), false)).toEqual({
    head: 'Every 5 minutes · since 14:02 (23m)',
    detail: 'due now (runs when Claude is idle) · not run yet',
  })
  const ran = fired([loop], 'x', at(14, 25, 3))[0]
  if (ran === undefined) throw new Error('no loop')
  expect(loopLines(ran, at(14, 27), false).detail).toBe('next 14:30 (in 3m) · ran 1× · last 14:25')
})

const msg = (over: Partial<HubMessage> & { id: string; at: number }): HubMessage => ({
  fromId: 'peer', fromName: 'api-fix', by: 'person', to: 'all', text: 'hi', ...over,
})

const board = (over: Partial<HubFile> & { sessionId: string }): HubFile => ({
  v: 1, name: over.sessionId, root: '/r', cwd: '/r', branch: 'main', state: 'idle', doing: '', loops: 0, nextLoopAt: null, agents: 0,
  heartbeatAt: 0, ended: false, seenAt: 0, messages: [], ...over,
})

test('the board: live members only, messages for this session, oldest first', () => {
  const now = 10_000_000
  const files = [
    board({ sessionId: 'me', heartbeatAt: now, messages: [msg({ id: 'm3', at: now - 1_000, fromId: 'me', fromName: 'me', text: 'ok' })] }),
    board({ sessionId: 'peer', name: 'api-fix', state: 'working', heartbeatAt: now - 60_000, messages: [
      msg({ id: 'm1', at: now - 5_000, text: 'to all' }),
      msg({ id: 'm2', at: now - 4_000, to: 'third', text: 'not for me' }),
      msg({ id: 'm4', at: now - 3_000, to: 'me', text: 'for me' }),
    ] }),
    board({ sessionId: 'stale', heartbeatAt: now - 6 * 60_000 }),
    board({ sessionId: 'ended', heartbeatAt: now, ended: true }),
  ]
  const hub = readHub(files, 'me', now)
  expect(hub.members.map(m => [m.sessionId, m.isSelf])).toEqual([['me', true], ['peer', false]])
  expect(hub.messages.map(m => m.text)).toEqual(['to all', 'for me', 'ok'])
  expect(unread(hub.messages, 'me', now - 4_500).map(m => m.text)).toEqual(['for me'])
  expect(resolveRecipient('API-FIX', hub.members)).toBe('peer')
  expect(resolveRecipient('', hub.members)).toBe('all')
  expect(resolveRecipient('nobody', hub.members)).toBeNull()
})

test('sessions the sessions mod sees in this repo, without a board file, still show', () => {
  const rows = [
    { sessionId: 'a', name: 'web', cwd: '/r/web', group: 'needs', summary: 'approve Bash', state: 'waiting', since: 5, isSelf: false },
    { sessionId: 'b', name: 'other', cwd: '/elsewhere', group: 'idle', summary: '', state: 'idle', since: 5, isSelf: false },
    { sessionId: 'c', name: 'rx', cwd: '/rx', group: 'idle', summary: '', state: 'idle', since: 5, isSelf: false },
    { sessionId: 'd', name: 'on board', cwd: '/r', group: 'idle', summary: '', state: 'idle', since: 5, isSelf: false },
  ]
  const bare = bareMembers(rows, '/r', new Set(['d']))
  expect(bare.map(m => [m.name, m.state, m.isBare])).toEqual([['web', 'needs', true]])
})

test('the launcher lists skills, not built-in commands or its own, and filters by name first', () => {
  const skills = skillsFrom([
    { name: 'ship-it', description: 'Ship it.', source: 'user' },
    { name: 'superpowers:brainstorming', description: 'Explore intent.', source: 'plugin', plugin: 'superpowers' },
    { name: 'agent-map', description: 'This pane.', source: 'plugin', plugin: 'agent-map' },
    { name: 'clear', description: 'Clear the chat.', source: 'builtin' },
    { name: 'simplify', description: 'Simplify the diff.', source: 'builtin' },
  ], 'agent-map')
  expect(skills.map(s => s.name)).toEqual(['ship-it', 'superpowers:brainstorming', 'simplify'])
  const list: CatalogEntry[] = [
    ...skills,
    { kind: 'agent', name: 'Plan', description: 'Plans.', source: 'built-in' },
    { kind: 'agent', name: 'Explore', description: 'Search the code to plan.', source: 'built-in' },
  ]
  expect(filterCatalog(list, 'agent', 'pl').map(c => c.name)).toEqual(['Plan', 'Explore'])
  expect(filterCatalog(list, 'skill', '').map(c => c.name)).toEqual(['ship-it', 'simplify', 'superpowers:brainstorming'])
})

test('reads an agent file and the role a type plays', () => {
  const md = '---\nname: reviewer\ndescription: "Reviews diffs for bugs. Use after edits."\ntools: Read\n---\nYou review.'
  expect(agentFromMarkdown(md, 'x', 'userSettings')).toEqual({ kind: 'agent', name: 'reviewer', description: 'Reviews diffs for bugs. Use after edits.', source: 'userSettings' })
  expect(agentFromMarkdown('no frontmatter', 'x', 'u')).toBeNull()
  expect(roleOf('Fast read-only search agent for locating code. Use it to find files.')).toBe('Fast read-only search agent for locating code.')
})

test('keeps a card while its agent is listed, then while it ended recently', () => {
  const card = (over: Partial<AgentCard> & { id: string }): AgentCard => ({
    type: 'Explore', name: '', purpose: '', task: '', role: '', calledBy: 'Claude', model: '', isBackground: false, startedAt: 0, calls: 0,
    lastStep: '', result: '', endedAt: null, ...over,
  })
  const cards = [card({ id: 'listed' }), card({ id: 'new', startedAt: 90_000 }), card({ id: 'lost', startedAt: 0 }), card({ id: 'done', endedAt: 50_000 })]
  expect(pruneCards(cards, new Set(['listed']), 100_000, 60_000).map(c => c.id)).toEqual(['listed', 'new', 'done'])
})

test('wraps text over lines at spaces, cutting the last', () => {
  expect(wrap('Find where the session token is validated', 20, 2)).toEqual(['Find where the', 'session token is va…'])
  expect(wrap('short', 20, 2)).toEqual(['short'])
  expect(wrap('一二三四五六七八九十', 8, 2)).toEqual(['一二三四', '五六七…'])
})

test('an agent file names its model and colour; the launcher groups types by where they come from', () => {
  const md = '---\nname: perf-profiler\ndescription: Looks for the slow parts.\nmodel: claude-sonnet-5-5\ncolor: Orange\n---\nYou profile.'
  const file = agentFromMarkdown(md, 'x', 'projectSettings')
  expect(file).toEqual({ kind: 'agent', name: 'perf-profiler', description: 'Looks for the slow parts.', source: 'projectSettings', model: 'sonnet', color: 'orange' })
  expect(agentFromMarkdown('---\nname: a\nmodel: inherit\n---\n', 'x', 'u')).toEqual({ kind: 'agent', name: 'a', description: '', source: 'u' })
  // The engine's offer carries neither: what the file said stays.
  const merged = mergeOffer([file as CatalogEntry], { agent: 'perf-profiler', description: 'Looks for the slow parts.', source: 'projectSettings' })
  expect(merged[0]?.model).toBe('sonnet')
  expect(dotColor(file as CatalogEntry)).toBe('#d7875f')
  expect(dotColor({ kind: 'agent', name: 'x', description: '', source: 'u' })).toMatch(/^#[0-9a-f]{6}$/)
  const list: CatalogEntry[] = [
    { kind: 'agent', name: 'Explore', description: '', source: 'built-in' },
    { kind: 'agent', name: 'mine', description: '', source: 'userSettings' },
    { kind: 'agent', name: 'odd', description: '', source: 'flagSettings' },
    { kind: 'agent', name: 'savvy:careful', description: '', source: 'plugin' },
    { kind: 'agent', name: 'perf-profiler', description: '', source: 'projectSettings' },
  ]
  expect(catalogSections(list).map(s => [s.label, s.entries.map(e => e.name)])).toEqual([
    ['PROJECT', ['perf-profiler']], ['YOURS', ['mine']], ['PLUGINS', ['savvy:careful']], ['BUILT-IN', ['Explore']], ['OTHER', ['odd']],
  ])
})
