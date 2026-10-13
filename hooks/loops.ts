import type { Loop } from '../types'

// An ended loop stays listed this long, so you see it stopped.
export const LOOP_KEEP_MS = 10 * 60 * 1000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type Field = Set<number>
type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; isAnyDom: boolean; isAnyDow: boolean }

function parseField(text: string, min: number, max: number): Field | null {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = b !== undefined ? Number(b) : stepText !== undefined ? max : lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

// A five-field cron expression (minute hour day-of-month month day-of-week), local time.
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [mi = '', ho = '', dm = '', mo = '', dw = ''] = parts
  const minute = parseField(mi, 0, 59)
  const hour = parseField(ho, 0, 23)
  const dom = parseField(dm, 1, 31)
  const month = parseField(mo, 1, 12)
  const dowRaw = parseField(dw, 0, 7)
  if (minute === null || hour === null || dom === null || month === null || dowRaw === null) return null
  // 7 is Sunday too.
  const dow = new Set([...dowRaw].map(d => d % 7))
  return { minute, hour, dom, month, dow, isAnyDom: dm === '*', isAnyDow: dw === '*' }
}

function dayMatches(c: Cron, d: Date): boolean {
  const inDom = c.dom.has(d.getDate())
  const inDow = c.dow.has(d.getDay())
  // As cron reads it: both restricted, either one is enough.
  if (!c.isAnyDom && !c.isAnyDow) return inDom || inDow
  return inDom && inDow
}

// The first minute after `after` the expression matches, within a year; null if never.
export function nextFire(expr: string, after: number): number | null {
  const c = parseCron(expr)
  if (c === null) return null
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const end = after + 366 * DAY
  while (d.getTime() <= end) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else {
      return d.getTime()
    }
  }
  return null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

// Words for the common shapes; the expression itself otherwise.
export function humanCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [mi = '', ho = '', dm = '', mo = '', dw = ''] = parts
  const isNum = (s: string): boolean => /^\d+$/.test(s)
  const rest = `${dm} ${mo} ${dw}`
  let m = /^\*\/(\d+)$/.exec(mi)
  if (mi === '*' && ho === '*' && rest === '* * *') return 'Every minute'
  if (m !== null && ho === '*' && rest === '* * *') return `Every ${m[1]} minutes`
  m = /^\*\/(\d+)$/.exec(ho)
  if (isNum(mi) && m !== null && rest === '* * *') return `Every ${m[1]} hours`
  if (isNum(mi) && ho === '*' && rest === '* * *') return `Every hour at :${pad2(Number(mi))}`
  if (isNum(mi) && isNum(ho) && rest === '* * *') return `Daily at ${pad2(Number(ho))}:${pad2(Number(mi))}`
  if (isNum(mi) && isNum(ho) && dm === '*' && mo === '*' && dw === '1-5') return `Weekdays at ${pad2(Number(ho))}:${pad2(Number(mi))}`
  return expr
}

type Fields = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function blank(over: Partial<Loop> & { id: string; kind: Loop['kind'] }): Loop {
  return {
    schedule: '', every: '', prompt: '', recurring: true, startedAt: null, nextAt: null, lastFiredAt: null, fires: 0,
    delaySeconds: null, reason: '', wakeId: null, endedAt: null, ...over,
  }
}

const isActive = (l: Loop): boolean => l.endedAt === null

// A CronCreate call that went through: a loop with an interval, or a one-shot reminder.
export function addCron(list: readonly Loop[], input: Fields, result: Fields, now: number): Loop[] {
  const id = str(result.id)
  if (id === '') return [...list]
  const schedule = str(input.cron)
  const recurring = result.recurring !== false && input.recurring !== false
  const loop = blank({
    id, kind: 'cron', schedule, prompt: str(input.prompt), recurring, startedAt: now,
    every: recurring ? (str(result.humanSchedule) || humanCron(schedule)) : 'Once',
    nextAt: nextFire(schedule, now),
  })
  return [...list.filter(l => l.id !== id), loop]
}

