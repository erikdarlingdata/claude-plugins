import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Entry } from '../types'

// One JSON file per interactive session id, in the registry folder. scripts/resume-sessions.ps1 decides which ones
// died, from these files and the pids in Claude Code's own <config>/sessions/<pid>.json, and reopens them.

type Where = { registry: string; sessions: string; script: string; powershell: string; terminal: string }

const slashes = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

// The folders and the script, from the options; an empty option means the default under the Claude config folder.
async function whereOf($: EngineInterface, options: PluginOptions): Promise<Where> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const config = slashes(configDir || `${home}/.claude`)

  return {
    registry: slashes(text(options.registry_dir, `${config}/session-registry`)),
    sessions: slashes(text(options.sessions_dir, `${config}/sessions`)),
    script: slashes(text(options.resume_script, `${$.plugin.root}/scripts/resume-sessions.ps1`)),
    powershell: text(options.powershell, 'pwsh'),
    terminal: text(options.terminal, 'wezterm'),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// This process's entry; null for a -p run. A reload starts it over from the file.
let entry: Entry | null = null
// This process's <sessions folder>/<pid>.json, once found: where its name comes from.
let pidFile = ''

async function save($: EngineInterface, where: Where, next: Entry) {
  entry = next
  await $.fs.write(`${where.registry}/${next.sessionId}.json`, `${JSON.stringify(next, null, 2)}\n`)
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  return $.fs.read(path).then(body => JSON.parse(String(body)) as T).catch(() => null)
}

// The name ListAgents shows for this session. The pid file can appear after session.start, so this retries until found.
async function nameOf($: EngineInterface, where: Where, sessionId: string): Promise<string> {
  if (!pidFile) {
    const files = await $.fs.list(where.sessions).catch(() => [])
    for (const f of files) {
      if (f.kind === 'file' && f.name.endsWith('.json')) {
        const one = await readJson<{ sessionId?: string }>($, `${where.sessions}/${f.name}`)
        if (one?.sessionId === sessionId) {
          pidFile = `${where.sessions}/${f.name}`
          break
        }
      }
    }
  }
  const own = pidFile ? await readJson<{ sessionId?: string; name?: string }>($, pidFile) : null

  return own?.sessionId === sessionId ? own.name ?? '' : ''
}

// The entry for the session running now: the saved one when it has this id (a reload, a resume), else a new one (/clear).
async function current($: EngineInterface, where: Where, cwd: string): Promise<Entry> {
  const sessionId = await $.session.id()
  if (entry?.sessionId === sessionId) {
    return entry
  }
  pidFile = ''
  const saved = await readJson<Entry>($, `${where.registry}/${sessionId}.json`)
  const now = iso(await $.clock.now())

  return {
    sessionId,
    name: saved?.name ?? '',
    cwd,
    permissionMode: saved?.permissionMode ?? entry?.permissionMode ?? '',
    startedAt: saved?.startedAt ?? now,
    lastActive: now,
    ended: '',
  }
}

async function touch($: EngineInterface, where: Where, permissionMode?: string) {
  if (!entry) {
    return
  }
  const base = await current($, where, entry.cwd)
  await save($, where, {
    ...base,
    name: (await nameOf($, where, base.sessionId)) || base.name,
    permissionMode: permissionMode ?? base.permissionMode,
    lastActive: iso(await $.clock.now()),
    ended: '',
  })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'resume-sessions',
      description: 'List the interactive sessions that died or were interrupted in the last 72 hours, with the command that reopens each',
    })
    if (e.isInteractive) {
      const where = await whereOf($, options)
      entry = null
      await save($, where, await current($, where, e.cwd))
    }

    return started
  }).catch(($, e, next) => next(e))

  // Each prompt's hook input carries the permission mode the session runs in.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await touch($, await whereOf($, options), e.permission_mode)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A session driven by peer messages may never get a typed prompt: its own tool calls carry the mode too.
  // Written only when the mode changes (or the name is still missing), so the common call costs nothing.
  on('classic.PreToolUse', async ($, e, next) => {
    if (entry && !e.agent_id && e.permission_mode && (e.permission_mode !== entry.permissionMode || !entry.name)) {
      await touch($, await whereOf($, options), e.permission_mode)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await touch($, await whereOf($, options))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (entry?.sessionId === e.sessionId) {
      const ended = e.reason === 'prompt_input_exit' || e.reason === 'clear' ? 'exited' : 'interrupted'
      await save($, await whereOf($, options), { ...entry, ended, lastActive: iso(await $.clock.now()) })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'resume-sessions' }, async $ => {
    const where = await whereOf($, options)
    const argv = [where.powershell, '-NoProfile', '-File', where.script, '-Registry', where.registry, '-Sessions', where.sessions]
    if (where.terminal !== 'wezterm') {
      argv.push('-Terminal', where.terminal) // the bundled script takes it; a script of your own may not
    }
    const ran = await $.process.run(argv, { timeoutMs: 30000 })
    const out = `${ran.stdout}${ran.stderr ? `\n${ran.stderr}` : ''}`.trim()

    return { text: out || `The resume script printed nothing (exit ${ran.exitCode}).` }
  })
}
