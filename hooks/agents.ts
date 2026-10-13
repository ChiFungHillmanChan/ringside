import type { AgentCard, CatalogEntry } from '../types'

const MAX_CARDS = 40
const TASK_CHARS = 400
const RESULT_CHARS = 4000

type Fields = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// The first sentence of a description, which is what the type is for.
export function roleOf(description: string): string {
  const flat = oneLine(description)
  const end = flat.search(/[.!?。](\s|$)/)
  return end < 0 ? flat : flat.slice(0, end + 1)
}

export function roleFor(catalog: readonly CatalogEntry[], type: string, name: string): string {
  const entry = catalog.find(c => c.kind === 'agent' && c.name === type)
  if (entry !== undefined) return roleOf(entry.description)
  if (type === 'teammate' || type === '') return name === '' ? 'Teammate' : `Teammate "${name}"`
  if (type === 'fork') return 'A fork of this conversation, with its full context.'
  return ''
}

// Who a spawn came from, in the words the pane shows.
export function callerOf(input: Fields, cards: readonly AgentCard[], plugin: string | undefined): string {
  if (input.workflow !== undefined) return 'workflow'
  const parent = str(input.parentAgentId)
  if (parent !== '') {
    const p = cards.find(c => c.id === parent)
    return p === undefined ? 'a subagent' : `${p.type} agent`
  }
  if (plugin !== undefined && plugin !== '') return plugin
  return 'Claude'
}

// The agent type a spawn names: the engine's word, or the Agent tool's.
export function typeOf(input: Fields): string {
  return str(input.subagentType) || str(input.subagent_type)
}

// A launch whose spawn answered no id yet: its card waits under this one until the agent is listed.
export const PENDING_ID = 'launch-'

export function newCard(input: Fields, result: Fields, calledBy: string, role: string, now: number): AgentCard | null {
  const id = str(result.agentId)
  if (id === '') return null
  return {
    id,
    type: typeOf(input) || 'agent',
    name: str(input.name),
    purpose: oneLine(str(input.description)),
    task: oneLine(str(input.prompt)).slice(0, TASK_CHARS),
    role,
    calledBy,
    model: shortModel(str(result.model) || str(input.model)),
    isBackground: input.background === true || input.run_in_background === true,
    startedAt: now,
    calls: 0,
    lastStep: '',
    result: '',
    endedAt: null,
  }
}

export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model)
  return m?.[1]?.toLowerCase() ?? model
}

export function addCard(cards: readonly AgentCard[], card: AgentCard): AgentCard[] {
  return [...cards.filter(c => c.id !== card.id), card].slice(-MAX_CARDS)
}

// A launched card still under its pending id takes the id of the agent the engine now lists for it.
export function adoptCards(cards: readonly AgentCard[], rows: readonly { id: string; label: string }[]): AgentCard[] {
  const owned = new Set(cards.map(c => c.id))
  return cards.map(c => {
    if (!c.id.startsWith(PENDING_ID)) return c
    const row = rows.find(r => !owned.has(r.id) && r.label === `${c.type}: ${c.purpose}`)
    if (row === undefined) return c
    owned.add(row.id)
    return { ...c, id: row.id }
  })
}

export function noteStep(cards: readonly AgentCard[], agentId: string, step: string): AgentCard[] {
  return cards.map(c => (c.id === agentId ? { ...c, calls: c.calls + 1, lastStep: step } : c))
}

export function finishCard(cards: readonly AgentCard[], agentId: string, answer: string, now: number): AgentCard[] {
  return cards.map(c => (c.id === agentId
    ? { ...c, result: oneLine(answer).slice(0, RESULT_CHARS), endedAt: c.endedAt ?? now }
    : c))
}

// A card stays while the engine lists its agent; after that, until it has been
// ended for keepMs (or a minute, for one the engine never listed nor ended).
export function pruneCards(cards: readonly AgentCard[], listedIds: ReadonlySet<string>, now: number, keepMs: number): AgentCard[] {
  return cards.filter(c => listedIds.has(c.id) || (c.endedAt === null ? now - c.startedAt < 60_000 : now - c.endedAt < keepMs))
}

// Built-in skills worth a click; the rest of the built-ins are commands (/clear, /model).
const BUILTIN_SKILLS = new Set([
  'simplify', 'code-review', 'security-review', 'init', 'loop', 'schedule', 'batch', 'debug', 'verify',
  'deep-research', 'dataviz', 'fewer-permission-prompts', 'review',
])

type CommandLike = { name: string; description: string; source: string; plugin?: string }

export function skillsFrom(commands: readonly CommandLike[], self: string): CatalogEntry[] {
  return commands
    .filter(c => c.source === 'user' || (c.source === 'plugin' && c.plugin !== self) || (c.source === 'builtin' && BUILTIN_SKILLS.has(c.name)))
    .map(c => ({ kind: 'skill' as const, name: c.name, description: oneLine(c.description), source: c.plugin ?? c.source }))
}

// One agent type the engine offered the model: added or refreshed.
export function mergeOffer(list: readonly CatalogEntry[], offer: { agent: string; description: string; source: string }): CatalogEntry[] {
  const entry: CatalogEntry = { kind: 'agent', name: offer.agent, description: oneLine(offer.description), source: offer.source }
  const prior = list.find(c => c.kind === 'agent' && c.name === offer.agent)
  if (prior !== undefined && prior.description === entry.description && prior.source === entry.source) return [...list]
  return [...list.filter(c => !(c.kind === 'agent' && c.name === offer.agent)), entry]
}

export function replaceSkills(list: readonly CatalogEntry[], skills: readonly CatalogEntry[]): CatalogEntry[] {
  return [...list.filter(c => c.kind === 'agent'), ...skills]
}

// An agent file's frontmatter: its name and description.
export function agentFromMarkdown(text: string, fallback: string, source: string): CatalogEntry | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (fm === null) return null
  const field = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm[1] ?? '')
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const name = field('name') || fallback
  return name === '' ? null : { kind: 'agent', name, description: oneLine(field('description')), source }
}

// What the launcher lists for a query: names that start with it first, then the rest that contain it.
export function filterCatalog(list: readonly CatalogEntry[], kind: CatalogEntry['kind'], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase()
  const ofKind = list.filter(c => c.kind === kind)
  const byName = (a: CatalogEntry, b: CatalogEntry): number => a.name.localeCompare(b.name)
  if (q === '') return ofKind.slice().sort(byName)
  const starts = ofKind.filter(c => c.name.toLowerCase().startsWith(q)).sort(byName)
  const contains = ofKind
    .filter(c => !c.name.toLowerCase().startsWith(q) && `${c.name} ${c.description}`.toLowerCase().includes(q))
    .sort(byName)
  return [...starts, ...contains]
}

// A few words for the Agent call's description, from the task the person typed.
export function purposeOf(task: string): string {
  const words = oneLine(task).split(' ').slice(0, 6).join(' ')
  return words.length > 48 ? `${words.slice(0, 47)}…` : words
}
