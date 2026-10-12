import type { On, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The clock stands where a 7-day window ending on RESETS is 100% elapsed, so no existing test is ahead of pace.
const DEFAULT_NOW = Date.parse('2026-10-08T14:00:00Z')
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const RESETS = '2026-10-08T00:00:00Z'
// A week that began 2026-10-01 00:00Z, and 4.2 days (60%) of it gone: 2026-10-05 04:48Z.
const SIXTY_PERCENT = Date.parse('2026-10-01T00:00:00Z') + Math.round(0.6 * WEEK_MS)

const CONTEXT = { window: 200000, tokens: 1000, percent: 1 }
const measure = (rateLimits: SessionRateLimit[]) => ({ context: CONTEXT, rateLimits, changed: ['rateLimits' as const] })

// The engine's side: tools answer "ok", toasts are recorded, usage reads `limits`.
const engine = (on: On, limits: SessionRateLimit[], now = DEFAULT_NOW) => {
  const toasts: string[] = []
  mock.clock(on, { now })
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

// Pace: 60% of the week has passed at SIXTY_PERCENT, so 7-day usage of 70% runs exactly 10 points ahead.
const sevenDay = (percentUsed: number, resetsAt: string | undefined = RESETS) =>
  ({ kind: 'seven_day', percentUsed, ...(resetsAt ? { resetsAt } : {}) }) as SessionRateLimit
const spawn = ($: { agent: { spawn: (i: never) => Promise<{ deny?: string; agentId?: string }> } }) =>
  $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'builder' } as never)
const paceToasts = (toasts: string[]) => toasts.filter(t => /ahead of pace/.test(t))

test('usage exactly 10 points ahead of the week refuses a spawn, and says when it lifts', async ($, on) => {
  engine(on, [sevenDay(70)], SIXTY_PERCENT)
  const refused = await spawn($ as never)
  expect(refused.deny).toMatch(/7-day usage is at 70% with 60% of the week passed, 10 points ahead of pace/)
  // Flat usage at 70% is 10 ahead until 60% of the week has passed: now.
  expect(refused.deny).toMatch(/refused until 2026-10-05 04:48Z \(UTC\) if usage stays flat/)
  expect(refused.deny).toMatch(/Erik's OK, or waiting until that time, lifts it/)
})

test('the refusal lifts when elapsed reaches usage minus the margin', async ($, on) => {
  engine(on, [sevenDay(75)], SIXTY_PERCENT)
  // 75% used: the gap is back to 10 at 65% elapsed, 4.55 days into the week.
  expect((await spawn($ as never)).deny).toMatch(/15 points ahead of pace.*until 2026-10-05 13:12Z/)
})

test('usage 9.9 points ahead lets a spawn go ahead', async ($, on) => {
  const toasts = engine(on, [sevenDay(69.9)], SIXTY_PERCENT)
  expect((await spawn($ as never)).agentId).toBe('a1')
  await $.session.measure(measure([sevenDay(69.9)]) as never)
  expect(paceToasts(toasts)).toEqual([])
})

test('paceMargin 0 turns the pace check off', { options: { paceMargin: 0 } }, async ($, on) => {
  const toasts = engine(on, [sevenDay(90)], SIXTY_PERCENT)
  expect((await spawn($ as never)).agentId).toBe('a1')
  await $.session.measure(measure([sevenDay(90)]) as never)
  expect(paceToasts(toasts)).toEqual([])
})

test('paceMargin moves the margin', { options: { paceMargin: 15 } }, async ($, on) => {
  engine(on, [sevenDay(74.9)], SIXTY_PERCENT)
  expect((await spawn($ as never)).agentId).toBe('a1')
})

test('a negative paceMargin falls back to 10', { options: { paceMargin: -5 } }, async ($, on) => {
  engine(on, [sevenDay(70)], SIXTY_PERCENT)
  expect((await spawn($ as never)).deny).toMatch(/10 points ahead of pace \(limit 10 points\)/)
})

test('without resetsAt there is no pace check', async ($, on) => {
  const toasts = engine(on, [sevenDay(90, '')], SIXTY_PERCENT)
  expect((await spawn($ as never)).agentId).toBe('a1')
  await $.session.measure(measure([sevenDay(90, '')]) as never)
  expect(paceToasts(toasts)).toEqual([])
})

test('the 5-hour window is not paced', async ($, on) => {
  engine(on, [{ kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-05T09:00:00Z' }], SIXTY_PERCENT)
  expect((await spawn($ as never)).agentId).toBe('a1')
})

test('the pace warning fires once per window, again as the gap doubles, and again in a new window', async ($, on) => {
  const toasts = engine(on, [], SIXTY_PERCENT)
  await $.session.measure(measure([sevenDay(72)]) as never)
  await $.session.measure(measure([sevenDay(73)]) as never)
  expect(paceToasts(toasts).length).toBe(1)
  expect(paceToasts(toasts)[0]).toMatch(/7-day usage is at 72% with 60% of the week passed, 12 points ahead of pace.*refused until 2026-10-05 08:10Z/)

  // Another margin on top of the first level warns again, once.
  await $.session.measure(measure([sevenDay(81)]) as never)
  await $.session.measure(measure([sevenDay(82)]) as never)
  expect(paceToasts(toasts).length).toBe(2)

  // A new window (a later resetsAt) starts over.
  await $.session.measure(measure([sevenDay(72, '2026-10-12T04:48:00Z')]) as never)
  expect(paceToasts(toasts).length).toBe(3)
})

test('the model gets one pace note on its next tool result', async ($, on) => {
  engine(on, [], SIXTY_PERCENT)
  await $.session.measure(measure([sevenDay(75)]) as never)
  await $.session.measure(measure([sevenDay(76)]) as never)
  const first = await $.tool.call(bash())
  expect(first.context?.[0]).toMatch(/7-day usage is at 75%.*15 points ahead of pace.*refused until 2026-10-05 13:12Z/)
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})

test('the 95% gate still refuses at its percent, ahead of pace or not', async ($, on) => {
  engine(on, [sevenDay(95.2)], SIXTY_PERCENT)
  expect((await spawn($ as never)).deny).toMatch(/7-day usage window is at 95.2%.*at or past the 95% limit/)
})

test('the 95% gate still refuses with the pace check off', { options: { paceMargin: 0 } }, async ($, on) => {
  engine(on, [sevenDay(95.2)], SIXTY_PERCENT)
  expect((await spawn($ as never)).deny).toMatch(/at or past the 95% limit/)
})

test('tellModelAtPercent 0 never tells the model', { options: { tellModelAtPercent: 0 } }, async ($, on) => {
  const toasts = engine(on, [])
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: '2026-10-06T05:00:00Z' }]) as never)
  expect(toasts.length).toBe(1)
  expect((await $.tool.call(bash())).context ?? []).toEqual([])
})
