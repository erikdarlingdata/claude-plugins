export type Row = {
  type: string
  description: string
  model: string
  effort: string
  steps: number
  context: number
  advisor: number
  /** Estimated list-price cost so far, in USD. */
  cost: number
  isDone: boolean
  /** Clock times in ms; endedAt is 0 while it runs. */
  startedAt: number
  endedAt: number
  tools: number
  lastTool: string
  /** How its run ended (answer, aborted, error, refusal); '' while it runs. */
  outcome: string
  /** How many /steer messages the person sent it. */
  steered: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-band': { rows: Record<string, Row>; isHidden: boolean; mainCost: number }
  }
}
