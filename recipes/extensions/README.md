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
| `subagent-cost.ts` | Subagent spend by type and thinking level: footer chip, machine-wide ledger, `/subagent-cost` reports | `/subagent-cost [types\|agents\|sessions] [session\|today\|week\|<N>d]`; ledger in `~/.pi/agent/subagent-ledger/` |

## subagent-cost.ts

**Requirement.** It listens for `subagents:usage`, which pi-subagents emits once
per assistant message for every agent: top-level, nested and workflow children.
The event is not in the npm release of `@tintinweb/pi-subagents` yet. It is on
the `integration/opus-subagents` branch of
<https://github.com/erikdarlingdata/pi-subagents>. Without it the extension
loads, the chip stays empty, and the reports show only backfilled history.

**Footer.** Status key `subagent-usage`, text like
`agents $3.30 (reviewer/high $2.10, lane/medium $1.20, scout/low* $0.15)`. A `*`
marks a group that ran at a different thinking level than it asked for, for
example when pi clamped `minimal` to the model's lowest level. With
pi-cc-extensions' footer the chip sits on line 1 next to the session's own `$`.
The session `$` excludes subagent spend unless pi-subagents' `reportUsage` is
on, so the two figures do not overlap.

**Reports.** `/subagent-cost` shows this session by type, thinking level and
model. Add `agents` for the most expensive agents, or `sessions` for spend per
session. Add `today`, `week` or `<N>d` to read the ledger and cover every pi
session on the machine. Every view has a `time` column: the sum of gaps between
an agent's messages, each capped at 10 minutes, so idle time between resumes is
not counted.

**Ledger.** One JSON line per message in
`~/.pi/agent/subagent-ledger/YYYY-MM-DD.jsonl` (UTC day): `ts`, `sessionId`,
`sessionName`, `cwd`, `id`, `type`, `description`, `model`, `thinking`,
`requestedThinking`, `depth`, `parentAgentId`, `workflowId`, `cost`, `input`,
`output`, `cacheRead`, `cacheWrite`. The watchdog's `budget.dailyUsd` reads it.
Plan on roughly 2–10 MB per busy day.

**Backfill.** `recipes/scripts/subagent-ledger-backfill.py` rebuilds ledger lines
from the sessions pi-subagents saves for top-level agents (`rememberAgents`, on
by default). Run `--dry-run` first. Lines get `"source": "backfill"`; re-running
replaces earlier backfill lines, and an agent's messages are skipped once the
live extension has a line for it, so it is safe to run at any time. Nested
agents are not saved and cannot be recovered, and neither is the thinking level
an agent asked for.

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
