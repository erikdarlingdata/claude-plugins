import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, Book } from '../types'

// One entry in the plugin's own store per session id, so a resumed or restarted session keeps its open asks.
// A new session id (/clear) starts empty. An entry is removed when its last ask is settled.
const KEY_PREFIX = 'asks:'
const DAY_MS = 86400000
const ADD = 'mcp__open-asks__ask_add'
const RESOLVE = 'mcp__open-asks__ask_resolve'
const LIST = 'mcp__open-asks__ask_list'

// Sent once per session in the system prompt (static text, so it caches); the tool descriptions say the rest.
const RULE = {
  id: 'open-asks:rule',
  scope: 'session',
  text:
    'Open asks: every time a reply asks the user a question or leaves a decision to them, record each one with ' +
    'ask_add before the reply ends: the full question with the context needed to answer it, and your ' +
    'recommendation. When a user message answers, declines or moots one, call ask_resolve with its id before acting ' +
    'on it. Whenever a reply mentions open asks, write each one out in full with your recommendation; never refer to ' +
    'them by id or number alone.',
} as const

const book = atom({ plugin: 'open-asks', key: 'book' } as const, { asks: [], nextId: 1 } as Book)
const isHidden = atom({ plugin: 'open-asks', key: 'isHidden' } as const, false)

// The session the entry belongs to: set at session.start, '' for a run that never started one.
let sessionId = ''

// The limits come from the plugin's options; register() sets them before any hook runs.
let maxText = 400
let maxShown = 6

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const line = (ask: Ask) => `[${ask.id}] ${clip(ask.text, maxText)}${ask.from ? ` (for ${ask.from})` : ''}`
const rec = (ask: Ask) => (ask.recommendation ? `Recommend: ${clip(ask.recommendation, maxText)}` : '')

function listing(all: Book): string {
  const rows = all.asks.flatMap(ask => (rec(ask) ? [line(ask), `    ${rec(ask)}`] : [line(ask)]))

  return all.asks.length === 0 ? 'No open asks.' : [`Open asks (${all.asks.length}):`, ...rows].join('\n')
}

async function save($: EngineInterface, next: Book) {
  if (sessionId) {
    await (next.asks.length > 0 ? $.store.set(KEY_PREFIX + sessionId, next) : $.store.delete(KEY_PREFIX + sessionId)).catch(() => undefined)
  }
}

async function change($: EngineInterface, fn: (all: Book) => Book): Promise<Book> {
  await update($, book, fn)
  const now = await read($, book)
  await save($, now)

  return now
}

// Ids from a tool input or a command argument: a number, an array of them, or text like "2, 5 7".
function idsOf(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)

  return raw.map(v => Number(v)).filter(n => Number.isInteger(n) && n > 0)
}

async function add($: EngineInterface, text: string, recommendation: string, from: string): Promise<{ ask: Ask | null; all: Book }> {
  const clean = oneLine(text)
  if (!clean) {
    return { ask: null, all: await read($, book) }
  }
  const at = await $.clock.now()
  let made: Ask | null = null
  const all = await change($, b => {
    // The same question asked again keeps its id instead of piling up; a newer recommendation replaces the older one.
    const same = b.asks.find(a => a.text.toLowerCase() === clean.toLowerCase())
    if (same) {
      const kept: Ask = { ...same, recommendation: oneLine(recommendation) || same.recommendation || '' }
      made = kept
      return { ...b, asks: b.asks.map(a => (a.id === same.id ? kept : a)) }
    }
    made = { id: b.nextId, text: clean, recommendation: oneLine(recommendation), from: oneLine(from), addedAt: at }
    return { asks: [...b.asks, made], nextId: b.nextId + 1 }
  })

  return { ask: made, all }
}

async function resolve($: EngineInterface, ids: number[]): Promise<{ gone: number[]; all: Book }> {
  const before = await read($, book)
  const gone = before.asks.filter(a => ids.includes(a.id)).map(a => a.id)
  const all = await change($, b => ({ ...b, asks: b.asks.filter(a => !ids.includes(a.id)) }))

  return { gone, all }
}

// Entries left by sessions that never settled their asks go after keepDays, so the store does not grow for ever.
async function prune($: EngineInterface, keepDays: number) {
  if (keepDays <= 0) {
    return
  }
  const cutoff = (await $.clock.now()) - keepDays * DAY_MS
  for (const key of (await $.store.keys()).filter(k => k.startsWith(KEY_PREFIX) && k !== KEY_PREFIX + sessionId)) {
    const old = (await $.store.get(key)) as Book | undefined
    const newest = Math.max(0, ...(old?.asks ?? []).map(a => a.addedAt))
    if (newest < cutoff) {
      await $.store.delete(key)
    }
  }
}

