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
cp recipes/extensions/cache-tuning.ts ~/.pi/agent/extensions/
cp recipes/extensions/self-compact.ts ~/.pi/agent/extensions/
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
| `cache-tuning.ts` | Prompt-cache fixes for long-lived sessions on Anthropic models: 1-hour cache for the main session, two workarounds (needed before pi 1.2.0) for a pi bug that changes the system prompt, a keep-warm for idle sessions, a hold on pi-memory's prompt block, a keep-warm for subagents during long tool calls, and a per-request debug log | `PI_CACHE_KEEPWARM=0`, `PI_CACHE_KEEPWARM_HOURS`, `PI_CACHE_MEMORY_HOLD=0`, `PI_CACHE_HOLD_ROLLOVER=0`, `PI_CACHE_TOOLWARM=0`, `PI_CACHE_DEBUG=0`. Log in `~/.pi/agent/cache-debug/`. Reports: `recipes/scripts/cache-debug-report.py`, `recipes/scripts/rewrite-classify.py` |
| `self-compact.ts` | Lets a long-running session compact itself at task boundaries, compacts an idle session that grew too large, keeps compaction file lists from growing, and (trial) writes the summary from the cache | `PI_SELF_COMPACT_MIN_TOKENS`, `PI_SELF_COMPACT_AUTO_TOKENS`, `PI_SELF_COMPACT_IDLE_MIN`, `PI_SELF_COMPACT_FILE_LISTS=all`, `PI_SELF_COMPACT_CACHED_SUMMARY=1` or `~/.pi/agent/self-compact-cached-summary` |
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

## cache-tuning.ts

For sessions that run for days on an Anthropic model (direct or through
OpenRouter) and are woken by background-task, subagent and intercom
notifications. Checked against pi 1.0.4, with parts 2 and 3 re-read against the
pi 1.2.0 code. Each part is measured in the source
header. All of it changes the provider request only, never the transcript.

1. **1-hour cache for the main session.** Sets `PI_CACHE_RETENTION=long` when
   it is unset. pi reads the variable on every request, so `/reload` applies
   it. `long` is the only value that changes anything. Subagents run in the
   same process, so they inherit it. The extension strips the 1-hour TTL from
   their requests again, because they rarely sit idle long enough to gain from
   it and a 1-hour write costs 2x input instead of 1.25x.
