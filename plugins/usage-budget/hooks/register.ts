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

const DEFAULT_PACE_MARGIN = 10
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

// "10" -> 10; 0 turns the pace check off; anything that does not parse to a non-negative number falls back to the default.
function parseMargin(value: unknown): number {
  const text = String(value ?? '').trim()
  const parsed = text === '' ? NaN : Number(text)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PACE_MARGIN
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`
const pts = (n: number) => String(Math.round(n * 10) / 10)

// How far the 7-day window's usage runs ahead of the share of the week that has passed, in points, and the UTC time
// at which that gap falls back under the margin if usage stays flat. Null when the check does not apply: another
// window, no reset time to measure the week from, or a gap under the margin.
type Pace = { used: number; elapsed: number; ahead: number; until: string }

function paceOf(w: SessionRateLimit, now: number, margin: number): Pace | null {
  const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  if (w.kind !== 'seven_day' || margin <= 0 || !Number.isFinite(resetsAt)) {
    return null
  }

  const elapsed = Math.min(100, Math.max(0, 100 * (1 - (resetsAt - now) / WEEK_MS)))
  const ahead = w.percentUsed - elapsed
  // The tiny slack keeps a gap of exactly the margin from slipping under it by floating-point error.
  if (ahead < margin - 1e-9) {
    return null
  }

  // Elapsed reaches (percentUsed - margin) at this moment; rounded up to the minute so the refusal is surely over by then.
  const liftsAt = resetsAt - WEEK_MS + ((w.percentUsed - margin) / 100) * WEEK_MS

  return { used: w.percentUsed, elapsed, ahead, until: utc(Math.ceil(liftsAt / MINUTE_MS - 1e-6) * MINUTE_MS) }
}

const paceFacts = (p: Pace) =>
  `the account's 7-day usage is at ${p.used}% with ${pts(p.elapsed)}% of the week passed, ${pts(p.ahead)} points ahead of pace`

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
  // New spawns are refused, and the seat warned, when 7-day usage runs this many points ahead of the share of the week
  // that has passed. 0 turns the check off.
  const paceMargin = parseMargin(options.paceMargin ?? DEFAULT_PACE_MARGIN)

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

    // Pace: warn once per window, and again each time the gap grows by another margin.
    const now = paceMargin > 0 && e.rateLimits.some(w => w.kind === 'seven_day' && w.resetsAt) ? await $.clock.now() : 0
    for (const w of e.rateLimits) {
      const pace = paceOf(w, now, paceMargin)
      if (!pace) {
        continue
      }

      const key = `${w.kind}:pace`
      const level = Math.floor((pace.ahead + 1e-9) / paceMargin)
      const prior = (await read($, warned))[key]
      const priorLevel = prior && prior.resetsAt === (w.resetsAt ?? '') ? prior.level : 0
      if (level <= priorLevel) {
        continue
      }

      await update($, warned, all => ({ ...all, [key]: { level, resetsAt: w.resetsAt ?? '' } }))
      $.ui.toast(`Usage: ${paceFacts(pace)} (limit ${paceMargin}). New subagents are refused until ${pace.until} if usage stays flat.`)
      if (tellModelAt > 0) {
        await update($, note, pending =>
          `${pending ? `${pending} ` : ''}usage-budget: ${paceFacts(pace)} (limit ${paceMargin}). New subagent spawns are refused ` +
          `until ${pace.until} (UTC) if usage stays flat. Start no new optional work, finish what is in flight, ` +
          'keep the handoff current, and tell the user.')
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

    if (paceMargin > 0) {
      const { rateLimits } = await $.session.usage()
      if (rateLimits.some(w => w.kind === 'seven_day' && w.resetsAt)) {
        const now = await $.clock.now()
        for (const w of rateLimits) {
          const pace = paceOf(w, now, paceMargin)
          if (pace) {
            return {
              deny:
                `usage-budget: ${paceFacts(pace)} (limit ${paceMargin} points). New subagents are refused until ${pace.until} ` +
                "(UTC) if usage stays flat. Spawn none; finish the work in hand, write the handoff, and tell the user. Erik's OK, " +
                'or waiting until that time, lifts it.',
            }
          }
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // if the check itself fails, the spawn goes ahead
}
