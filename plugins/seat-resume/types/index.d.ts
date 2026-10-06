/** One interactive session in the session registry (one JSON file per session id). */
export type Entry = {
  sessionId: string
  /** The session's name as ListAgents shows it (from Claude Code's own ~/.claude/sessions/<pid>.json); '' until known. */
  name: string
  cwd: string
  /** As the last prompt's hook input reported it (default, acceptEdits, bypassPermissions, plan, ...); '' until the first prompt. */
  permissionMode: string
  startedAt: string
  lastActive: string
  /**
   * '' while it runs or after it died without an end; 'exited' when the person left (/exit, ctrl+c, /clear);
   * 'interrupted' when the process was told to stop (terminal closed, SIGTERM, SIGHUP).
   */
  ended: '' | 'exited' | 'interrupted'
}