2. **Prompt sections that disappear on notification runs.** Not needed on pi
   1.2.0 and later: pi now runs `before_agent_start` for notification runs
   (pi#10267, fixed in 1.2.0). On older pi, pi runs
   `before_agent_start` only for typed prompts
   ([earendil-works/pi#10267](https://github.com/earendil-works/pi/issues/10267)).
   On the second request of a run started by `sendMessage(..., { triggerTurn:
   true })`, pi records a removal of every section an extension added there.
   The next typed prompt adds it back. On Anthropic each change rewrites the
   whole conversation in the cache. The extension drops those removals for the
   two sections known to do this (`pi_background_shell_policy` from
   pi-background-tasks and `agent_browser` from pi-agent-browser-native).
3. **A forced system prompt that notification runs do not send.** Not needed
   on pi 1.2.0 and later. This comes from reading the 1.2.0 code and has not
   been tested on a live session. On older pi, the same
   bug, for an extension that returns `systemPrompt` from
   `before_agent_start`. pi-memory appends its `## Memory` block this way.
   pi sends that text as a forced prompt for the whole typed run, without the
   sections that later extensions add. A run started by a notification has no
   forced prompt and sends the transcript's version instead, so the two
   versions swap and each swap rewrites the whole conversation. The extension
   remembers the system text of the last typed run (one that fired
   `before_agent_start`) and sends it on notification runs.
4. **Keep-warm for idle sessions.** pi's own idle `cacheWarming` stops 30
   minutes after the last request, so it never fires with the 1-hour cache.
   After the session settles, the extension re-sends its last request with a
   one-token output cap every 54 minutes. A ping costs one cache read, about
   1/40 of a rewrite. It stops at the next real request, at compaction, after
   24 hours, when a timer fires late (sleep), and when a ping fails or finds
   the cache gone. Main session only. Pings are logged and, if
   `subagent-cost.ts` is installed, written to its ledger as seat lines with
   thinking `(cache warm)`.
5. **Debug log.** Every request is split into blocks (settings, each tool, the
   system prompt, each message part) and hashed. The log records where it first
   differs from the previous request, the cache usage of each reply, each ping,
   and each compaction start, success or failure. `cache-debug-report.py
   [hours] [--all]` lists every full rewrite with its cause: "prefix
   unchanged" (the provider dropped the cache), the block that changed, or a
   reload.
6. **Hold the pi-memory block.** pi-memory rebuilds its `## Memory` block in
   the system prompt after a long-term memory write and at the start of a
   compaction. Each rebuild rewrites the whole conversation in the cache. The
   session already has the entry it wrote in its conversation. So when the
   only change is inside that block and the reason is a long-term write or a
   running compaction, the extension sends the previous system text. It takes
   the new block on the first request after a load or a compaction. At local
   midnight it keeps the old block too, and adds a short message after the
   history with the new date. `PI_CACHE_HOLD_ROLLOVER=0` takes the new block
   instead. Main session only.
   Cache effect: the request after a memory write wrote 13 tokens instead of
   20,929. The request after midnight wrote 139 tokens instead of 13,105.
7. **Keep-warm during long tool calls.** Subagents use the 5-minute cache. A
   subagent that waits more than 5 minutes for a build or a test run loses it,
   and its next request rewrites the whole context. While a tool call runs, the
   extension re-sends the subagent's last request with a one-token cap every
   4.5 minutes, for up to 60 minutes. Each ping's cost goes into the
   `subagent-cost.ts` ledger under that subagent's id.
   Cache effect: after a 5-minute wait, the next request wrote 89 tokens
   instead of 12,844. A ping costs about $0.01 to $0.03.

`recipes/scripts/rewrite-classify.py` names a cause for each cache rewrite
from the session files alone: session start, compaction, model or thinking
change, idle gap, memory write, day change, system-prompt change, or
unexplained. It needs no debug log, so it also covers sessions from before you
installed this extension. `--validate` compares it with
`cache-debug-report.py`, and `--csv` writes one row per rewrite.

Three related settings that are not in the extension:

- **pi-lens context injection.** pi-lens adds one-time messages (start-up
  guidance, turn-end findings) to a single request and does not save them, so
  the next request differs at that point and the rest is rewritten. In long
  sessions, set `{"contextInjection": {"enabled": false}}` in
  `~/.pi-lens/config.json`. Its tools, LSP and read guard keep working.
- **pi-memory in subagents.** pi-memory keeps one snapshot per process, and
  in-process subagents share it. Each subagent start refreshes it, so the
  parent's system prompt changes and its whole conversation is rewritten. Add
  `exclude_extensions: [pi-memory]` to agent files that load `"*"`. Then run
  `/reload` in sessions with scheduled subagent jobs. Scheduled jobs do not
  read the agent files again by themselves.
- **Changing the thinking level for one turn** keeps the cache on models
  where pi sends effort as a mid-conversation message (Opus 5.5:
  `supportsMidConvoEffort`). On a model without it, a level change rewrites
  the whole cache once.

## self-compact.ts

For sessions that run for days and get work from several places (you,
intercom, subagents, timers). You are often not there to run `/compact`
between tasks, and a session that is not compacted sends its whole history on
every request. Main session only. Events are logged to
`~/.pi/agent/cache-debug/`.

1. **The `self_compact` tool.** The agent calls it at a task boundary, with a
   reason and an optional `keep` list of facts the summary must hold. Below
   `PI_SELF_COMPACT_MIN_TOKENS` (default 150k) it does nothing. Above it, the
   compaction runs once the run has ended and the session is idle, so no
   request is sent during it. Add a line to your `AGENTS.md` that tells agents
   to call it when a task ends and the next work is unrelated.
2. **Idle backstop.** A session that settles above
   `PI_SELF_COMPACT_AUTO_TOKENS` (default 400k, 0 turns it off) and stays idle
   for `PI_SELF_COMPACT_IDLE_MIN` minutes (default 15) is compacted.
3. **File lists.** pi adds `<read-files>` and `<modified-files>` to every
   summary and carries the earlier lists forward, so they only grow. One
   session's lists reached 643 paths, about 17k tokens on every request. The
   extension keeps only the files from the span being summarized.
   `PI_SELF_COMPACT_FILE_LISTS=all` keeps pi's behavior.
4. **Cached summary (trial, off by default).** pi sends the conversation to
   the summary call as one new text message, so that call reads nothing from
   the cache. This part sends the session's last request unchanged, with the
   summary instructions added at the end, so the conversation is a cache read.
   It needs `cache-tuning.ts`. On any problem it falls back to pi's summary.
   Turn it on with `PI_SELF_COMPACT_CACHED_SUMMARY=1`, or per session: put the
   first 13 characters of the session id (or `*`) on a line of
   `~/.pi/agent/self-compact-cached-summary`.
   Cache effect: at 101k tokens, the summary call read 101,562 tokens from the
   cache and cost $0.018.

Cache effect of parts 1 and 2: one busy session averaged 517k tokens of
context a request before, and 207k to 224k after. Its cost per request fell
from $0.143 to $0.081 to $0.090.

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
