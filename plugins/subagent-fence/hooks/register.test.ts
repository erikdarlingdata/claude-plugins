import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

// A small file system for the engine's side: a path ending in "/.git" is a directory in a plain checkout
// (/repo, /w/app) and a file in a linked worktree (/w/app/.claude/worktrees/a1). A file's name says its size:
// "big" is 90 KB, anything else 1 KB. Every other path does not exist.
const plainCheckouts = ['c:/repo', 'c:/w/app']
const linkedWorktrees = ['c:/w/app/.claude/worktrees/a1']
const engine = (on: On) => {
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
  on('fs.stat', async (_$, e) => {
    const path = String((e as { path: string }).path).replace(/\\/g, '/').toLowerCase()
    const kind = path.endsWith('/.git')
      ? (plainCheckouts.includes(path.slice(0, -5)) ? 'dir' : linkedWorktrees.includes(path.slice(0, -5)) ? 'file' : undefined)
      : path.includes('big') || path.includes('small') || path.includes('x.cs') ? 'file' : undefined
    if (!kind) {
      throw new Error(`ENOENT ${path}`)
    }
    return { value: { kind, size: path.includes('big') ? 90000 : 1000, mtimeMs: 0, isLink: false } } as never
  })
}
const run = async ($: Engine, input: Record<string, unknown>, agentId?: string) =>
  (await $.tool.call({ tool_use_id: 'u', ...(agentId ? { agentId } : {}), ...input } as never)).deny
const bash = (command: string) => ({ tool: 'Bash', command })

test('force-pushes and pushes to protected branches are refused for everyone; feature pushes are not', async ($, on) => {
  engine(on)
  for (const c of ['git push --force', 'git push -f origin fix/1', 'git push origin +fix/1', 'git push --force-with-lease origin fix/1']) {
    expect(await run($, bash(c))).toMatch(/force-push/)
  }
  for (const c of ['git -C C:/repo push origin HEAD:dev', 'git push origin main', 'git status && git push origin dev', 'git push origin master']) {
    expect(await run($, bash(c))).toMatch(/protected branch/)
  }
  for (const c of ['git push -u origin feature/5299-dev-fix', 'git push origin --delete feature/old', 'git push origin feature/main-thing']) {
    expect(await run($, bash(c), 'a1')).toBeUndefined()
  }
})

test('protected_branches changes which branches a push may not target', { options: { protected_branches: ['release'] } }, async ($, on) => {
  engine(on)
  expect(await run($, bash('git push origin main'))).toBeUndefined()
  expect(await run($, bash('git push origin release'))).toMatch(/protected branch/)
  expect(await run($, bash('git push origin HEAD:refs/heads/release'))).toMatch(/protected branch/)
  expect(await run($, bash('git push origin dev'))).toBeUndefined()
})

test('guard_force_push off lets a force-push through; the branch guard still holds', { options: { guard_force_push: false } }, async ($, on) => {
  engine(on)
  expect(await run($, bash('git push --force origin fix/1'))).toBeUndefined()
  expect(await run($, bash('git push --force origin main'))).toMatch(/protected branch/)
})

test('guard_protected_branches off lets a push to main through; a force-push is still refused', { options: { guard_protected_branches: false } }, async ($, on) => {
  engine(on)
  expect(await run($, bash('git push origin main'))).toBeUndefined()
  expect(await run($, bash('git push -f origin main'))).toMatch(/force-push/)
})

test('--no-verify and kills by name are refused; kills by PID are not', async ($, on) => {
  engine(on)
  expect(await run($, bash('git commit --no-verify -m x'))).toMatch(/--no-verify/)
  expect(await run($, bash('git commit -m "x"'))).toBeUndefined()
  for (const c of ['taskkill //F //IM dotnet.exe', 'pkill -f node', 'killall dotnet']) {
    expect(await run($, bash(c))).toMatch(/Kill by PID only/)
  }
  expect(await run($, { tool: 'PowerShell', command: 'Stop-Process -Name dotnet -Force' })).toMatch(/Kill by PID only/)
  expect(await run($, bash('taskkill //PID 4120 //F'))).toBeUndefined()
  expect(await run($, { tool: 'PowerShell', command: 'Stop-Process -Id 4120' })).toBeUndefined()
})

test('guard_no_verify off allows --no-verify', { options: { guard_no_verify: false } }, async ($, on) => {
  engine(on)
  expect(await run($, bash('git commit --no-verify -m x'))).toBeUndefined()
})

test('guard_kill_by_name off allows a kill by name', { options: { guard_kill_by_name: false } }, async ($, on) => {
  engine(on)
  expect(await run($, bash('pkill -f node'))).toBeUndefined()
})

