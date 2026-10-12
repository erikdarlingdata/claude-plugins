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
  expect(await run($ as never)).toMatch(/subagents \$14\.70 \(1\), main session \$29\.40/)
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

// The main session runs claude-haiku-5-5 and the subagent claude-haiku-4-5, each taking one step with `usage`.
const haikuEngine = (on: On, usage: { input: number; output: number; read?: number; write?: number }) => {
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  on('turn.step', async function* (_$, e) {
    const model = e.agentId ? 'claude-haiku-4-5' : 'claude-haiku-5-5'
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model, input_tokens: usage.input, output_tokens: usage.output,
        cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.write ?? 0 } }
  })
  mock.clock(on, { now: 0 })
}

test('the default prices price claude-haiku-5-5 at $0.10/$0.50 and claude-haiku-4-5 at $1/$5', async ($, on) => {
  haikuEngine(on, { input: 100000, output: 100000 })
  // haiku-4-5 at $1/$5: 0.10 + 0.50 = 0.60; haiku-5-5 at $0.10/$0.50, a prompt of exactly 100k: 0.01 + 0.05 = 0.06
  expect(await run($ as never)).toMatch(/subagents \$0\.60 \(1\), main session \$0\.06/)
})

test('a claude-haiku-5-5 prompt over 100k tokens is priced at 5x for the whole request, not claude-haiku-4-5', async ($, on) => {
  haikuEngine(on, { input: 100001, output: 100000 })
  // haiku-5-5 over 100k, $0.50/$2.50: 0.05 + 0.25 = 0.30; haiku-4-5 has no long-prompt tier: 0.60
  expect(await run($ as never)).toMatch(/subagents \$0\.60 \(1\), main session \$0\.30/)
})

test('the 100k tier counts cache reads and cache writes in the prompt, and scales their prices', async ($, on) => {
  // 1000 + 98999 + 1 = 100000 tokens of prompt: standard prices
  haikuEngine(on, { input: 1000, read: 98999, write: 1, output: 1000000 })
  // standard: output 0.50 + input 0.0001 + read 0.00098999 + write 0.000000125 = 0.50109 -> $0.50
  expect(await run($ as never)).toMatch(/main session \$0\.50/)
})

test('one more cached token puts the request over 100k and the whole request, cache prices included, at 5x', async ($, on) => {
  haikuEngine(on, { input: 1000, read: 99000, write: 1, output: 1000000 })
  // 100001 tokens of prompt: 5 x (0.50 + 0.0001 + 0.00099 + 0.000000125) = 2.5054... -> $2.51
  expect(await run($ as never)).toMatch(/main session \$2\.51/)
})

test('cacheWriteMultiplier and cacheReadMultiplier scale the cache prices', { options: { cacheWriteMultiplier: 2, cacheReadMultiplier: 1 } }, async ($, on) => {
  engine(on)
  // sonnet: 3 + 6 + 3 + 15 = 27
  expect(await run($ as never)).toMatch(/subagents \$18\.00 \(1\)/)
})

test('an unreadable priceTable falls back to the defaults', { options: { priceTable: 'nonsense' } }, async ($, on) => {
  engine(on)
  expect(await run($ as never)).toMatch(/subagents \$14\.70 \(1\)/)
})