// A ScheduleWakeup call: a self-paced loop booking its next turn, or ending.
export function addWakeup(list: readonly Loop[], input: Fields, result: Fields, now: number): Loop[] {
  if (input.stop === true || result.stopped === true) {
    return list.map(l => (l.kind === 'wakeup' && isActive(l) ? { ...l, endedAt: now, nextAt: null } : l))
  }
  const prompt = str(input.prompt)
  const delay = num(result.clampedDelaySeconds) ?? num(input.delaySeconds)
  const nextAt = num(result.scheduledFor) ?? (delay === null ? null : now + delay * 1000)
  const prior = list.find(l => l.kind === 'wakeup' && isActive(l) && l.prompt === prompt) ??
    list.find(l => l.kind === 'wakeup' && isActive(l))
  const loop: Loop = prior === undefined
    ? blank({ id: `wake-${now}`, kind: 'wakeup', every: 'Self-paced', prompt, startedAt: now, nextAt, delaySeconds: delay, reason: str(input.reason) })
    : { ...prior, prompt, nextAt, delaySeconds: delay, reason: str(input.reason) || prior.reason }
  return [...list.filter(l => l.id !== loop.id), loop]
}

// A CronDelete that went through, or a stop pressed in the pane.
export function endLoop(list: readonly Loop[], id: string, now: number): Loop[] {
  return list.map(l => ((l.id === id || l.wakeId === id) && isActive(l) ? { ...l, endedAt: now, nextAt: null } : l))
}

// The loop a scheduled prompt belongs to: by its prompt, else the only one due.
export function loopOfFire(list: readonly Loop[], text: string, now: number): Loop | undefined {
  const active = list.filter(isActive)
  const exact = active.find(l => l.prompt.trim() === text.trim())
  if (exact !== undefined) return exact
  const due = active.filter(l => l.nextAt !== null && Math.abs(l.nextAt - now) < 5 * MINUTE)
  if (due.length === 1) return due[0]
  return active.length === 1 ? active[0] : undefined
}

// A loop's prompt just ran: count it and work out the next run.
export function fired(list: readonly Loop[], text: string, now: number): Loop[] {
  const loop = loopOfFire(list, text, now)
  if (loop === undefined) return [...list]
  return list.map(l => {
    if (l.id !== loop.id) return l
    const counted = { ...l, fires: l.fires + 1, lastFiredAt: now }
    if (l.kind === 'wakeup') return { ...counted, nextAt: null, wakeId: null }
    if (!l.recurring) return { ...counted, nextAt: null, endedAt: now }
    return { ...counted, nextAt: nextFire(l.schedule, now) }
  })
}

export type CronSeen = { id: string; schedule: string; recurring: boolean; prompt: string }

// The engine's own list of what will wake this session, at the end of a turn:
// loops it no longer holds have ended; ones made before this mod saw them join.
export function reconcile(list: readonly Loop[], crons: readonly CronSeen[], now: number): Loop[] {
  const ids = new Set(crons.map(c => c.id))
  let next: Loop[] = list.map(l => {
    if (!isActive(l)) return l
    if (l.kind === 'cron') return ids.has(l.id) ? l : { ...l, endedAt: now, nextAt: null }
    const pending = crons.find(c => !c.recurring && (c.id === l.wakeId || c.prompt === l.prompt))
    if (pending === undefined) return { ...l, endedAt: now, nextAt: null }
    return { ...l, wakeId: pending.id, nextAt: l.nextAt ?? nextFire(pending.schedule, now) }
  })
  const known = new Set(next.flatMap(l => [l.id, l.wakeId ?? '']))
  for (const c of crons) {
    if (known.has(c.id)) continue
    next.push(blank({
      id: c.id, kind: 'cron', schedule: c.schedule, prompt: c.prompt, recurring: c.recurring,
      every: c.recurring ? humanCron(c.schedule) : 'Once', nextAt: nextFire(c.schedule, now),
    }))
  }
  next = next.map(l => (isActive(l) && l.kind === 'cron' && (l.nextAt === null || l.nextAt < now - 10 * MINUTE)
    ? { ...l, nextAt: nextFire(l.schedule, now) }
    : l))
  return pruneLoops(next, now)
}

export function pruneLoops(list: readonly Loop[], now: number): Loop[] {
  return list.filter(l => l.endedAt === null || now - l.endedAt < LOOP_KEEP_MS)
}

export function activeLoops(list: readonly Loop[]): Loop[] {
  return list.filter(isActive)
}
