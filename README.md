# Darling Data — Claude Code plugins

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
from [Darling Data](https://erikdarling.com).

```
/plugin marketplace add erikdarlingdata/claude-plugins
```

## Plugins

### `sqlserver-query-plans`

Teaches Claude to read a SQL Server execution plan and say what is actually slow,
and why.

```
/plugin install sqlserver-query-plans@erikdarling
```

Point Claude at a `.sqlplan` file and ask. The skill is model-invoked — you do not
need to call it explicitly.

The hard part of plan analysis is not spotting operators. It is knowing which
numbers mean what they appear to mean. This plugin is built mostly out of the
conclusions that sound authoritative and are wrong:

- **Cost percentages are estimates in every plan**, including actual plans.
  Nothing recomputes them after execution. The 97%-cost operator is routinely not
  the slow one, and an operator shown at 0% can consume the entire runtime.
- **Row-mode operator times are cumulative.** Ranking operators by raw
  `ActualElapsedms` ranks them by depth and always crowns the root node. Batch
  mode reports standalone times. Exchange operators report times that are close
  to meaningless.
- **`EstimateRows` is per-execution; `ActualRows` is a total.** Without dividing
  by `ActualExecutions`, the inner side of every nested loop looks
  catastrophically underestimated when it may have estimated perfectly.
- **Missing-index requests are hints, not DDL.** Equality columns come out in
  arbitrary order, existing indexes are ignored, and the `Impact` figure is a
  percentage of an estimated cost.
- **A scan is not a defect and a seek is not a virtue.** Judge by rows touched
  and time spent.

It also ships `scripts/extract.py`, which flattens a `.sqlplan` into a compact
digest. This is not a convenience:

- `.sqlplan` files are **UTF-16**, so `grep` silently matches nothing and reports
  no error. A negative result from `grep` on a plan file is worthless.
- Some plans are UTF-8 bytes that still declare `encoding="utf-16"`, because they
  were opened and re-saved. Strict XML parsers reject them.
- A trivial two-table join is 120 KB. Real plans run to megabytes. Reading one
  into context wastes the context and still misses things.

The extractor handles the encoding, computes correct self-time attribution
(subtracting children in row mode, within a thread rather than across threads in
parallel plans, and not at all in batch mode), normalizes cardinality per
execution, and recognizes the optimizer's default-guess selectivity fingerprints.
`--node N` drills into a single operator; `--sql` recovers full statement text.

Requires Python 3 (standard library only). Without it, the skill degrades to a
documented `grep`-based fallback and says plainly what it cannot determine.

## GitHub Copilot CLI

This plugin also works in [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli/),
which reads the same `SKILL.md` and `plugin.json` format.

```
copilot plugin marketplace add erikdarlingdata/claude-plugins
copilot plugin install sqlserver-query-plans@erikdarling
```

Or add just the skill, without the marketplace:

```
/skills add ./plugins/sqlserver-query-plans/skills/query-plan-analysis
```

As in Claude Code, the skill is model-invoked: point Copilot at a `.sqlplan` and ask.

## Claude Code mods

Small hook modules for people who run several agents at once. Each one is a
plugin of its own. Install only the ones you want, and set their options in
`/config` (or under `pluginConfigs` in `settings.json`). They need a Claude Code
version that loads plugin hook modules.

### `subagent-fence`

Stops the mistakes an unattended agent makes that cannot be taken back.

```
/plugin install subagent-fence@erikdarling
```

For the main session and every subagent it refuses four things. A force-push.
A push to a protected branch. A git command that skips the repository's hooks.
Killing processes by name (`pkill`, `killall`, `taskkill /IM`,
`Stop-Process -Name`), because a name match can kill another session's
processes.

Three more guards are off until you set them. One bans folders: nothing reads,
writes or enters them. One keeps a subagent from editing a plain git checkout,
or running a changing git command there, so it works in its own worktree. One
stops a subagent reading a big text file whole instead of by offset and limit.

| Option | Default | What it does |
| :- | :- | :- |
| `guard_force_push` | on | Refuse `--force`, `--force-with-lease`, `-f` and `+refspec` pushes |
| `guard_protected_branches` | on | Refuse a push that targets a protected branch |
| `protected_branches` | `main`, `master`, `dev` | The branch names a push cannot target |
| `guard_no_verify` | on | Refuse the git flag that skips hooks |
| `guard_kill_by_name` | on | Refuse killing processes by name |
| `banned_paths` | none | Folders that nothing reads, writes or enters |
| `guard_shared_checkout` | off | Keep subagents out of plain git checkouts |
| `shared_checkout_root` | empty | Limit that guard to checkouts under this folder. Empty detects a plain checkout anywhere: a folder whose `.git` is a directory, where a linked worktree has a `.git` file |
| `read_limit_bytes` | 0 (off) | Refuse a subagent's `Read` of a text file over this size when it gives no `limit` |

### `model-allowlist`

Checks the model a subagent is spawned with.

```
/plugin install model-allowlist@erikdarling
```

A pinned model id goes stale: a dated or versioned name keeps pointing at an
old model after the tier moves on. This refuses a spawn that names one and asks
for a tier alias (`opus`, `sonnet`, `haiku`) instead. A spawn with no model is
always allowed, because the agent file or the parent decides then.

You can add rules of your own. One example: the `lane` agent runs Sonnet, and
Opus only when the brief says design, security or hard debugging. With no rules,
every alias is allowed.

| Option | Default | What it does |
| :- | :- | :- |
| `refuse_pinned_ids` | on | Refuse any model that is not an allowed alias |
| `allowed_aliases` | `opus`, `sonnet`, `haiku`, `fable`, `inherit` | The names that count as aliases. A trailing `[1m]`-style suffix is ignored |
| `rules` | none | One rule per entry, written `agent type pattern => model => brief pattern => message` |

A rule applies when the spawn's agent type matches the first pattern and it
names that model (`*` for any model). The brief must then match the brief
pattern, or the spawn is refused. Leave the brief pattern empty to refuse the
pairing outright. The message is optional and can use `{type}` and `{model}`.
Patterns are case-insensitive regular expressions. A rule that does not parse
is skipped. For example:

```
^(lane|worker-.*)$ => opus => \b(design|security|hard[- ]debug) => {type} runs sonnet; name the reason in the brief to use opus.
```

### `seat-resume`

Brings interrupted sessions back after a crash, a reboot or a closed terminal.

```
/plugin install seat-resume@erikdarling
```

The plugin writes one small file per interactive session: its id, name, folder,
permission mode and last activity. It marks the file when the session ends.
`/resume-sessions` lists the sessions that died or were interrupted in the last
72 hours, with the command that reopens each. The script's `-Launch` switch
reopens all of them in terminal tabs. Sessions you left with `/exit`, Ctrl+C or
`/clear` stay closed. The plugin name still says "seat", but everything you see
says "session".

This one is Windows only. The bundled script (`scripts/resume-sessions.ps1`) is
PowerShell. It compares Windows process start times to tell a live session from
a reused process id. It reopens tabs in [WezTerm](https://wezterm.org) or
Windows Terminal. Nobody has tried the plugin on macOS or Linux.

| Option | Default | What it does |
| :- | :- | :- |
| `registry_dir` | empty: `session-registry` in your Claude config folder | Where the per-session files go |
| `sessions_dir` | empty: `sessions` in your Claude config folder | Where Claude Code records its running sessions |
| `resume_script` | empty: the bundled script | The PowerShell script `/resume-sessions` runs |
| `powershell` | `pwsh` | The program that runs it (`powershell` for Windows PowerShell 5.1) |
| `terminal` | `wezterm` | `wezterm` or `windows-terminal`: where `-Launch` reopens sessions |

The Claude config folder is `CLAUDE_CONFIG_DIR` when that is set, otherwise
`.claude` in your home folder.

## pi

This repository is also a [pi package](https://pi.dev/packages): the root
`package.json` declares every `plugins/*/skills` and `plugins/*/extensions`
directory, and [pi](https://pi.dev) reads the same `SKILL.md` format the other
two harnesses do. Install straight from git — no marketplace step:

```
pi install git:github.com/erikdarlingdata/claude-plugins
```

As everywhere else, the skill is model-invoked: point pi at a `.sqlplan` and ask.

### `pi-session-resume` (pi only)

Your machine restarts for updates with a dozen pi sessions open; this brings
them all back with one command, as terminal tabs, in their original
directories, with full history:

```
pi-resume-sessions
```

An extension (auto-loaded by the install above) records every open interactive
session; the `pi-resume-sessions` script reopens the interrupted ones — Ghostty
tabs on macOS, tmux anywhere. Sessions you quit deliberately (Ctrl+D, `/quit`)
stay closed; sessions killed by a reboot, a closed window, or a crash come
back. Idle-time filters keep abandoned sessions from resurrecting.

The script needs a one-time symlink onto your PATH, and macOS needs a one-time
Automation permission — see
[`plugins/pi-session-resume/README.md`](plugins/pi-session-resume/README.md)
for both, plus the design notes. This one is pi-only: Claude Code and Copilot
CLI don't load pi extensions.

### `pi-subagent-watchdog` (pi only)

Background subagents only report back when they finish — nothing wakes the
orchestrator while one wedges on a giant grep or balloons from 200k to 2M
tokens. This extension (auto-loaded by the install above) polls every running
subagent's live vitals — tokens, cost, context %, tool uses, turns, wall clock,
compactions — and batches nearby threshold crossings into one compact
orchestrator check-in. Full structured records persist outside LLM context;
per-agent and fleet-wide rate limits keep the watchdog from becoming its own
token amplifier. Two orchestrator postures: `guide` (assess with judgment) and
`strict` (thresholds are budgets — wrap up by default, one evidence-cited
extension max). Optional automatic hard stop handles the truly wedged, with
the outcome reported from the RPC reply rather than assumed. An optional exact
model invariant hard-stops any top-level child that bypasses the manager's
pre-spawn model policy. Optional per-agent cost signal and hard stop, plus
session and daily USD budget warnings. The CLI surfaces also identify each child's effective
model and thinking level.

Humans get a `/watchdog` panel (vitals, manual check-ins, steering, hard
stop) plus `/watchdog help | status | config | reload` — config edits apply
live, no session restart. See
[`plugins/pi-subagent-watchdog/README.md`](plugins/pi-subagent-watchdog/README.md)
for signals, modes, and design notes. Requires the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension; pi-only
for the same reason as above.

### `pi-subagent-guardrails` (pi only)

Token-budget guardrails for multi-agent setups, built after an overnight orchestration burned through its usage limit
(95% of the spend came at more than 150k context). It has three pieces:

- [`guardrails.md`](plugins/pi-subagent-guardrails/guardrails.md): the written rules for fan-out caps, model tiers,
  context discipline, session length and ranking.
- **A context-wall extension**, loaded only into subagents through their agent files. It tells the child its own
  size at 150k and 200k. At 250k it refuses everything but git/gh and markdown writes, so the agent commits and
  reports instead of being aborted with its work lost.
- **A `lane` agent type** for code-editing lanes: Sonnet, its own worktree, draft PRs, no fan-out tools.

The wall is deliberately **not** auto-loaded, because it would wall off your interactive session too. See
[`plugins/pi-subagent-guardrails/README.md`](plugins/pi-subagent-guardrails/README.md) for install and the
recommended watchdog and pi-subagents settings.

## Not a plugin: the pi setup guide

[`pi-setup-guide.md`](pi-setup-guide.md) — a distilled ~15-minute setup for
[pi](https://pi.dev) written for Claude Code ex-pats: install, model/thinking
defaults, the trust model, a Claude-to-pi habit translation table, a
tested-together extension stack, full source for a few small
quality-of-life extensions (refusal fallback, tab-title status, `!` command
wake-ups + autocomplete), how to point pi at years of accumulated Claude Code
memory instead of migrating it, and a troubleshooting section of the gotchas
that actually happened. The plugins in this repo (§11–§13 of the guide) slot
into that stack.

## About

Built by [Erik Darling](https://erikdarling.com) at Darling Data. SQL Server
consulting, training, and free tools: **<https://erikdarling.com>**

## License

MIT
