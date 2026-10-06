import type { PluginOptions, Register } from 'claude-code'

const SEPARATOR = '=>'

// One rule: when `type` matches the spawn's agent type and the spawn names `model` ('*' for any), the brief
// must match `reason`. An empty reason pattern refuses always. `message` replaces the default refusal text.
type Rule = { type: RegExp; model: string; reason: RegExp | undefined; message: string }

// A list option arrives as an array; a hand-edited settings.json may hold one newline-separated string.
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
  .map(s => String(s).trim()).filter(Boolean)

// "agent type pattern => model => brief pattern => message". A rule that does not parse is skipped.
function parseRule(text: string): Rule | undefined {
  const [type = '', model = '', reason = '', ...message] = text.split(SEPARATOR).map(s => s.trim())
  try {
    return {
      type: new RegExp(type === '*' || type === '' ? '.*' : type, 'i'),
      model: model.toLowerCase(),
      reason: reason ? new RegExp(reason, 'i') : undefined,
      message: message.join(` ${SEPARATOR} `),
    }
  } catch {
    return undefined
  }
}

const deny = (why: string) => ({ deny: `model-allowlist: ${why}` })

export const register: Register = (on, options: PluginOptions) => {
  const refusePinned = typeof options.refuse_pinned_ids === 'boolean' ? options.refuse_pinned_ids : true
  const aliases = new Set(list(options.allowed_aliases).map(a => a.toLowerCase()))
  const rules = list(options.rules).map(parseRule).filter((r): r is Rule => r !== undefined && r.model !== '')

  on('agent.spawn', async ($, e, next) => {
    const named = e.model?.trim().toLowerCase()
    if (!named) {
      return next(e) // the agent file's model, or the parent's: set by config, not by this call
    }
    const model = named.replace(/\[[^\]]*\]$/, '')

    if (refusePinned && !aliases.has(model)) {
      return deny(
        `"${e.model}" is a pinned model id. Name a tier alias instead (${[...aliases].join(', ')}), ` +
        'or leave the model out so the agent file or the parent decides.')
    }

    const type = e.subagentType ?? ''
    for (const rule of rules) {
      if ((rule.model === '*' || rule.model === model) && rule.type.test(type) && !(rule.reason?.test(e.prompt ?? ''))) {
        const text = rule.message ||
          (rule.reason
            ? `{type} may only use {model} when the brief says why (it must match /${rule.reason.source}/). ` +
              'Name the reason in the brief, or dispatch without a model.'
            : '{type} may not use {model}. Dispatch without a model, or name another one.')
        return deny(text.replaceAll('{type}', type || 'this agent type').replaceAll('{model}', model))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // if the check itself fails, the spawn goes ahead
}
