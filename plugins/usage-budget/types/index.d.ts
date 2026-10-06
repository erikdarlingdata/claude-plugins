/** The highest threshold already announced for one window, until that window resets. */
export type Warned = { level: number; resetsAt: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-budget': { warned: Record<string, Warned>; note: string | null }
  }
}
