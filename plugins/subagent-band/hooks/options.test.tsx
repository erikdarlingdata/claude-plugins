import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// 1M cache-read tokens a step; one subagent (a1) and the main session each take one.
const engine = (on: On) => {
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_$, e) {
    const model = e.agentId ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model, input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000 } }
  })
  mock.clock(on, { now: 0 })
}

const run = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  for (const agentId of ['a1', undefined]) {
    const s = $.turn.step({ turnId: 't', index: 0, model: 'x', effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of s) { /* drain */ }
    await s.result
  }

  return ((await $.command.run({ command: 'subagent-cost', args: '' } as never)) as { text: string }).text
}

// sonnet: input 3 + cache write 3 x 1.25 + cache read 3 x 0.1 + output 15 = 22.05; opus: 5 + 6.25 + 0.5 + 25 = 36.75
test('the default prices are the public list prices', async ($, on) => {
  engine(on)
  expect(await run($ as never)).toMatch(/subagents \$22\.05 \(1\), main session \$36\.75/)
})

test('priceTable sets each family\'s input and output price', { options: { priceTable: 'opus:10:50, sonnet:1:2' } }, async ($, on) => {
  engine(on)
  // sonnet: 1 + 1.25 + 0.1 + 2 = 4.35; opus: 10 + 12.5 + 1 + 50 = 73.5
  expect(await run($ as never)).toMatch(/subagents \$4\.35 \(1\), main session \$73\.50/)
})

test('a model outside the priceTable is priced as its first family', { options: { priceTable: 'haiku:1:1' } }, async ($, on) => {
  engine(on)
  // 1 + 1.25 + 0.1 + 1 = 3.35 for both
  expect(await run($ as never)).toMatch(/subagents \$3\.35 \(1\), main session \$3\.35/)
})

test('cacheWriteMultiplier and cacheReadMultiplier scale the cache prices', { options: { cacheWriteMultiplier: 2, cacheReadMultiplier: 1 } }, async ($, on) => {
  engine(on)
  // sonnet: 3 + 6 + 3 + 15 = 27
  expect(await run($ as never)).toMatch(/subagents \$27\.00 \(1\)/)
})

test('an unreadable priceTable falls back to the defaults', { options: { priceTable: 'nonsense' } }, async ($, on) => {
  engine(on)
  expect(await run($ as never)).toMatch(/subagents \$22\.05 \(1\)/)
})
