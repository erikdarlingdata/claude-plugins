export type Tracked = {
  type: string
  startedAt: number
  edits: number
  context: number
  hasTimeWarning: boolean
  hasEditNudge: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-wall': { agents: Record<string, Tracked> }
  }
}
