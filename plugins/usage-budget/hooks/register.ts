import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { Warned } from '../types'

const DEFAULT_THRESHOLDS = [70, 85, 95]

// "70, 85, 95" -> [70, 85, 95]; anything that does not parse to at least one percent falls back to the defaults.
function parsePercents(value: unknown): number[] {
  const parsed = String(value ?? '')
    .split(/[\s,]+/)
    .map(v => Number(v))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100)

  return parsed.length > 0 ? parsed : DEFAULT_THRESHOLDS
}

const warned = atom({ plugin: 'usage-budget', key: 'warned' } as const, {} as Record<string, Warned>)
const note = atom({ plugin: 'usage-budget', key: 'note' } as const, null as string | null)

const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day' }
const name = (kind: string) => NAMES[kind] ?? kind
const short = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind)
const resets = (w: SessionRateLimit) => (w.resetsAt ? ` (resets ${w.resetsAt.slice(0, 16).replace('T', ' ')}Z)` : '')

export const register: Register = (on, options) => {
  const gate = Number(options.spawnGatePercent ?? 95)
  const thresholds = parsePercents(options.warnPercents ?? DEFAULT_THRESHOLDS.join(', '))
  // From this level on, the main session's model is told too, not just the person. 0 never tells the model.
  const tellModelAt = Number(options.tellModelAtPercent ?? 85)

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      $.ui.status(e.rateLimits.map(w => `${short(w.kind)} ${Math.round(w.percentUsed)}%`).join(' · '))
    }

    for (const w of e.rateLimits) {
      const level = Math.max(0, ...thresholds.filter(t => w.percentUsed >= t))
      const resetsAt = w.resetsAt ?? ''
      const prior = (await read($, warned))[w.kind]
      const priorLevel = prior && prior.resetsAt === resetsAt ? prior.level : 0
      if (level <= priorLevel) {
        continue
      }

      await update($, warned, all => ({ ...all, [w.kind]: { level, resetsAt } }))
      $.ui.toast(`Usage: the ${name(w.kind)} window is at ${w.percentUsed}%${resets(w)}`)
      if (tellModelAt > 0 && level >= tellModelAt) {
        const gateLine = gate > 0
          ? level >= gate
            ? ` New subagent spawns are now refused (limit ${gate}%).`
            : ` New subagent spawns will be refused at ${gate}%.`
          : ''
        await update($, note, () =>
          `usage-budget: the account's ${name(w.kind)} usage window is at ${w.percentUsed}%${resets(w)}.` +
          `${gateLine} Start no new optional work, finish what is in flight, keep the handoff current, and tell the user.`)
      }
    }

    return next(e)
  })

  // Hand a pending note to the model on its next tool result (main session only).
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined) {
      return ran
    }

    const pending = await read($, note)
    if (!pending) {
      return ran
    }

    await update($, note, () => null)

    return { ...ran, context: [...(ran.context ?? []), pending] }
  }).catch(($, e, next) => next(e)) // never in the way of a tool call: replays what already ran

  on('agent.spawn', async ($, e, next) => {
    if (gate > 0) {
      const { rateLimits } = await $.session.usage()
      const over = rateLimits.find(w => w.percentUsed >= gate)
      if (over) {
        return {
          deny:
            `usage-budget: the account's ${name(over.kind)} usage window is at ${over.percentUsed}%${resets(over)}, ` +
            `at or past the ${gate}% limit for new subagents. Spawn none; finish the work in hand, write the handoff, and tell the user.`,
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // if the check itself fails, the spawn goes ahead
}
