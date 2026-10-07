# Optional Pi extension recipes

These are opt-in quality-of-life recipes referenced by
[`pi-setup-guide.md`](../../pi-setup-guide.md). They are deliberately outside
the package's `pi.extensions` manifest: installing `claude-plugins` does not
silently activate personal TUI or provider behavior.

Copy only the files you want:

```bash
mkdir -p ~/.pi/agent/extensions
cp recipes/extensions/reply-timestamps.ts ~/.pi/agent/extensions/
cp recipes/extensions/clickable-links.ts ~/.pi/agent/extensions/
cp recipes/extensions/bang-notify.ts ~/.pi/agent/extensions/
cp recipes/extensions/settle-bell.ts ~/.pi/agent/extensions/
cp recipes/extensions/subagent-cost.ts ~/.pi/agent/extensions/
# Advanced and policy-sensitive; read its warning first:
cp recipes/extensions/refusal-fallback.ts ~/.pi/agent/extensions/
```

Run `/reload` after copying a local extension. **Pi-subagents aborts its running
children during session shutdown**, so let useful subagents finish before
reloading their parent session.

## Recipes

| File | Purpose | Self-test / config |
| --- | --- | --- |
| `reply-timestamps.ts` | Durable, TUI-only reply timestamps and a footer clock | `~/.pi/agent/reply-timestamps.json` |
| `clickable-links.ts` | OSC 8 links on markdown labels and bare URLs | `/linktest`; `~/.pi/agent/clickable-links.json` |
| `bang-notify.ts` | Wake Pi when a contextual `!` command finishes; learn command completions | `~/.pi/agent/bang-notify.json`; history in `bang-history.json` |
| `settle-bell.ts` | Ring BEL on `agent_settled` | Configure the terminal's bell/attention behavior |
| `refusal-fallback.ts` | Retry an approved false-positive provider refusal on another model | Edit constants in the source |
| `subagent-cost.ts` | Session and subagent spend: footer chip by agent type and thinking level, machine-wide ledger, `/subagent-cost` reports | `/subagent-cost [types\|agents\|sessions\|issues\|daily] [session\|today\|week\|<N>d\|<N>h] [session:<name\|id\|this\|all>]`; ledger in `~/.pi/agent/subagent-ledger/` |

## subagent-cost.ts

**What it counts.** Each session's own spend (its assistant messages and
compactions) and its subagents' spend, kept apart. A session's own lines carry
`"kind": "seat"`. Only the first instance in a pi process records seat lines:
pi-subagents runs children in the same process, and a child that loads this
extension must not record its messages as a seat. A separate headless `pi -p`
process records itself, labelled `(no session file)`.

**Requirement.** It listens for `subagents:usage`, which pi-subagents emits once
per assistant message for every agent: top-level, nested and workflow children.
The event is not in the npm release of `@tintinweb/pi-subagents` yet
(proposed upstream in tintinweb/pi-subagents#377). It is on the
`integration/opus-subagents` branch of
<https://github.com/erikdarlingdata/pi-subagents>. Without it the extension
loads and still records each session's own spend; the chip stays empty, and
subagent rows come only from the backfill.

**Footer.** Status key `subagent-usage`, text like
`agents $3.30 (reviewer/high $2.10, lane/medium $1.20, scout/low* $0.15)`. A `*`
marks a group that ran at a different thinking level than it asked for, for
example when pi clamped `minimal` to the model's lowest level. With
pi-cc-extensions' footer the chip sits on line 1 next to the session's own `$`.
The session `$` excludes subagent spend unless pi-subagents' `reportUsage` is
on, so the two figures do not overlap.

**Reports.** `/subagent-cost` shows this session by type, thinking level and
model, with the session's own spend as `seat` rows and an average cost per
agent. Add `agents` for the most expensive agents, `sessions` for each
session's own and agent spend, or `issues` for agent spend per issue or PR
number (the first `#123` in an agent's description; repos are not told apart).
Every view has a `time` column: the sum of gaps between an agent's messages,
each capped at 10 minutes, so idle time between resumes is not counted.

**Ranges.** A range reads the ledger, so it covers every pi session on the
machine. `today` starts at local midnight. `<N>h` is a rolling window ending
now, and so is `<N>d` in the totals views (`types`, `agents`, `sessions`,
`issues`).

**Per day.** A range with no view gives one row per local day: seat spend,
agent spend, agents, sessions, messages and total. Here `<N>d` is today and the
N−1 whole days before it. `session:<x>` limits the range to sessions whose name
is or contains `<x>`, whose id starts with `<x>`, or this session (`this`), and
splits each day by type, thinking level and model. `session:all` splits each
day by session. Without a range, a filter covers 7 days. A day lists its top 10
rows and folds the rest into one line.

```
/subagent-cost 7d                    # total per day, every session
/subagent-cost session:all 3d        # per day, per session
/subagent-cost session:pm-worker 7d  # one session, per day, per model
/subagent-cost types week            # one total per type/thinking/model
```

**Incomplete data.** A session that has not loaded this version records nothing
live; its spend reaches the ledger only through the backfill. When a session in
the range has written to its session file more than 10 minutes after its last
ledger line, the report ends with an `Incomplete:` line naming it.

**Ledger.** One JSON line per message in
`~/.pi/agent/subagent-ledger/YYYY-MM-DD.jsonl` (UTC day): `ts`, `sessionId`,
`sessionName`, `cwd`, `id`, `type`, `description`, `model`, `thinking`,
`requestedThinking`, `depth`, `parentAgentId`, `workflowId`, `cost`, `input`,
`output`, `cacheRead`, `cacheWrite`, and `kind: "seat"` on a session's own
lines (type `seat`, id = the session id). The watchdog's `budget.dailyUsd` reads
it and skips seat lines.
Plan on roughly 2–10 MB per busy day.

**Backfill.** `recipes/scripts/subagent-ledger-backfill.py` rebuilds ledger lines
from saved sessions: subagents (pi-subagents saves top-level agents with
`rememberAgents`, on by default), every other session as a seat (a message
copied into a fork counts once), and the per-agent usage the old `subagent`
example tool left in its results. Run `--dry-run` first. Lines get
`"source": "backfill"`; re-running replaces earlier backfill lines, and an agent
or seat's messages are skipped once the live extension has a line for it, so it
is safe to run at any time. Nested
agents are not saved and cannot be recovered, and neither is the thinking level
an agent asked for.

Live sessions keep appending while it runs (25–75 s on a few thousand
sessions). It keeps those lines: before swapping each day file it copies what
was appended since its first read, and afterwards it copies anything a writer
put in the old file during the swap. Earlier versions dropped them. One run at a
time (a lock on `.backfill.lock`; a second run exits 0), and each finished run
touches `.last-backfill`, which the `Incomplete:` note quotes.

To run it hourly on macOS, a launchd agent with `StartCalendarInterval`
`Minute` 7, `Nice` 10 and `LowPriorityIO` works; on Linux, a cron line or a
systemd timer.

## Safety notes

- Extensions execute as your user and can run arbitrary code. Review every file
  before copying it.
- `refusal-fallback.ts` automatically resends the original request to another
  model. Use it only when that provider is approved for the data and the first
  refusal is a known false positive; never use it to evade a legitimate policy.
- `bang-notify.ts` never wakes for `!!` because that output is intentionally
  excluded from model context.
- OSC 8 capability settings override environment detection. Do not force
  hyperlinks through a terminal path that cannot render them.
- A write-only output surface needs a self-test. `/linktest` exists because an
  OSC sequence can fail silently while the extension believes it succeeded.
