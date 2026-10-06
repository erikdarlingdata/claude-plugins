import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60000

// The engine's side: every tool answers "ok"; a spawn starts `id`; a step reports `context` tokens.
const engine = (on: On, id: string, context = 1000) => {
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: id }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: context, cache_creation_input_tokens: 0 } }
  })
}
const call = (agentId: string | undefined, input: Record<string, unknown>) =>
  ({ tool_use_id: 'u', ...(agentId ? { agentId } : {}), ...input }) as never

test('a subagent is warned at 45 minutes and limited to git, gh and note writes at 60', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, 'a1')
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'Explore' })

  await clock.advance(44 * MIN)
  expect((await $.tool.call(call('a1', { tool: 'Bash', command: 'ls' }))).context ?? []).toEqual([])

  await clock.advance(1 * MIN)
  const warned = await $.tool.call(call('a1', { tool: 'Bash', command: 'ls' }))
  expect(warned.context?.[0]).toMatch(/45 minutes in\. At 60 minutes only git, gh/)
  expect((await $.tool.call(call('a1', { tool: 'Bash', command: 'ls' }))).context ?? []).toEqual([])

  await clock.advance(15 * MIN)
  expect((await $.tool.call(call('a1', { tool: 'Bash', command: 'ls' }))).deny).toMatch(/60 minutes, at or past the 60-minute limit/)
  expect((await $.tool.call(call('a1', { tool: 'Read', file_path: 'C:/x.cs' }))).deny).toBeDefined()
  expect((await $.tool.call(call('a1', { tool: 'Write', file_path: 'C:/x.cs', content: '' }))).deny).toBeDefined()
  expect((await $.tool.call(call('a1', { tool: 'Bash', command: '  git push origin fix' }))).deny).toBeUndefined()
  expect((await $.tool.call(call('a1', { tool: 'PowerShell', command: 'gh pr view 1' }))).deny).toBeUndefined()
  expect((await $.tool.call(call('a1', { tool: 'Write', file_path: 'C:/notes/HANDOFF.MD', content: '' }))).deny).toBeUndefined()
  expect((await $.tool.call(call('a1', { tool: 'Bash', command: 'github-cli x' }))).deny).toBeDefined()
})

test('the main loop and a finished subagent are never limited', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, 'a2')
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'general-purpose' })
  await clock.advance(90 * MIN)
  expect((await $.tool.call(call(undefined, { tool: 'Bash', command: 'ls' }))).deny).toBeUndefined()
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', text: '', agentId: 'a2' })
  expect((await $.tool.call(call('a2', { tool: 'Bash', command: 'ls' }))).deny).toBeUndefined()
})

const step = async ($: Engine, agentId: string) => {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'x', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) { /* drain */ }
  await s.result
}

test('a code-changing agent past 100k with no edit is nudged once', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on, 'a3', 120000)
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'general-purpose' })
  await step($, 'a3')
  const nudged = await $.tool.call(call('a3', { tool: 'Grep', pattern: 'x' }))
  expect(nudged.context?.[0]).toMatch(/about 120k tokens of context and no file edited yet/)
  expect((await $.tool.call(call('a3', { tool: 'Grep', pattern: 'x' }))).context ?? []).toEqual([])
})

test('the nudge skips an agent that edited and every other agent type', async ($, on) => {
  mock.clock(on, { now: 0 })
  let n = 0
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: `b${++n}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 } }
  })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'general-purpose' })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'Explore' })
  await $.tool.call(call('b1', { tool: 'Edit', file_path: 'C:/x.cs', old_string: 'a', new_string: 'b' }))
  await step($, 'b1')
  await step($, 'b2')
  expect((await $.tool.call(call('b1', { tool: 'Grep', pattern: 'x' }))).context ?? []).toEqual([])
  expect((await $.tool.call(call('b2', { tool: 'Grep', pattern: 'x' }))).context ?? []).toEqual([])
})
