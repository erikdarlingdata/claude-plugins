import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tracked } from '../types'

const agents = atom({ plugin: 'subagent-wall', key: 'agents' } as const, {} as Record<string, Tracked>)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// What stays allowed past the limit: git and gh commands, and note writes.
const GIT_GH = /^(git|gh)(\s|$)/
const isNote = (path: unknown) => /\.(md|txt)$/.test(String(path ?? '').trim().toLowerCase())

function patch($: EngineInterface, id: string, fn: (t: Tracked) => Tracked) {
  return update($, agents, all => (all[id] ? { ...all, [id]: fn(all[id]) } : all))
}

export const register: Register = (on, options) => {
  const warnMs = Number(options.warnMinutes ?? 45) * 60000
  const limitMs = Number(options.limitMinutes ?? 60) * 60000
  const nudgeTokens = Number(options.noEditNudgeK ?? 100) * 1000
  // The agent types that change code; only they get the no-edit nudge.
  const codeTypes = new Set(
    String(options.codeAgentTypes ?? 'general-purpose')
      .split(/[\s,]+/)
      .filter(Boolean),
  )

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId
    if (id) {
      const startedAt = await $.clock.now()
      await update($, agents, all => ({
        ...all,
        [id]: { type: e.subagentType, startedAt, edits: 0, context: 0, hasTimeWarning: false, hasEditNudge: false },
      }))
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage
    if (e.agentId && usage) {
      const context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await patch($, e.agentId, t => ({ ...t, context }))
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await update($, agents, all => {
        const { [id]: _, ...rest } = all

        return rest
      })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    const tracked = id ? (await read($, agents))[id] : undefined
    if (!id || !tracked) {
      return next(e)
    }

    const elapsed = (await $.clock.now()) - tracked.startedAt
    const minutes = Math.floor(elapsed / 60000)

    if (limitMs > 0 && elapsed >= limitMs) {
      const isAllowed =
        e.tool === 'Bash' || e.tool === 'PowerShell'
          ? GIT_GH.test(String(e.command ?? '').trim())
          : e.tool === 'Write' || e.tool === 'Edit'
            ? isNote(e.file_path)
            : false
      if (!isAllowed) {
        return {
          deny:
            `subagent-wall: ${minutes} minutes, at or past the ${limitMs / 60000}-minute limit. ` +
            'From here only git/gh commands and .md/.txt writes are allowed. Commit, push, put your report ' +
            'in the PR body or your final message, and end your turn.',
        }
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }

    const notes: string[] = []
    const isEdit = EDIT_TOOLS.has(e.tool) && ran.isError !== true
    if (isEdit) {
      await patch($, id, t => ({ ...t, edits: t.edits + 1 }))
    }

    if (warnMs > 0 && elapsed >= warnMs && !tracked.hasTimeWarning) {
      await patch($, id, t => ({ ...t, hasTimeWarning: true }))
      notes.push(
        `subagent-wall: ${minutes} minutes in. At ${limitMs / 60000} minutes only git, gh and .md/.txt writes ` +
        'will be allowed. Start no new item: finish the one in hand, commit, push, and report.',
      )
    }

    if (nudgeTokens > 0 && codeTypes.has(tracked.type) && tracked.edits === 0 && !isEdit &&
        tracked.context >= nudgeTokens && !tracked.hasEditNudge) {
      await patch($, id, t => ({ ...t, hasEditNudge: true }))
      notes.push(
        `subagent-wall: about ${Math.round(tracked.context / 1000)}k tokens of context and no file edited yet. ` +
        'Stop exploring: make the change now from what you know, or report what blocks you.',
      )
    }

    return notes.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  }).catch(($, e, next) => next(e)) // if the wall itself fails, the call goes ahead (replayed if it already ran)
}
