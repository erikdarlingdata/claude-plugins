import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import type { Row } from '../types'

const rows = atom({ plugin: 'subagent-band', key: 'rows' } as const, {} as Record<string, Row>)
const isHidden = atom({ plugin: 'subagent-band', key: 'isHidden' } as const, false)
const mainCost = atom({ plugin: 'subagent-band', key: 'mainCost' } as const, 0)

const blank = (): Row => ({
  type: '?', description: '', model: '?', effort: '?', steps: 0, context: 0, advisor: 0, cost: 0, isDone: false,
  startedAt: 0, endedAt: 0, tools: 0, lastTool: '', outcome: '', steered: 0,
})

const FLEET = 'subagent-fleet'
const VITALS_TOOL = 'subagent_vitals'
const shortId = (id: string) => id.replace(/^a/, '').slice(0, 6)
const mins = (row: Row, now: number) => Math.max(0, Math.round(((row.endedAt || now) - row.startedAt) / 60000))

// One line per subagent: running ones first, then finished ones, newest first.
const fleetLines = (all: Record<string, Row>, now: number, includeFinished: boolean) => {
  const entries = Object.entries(all)
    .filter(([, row]) => includeFinished || !row.isDone)
    .sort(([, a], [, b]) => Number(a.isDone) - Number(b.isDone) || b.startedAt - a.startedAt)

  return entries.map(([id, row]) =>
    `${row.isDone ? `done(${row.outcome || '?'})` : 'running'} ${shortId(id)} ${row.type} ${row.model} ${row.effort} ` +
    `${mins(row, now)}m step ${row.steps} tools ${row.tools}${row.lastTool && !row.isDone ? ` (last ${row.lastTool})` : ''} ` +
    `ctx ${kilo(row.context)} ${usd(row.cost)}${row.advisor ? ` advisor ${row.advisor}` : ''}` +
    `${row.steered ? ` steered ${row.steered}` : ''} | ${row.description}`)
}

// claude-sonnet-5-5-20261001 -> sonnet-5-5
const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const usd = (n: number) => `$${n.toFixed(2)}`

// Prices per million tokens (input, output), by model family: "opus:5:25, sonnet:3:15" -> [['opus', 5, 25], ['sonnet', 3, 15]].
// A model whose id names none of the families is priced as the first one. Estimates, not the bill.
type Prices = { table: [string, number, number][]; cacheWrite: number; cacheRead: number }
const DEFAULT_PRICES = 'opus:5:25, sonnet:3:15, haiku:1:5'

function parsePrices(value: unknown, cacheWrite: unknown, cacheRead: unknown): Prices {
  const parse = (text: string) =>
    text
      .split(',')
      .map(part => part.trim().split(':'))
      .flatMap(([family = '', input, output]): [string, number, number][] =>
        family.trim() && Number.isFinite(Number(input)) && Number.isFinite(Number(output)) && input !== undefined && output !== undefined
          ? [[family.trim().toLowerCase(), Number(input), Number(output)]]
          : [])
  const table = parse(String(value ?? '')).length > 0 ? parse(String(value)) : parse(DEFAULT_PRICES)

  return { table, cacheWrite: Number(cacheWrite ?? 1.25), cacheRead: Number(cacheRead ?? 0.1) }
}

const stepCost = (u: TurnUsage, prices: Prices) => {
  const [, input, output] = prices.table.find(([family]) => u.model.toLowerCase().includes(family)) ?? prices.table[0]

  return (u.input_tokens * input + u.cache_creation_input_tokens * prices.cacheWrite * input +
    u.cache_read_input_tokens * prices.cacheRead * input + u.output_tokens * output) / 1e6
}

