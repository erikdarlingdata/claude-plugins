# pi-subagent-watchdog

Catch runaway [pi](https://pi.dev) subagents while they're still 60 seconds
old instead of 2M tokens deep.

Background subagents (from the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension) only
notify the orchestrator when they *finish*. Between spawn and completion the
orchestrator model is asleep — a child can wedge on one enormous grep, quietly
compact and keep burning, or balloon from 200k to 2M tokens, and nothing wakes
the parent. This extension watches every running top-level subagent's live
vitals and, when any configurable signal crosses its threshold, injects a
check-in message into the main conversation so the orchestrator assesses the
child: on track, lost and needing guidance, or runaway and needing a wrap-up
order or a stop.

## Install

```bash
pi install git:github.com/erikdarlingdata/claude-plugins
```

The extension auto-loads on the next pi session. It requires the
`@tintinweb/pi-subagents` extension (the one that provides the `Agent` tool) —
without it, the watchdog idles harmlessly.

Or copy the single file by hand: `extensions/subagent-watchdog.ts` goes
anywhere under `~/.pi/agent/extensions/`.

## Quick start

Nothing to configure — sane defaults apply. Then:

```text
/watchdog help     full command + settings reference
/watchdog config   edit config in pi's editor (JSON-validated, applied live)
/watchdog          interactive panel when agents are running
```

When a subagent crosses a threshold, the orchestrator receives a numbered
check-in carrying vitals, the agent's most recent tool calls, and a decision
protocol — plus self-diagnosing notes for the two known non-distress
signatures (a wedged first tool call, and frozen-counters-while-composing).
You'll see a `🐕 N` footer status while agents are watched.

## Signals

All optional; `0`/`null` disables one. Defaults sit above the measured
envelope of a healthy, thorough worker (~113k tokens / 10 tools / 7 turns /
5 min for a careful reviewer).

| Signal | Default | What it catches |
| --- | --- | --- |
| `tokens` | 250000 | lifetime spend (input + output + cacheWrite) |
| `contextPercent` | 60 | child context fill — the earliest runaway tell; lifetime totals grow quadratically once context is fat |
| `toolUses` | 40 | iteration count (completed tool calls) |
| `turns` | 30 | assistant turns, derived from the child's transcript |
| `minutes` | 10 | wall clock — the **only** signal that catches a tool call wedged mid-execution |
| `compactions` | 1 | the child auto-compacted; on a chunk-sized task that's a red flag |

Different task shapes trip different signals first (big-read agents hit
`tokens`, step-per-turn agents hit `turns`, wedged tools hit only `minutes`) —
which is why it's multi-signal.

## Modes

`mode` sets the orchestrator's posture when a signal is hit:

| | `guide` (default) | `strict` |
| --- | --- | --- |
| Framing | assess: on track / lost / runaway | thresholds are **budgets** |
| Healthy agent | runs free, no action | wrap-up steer by default; continuation requires cited convergence evidence plus ONE named, bounded extension ("+2 minutes") |
| Repeat check-in | re-assess with numbered context | check-in #2 = extension spent: wrap up or stop |
| Best for | interactive sessions, tasks of varying size | cost-capped or unattended fleets |

Check-ins are numbered per agent in both modes, so the orchestrator knows a
first look from a re-assessment.

## Config

`~/.pi/agent/subagent-watchdog.json`, overridden per-project by
`.pi/subagent-watchdog.json` (trusted projects only). Edit via
`/watchdog config`, or by hand followed by `/watchdog reload` — no session
restart either way.

```json
{
  "enabled": true,
  "mode": "guide",
  "action": "wake",
  "deliverAs": "steer",
  "pollIntervalMs": 15000,
  "cooldownMs": 90000,
  "renotifyFactor": 2,
  "signals": {
    "tokens": 250000,
    "contextPercent": 60,
    "toolUses": 40,
    "turns": 30,
    "minutes": 10,
    "compactions": 1
  },
  "hardStop": { "enabled": false, "tokens": 1500000, "minutes": 45 }
}
```

- `action` — `"wake"` injects the check-in for the orchestrator LLM;
  `"notify"` is UI-toast only (breaches aren't consumed when no UI exists to
  show them).
- Re-arm: after alerting, a signal re-alerts at `value × renotifyFactor`
  (`contextPercent`: +15 pts; `compactions`: each increment); `cooldownMs`
  floors the wake rate per agent. Values are sanitized — strings parse,
  nonsense falls back, floors apply.
- `hardStop` — opt-in automatic abort. Unlike a steer (which queues behind a
  running tool call), the stop interrupts a wedged tool mid-execution. The
  outcome is reported to the orchestrator **from the RPC reply**: a failed or
  unanswered stop says so explicitly (agent still running, do not respawn) and
  re-arms for retry.

## Surfaces

- **`/watchdog`** — audit + intervention panel: pick a running agent → show
  vitals/recent tools, request an immediate check-in, steer it (custom or
  canned wrap-up), or hard stop.
- **`/watchdog config` / `reload` / `status` / `help`** — settings without
  session restarts.
- **`subagent_vitals` tool** — lets the orchestrator snapshot every running
  agent's vitals and recent tool calls in one call.

## How it works

- Roster from the `subagents:created/started/completed/failed` bus events.
- A lazy poll timer reads each running agent's **live record** through
  pi-subagents' documented manager registry
  (`globalThis[Symbol.for("pi-subagents:manager")]`): lifetime usage, tool
  uses, compactions, context %.
- The child's streamed `.output` transcript is read incrementally (byte-offset
  tailing) for the two things the record doesn't carry: derived turn count and
  the most recent tool calls.
- `subagents:compacted` triggers an immediate evaluation.
- On breach: `pi.sendMessage({...}, { deliverAs: "steer", triggerTurn: true })`
  wakes the orchestrator; hard stops go through the `subagents:rpc:stop` bus
  verb with reply-verified reporting.
- A root-ownership claim (`Symbol.for("subagent-watchdog:owner")`, mirroring
  pi-subagents' own manager-key pattern) keeps child sessions — which re-run
  extension factories in the same process — fully dormant, so check-ins can
  never leak into a child's conversation.

## Limitations

- Top-level agents only: workflow/nested children are owned by their parents
  and invisible to the registry by design.
- Turn count and recent tools need the `.output` transcript
  (pi-subagents' `outputTranscript`, on by default); other signals work
  without it.
- A steer cannot interrupt a *running* tool call — it queues until the tool
  returns. Only a hard stop (auto or `/watchdog`) breaks a wedged execution;
  check-ins say so when they detect that case.
- The roster is in-memory: children already running across a `/resume` are
  re-tracked only if pi-subagents re-emits lifecycle events for them.
