import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Paths compare in one form: forward slashes, no doubled slashes, lower case, /c/... as c:/...
const slashes = (p: unknown) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
const norm = (p: unknown) => slashes(p).replace(/^\/([a-z])\//i, '$1:/').replace(/(.)\/$/, '$1').toLowerCase()
// A whole command line in the same form, so a banned root is found wherever it is written in it.
const normCommand = (c: string) => slashes(c).replace(/(^|[^a-z0-9])\/([a-z])\//gi, '$1$2:/').toLowerCase()
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A list option arrives as an array; a hand-edited settings.json may hold one comma-separated string.
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [])
  .map(s => String(s).trim()).filter(Boolean)
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

const MUTATING_GIT = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch'])
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i

const KILL_BY_NAME = /\bpkill\b|\bkillall\b|\btaskkill\b[^;&|\n]*\/+im\b|\bstop-process\b[^;&|\n]*-name\b/i
const NO_VERIFY = /\bgit\b[^;&|\n]*\s--no-verify\b/

type Config = {
  forcePush: boolean
  protectedPush: boolean
  protectedBranch: RegExp | undefined
  noVerify: boolean
  killByName: boolean
  bannedRoots: string[]
  bannedInCommand: RegExp[]
  sharedCheckout: boolean
  sharedRoot: string
  readLimitBytes: number
}

function readConfig(options: PluginOptions): Config {
  const bannedRoots = list(options.banned_paths).map(norm).filter(Boolean)
  const branches = list(options.protected_branches).map(escapeRegex)
  const limit = Number(options.read_limit_bytes)

  return {
    forcePush: flag(options.guard_force_push, true),
    protectedPush: flag(options.guard_protected_branches, true),
    protectedBranch: branches.length ? new RegExp(`(^|:)(refs/heads/)?(${branches.join('|')})$`) : undefined,
    noVerify: flag(options.guard_no_verify, true),
    killByName: flag(options.guard_kill_by_name, true),
    bannedRoots,
    bannedInCommand: bannedRoots.map(root => new RegExp(`(^|[^a-z0-9_.-])${escapeRegex(root)}(?=[/'"\\s;&|)]|$)`)),
    sharedCheckout: flag(options.guard_shared_checkout, false),
    sharedRoot: norm(options.shared_checkout_root),
    readLimitBytes: Number.isFinite(limit) && limit > 0 ? limit : 0,
  }
}

// Each `git push` in a command: refused when it forces, or names a protected branch as a target.
function pushProblem(command: string, cfg: Config): string | undefined {
  for (const m of command.matchAll(/\bgit\b(?:\s+-C\s+\S+)?\s+push\b([^;&|\n]*)/g)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean)
    if (cfg.forcePush && words.some(w => /^(--force|--force-with-lease(=.*)?|--force-if-includes|-[a-zA-Z]*f[a-zA-Z]*)$/.test(w))) {
      return 'a force-push'
    }
    const refspecs = words.filter(w => !w.startsWith('-')).slice(1)
    if (cfg.forcePush && refspecs.some(r => r.startsWith('+'))) {
      return 'a force-push (+refspec)'
    }
    if (cfg.protectedPush && cfg.protectedBranch && refspecs.some(r => cfg.protectedBranch!.test(r))) {
      return 'a push to a protected branch'
    }
  }
  return undefined
}

// A plain git checkout is shared; a linked worktree is not. Walks up from the path to the nearest `.git`:
// a directory means a plain checkout, a file means a linked worktree. With a root set, only paths under it count.
async function isSharedCheckout($: EngineInterface, path: unknown, cfg: Config): Promise<boolean> {
  const n = norm(path)
  if (!/^([a-z]:)?\//.test(n)) {
    return false // relative: the working directory is unknown here
  }
  if (cfg.sharedRoot && !n.startsWith(`${cfg.sharedRoot}/`)) {
    return false
  }
  let dir = slashes(path).replace(/^\/([a-z])\//i, '$1:/').replace(/(.)\/$/, '$1')
  for (let i = 0; i < 40 && dir; i++) {
    const git = await $.fs.stat(`${dir}/.git`).catch(() => undefined)
    if (git) {
      return git.kind === 'dir'
    }
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir || !up || /^[a-z]:$/i.test(up)) {
      break
    }
    dir = up
  }

  return false
}

// `git -C <shared checkout> <mutating command>` or `cd <shared checkout> && git <mutating command>`.
async function sharedGitMutation($: EngineInterface, command: string, cfg: Config): Promise<string | undefined> {
  const found = [
    ...[...command.matchAll(/\bgit\s+-C\s+["']?([^\s"']+)["']?\s+([a-z-]+)/g)].map(m => [m[1], m[2]]),
    ...[...command.matchAll(/\bcd\s+["']?([^\s"';&|]+)["']?\s*(?:&&|;)\s*git\s+([a-z-]+)/g)].map(m => [m[1], m[2]]),
  ]
  for (const [dir, verb] of found) {
    if (MUTATING_GIT.has(verb) && await isSharedCheckout($, `${dir}/`, cfg)) {
      return `git ${verb} in ${dir}`
    }
  }
  return undefined
}

const deny = (why: string) => ({ deny: `subagent-fence: ${why}` })

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isSubagent = Boolean(e.agentId)
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? String(input.command ?? '') : ''
    const path = input.file_path ?? input.notebook_path ?? input.path

    // Everywhere, the main session included.
    if (cfg.bannedRoots.length) {
      const n = norm(path)
      const hit = cfg.bannedRoots.some(root => n === root || n.startsWith(`${root}/`))
        || (command && cfg.bannedInCommand.some(re => re.test(normCommand(command))))
      if (hit) {
        return deny('that path is on the banned list (the banned_paths option). Never read, write or enter it.')
      }
    }
    if (command) {
      const push = pushProblem(command, cfg)
      if (push) {
        return deny(`${push} is never allowed here. Push a feature branch and open a PR; never force-push.`)
      }
      if (cfg.noVerify && NO_VERIFY.test(command)) {
        return deny('--no-verify bypasses the hooks, which is never allowed. Fix what the hook reports instead.')
      }
      if (cfg.killByName && KILL_BY_NAME.test(command)) {
        return deny('killing processes by name can kill other sessions\' processes. Kill by PID only.')
      }
    }

    if (isSubagent) {
      if (cfg.sharedCheckout) {
        if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && await isSharedCheckout($, path, cfg)) {
          return deny(`${String(path)} is in a shared checkout. Edit only inside your own worktree; never the main checkout.`)
        }
        const mutation = command ? await sharedGitMutation($, command, cfg) : undefined
        if (mutation) {
          return deny(`${mutation} changes a shared checkout. Run git only inside your own worktree.`)
        }
      }
      if (cfg.readLimitBytes && e.tool === 'Read' && input.limit === undefined && !NOT_TEXT.test(String(path ?? ''))) {
        const size = await $.fs.stat(String(path)).then(s => (s.kind === 'file' ? s.size : 0)).catch(() => 0)
        if (size > cfg.readLimitBytes) {
          return deny(
            `${String(path)} is ${Math.round(size / 1000)} KB. Read it by offset and limit (150 lines or fewer): ` +
            'find the line with grep -n first, then read that window.')
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // if the fence itself fails, the call goes ahead
}