// The /subagent-cost report: this session's subagents by type, by issue number in the description, and the main session.
const report = (all: Record<string, Row>, main: number) => {
  const byType = new Map<string, { n: number; cost: number }>()
  const byIssue = new Map<string, number>()
  let total = 0
  for (const row of Object.values(all)) {
    const t = byType.get(row.type) ?? { n: 0, cost: 0 }
    byType.set(row.type, { n: t.n + 1, cost: t.cost + row.cost })
    for (const issue of new Set(row.description.match(/#\d+/g) ?? [])) {
      byIssue.set(issue, (byIssue.get(issue) ?? 0) + row.cost)
    }
    total += row.cost
  }
  const lines = [`Estimated list-price cost this session: subagents ${usd(total)} (${Object.keys(all).length}), main session ${usd(main)}`]
  for (const [type, t] of [...byType].sort((a, b) => b[1].cost - a[1].cost)) {
    lines.push(`  ${pad(type, 18)} ${pad(String(t.n), 4)} ${usd(t.cost)}`)
  }
  if (byIssue.size > 0) {
    lines.push('By issue number in the agent description:')
    for (const [issue, cost] of [...byIssue].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      lines.push(`  ${pad(issue, 8)} ${usd(cost)}`)
    }
  }

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const prices = parsePrices(options.priceTable ?? DEFAULT_PRICES, options.cacheWriteMultiplier, options.cacheReadMultiplier)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagent-band',
      description: 'Show or hide the band of running subagents (type, model, effort, cost)',
    })
    await $.command.register({
      name: 'subagent-cost',
      description: "This session's estimated subagent cost by agent type and issue number, and the main session's own",
    })
    await $.command.register({ name: 'fleet', description: 'Open a pane with every subagent of this session, running and finished' })
    await $.command.register({ name: 'steer', description: 'Send a running subagent a message: /steer <id from /fleet> <text>' })
    await $.tool.register({
      name: VITALS_TOOL,
      description:
        "This session's subagents now: id, type, model, effort, minutes, steps, tool calls, last tool, context, " +
        'estimated cost, and how finished ones ended. Cheap: use it instead of reading a subagent\'s output file ' +
        'to check progress. Never call it in a polling loop.',
      inputSchema: {
        type: 'object',
        properties: { includeFinished: { type: 'boolean', description: 'Also list finished subagents (default false).' } },
      },
    })

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async $ => {
    await $.ui.open({ id: FLEET, title: 'Subagent fleet' })

    return { text: 'Subagent fleet pane opened.' }
  })

  on('command.run', { command: 'steer' }, async ($, e) => {
    const [prefix = '', ...words] = e.args.trim().split(/\s+/)
    const text = words.join(' ').trim()
    if (!prefix || !text) {
      return { text: 'Usage: /steer <id from /fleet> <message>' }
    }
    const matches = Object.entries(await read($, rows)).filter(([id, row]) => !row.isDone && shortId(id).startsWith(prefix))
    if (matches.length !== 1) {
      return { text: matches.length === 0 ? `No running subagent with id ${prefix}.` : `${prefix} matches ${matches.length} subagents; give more of the id.` }
    }
    const [id, row] = matches[0]
    await $.session.send({ to: { agentId: id }, text })
    await update($, rows, all => ({ ...all, [id]: { ...all[id], steered: all[id].steered + 1 } }))

    return { text: `Sent to ${row.type} ${shortId(id)}${row.steered >= 1 ? ` (follow-up ${row.steered + 1})` : ''}.` }
  })

  on('tool.call', { tool: 'mcp__subagent-band__subagent_vitals' }, async ($, e) => {
    const input = e as unknown as { includeFinished?: boolean }
    const lines = fleetLines(await read($, rows), await $.clock.now(), input.includeFinished === true)
    const text = lines.length > 0 ? lines.join('\n') : 'No subagents are running.'

    return { result: text } as never
  })

  // A subagent's tool calls: how many, and the latest.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await update($, rows, all => (all[id] ? { ...all, [id]: { ...all[id], tools: all[id].tools + 1, lastTool: e.tool } } : all))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'subagent-band' }, async $ => {
    const hidden = await update($, isHidden, h => !h)

    return { text: hidden ? 'Subagent band hidden.' : 'Subagent band shown.' }
  })

  on('command.run', { command: 'subagent-cost' }, async $ => ({ text: report(await read($, rows), await read($, mainCost)) }))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId
    if (id) {
      const startedAt = await $.clock.now()
      await update($, rows, all => ({
        ...all,
        [id]: { ...blank(), type: e.subagentType, description: e.description, model: shortModel(spawned.model), startedAt },
      }))
    }

    return spawned
  }).catch(($, e, next) => next(e)) // an observer: if this hook fails, the spawn goes ahead (replayed, never run twice)

  // Every model request a subagent makes: the model and effort it actually ran at.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const id = e.agentId
    if (!id && response.usage) {
      const cost = stepCost(response.usage, prices)
      await update($, mainCost, total => total + cost)
    }
    if (id) {
      const usage = response.usage
      const advisor = (response.serverToolUses ?? []).filter(use => use.name === 'advisor').length
      await update($, rows, all => {
        const row = all[id] ?? blank()

        return {
          ...all,
          [id]: {
            ...row,
            model: shortModel(usage?.model ?? e.model),
            effort: e.effort === undefined ? 'none' : String(e.effort),
            steps: row.steps + 1,
            context: usage
              ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
              : row.context,
            advisor: row.advisor + advisor,
            cost: row.cost + (usage ? stepCost(usage, prices) : 0),
          },
        }
      })
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const endedAt = await $.clock.now()
      const outcome = e.reason
      await update($, rows, all => (all[id] ? { ...all, [id]: { ...all[id], isDone: true, endedAt, outcome } } : all))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: FLEET }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, rows)
    const lines = fleetLines(all, await $.clock.now(), true)
    const { rateLimits } = await $.session.usage()
    const usage = rateLimits.map(w => `${w.kind === 'five_hour' ? '5h' : w.kind === 'seven_day' ? '7d' : w.kind} ${Math.round(w.percentUsed)}%`).join(' · ')
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Text key="head" bold>
          {`${Object.values(all).filter(row => !row.isDone).length} running · subagents ${usd(Object.values(all).reduce((sum, row) => sum + row.cost, 0))} · main session ${usd(await read($, mainCost))} (est.)${usage ? ` · usage ${usage}` : ''}`}
        </Text>
        {lines.length === 0 && <Text key="none" dimColor>No subagents yet.</Text>}
        {lines.slice(0, room).map((line, i) => (
          <Text key={`l${i}`} dimColor={line.startsWith('done')}>{line}</Text>
        ))}
        <Text key="help" dimColor>{'/steer <id> <message> sends a running subagent a message.'}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const all = await read($, rows)
    const live = Object.entries(all).filter(([, row]) => !row.isDone)
    if (live.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {live.map(([id, row]) => (
          <Text key={id} dimColor>
            {pad(row.type, 14)} {pad(row.model, 12)} {pad(row.effort, 6)} step {row.steps} · ctx {kilo(row.context)}
            {row.advisor ? ` · advisor ${row.advisor}` : ''} · {usd(row.cost)} · {row.description}
          </Text>
        ))}
        <Text key="total" dimColor>
          {`subagents this session ${usd(Object.values(all).reduce((sum, row) => sum + row.cost, 0))} · main session ${usd(await read($, mainCost))} (est.)`}
        </Text>
      </Box>
    )
  })
}
