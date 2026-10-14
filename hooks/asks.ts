// Questions Claude asks the person with choices, in the shape the pane draws as
// cards: from AskUserQuestion's input, from the question an answer ends on, or
// from another session's board file. Pure: no `$` here, so it is tested on its own.

import type { Ask, Choice } from '../types'

export type { Ask, Choice }

// Most a card list carries, so one session cannot crowd every other pane.
export const ASKS_MAX = 4
export const CHOICES_MAX = 6
const QUESTION_MAX = 300
const HEADER_MAX = 24
const LABEL_MAX = 80
const DETAIL_MAX = 200

type Fields = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
// The words, without the Markdown marks a reply is written in.
const plain = (s: string): string => oneLine(s.replace(/\*\*|__|`/g, '').replace(/^[*_]+|[*_]+$/g, ''))
const capital = (s: string): string => (s === '' ? s : `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`)

function asChoice(v: unknown): Choice | null {
  const o = v as Fields
  if (o === null || typeof o !== 'object') return null
  const label = clip(oneLine(str(o.label)), LABEL_MAX)
  // AskUserQuestion calls it `description`; a stored card, `detail`.
  return label === '' ? null : { label, detail: clip(oneLine(str(o.detail) || str(o.description)), DETAIL_MAX) }
}

function asAsk(v: unknown, optionsKey: 'options' | 'choices'): Ask | null {
  const o = v as Fields
  if (o === null || typeof o !== 'object') return null
  const question = clip(oneLine(str(o.question)), QUESTION_MAX)
  if (question === '') return null
  // A free-text or number question has no choices: the dialog is where it is answered.
  const isChoice = o.kind === undefined || o.kind === 'choice'
  const list = o[optionsKey]
  const choices = isChoice && Array.isArray(list) ? list.slice(0, CHOICES_MAX).flatMap(c => asChoice(c) ?? []) : []
  return { question, header: clip(oneLine(str(o.header)), HEADER_MAX), choices, isMulti: o.multiSelect === true || o.isMulti === true }
}

// AskUserQuestion's questions, each with its choices.
export function asksOfInput(input: unknown): Ask[] {
  const qs = (input as Fields | null)?.questions
  return Array.isArray(qs) ? qs.slice(0, ASKS_MAX).flatMap(q => asAsk(q, 'options') ?? []) : []
}

// Another session's published questions, as far as they hold up: its file is not trusted to be well formed.
export function asAsks(raw: unknown): Ask[] {
  return Array.isArray(raw) ? raw.slice(0, ASKS_MAX).flatMap(q => asAsk(q, 'choices') ?? []) : []
}

// The answers AskUserQuestion returns: each question's chosen labels, comma-joined for a multi-select.
export function answersOf(asks: readonly Ask[], picks: Readonly<Record<number, readonly string[]>>): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const [i, a] of asks.entries()) {
    const chosen = picks[i] ?? []
    if (chosen.length === 0) return null
    answers[a.question] = chosen.join(', ')
  }
  return answers
}

// The answers in the call's own words: each question as Claude asked it, each
// option's label as Claude gave it (the cards draw them cleaned up and cut short).
export function answersFor(input: unknown, picks: Readonly<Record<number, readonly string[]>>): Record<string, string> {
  const qs = (input as Fields | null)?.questions
  const list = Array.isArray(qs) ? (qs as unknown[]) : []
  const asks = asksOfInput(input)
  const answers: Record<string, string> = {}
  for (const [key, labels] of Object.entries(picks)) {
    const i = Number(key)
    const q = list[i] as Fields | undefined
    const a = asks[i]
    if (q === undefined || q === null || a === undefined) continue
    const options = Array.isArray(q.options) ? (q.options as Fields[]) : []
    answers[str(q.question)] = labels.map(l => {
      const at = a.choices.findIndex(c => c.label === l)
      return at < 0 ? l : str(options[at]?.label) || l
    }).join(', ')
  }
  return answers
}

// A press on a card: a single-choice question takes it, a multi-select toggles it.
export function pick(current: readonly string[], label: string, isMulti: boolean): string[] {
  if (!isMulti) return [label]
  return current.includes(label) ? current.filter(l => l !== label) : [...current, label]
}

// ---- the question an answer ends on ----

const ITEM = /^(?:(\d{1,2})[.)]|\(?([A-Za-z])[.)]|[-*•])\s+(?:\[[ xX]\]\s+)?(.+)$/
const LEAD = /^(?:(?:so|ok|okay),?\s+)?(?:should i|shall i|do you want(?: me)? to|want me to|would you like(?: me)? to|do you prefer(?: to)?|would you prefer(?: to)?|can i|may i)\s+(.+)$/i
// A question that asks to pick from the list above it; a list of findings above "Which tests?" is not one.
const PICKS = /\b(?:which one|which of (?:these|them|the)|pick one|choose one|one of (?:these|them|the above))\b|^which\?$/i
// A line after the list that still belongs to the question ("Or something else.").
const CLOSING = /^(?:or\b|let me know|tell me|reply with|just say)/i

const withoutCode = (text: string): string => text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '')
const indentOf = (line: string): number => line.length - line.trimStart().length
// A line that asks: it ends on a question mark (a quote or bracket may follow), and is no heading.
const asksOn = (line: string): boolean => !/^\s*#/.test(line) && /[?？]["'”’)]*$/.test(plain(line))

// "**Fix it first**: then merge" or "Fix it first — then merge": the label, then what it leads to.
function choiceOfItem(item: string): Choice {
  const bold = /^\*\*(.+?)\*\*\s*[:.\-–—]?\s*(.*)$/.exec(item)
  if (bold !== null) return { label: clip(plain(bold[1] ?? ''), LABEL_MAX), detail: clip(plain(bold[2] ?? ''), DETAIL_MAX) }
  const text = plain(item)
  const cut = /\s[—–-]\s|:\s/.exec(text)
  if (cut !== null && cut.index > 0 && cut.index <= 50) {
    return { label: clip(text.slice(0, cut.index).trim(), LABEL_MAX), detail: clip(text.slice(cut.index + cut[0].length).trim(), DETAIL_MAX) }
  }
  return { label: clip(text, LABEL_MAX), detail: '' }
}

// A list of two to six items starting at `from` and running `step` (1 down, -1
// up), all of one marker kind at one indent. Blank lines may stand between
// items; a deeper line (a sub-point, a wrapped line) is more about its item.
function listAt(raw: readonly string[], from: number, step: 1 | -1): { choices: Choice[]; used: number } {
  const items: { text: string; more: string[] }[] = []
  // Read upwards, an item's deeper lines come before the item itself.
  let held: string[] = []
  let kind = ''
  let base = -1
  let i = from
  let last = from - step
  const words = (line: string): string => { const t = line.trim(); return ITEM.exec(t)?.[3] ?? t }
  while (i >= 0 && i < raw.length) {
    const line = raw[i] ?? ''
    if (line.trim() === '') {
      i += step
      continue
    }
    const indent = indentOf(line)
    const isDeeper = base >= 0 ? indent > base : step === -1 && indent >= 2
    if (isDeeper) {
      if (step === 1) items[items.length - 1]?.more.push(words(line))
      else held = [words(line), ...held]
      last = i
      i += step
      continue
    }
    const hit = ITEM.exec(line.trim())
    if (hit === null || (base >= 0 && indent !== base)) break
    const k = hit[1] !== undefined ? 'n' : hit[2] !== undefined ? 'a' : 'b'
    if (kind !== '' && k !== kind) break
    kind = k
    base = indent
    items.push({ text: hit[3] ?? '', more: step === 1 ? [] : held })
    held = []
    last = i
    i += step
  }
  if (step === -1) items.reverse()
  if (items.length < 2 || items.length > CHOICES_MAX) return { choices: [], used: 0 }
  const choices = items.map(it => {
    const c = choiceOfItem(it.text)
    return c.detail === '' && it.more.length > 0 ? { ...c, detail: clip(plain(it.more.join('; ')), DETAIL_MAX) } : c
  }).filter(c => c.label !== '')
  return { choices, used: Math.abs(last - from) + 1 }
}

// "Should I X, or Y?", "X, Y, or Z?" and "use A or B?": the choices the question itself names.
function inlineChoices(rest: string): Choice[] {
  const parts = rest.split(/,\s*or\s+/i)
  let all: string[]
  if (parts.length === 2) {
    const [head = '', last = ''] = parts
    const firsts = head.split(/,\s+/)
    all = firsts.length > 1 && firsts.length <= 3 && firsts.every(p => p.length <= 40) ? [...firsts, last] : [head, last]
  } else {
    const sides = rest.split(/\s+or\s+/i)
    if (parts.length !== 1 || sides.length !== 2) return []
    const [a = '', b = ''] = sides.map(x => x.trim())
    const aw = a.split(/\s+/)
    // "use Postgres or SQLite": a one-word second side borrows the first side's verb.
    all = [a, !b.includes(' ') && aw.length >= 2 ? [...aw.slice(0, -1), b].join(' ') : b]
  }
  const labels = all.map(p => plain(p).replace(/[.?？!]+$/, '').trim())
  if (labels.some(w => w.length < 2 || w.length > LABEL_MAX)) return []
  return labels.map(w => ({ label: capital(w), detail: '' }))
}

// The question an answer ends on, with the choices it offers: a numbered,
// lettered or bulleted list right after it ("Which one?" then 1. 2. 3.), the
// choices the question names ("Should I X, or Y?"), Yes or No for a plain
// "Want me to …?", or the list right before a "Which one?". Null when the answer
// does not end on a question, or offers no choices that can be read for sure.
export function replyAskOf(answer: string): Ask | null {
  const raw = withoutCode(answer).split('\n')
  while (raw.length > 0 && (raw[raw.length - 1] ?? '').trim() === '') raw.pop()
  let at = -1
  for (let i = raw.length - 1; i >= 0 && i >= raw.length - 30; i -= 1) {
    if (asksOn(raw[i] ?? '')) {
      at = i
      break
    }
  }
  if (at < 0) return null
  // The question ends the answer: after it come at most its list and one closing line.
  const after = listAt(raw, at + 1, 1)
  const rest = raw.slice(at + 1 + after.used).filter(l => l.trim() !== '')
  if (rest.length > 1 || (rest.length === 1 && !CLOSING.test(plain(rest[0] ?? '')))) return null
  const line = plain(raw[at] ?? '')
  const end = Math.max(line.lastIndexOf('?'), line.lastIndexOf('？'))
  const question = clip((line.slice(0, end + 1).split(/(?<=[.!。！])\s+/).pop() ?? '').trim(), QUESTION_MAX)
  if (question === '') return null
  const ask = (choices: Choice[]): Ask => ({ question, header: '', choices, isMulti: false })
  if (after.choices.length > 0) return ask(after.choices)
  const lead = LEAD.exec(question.replace(/[?？]+$/, ''))
  if (lead !== null) {
    const body = lead[1] ?? ''
    const inline = inlineChoices(body)
    if (inline.length > 0) return ask(inline)
    // An "or" that does not split cleanly: no cards, rather than a wrong Yes or No.
    if (/\bor\b/i.test(body)) return null
    return ask([{ label: 'Yes', detail: capital(plain(body)) }, { label: 'No', detail: '' }])
  }
  // "Which one?" after a list, or a closing "Or something else?": the list above is the choice.
  const before = PICKS.test(question) || /^or\b/i.test(question) ? listAt(raw, at - 1, -1).choices : []
  return before.length > 0 ? ask(before) : null
}
