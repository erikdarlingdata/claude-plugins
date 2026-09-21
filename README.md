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
subagent's live vitals — tokens, context %, tool uses, turns, wall clock,
compactions — and batches nearby threshold crossings into one compact
orchestrator check-in. Full structured records persist outside LLM context;
per-agent and fleet-wide rate limits keep the watchdog from becoming its own
token amplifier. Two orchestrator postures: `guide` (assess with judgment) and
`strict` (thresholds are budgets — wrap up by default, one evidence-cited
extension max). Optional automatic hard stop handles the truly wedged, with
the outcome reported from the RPC reply rather than assumed. The CLI surfaces
also identify each child's effective model and thinking level.

Humans get a `/watchdog` panel (vitals, manual check-ins, steering, hard
stop) plus `/watchdog help | status | config | reload` — config edits apply
live, no session restart. See
[`plugins/pi-subagent-watchdog/README.md`](plugins/pi-subagent-watchdog/README.md)
for signals, modes, and design notes. Requires the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension; pi-only
for the same reason as above.

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
