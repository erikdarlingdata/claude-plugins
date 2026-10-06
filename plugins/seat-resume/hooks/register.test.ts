import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const REG = 'C:/Work/registry'
const SES = 'C:/Work/sessions'
const OPTS = { registry_dir: REG, sessions_dir: SES }

// The engine's side: an in-memory file system, a session id the test can change, and quiet defaults.
const engineBottom = (on: On, env: Record<string, string> = {}) => {
  on('env.get', async (_$, e) => ({ value: env[(e as { name: string }).name] }) as never)
  const files = new Map<string, string>()
  const norm = (path: string) => path.split('\\').join('/')
  const session = { id: 's1' }
  on('fs.write', async (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.read', async (_$, e) => {
    const { path } = e as unknown as { path: string }
    if (!files.has(norm(path))) throw new Error(`missing ${path}`)
    return { value: files.get(norm(path)) } as never
  })
  on('fs.list', async (_$, e) => {
    const { path } = e as unknown as { path: string }
    const dir = norm(path)
    const names = [...files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('session.id', async () => ({ value: session.id }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('classic.UserPromptSubmit', async () => ({}) as never)
  mock.clock(on, { now: Date.parse('2026-10-06T03:00:00Z') })
  const entry = (id: string) => JSON.parse(files.get(`${REG}/${id}.json`) ?? 'null')

  return { files, session, entry }
}

const prompt = (permission_mode: string) =>
  ({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 's1', transcript_path: '', cwd: 'C:/Work/app', permission_mode }) as never

test('an interactive session is registered with its name, cwd and permission mode; a -p run is not', { options: OPTS }, async ($, on) => {
  const { files, entry } = engineBottom(on)
  files.set(`${SES}/4242.json`, JSON.stringify({ pid: 4242, sessionId: 's1', name: 'demo-2' }))

  await $.session.start({ cwd: 'C:/Work/app', surface: null, isInteractive: false } as never)
  expect(entry('s1')).toBeNull()

  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  expect(entry('s1')).toMatchObject({ sessionId: 's1', cwd: 'C:/Work/app', ended: '', lastActive: '2026-10-06T03:00:00.000Z' })

  await $.classic.UserPromptSubmit(prompt('bypassPermissions'))
  expect(entry('s1')).toMatchObject({ name: 'demo-2', permissionMode: 'bypassPermissions' })
})

test('leaving on purpose marks it exited; a closed terminal marks it interrupted', { options: OPTS }, async ($, on) => {
  const { session, entry } = engineBottom(on)
  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(entry('s1').ended).toBe('interrupted')

  // A resume of the same id clears the mark and keeps when it started.
  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  expect(entry('s1')).toMatchObject({ ended: '', startedAt: '2026-10-06T03:00:00.000Z' })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(entry('s1').ended).toBe('exited')
  session.id = 's2'
})

test('/clear ends the old id as exited and the next prompt registers the new id with the same mode', { options: OPTS }, async ($, on) => {
  const { session, entry } = engineBottom(on)
  await $.session.start({ cwd: 'C:/Work/other', surface: 'terminal', isInteractive: true } as never)
  await $.classic.UserPromptSubmit(prompt('acceptEdits'))
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  session.id = 's2'
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', text: '' } as never)

  expect(entry('s1').ended).toBe('exited')
  expect(entry('s2')).toMatchObject({ sessionId: 's2', cwd: 'C:/Work/other', permissionMode: 'acceptEdits', ended: '' })
})

test('a tool call of the main session records a changed mode; a subagent tool call does not', { options: OPTS }, async ($, on) => {
  const { files, entry } = engineBottom(on)
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  files.set(`${SES}/77.json`, JSON.stringify({ pid: 77, sessionId: 's1', name: 'demo-3' }))
  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  const call = (permission_mode: string, agent_id?: string) =>
    $.tool.call({ tool: 'Bash', tool_use_id: 'u', command: 'ls', permission_mode, ...(agent_id ? { agentId: agent_id, agent_id } : {}) } as never)

  await call('plan', 'sub-1')
  expect(entry('s1').permissionMode).toBe('')
  await call('bypassPermissions')
  expect(entry('s1')).toMatchObject({ permissionMode: 'bypassPermissions', name: 'demo-3' })
})

test('with no folder options the registry and sessions folders sit in the Claude config folder', async ($, on) => {
  const { files, entry } = engineBottom(on, { CLAUDE_CONFIG_DIR: 'C:/Home/.claude' })
  files.set('C:/Home/.claude/sessions/9.json', JSON.stringify({ pid: 9, sessionId: 's1', name: 'named' }))
  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  await $.classic.UserPromptSubmit(prompt('plan'))
  expect(JSON.parse(files.get('C:/Home/.claude/session-registry/s1.json') ?? 'null')).toMatchObject({ name: 'named', permissionMode: 'plan' })
  expect(entry('s1')).toBeNull()
})

test('home folder is the fallback when CLAUDE_CONFIG_DIR is not set', async ($, on) => {
  const { files } = engineBottom(on, { HOME: 'C:/Users/someone' })
  await $.session.start({ cwd: 'C:/Work/app', surface: 'terminal', isInteractive: true } as never)
  expect(files.has('C:/Users/someone/.claude/session-registry/s1.json')).toBe(true)
})

// The engine's side of /resume-sessions: the command's argv is what the test reads back.
const runCommand = async ($: Engine, on: On) => {
  engineBottom(on)
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...(e as unknown as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: 'listed', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  const result = await $.command.run({ command: 'resume-sessions', args: '' } as never)
  return { calls, text: (result as { text?: string }).text }
}

test('/resume-sessions runs the bundled script with the folders and the default terminal', { options: OPTS }, async ($, on) => {
  const { calls, text } = await runCommand($, on)
  expect(text).toBe('listed')
  expect(calls[0].slice(0, 3)).toEqual(['pwsh', '-NoProfile', '-File'])
  expect(calls[0][3].split('\\').join('/')).toMatch(/\/scripts\/resume-sessions\.ps1$/)
  expect(calls[0].slice(4)).toEqual(['-Registry', REG, '-Sessions', SES])
})

test('resume_script, powershell and terminal change the command that runs', { options: { ...OPTS, resume_script: 'C:\\Tools\\mine.ps1', powershell: 'powershell', terminal: 'windows-terminal' } }, async ($, on) => {
  const { calls } = await runCommand($, on)
  expect(calls[0]).toEqual(['powershell', '-NoProfile', '-File', 'C:/Tools/mine.ps1', '-Registry', REG, '-Sessions', SES, '-Terminal', 'windows-terminal'])
})
