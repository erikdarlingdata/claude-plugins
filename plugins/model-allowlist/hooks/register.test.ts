import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

const spawn = async ($: Engine, subagentType: string, model: string | undefined, prompt = 'Fix the off-by-one in the grid.') =>
  (await $.agent.spawn({ prompt, description: 'x', subagentType, ...(model ? { model } : {}) })).deny

// Rules in the option's own syntax: agent type pattern => model => brief pattern => message.
const RULES = [
  '^(lane|worker-.*)$ => opus => \\b(design|security|hard[- ]debug)',
  '.* => fable => \\btie[- ]?break => A fable {type} is only for a tie-break between conflicting reviews, named in the brief.',
  '^scout$ => opus',
]

test('pinned model ids are refused; aliases and no model are not', async ($, on) => {
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  expect(await spawn($, 'worker-medium', 'claude-opus-4-8')).toMatch(/pinned model id/)
  expect(await spawn($, 'lane', 'claude-sonnet-5-5-20261001')).toMatch(/pinned model id/)
  expect(await spawn($, 'worker-medium', 'haiku')).toBeUndefined()
  expect(await spawn($, 'lane', undefined)).toBeUndefined()
  expect(await spawn($, 'code-reviewer', 'Sonnet')).toBeUndefined()
  expect(await spawn($, 'code-reviewer', 'opus[1m]')).toBeUndefined()
})

test('refuse_pinned_ids off lets a pinned id through', { options: { refuse_pinned_ids: false } }, async ($, on) => {
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  expect(await spawn($, 'worker-medium', 'claude-opus-4-8')).toBeUndefined()
})

test('allowed_aliases decides which names count as aliases', { options: { allowed_aliases: ['sonnet', 'best'] } }, async ($, on) => {
  on('agent.spawn', async () => ({ model: 'x', agentId: 'a1' }))
  expect(await spawn($, 'lane', 'best')).toBeUndefined()
  expect(await spawn($, 'lane', 'haiku')).toMatch(/pinned model id/)
})

test('with no rules, every alias is allowed for every agent type', async ($, on) => {
  on('agent.spawn', async () => ({ model: 'x', agentId: 'a1' }))
  expect(await spawn($, 'lane', 'opus')).toBeUndefined()
  expect(await spawn($, 'worker-high', 'fable', 'Review PR 12.')).toBeUndefined()
})

test('a rule refuses its model unless the brief matches', { options: { rules: RULES } }, async ($, on) => {
  on('agent.spawn', async () => ({ model: 'x', agentId: 'a3' }))
  expect(await spawn($, 'lane', 'opus')).toMatch(/lane may only use opus when the brief says why/)
  expect(await spawn($, 'worker-high', 'opus', 'Summarize the CI failures.')).toMatch(/worker-high may only use opus/)
  expect(await spawn($, 'worker-xhigh', 'opus', 'Write the design plan for the export filter.')).toBeUndefined()
  expect(await spawn($, 'lane', 'opus', 'Hard debugging: the worker crashes after a forced drop.')).toBeUndefined()
  expect(await spawn($, 'worker-high', 'opus', 'This is security-adjacent work.')).toBeUndefined()
  expect(await spawn($, 'tech-lead', 'opus')).toBeUndefined()
  expect(await spawn($, 'lane', 'sonnet')).toBeUndefined()
})

test('a rule with a message and a "*" agent type; a rule with no brief pattern always refuses', { options: { rules: RULES } }, async ($, on) => {
  on('agent.spawn', async () => ({ model: 'x', agentId: 'a2' }))
  expect(await spawn($, 'security-reviewer', 'fable', 'Review PR 5301.')).toBe(
    'model-allowlist: A fable security-reviewer is only for a tie-break between conflicting reviews, named in the brief.')
  expect(await spawn($, 'worker-xhigh', 'fable', 'Tie-break: the two reviews of PR 5301 conflict on the TLS check.')).toBeUndefined()
  expect(await spawn($, 'scout', 'opus', 'design the whole thing')).toMatch(/scout may not use opus/)
  expect(await spawn($, 'scout', 'haiku')).toBeUndefined()
})

test('a rule that is not a valid pattern is skipped, not fatal', { options: { rules: ['([ => opus => x', '^lane$ => opus => design'] } }, async ($, on) => {
  on('agent.spawn', async () => ({ model: 'x', agentId: 'a4' }))
  expect(await spawn($, 'lane', 'opus')).toMatch(/lane may only use opus/)
  expect(await spawn($, 'lane', 'opus', 'a design task')).toBeUndefined()
})