export const register: Register = (on, options) => {
  maxText = Math.max(40, Number(options.maxQuestionChars ?? 400))
  maxShown = Math.max(1, Number(options.maxBandAsks ?? 6))
  const keepDays = Number(options.keepDays ?? 30)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()
    await prune($, keepDays).catch(() => undefined)
    const saved = (await $.store.get(KEY_PREFIX + sessionId).catch(() => undefined)) as Book | undefined
    await update($, book, () => (saved && Array.isArray(saved.asks) ? saved : { asks: [], nextId: 1 }))

    await $.command.register({
      name: 'asks',
      description: 'The questions this session is waiting on you for. /asks done <ids> drops answered ones; /asks hide|show|clear',
    })
    await $.tool.register({
      name: 'ask_add',
      description:
        'Record a question or decision you are waiting on from the user. It stays in a band above their prompt until ' +
        'settled, so it does not get lost in scrollback, and the user answers from the band alone: never make them ' +
        'scroll back or ask what it means. Call it every time your reply asks the user something or leaves a decision ' +
        'to them, one call per question. text is the full question in plain words with the context needed to answer ' +
        'it (the issue number, what is at stake, the numbers that matter), up to about 300 characters, no internal ' +
        'jargon. recommendation is your answer and its reason in one sentence. For a question another agent asked ' +
        'you to relay, set from to the name of that agent. Returns the id.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The full question with the context needed to answer it, as the user would read it.' },
          recommendation: { type: 'string', description: 'Your recommended answer and its one-line reason.' },
          from: { type: 'string', description: "The name of the agent whose question you are relaying; omit for your own." },
        },
        required: ['text', 'recommendation'],
      },
    })
    await $.tool.register({
      name: 'ask_resolve',
      description:
        'Remove open asks that the user answered, declined or made moot, by id. Call it as soon as a user message ' +
        'settles one, and before acting on the answer. Also when you settle one yourself because it no longer applies.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'integer' }, description: 'The ids from ask_add or ask_list.' } },
        required: ['ids'],
      },
    })
    await $.tool.register({
      name: 'ask_list',
      description: 'The open asks with their ids. Use it after a compaction, or when unsure which ids are still open.',
      inputSchema: { type: 'object', properties: {} },
    })

    return started
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections.filter(s => s.id !== RULE.id), RULE] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ADD }, async ($, e) => {
    if (e.agentId) {
      return { result: 'Subagents do not record asks: put the question in your report to the session that dispatched you.' } as never
    }
    const input = e as unknown as { text?: string; recommendation?: string; from?: string }
    const { ask, all } = await add($, input.text ?? '', input.recommendation ?? '', input.from ?? '')
    const head = ask ? `Recorded as [${ask.id}].` : 'Nothing recorded: the text was empty.'

    return { result: `${head}\n${listing(all)}` } as never
  })

  on('tool.call', { tool: RESOLVE }, async ($, e) => {
    const input = e as unknown as { ids?: unknown }
    const { gone, all } = await resolve($, idsOf(input.ids))
    const head = gone.length > 0 ? `Resolved ${gone.map(id => `[${id}]`).join(' ')}.` : 'No open ask had those ids.'

    return { result: `${head}\n${listing(all)}` } as never
  })

  on('tool.call', { tool: LIST }, async $ => ({ result: listing(await read($, book)) }) as never)

  on('command.run', { command: 'asks' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'done' || verb === 'drop') {
      const { gone, all } = await resolve($, idsOf(rest.join(' ')))
      return { text: `${gone.length > 0 ? `Dropped ${gone.map(id => `[${id}]`).join(' ')}.` : 'No open ask had those ids.'}\n${listing(all)}` }
    }
    if (verb === 'clear') {
      await change($, b => ({ ...b, asks: [] }))
      return { text: 'Cleared every open ask.' }
    }
    if (verb === 'hide' || verb === 'show') {
      await update($, isHidden, () => verb === 'hide')
      return { text: verb === 'hide' ? 'The asks band is hidden. /asks show brings it back.' : 'The asks band is showing.' }
    }

    return { text: `${listing(await read($, book))}\n/asks done <ids> drops answered ones.` }
  })

  // Composes with any band beneath it (such as subagent-band's), so both show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return below
    }
    const { asks } = await read($, book)
    if (asks.length === 0) {
      return below
    }

    const { Box, Text } = $.ui.resolve(e)
    // Each ask takes two rows or more (a long question wraps); show the newest that fit and point at /asks for the rest.
    const room = Math.max(1, Math.min(maxShown, Math.floor(((e.props.maxRows ?? 12) - 1) / 3)))
    const shown = asks.slice(-room)
    const hidden = asks.length - shown.length

    return (
      <Box flexDirection="column">
        <Text key="head" bold color="yellow">{`Waiting on you (${asks.length})${hidden > 0 ? ` · ${hidden} older: /asks` : ''}`}</Text>
        {shown.flatMap(ask => [
          <Text key={`a${ask.id}`}>{line(ask)}</Text>,
          ...(rec(ask) ? [<Text key={`r${ask.id}`} dimColor>{`    ${rec(ask)}`}</Text>] : []),
        ])}
        {below ?? null}
      </Box>
    )
  })
}