test('with no banned_paths, nothing is fenced off', async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Read', file_path: 'C:\\Secret\\old-repo\\README.md' })).toBeUndefined()
  expect(await run($, bash('ls /c/Secret/old-repo/'))).toBeUndefined()
})

test('banned_paths are refused for everyone; similar names are not', { options: { banned_paths: ['C:\\Secret\\old-repo', 'C:/Secret/archive'] } }, async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Read', file_path: 'C:\\Secret\\old-repo\\README.md' })).toMatch(/banned/)
  expect(await run($, { tool: 'Grep', pattern: 'x', path: '/c/Secret/Archive' })).toMatch(/banned/)
  expect(await run($, bash('ls /c/Secret/old-repo/'))).toMatch(/banned/)
  expect(await run($, bash('cat C:\\Secret\\archive\\x.sql'))).toMatch(/banned/)
  expect(await run($, bash('cd "C:/Secret/old-repo" && ls'))).toMatch(/banned/)
  expect(await run($, { tool: 'Read', file_path: 'C:\\Secret\\old-repo-notes\\README.md' })).toBeUndefined()
  expect(await run($, bash('ls /c/Secret/old-repo-tools/'))).toBeUndefined()
  expect(await run($, bash('ls /c/Elsewhere/Secret/old-repo/'))).toBeUndefined()
})

test('guard_shared_checkout is off by default', async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Edit', file_path: 'C:\\repo\\src\\x.cs', old_string: 'a', new_string: 'b' }, 'a1')).toBeUndefined()
  expect(await run($, bash('git -C C:/repo checkout dev'), 'a1')).toBeUndefined()
})

test('a subagent may not edit or change a plain git checkout; a linked worktree may be, so may the main session', { options: { guard_shared_checkout: true } }, async ($, on) => {
  engine(on)
  const main = 'C:\\w\\app\\Lite\\x.cs'
  const tree = 'C:\\w\\app\\.claude\\worktrees\\a1\\Lite\\x.cs'
  expect(await run($, { tool: 'Edit', file_path: main, old_string: 'a', new_string: 'b' }, 'a1')).toMatch(/shared checkout/)
  expect(await run($, { tool: 'Write', file_path: 'C:/repo/new/file.md', content: '' }, 'a1')).toMatch(/shared checkout/)
  expect(await run($, { tool: 'Edit', file_path: tree, old_string: 'a', new_string: 'b' }, 'a1')).toBeUndefined()
  expect(await run($, { tool: 'Write', file_path: 'C:\\notes\\h.md', content: '' }, 'a1')).toBeUndefined()
  expect(await run($, { tool: 'Edit', file_path: main, old_string: 'a', new_string: 'b' })).toBeUndefined()

  expect(await run($, bash('git -C C:/w/app checkout dev'), 'a1')).toMatch(/git checkout in/)
  expect(await run($, bash('cd /c/w/app && git stash'), 'a1')).toMatch(/git stash in/)
  expect(await run($, bash('git -C C:/w/app log -1'), 'a1')).toBeUndefined()
  expect(await run($, bash('git -C C:/w/app/.claude/worktrees/a1 commit -m x'), 'a1')).toBeUndefined()
})

test('shared_checkout_root limits the shared-checkout guard to checkouts under it', { options: { guard_shared_checkout: true, shared_checkout_root: 'C:\\w' } }, async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Edit', file_path: 'C:\\w\\app\\x.cs', old_string: 'a', new_string: 'b' }, 'a1')).toMatch(/shared checkout/)
  expect(await run($, { tool: 'Edit', file_path: 'C:\\repo\\x.cs', old_string: 'a', new_string: 'b' }, 'a1')).toBeUndefined()
  expect(await run($, bash('git -C C:/repo checkout dev'), 'a1')).toBeUndefined()
  expect(await run($, bash('git -C C:/w/app checkout dev'), 'a1')).toMatch(/git checkout in/)
})

test('read_limit_bytes is off by default', async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.cs' }, 'a1')).toBeUndefined()
})

test('a subagent may not read a large text file whole; with a limit, small, or as the main session it may', { options: { read_limit_bytes: 40000 } }, async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.cs' }, 'a1')).toMatch(/is 90 KB\. Read it by offset and limit/)
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.cs', offset: 10, limit: 100 }, 'a1')).toBeUndefined()
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\small.cs' }, 'a1')).toBeUndefined()
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.png' }, 'a1')).toBeUndefined()
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.cs' })).toBeUndefined()
})

test('a bigger read_limit_bytes lets the same file through', { options: { read_limit_bytes: 100000 } }, async ($, on) => {
  engine(on)
  expect(await run($, { tool: 'Read', file_path: 'C:\\x\\big.cs' }, 'a1')).toBeUndefined()
})
