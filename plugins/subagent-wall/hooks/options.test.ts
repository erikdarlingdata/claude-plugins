import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60000

// The engine's side: every tool answers "ok"; each spawn starts the next id; a step reports `context` tokens.
const engine = (on: On, prefix: string, context = 1000) => {
  let n = 0
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: `${prefix}${++n}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: context, cache_creation_input_tokens: 0 } }
  })
}
const call = (agentId: string, input: Record<string, unknown>) => ({ tool_use_id: 'u', agentId, ...input }) as never
const spawn = ($: Engine, subagentType: string) => $.agent.spawn({ prompt: 'x', description: 'x', subagentType })
const step = async ($: Engine, agentId: string) => {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'x', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) { /* drain */ }
  await s.result
}

test('codeAgentTypes names the agent types that get the nudge', { options: { codeAgentTypes: 'builder, fixer' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on, 'c', 150000)
  await spawn($, 'fixer')
  await spawn($, 'general-purpose')
  await step($, 'c1')
  await step($, 'c2')
  expect((await $.tool.call(call('c1', { tool: 'Grep', pattern: 'x' }))).context?.[0]).toMatch(/no file edited yet/)
  expect((await $.tool.call(call('c2', { tool: 'Grep', pattern: 'x' }))).context ?? []).toEqual([])
})

test('warnMinutes and limitMinutes move the warning and the limit', { options: { warnMinutes: 10, limitMinutes: 20 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, 'd')
  await spawn($, 'Explore')
  await clock.advance(10 * MIN)
  expect((await $.tool.call(call('d1', { tool: 'Bash', command: 'ls' }))).context?.[0]).toMatch(/10 minutes in\. At 20 minutes only/)
  await clock.advance(10 * MIN)
  expect((await $.tool.call(call('d1', { tool: 'Bash', command: 'ls' }))).deny).toMatch(/at or past the 20-minute limit/)
})

test('limitMinutes 0 turns the limit off', { options: { limitMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, 'e')
  await spawn($, 'Explore')
  await clock.advance(120 * MIN)
  expect((await $.tool.call(call('e1', { tool: 'Bash', command: 'ls' }))).deny).toBeUndefined()
})

test('noEditNudgeK sets the context size that triggers the nudge', { options: { noEditNudgeK: 200 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on, 'f', 150000)
  await spawn($, 'general-purpose')
  await step($, 'f1')
  expect((await $.tool.call(call('f1', { tool: 'Grep', pattern: 'x' }))).context ?? []).toEqual([])
})
