import type { On, SessionRateLimit } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const CONTEXT = { window: 200000, tokens: 1000, percent: 1 }
const measure = (rateLimits: SessionRateLimit[]) => ({ context: CONTEXT, rateLimits, changed: ['rateLimits' as const] })

// The engine's side: tools answer "ok", toasts are recorded, usage reads `limits`.
const engine = (on: On, limits: SessionRateLimit[]) => {
  const toasts: string[] = []
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } as never })
  on('ui.status', async () => ({ value: undefined }) as never)
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: limits } }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  return toasts
}
const bash = (agentId?: string) => ({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', ...(agentId ? { agentId } : {}) }) as never

test('crossing 85% toasts once, and the model reads one note on its next tool result', async ($, on) => {
  const toasts = engine(on, [])
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 86, resetsAt: '2026-10-08T14:00:00Z' }]) as never)
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 87, resetsAt: '2026-10-08T14:00:00Z' }]) as never)
  expect(toasts).toEqual(['Usage: the 7-day window is at 86% (resets 2026-10-08 14:00Z)'])

  const sub = await $.tool.call(bash('a9'))
  expect(sub.context ?? []).toEqual([])
  const first = await $.tool.call(bash())
  expect(first.context?.[0]).toMatch(/7-day usage window is at 86%.*refused at 95%/)
  const second = await $.tool.call(bash())
  expect(second.context ?? []).toEqual([])
})

test('70% toasts without telling the model, and a new window warns again', async ($, on) => {
  const toasts = engine(on, [])
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 71, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 72, resetsAt: '2026-10-06T10:00:00Z' }]) as never)
  expect(toasts.length).toBe(2)
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})

test('a spawn is refused at 95%', async ($, on) => {
  engine(on, [{ kind: 'seven_day', percentUsed: 95.2 }])
  const refused = await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  expect(refused.deny).toMatch(/7-day usage window is at 95.2%, at or past the 95% limit/)
})

test('below the limit the spawn goes ahead', async ($, on) => {
  engine(on, [{ kind: 'seven_day', percentUsed: 60 }, { kind: 'five_hour', percentUsed: 94.9 }])
  const spawned = await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  expect(spawned.agentId).toBe('a1')
})

test('if the usage read fails, the spawn still goes ahead', async ($, on) => {
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a2' }))
  const spawned = await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  expect(spawned.agentId).toBe('a2')
})

test('spawnGatePercent moves the refusal point', { options: { spawnGatePercent: 80 } }, async ($, on) => {
  engine(on, [{ kind: 'five_hour', percentUsed: 81 }])
  const refused = await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  expect(refused.deny).toMatch(/at or past the 80% limit/)
})

test('spawnGatePercent 0 never refuses', { options: { spawnGatePercent: 0 } }, async ($, on) => {
  engine(on, [{ kind: 'five_hour', percentUsed: 99 }])
  const spawned = await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' })
  expect(spawned.agentId).toBe('a1')
})

test('warnPercents sets where the toasts fire', { options: { warnPercents: '50, 60' } }, async ($, on) => {
  const toasts = engine(on, [])
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 55, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  expect(toasts.length).toBe(2)
})

test('tellModelAtPercent moves the point where the model is told', { options: { tellModelAtPercent: 70 } }, async ($, on) => {
  engine(on, [])
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 72, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  expect((await $.tool.call(bash())).context?.[0]).toMatch(/5-hour usage window is at 72%/)
})

test('tellModelAtPercent 0 never tells the model', { options: { tellModelAtPercent: 0 } }, async ($, on) => {
  const toasts = engine(on, [])
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  expect(toasts.length).toBe(1)
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})
