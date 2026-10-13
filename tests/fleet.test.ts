import { expect, test } from 'claude-code/testing'

import { adaptHidden, adaptSessionRows, groupOf, parsePs, rowsFromRegistry, shellQuote, tmuxPaneOn } from '../hooks/fleet'

test('ps output maps pids to terminals; no terminal reads as null', () => {
  const ps = parsePs('  101 ttys003\n  202 ??\n303 pts/4\n  garbage\n')
  expect(ps.get(101)).toBe('/dev/ttys003')
  expect(ps.get(202)).toBeNull()
  expect(ps.get(303)).toBe('/dev/pts/4')
  expect(ps.size).toBe(3)
})

test('the registry lists live sessions only, once each, with what a waiting one waits on', () => {
  const registry = [
    { pid: 101, sessionId: 's-wait', cwd: '/work/shop', status: 'waiting', waitingFor: 'approve Bash', statusUpdatedAt: 900 },
    { pid: 102, sessionId: 's-busy', cwd: '/work/blog', status: 'busy', name: 'blog writer', startedAt: 500 },
    { pid: 103, sessionId: 's-dead', cwd: '/work/old', status: 'idle' },
    { pid: 104, sessionId: 'me', cwd: '/work/here', status: 'busy' },
    { pid: 105, sessionId: 's-wait', cwd: '/work/shop', status: 'idle' },
    { sessionId: 'no-pid' },
  ]
  const ps = new Map<number, string | null>([[101, '/dev/ttys001'], [102, null], [104, '/dev/ttys009'], [105, '/dev/ttys002']])
  const rows = rowsFromRegistry(registry, ps, 'me', 1_000)
  expect(rows.map(r => r.sessionId)).toEqual(['s-wait', 's-busy', 'me'])
  expect(rows[0]).toMatchObject({ name: 'shop', group: 'needs', summary: 'approve Bash', since: 900, tty: '/dev/ttys001', isSelf: false, jobId: null })
  expect(rows[1]).toMatchObject({ name: 'blog writer', group: 'working', summary: '', since: 500, tty: null })
  expect(rows[2]?.isSelf).toBe(true)
  // Without `ps` nothing can be told apart from a crashed session's leftover file.
  expect(rowsFromRegistry(registry, null, 'me', 1_000)).toEqual([])
})

test('engine states group by what they ask of the person', () => {
  expect(['waiting', 'blocked', 'busy', 'working', 'idle', 'done', 'failed'].map(groupOf)).toEqual(['needs', 'needs', 'working', 'working', 'idle', 'idle', 'idle'])
})

test("the sessions mod's rows are taken only in the shape this mod knows", () => {
  expect(adaptSessionRows(undefined)).toEqual([])
  expect(adaptSessionRows({ rows: [] })).toEqual([])
  const rows = adaptSessionRows([
    { sessionId: 'a', name: 'api', cwd: '/w/api', pid: 7, tty: '/dev/ttys001', state: 'waiting', group: 'needs', since: 5, summary: 'approve Edit', isSelf: false, jobId: null, usage: { contextPercent: 40, costUsd: 1.5, at: 3 } },
    { sessionId: 'b', group: 'sleeping' },
    { group: 'idle' },
    'nonsense',
  ])
  expect(rows).toEqual([
    { sessionId: 'a', jobId: null, name: 'api', cwd: '/w/api', pid: 7, tty: '/dev/ttys001', state: 'waiting', group: 'needs', since: 5, summary: 'approve Edit', isSelf: false, usage: { contextPercent: 40, costUsd: 1.5 } },
  ])
  expect(adaptHidden(['a', 3, null, 'b'])).toEqual(['a', 'b'])
  expect(adaptHidden('a')).toEqual([])
})

test('the tmux pane on a terminal is found by its tty', () => {
  const out = '/dev/ttys001 main @1 %1\n/dev/ttys004 work @3 %7\n'
  expect(tmuxPaneOn(out, '/dev/ttys004')).toEqual({ session: 'work', windowId: '@3', paneId: '%7' })
  expect(tmuxPaneOn(out, '/dev/ttys099')).toBeNull()
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
})
