import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const KEY = 'asks:s1'
const DAY = 86400000
const NOW = Date.parse('2026-10-06T15:00:00Z')

// The engine's side: an in-memory store, a session id, quiet registrations, a band beneath that draws one row.
const engineBottom = (on: On, initial: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  const session = { id: 's1' }
  on('store.get', async (_$, e) => ({ value: store.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', async (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    store.delete((e as unknown as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...store.keys()] }) as never)
  on('session.id', async () => ({ value: session.id }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  mock.clock(on, { now: NOW })

  return { store, session }
}

const BAND = { plugin: 'open-asks', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20 } } as const
const start = { cwd: 'C:/work/project', isInteractive: true } as never
const add = ($: { tool: { call: (e: never) => Promise<unknown> } }, text: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__open-asks__ask_add', text, ...extra } as never)

test('an added ask shows in the band above the prompt with what is beneath it, and leaves when resolved', async ($, on) => {
  engineBottom(on)
  await $.session.start(start)

  const added = (await $.tool.call({ tool: 'mcp__open-asks__ask_add', text: 'Post the question on #1234?', recommendation: 'Yes: it rules out file scanning.' } as never)) as unknown as { result: string }
  expect(added.result).toMatch(/Recorded as \[1\]/)

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /Waiting on you \(1\)/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\[1\] Post the question/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Recommend: Yes: it rules out file scanning\./ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /beneath/ }))?.text).toBeDefined()

  const resolved = (await $.tool.call({ tool: 'mcp__open-asks__ask_resolve', ids: [1] } as never)) as unknown as { result: string }
  expect(resolved.result).toMatch(/Resolved \[1\]/)
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: /Waiting on you/ })).toBeUndefined()
  expect((await after.find({ type: 'Text', text: /beneath/ }))?.text).toBeDefined()
})

test('the same question twice keeps one id; /asks done drops by id; the store keeps them for a restart', async ($, on) => {
  const { store } = engineBottom(on)
  await $.session.start(start)
  await add($, 'Swap in the new files?')
  await add($, 'swap in   the new files?')
  await add($, 'Cap the thread count now?', { from: 'other-agent' })

  const saved = store.get(KEY) as { asks: { id: number; from: string }[] }
  expect(saved.asks.map(a => a.id)).toEqual([1, 2])
  expect(saved.asks[1].from).toBe('other-agent')

  const again = (await add($, 'Swap in the new files?', { recommendation: 'Yes.' })) as { result: string }
  expect(again.result).toMatch(/Recorded as \[1\][\s\S]*\[1\] Swap in the new files\?\n {4}Recommend: Yes\./)

  const done = await $.command.run({ command: 'asks', args: 'done 1' } as never)
  expect((done as { text: string }).text).toMatch(/Dropped \[1\][\s\S]*\[2\] Cap the thread count now\? \(for other-agent\)/)
})

test('a restarted session picks its asks back up from the store, and the entry goes when the last one is settled', async ($, on) => {
  const { store } = engineBottom(on, { [KEY]: { asks: [{ id: 4, text: 'Keep going?', recommendation: '', from: '', addedAt: NOW }], nextId: 5 } })
  await $.session.start(start)
  expect(((await $.tool.call({ tool: 'mcp__open-asks__ask_list' } as never)) as unknown as { result: string }).result).toMatch(/\[4\] Keep going\?/)
  await $.tool.call({ tool: 'mcp__open-asks__ask_resolve', ids: [4] } as never)
  expect(store.has(KEY)).toBe(false)
})

test('a restart that starts under a new id and then resumes the old one gets the old asks back; a /clear starts empty', async ($, on) => {
  const { store, session } = engineBottom(on, { 'asks:old': { asks: [{ id: 10, text: 'Merge the PR?', recommendation: 'Yes.', from: '', addedAt: NOW }], nextId: 11 } })

  // The restarted process starts under a new id, with nothing saved under it.
  session.id = 'new'
  await $.session.start(start)
  expect(((await $.tool.call({ tool: 'mcp__open-asks__ask_list' } as never)) as unknown as { result: string }).result).toBe('No open asks.')

  // It then takes up the old id; the next prompt brings the old asks back into the band.
  session.id = 'old'
  await $.prompt.submit({ text: 'hi' } as never)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /\[10\] Merge the PR\?/ }))?.text).toBeDefined()

  // A new ask goes on after the old ones and is saved under the old id.
  const added = (await add($, 'Cap the thread count?', { recommendation: 'Yes.' })) as { result: string }
  expect(added.result).toMatch(/Recorded as \[11\]/)
  expect((store.get('asks:old') as { asks: { id: number }[] }).asks.map(a => a.id)).toEqual([10, 11])
  expect(store.has('asks:new')).toBe(false)

  // A /clear moves to a fresh id: the band empties at the end of the turn.
  session.id = 'cleared'
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', text: '' } as never)
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: /Waiting on you/ })).toBeUndefined()
})

test('the rule is added to the system prompt once, after the engine sections', async ($, on) => {
  engineBottom(on)
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'open-asks:rule'])
})

test('maxQuestionChars cuts a long question in the listing', { options: { maxQuestionChars: 50 } }, async ($, on) => {
  engineBottom(on)
  await $.session.start(start)
  const long = 'Should we do this very long thing that has far too many words to fit on one short line of the band?'
  const added = (await add($, long)) as { result: string }
  expect(added.result).toContain('[1] Should we do this very long thing that has far to…')
  expect(added.result).not.toContain('short line')
})

test('maxBandAsks limits how many asks the band draws', { options: { maxBandAsks: 2 } }, async ($, on) => {
  engineBottom(on)
  await $.session.start(start)
  for (const q of ['First?', 'Second?', 'Third?']) {
    await add($, q)
  }
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /Waiting on you \(3\) · 1 older/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[1\] First/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /\[3\] Third/ }))?.text).toBeDefined()
})

test('keepDays removes entries of other sessions whose newest ask is older, and keeps newer ones', { options: { keepDays: 10 } }, async ($, on) => {
  const ask = (addedAt: number) => ({ asks: [{ id: 1, text: 'q', recommendation: '', from: '', addedAt }], nextId: 2 })
  const { store } = engineBottom(on, { 'asks:old': ask(NOW - 11 * DAY), 'asks:recent': ask(NOW - 9 * DAY) })
  await $.session.start(start)
  expect([...store.keys()].sort()).toEqual(['asks:recent'])
})

test('keepDays 0 keeps every entry', { options: { keepDays: 0 } }, async ($, on) => {
  const { store } = engineBottom(on, { 'asks:old': { asks: [{ id: 1, text: 'q', recommendation: '', from: '', addedAt: 1 }], nextId: 2 } })
  await $.session.start(start)
  expect(store.has('asks:old')).toBe(true)
})
