import { expect, test } from 'claude-code/testing'

import { answersOf, asAsks, asksOfInput, pick, replyAskOf } from '../hooks/asks'

const labels = (text: string): string[] => (replyAskOf(text)?.choices ?? []).map(c => c.label)

test("AskUserQuestion's questions become cards: label, what it leads to, single or multi", () => {
  const asks = asksOfInput({
    questions: [
      { question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'date-fns', description: 'Small, tree-shakes' }, { label: 'Luxon', description: 'Time zones built in' }] },
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }] },
      { question: 'Anything else?', header: 'Notes', kind: 'text', multiSelect: false, options: [] },
    ],
  })
  expect(asks).toEqual([
    { question: 'Which library?', header: 'Library', choices: [{ label: 'date-fns', detail: 'Small, tree-shakes' }, { label: 'Luxon', detail: 'Time zones built in' }], isMulti: false },
    { question: 'Which checks?', header: 'Checks', choices: [{ label: 'Lint', detail: '' }, { label: 'Types', detail: '' }, { label: 'Tests', detail: '' }], isMulti: true },
    { question: 'Anything else?', header: 'Notes', choices: [], isMulti: false },
  ])
  expect(asksOfInput({})).toEqual([])
  expect(asksOfInput({ questions: 'nope' })).toEqual([])
})

test("another session's published questions are read defensively and capped", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ label: `opt ${i}`, detail: 'x'.repeat(500) }))
  const asks = asAsks([{ question: 'Pick?', header: 'h', choices: many, isMulti: false }, 'junk', { question: '' }, null])
  expect(asks.length).toBe(1)
  expect(asks[0]?.choices.length).toBe(6)
  expect((asks[0]?.choices[0]?.detail.length ?? 0) <= 200).toBe(true)
  expect(asAsks('junk')).toEqual([])
})

test('answers are each question\'s picks, comma-joined; a press takes one or toggles one', () => {
  const asks = asksOfInput({ questions: [{ question: 'A?', header: '', options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?', header: '', multiSelect: true, options: [{ label: 'p' }, { label: 'q' }] }] })
  expect(answersOf(asks, { 0: ['x'] })).toBeNull()
  expect(answersOf(asks, { 0: ['x'], 1: ['p', 'q'] })).toEqual({ 'A?': 'x', 'B?': 'p, q' })
  expect(pick(['x'], 'y', false)).toEqual(['y'])
  expect(pick(['p'], 'q', true)).toEqual(['p', 'q'])
  expect(pick(['p', 'q'], 'p', true)).toEqual(['q'])
})

test('a numbered list after the question: each item a card, its bold words the label', () => {
  const ask = replyAskOf('Done with the fixes.\n\nWhich should I do first?\n\n1. **Fix the band**: keep it quiet\n2. **Merge now** — ship 0.9.1\n3. Wait for review')
  expect(ask?.question).toBe('Which should I do first?')
  expect(ask?.choices).toEqual([
    { label: 'Fix the band', detail: 'keep it quiet' },
    { label: 'Merge now', detail: 'ship 0.9.1' },
    { label: 'Wait for review', detail: '' },
  ])
})

test('an indented line under an item is its detail; a closing line after the list is fine', () => {
  expect(replyAskOf('Which way?\n1. **Insert**\n   keeps the draft\n2. **Replace**\n   wipes it\n\nOr tell me another.')?.choices).toEqual([
    { label: 'Insert', detail: 'keeps the draft' },
    { label: 'Replace', detail: 'wipes it' },
  ])
})

test('"Should I X, or Y?" and "X, Y, or Z?" name their own choices', () => {
  expect(labels('All green.\n\nShould I fix item 1 (and 2 and 3 if you want) before merging, or merge and tag 0.9.1 now?'))
    .toEqual(['Fix item 1 (and 2 and 3 if you want) before merging', 'Merge and tag 0.9.1 now'])
  expect(labels('Do you want me to fix it, test it, or ship it?')).toEqual(['Fix it', 'Test it', 'Ship it'])
})

test('a list of findings before a question is not its choices; a list before "which one" is', () => {
  expect(labels('Open items:\n- CI is not pinned\n- media is large\n\nShould I fix item 1 first, or merge now?')).toEqual(['Fix item 1 first', 'Merge now'])
  expect(labels('Open items:\n- CI is not pinned\n- media is large\n\nAnything else on your mind?')).toEqual([])
  expect(labels('1. Alpha\n2. Beta\n\nWhich one do you want?')).toEqual(['Alpha', 'Beta'])
})

test('"Want me to …?" offers Yes and No', () => {
  expect(replyAskOf('Pushed.\n\nWant me to commit these on a branch?')?.choices).toEqual([
    { label: 'Yes', detail: 'Commit these on a branch' },
    { label: 'No', detail: '' },
  ])
})

test('no cards when the answer does not end on a question, or the question offers none', () => {
  expect(replyAskOf('All done. Tests pass.')).toBeNull()
  expect(replyAskOf('Is it the cache? It was.\n\nThe fix is in.\n\nTests pass.\n\nShipped.')).toBeNull()
  expect(replyAskOf('What do you think?')).toBeNull()
  expect(replyAskOf('Here:\n```\nwhy?\n```\nDone.')).toBeNull()
})

test('an answer that only mentions a question, or ends on a statement, is not waiting on the person', () => {
  expect(replyAskOf('Why did it fail? The cache was stale.\n\n1. Cleared the cache\n2. Re-ran tests\n\nAll green now.')).toBeNull()
  expect(replyAskOf('## Why did it break?\n\n- the cache\n- the lock\n\nBoth are fixed.')).toBeNull()
  expect(replyAskOf('## Which one?\n\n- a\n- b')).toBeNull()
  expect(replyAskOf('**What changed?**\n\n1. the parser\n2. the tests\n\nTests pass.')).toBeNull()
  expect(replyAskOf('Results at https://ci/x?run=5\n\n1. lint ok\n2. tests ok')).toBeNull()
})

test('"use A or B?" names both; an "or" that cannot be split shows no cards, never a wrong Yes or No', () => {
  expect(labels('Should I use Postgres or SQLite?')).toEqual(['Use Postgres', 'Use SQLite'])
  expect(labels('Should I merge now or wait for review?')).toEqual(['Merge now', 'Wait for review'])
  expect(replyAskOf('Should I keep it, or drop it, or wait, or ask?')).toBeNull()
})

test('a list above "Which tests should I run?" is not its choices; "Do you prefer …?" is a yes or no', () => {
  expect(replyAskOf('I changed:\n- a.ts\n- b.ts\n\nWhich tests should I run?')).toBeNull()
  expect(labels('Here is what changed:\n- Renamed foo\n- Dropped flag\n\nDo you prefer the new names?')).toEqual(['Yes', 'No'])
})

test('sub-points under an item are its detail; checkboxes and ~~~ code blocks are read right', () => {
  expect(replyAskOf('Which plan?\n1. **Small**\n   - one file\n   - no tests\n2. **Full**\n   - every file')?.choices).toEqual([
    { label: 'Small', detail: 'one file; no tests' },
    { label: 'Full', detail: 'every file' },
  ])
  expect(labels('Which next?\n- [ ] write tests\n- [x] ship')).toEqual(['write tests', 'ship'])
  expect(replyAskOf('Here:\n~~~\nwhy?\n~~~\nDone.')).toBeNull()
})
