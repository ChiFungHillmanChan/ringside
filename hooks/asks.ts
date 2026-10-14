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

// A press on a card: a single-choice question takes it, a multi-select toggles it.
export function pick(current: readonly string[], label: string, isMulti: boolean): string[] {
  if (!isMulti) return [label]
  return current.includes(label) ? current.filter(l => l !== label) : [...current, label]
}

// ---- the question an answer ends on ----

const ITEM = /^(?:(\d{1,2})[.)]|\(?([A-Za-z])[.)]|[-*•])\s+(.+)$/
const LEAD = /^(?:(?:so|ok|okay),?\s+)?(?:should i|shall i|do you want(?: me)? to|want me to|would you like(?: me)? to|do you prefer(?: to)?|would you prefer(?: to)?|can i|may i)\s+(.+)$/i
const PICKS = /\b(?:which|pick|choose|one of|option|prefer)\b/i

const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(?:```|$)/g, '')

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
// up), all of one marker kind. Blank lines may stand between items, and an
// indented line under an item is its detail.
function listAt(raw: readonly string[], from: number, step: 1 | -1): { choices: Choice[]; used: number } {
  const items: { text: string; more: string[] }[] = []
  // Read upwards, an item's indented lines come before the item itself.
  let held: string[] = []
  let kind = ''
  let i = from
  let last = from - step
  const isBlank = (k: number): boolean => (raw[k] ?? '').trim() === ''
  while (i >= 0 && i < raw.length) {
    const line = raw[i] ?? ''
    if (isBlank(i)) {
      i += step
      continue
    }
    const hit = ITEM.exec(line.trim())
    if (hit === null) {
      // Indented under an item: more about that item.
      if (/^\s{2,}\S/.test(line) && (step === -1 || items.length > 0)) {
        if (step === 1) items[items.length - 1]?.more.push(line.trim())
        else held = [line.trim(), ...held]
        last = i
        i += step
        continue
      }
      break
    }
    const k = hit[1] !== undefined ? 'n' : hit[2] !== undefined ? 'a' : 'b'
    if (kind !== '' && k !== kind) break
    kind = k
    items.push({ text: hit[3] ?? '', more: step === 1 ? [] : held })
    held = []
    last = i
    i += step
  }
  if (step === -1) items.reverse()
  if (items.length < 2 || items.length > CHOICES_MAX) return { choices: [], used: 0 }
  const choices = items.map(it => {
    const c = choiceOfItem(it.text)
    return c.detail === '' && it.more.length > 0 ? { ...c, detail: clip(plain(it.more.join(' ')), DETAIL_MAX) } : c
  }).filter(c => c.label !== '')
  return { choices, used: Math.abs(last - from) + 1 }
}

// "Should I X, or Y?" and "Should I X, Y, or Z?": the choices the question itself names.
function inlineChoices(rest: string): Choice[] {
  const parts = rest.split(/,\s*or\s+/i)
  if (parts.length !== 2) return []
  const [head = '', last = ''] = parts
  const firsts = head.split(/,\s+/)
  const all = firsts.length > 1 && firsts.length <= 3 && firsts.every(p => p.length <= 40) ? [...firsts, last] : [head, last]
  const words = all.map(p => plain(p).replace(/[.?？!]+$/, '').trim())
  if (words.some(w => w.length < 2 || w.length > LABEL_MAX)) return []
  return words.map(w => ({ label: capital(w), detail: '' }))
}

// The question an answer ends on, with the choices it offers: a numbered,
// lettered or bulleted list right after it ("Which one?" then 1. 2. 3.), "X, or
// Y?" in the question itself, a list right before it when it asks to pick one,
// and Yes or No for "Want me to …?". Null when the answer does not end on a question.
export function replyAskOf(answer: string): Ask | null {
  const raw = withoutCode(answer).split('\n')
  while (raw.length > 0 && (raw[raw.length - 1] ?? '').trim() === '') raw.pop()
  let at = -1
  for (let i = raw.length - 1; i >= 0 && i >= raw.length - 30; i -= 1) {
    if (/[?？]/.test(raw[i] ?? '')) {
      at = i
      break
    }
  }
  if (at < 0) return null
  // The question ends the answer: after it come at most its list and one closing line.
  const after = listAt(raw, at + 1, 1)
  const rest = raw.slice(at + 1 + after.used).filter(l => l.trim() !== '')
  if (rest.length > 1) return null
  const line = plain(raw[at] ?? '').replace(/^#+\s*/, '')
  const end = Math.max(line.lastIndexOf('?'), line.lastIndexOf('？'))
  const question = clip((line.slice(0, end + 1).split(/(?<=[.!。！])\s+/).pop() ?? '').trim(), QUESTION_MAX)
  if (question === '') return null
  const ask = (choices: Choice[]): Ask => ({ question, header: '', choices, isMulti: false })
  if (after.choices.length > 0) return ask(after.choices)
  const lead = LEAD.exec(question.replace(/[?？]+$/, ''))
  const inline = lead === null ? [] : inlineChoices(lead[1] ?? '')
  if (inline.length > 0) return ask(inline)
  // "Which one?" after a list, or a closing "Or something else?": the list above is the choice.
  const before = PICKS.test(question) || /^or\b/i.test(question) ? listAt(raw, at - 1, -1).choices : []
  if (before.length > 0) return ask(before)
  if (lead !== null) return ask([{ label: 'Yes', detail: capital(plain(lead[1] ?? '')) }, { label: 'No', detail: '' }])
  return null
}
