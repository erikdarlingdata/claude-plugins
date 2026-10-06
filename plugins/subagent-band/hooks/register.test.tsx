import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The engine's side: an empty Box when no plugin draws, a clock at 0, usage at 7d 40%,
// tools that answer "ok", and every message sent kept in `sent`.
const engineBottom = (on: On) => {
  const sent: { to: unknown; text: string }[] = []
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40 }] } }) as never)
  on('session.send', async (_$, e) => {
    sent.push(e as never)
    return { isDelivered: true } as never
  })
  on('ui.open', async () => ({ value: {} }) as never)
  const clock = mock.clock(on, { now: 0 })

  return { sent, clock }
}

const BAND = { plugin: 'subagent-band', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true } } as const

test('a running subagent shows its type, model, effort and context, and leaves the band when its run ends', { options: { priceTable: 'opus:4:20, sonnet:2:10' } }, async ($, on) => {
  engineBottom(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5-20261001', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 },
    }
  })

  await $.agent.spawn({ prompt: 'Read README.md.', description: 'read the readme', subagentType: 'planner' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'a1' })
  for await (const _ of step) { /* drain */ }
  await step.result

  const ui = await $.ui.mount(BAND)
  const row = await ui.find({ type: 'Text', text: /planner/ })
  expect(row?.text).toMatch(/sonnet-5-5\s+high\s+step 1 · ctx 42k · \$0\.01 · read the readme/)

  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, reason: 'answer', text: '', agentId: 'a1' })
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: /planner/ })).toBeUndefined()
})

test('the main loop draws no row', async ($, on) => {
  engineBottom(on)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const step = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })
  for await (const _ of step) { /* drain */ }
  await step.result

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /opus/ })).toBeUndefined()
})

test('/subagent-cost totals by type and issue number, and counts the main session apart', { options: { priceTable: 'opus:4:20, sonnet:2:10' } }, async ($, on) => {
  engineBottom(on)
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: `b${++n}` }))
  on('turn.step', async function* (_$, e) {
    // 1M cache-read tokens on sonnet = $0.20; on opus = $0.40
    const model = e.agentId ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0 } }
  })
  const drain = async (agentId?: string) => {
    const s = $.turn.step({ turnId: 't', index: 0, model: 'x', effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of s) { /* drain */ }
    await s.result
  }

  await $.agent.spawn({ prompt: 'x', description: 'fix #101 tests', subagentType: 'builder' })
  await $.agent.spawn({ prompt: 'x', description: 'plan #101 and #102', subagentType: 'planner' })
  await drain('b1')
  await drain('b2')
  await drain('b2')
  await drain()

  const out = await $.command.run({ command: 'subagent-cost', args: '' } as never)
  const text = (out as { text: string }).text
  expect(text).toMatch(/subagents \$0\.60 \(2\), main session \$0\.40/)
  expect(text).toMatch(/planner\s+1\s+\$0\.40/)
  expect(text).toMatch(/builder\s+1\s+\$0\.20/)
  expect(text).toMatch(/#101\s+\$0\.60/)
  expect(text).toMatch(/#102\s+\$0\.40/)
})

test('subagent_vitals lists running subagents with minutes, tool calls and last tool; finished ones on request', async ($, on) => {
  const { clock } = engineBottom(on)
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: `a${++n}abcdef` }))
  await $.agent.spawn({ prompt: 'x', description: 'fix #101', subagentType: 'builder' })
  await $.agent.spawn({ prompt: 'x', description: 'plan #102', subagentType: 'planner' })
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', pattern: 'x', agentId: 'a1abcdef' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'ls', agentId: 'a1abcdef' } as never)
  await clock.advance(12 * 60000)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', text: '', agentId: 'a2abcdef' })

  const vitals = async (includeFinished?: boolean) =>
    String((await $.tool.call({ tool: 'mcp__subagent-band__subagent_vitals', tool_use_id: 'v', ...(includeFinished ? { includeFinished } : {}) } as never)).result)
  const running = await vitals()
  expect(running).toMatch(/^running 1abcde builder sonnet-5-5 \? 12m step 0 tools 2 \(last Bash\) ctx 0 \$0\.00 \| fix #101$/)
  expect(running).not.toMatch(/planner/)
  expect(await vitals(true)).toMatch(/done\(answer\) 2abcde planner .* 12m /)
})

test('/steer sends one running subagent the message and counts it; a bad id sends nothing', async ($, on) => {
  const { sent } = engineBottom(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a9f00ba' }))
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })

  const run = async (args: string) => ((await $.command.run({ command: 'steer', args } as never)) as { text: string }).text
  expect(await run('zzz stop')).toMatch(/No running subagent with id zzz/)
  expect(await run('9f0')).toMatch(/Usage/)
  expect(await run('9f0 stop after this file and push')).toMatch(/Sent to builder 9f00ba\.$/)
  expect(sent).toEqual([expect.objectContaining({ to: 'a9f00ba', text: 'stop after this file and push' })])
  expect(await run('9f0 one more')).toMatch(/follow-up 2/)
})

test('the /fleet pane shows the usage, the totals and a line per subagent', async ($, on) => {
  engineBottom(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a7c0ffee' }))
  await $.agent.spawn({ prompt: 'x', description: 'fix #103', subagentType: 'builder' })

  const pane = await $.ui.mount({ plugin: 'subagent-band', surface: 'terminal', component: 'Pane', props: {} as never, requestId: 'subagent-fleet' })
  expect((await pane.find({ type: 'Text', text: /running · subagents/ }))?.text).toMatch(/^1 running · subagents \$0\.00 · main session \$0\.00 \(est\.\) · usage 7d 40%$/)
  expect((await pane.find({ type: 'Text', text: /running 7c0ffe builder/ }))?.text).toMatch(/fix #103$/)
})
