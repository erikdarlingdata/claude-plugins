# pi-subagent-watchdog

Catch runaway [pi](https://pi.dev) subagents while they're still 60 seconds
old instead of 2M tokens deep.

Background subagents (from the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension) only
notify the orchestrator when they *finish*. Between spawn and completion the
orchestrator model is asleep — a child can wedge on one enormous grep, quietly
compact and keep burning, or balloon from 200k to 2M tokens, and nothing wakes
the parent. This extension watches every running top-level subagent's live
vitals and, when any configurable signal crosses its threshold, queues a
compact, fleet-batched check-in so the orchestrator assesses the child: on
track, lost and needing guidance, or runaway and needing a wrap-up order or a
stop. Full structured details persist outside LLM context; per-agent and
global rate limits bound the watchdog's own token tax.

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

When subagents cross thresholds near one another, the orchestrator receives
one compact message containing their numbered check-ins, vitals, effective
model, and two most recent tool calls. The complete structured record — task,
all five retained tool calls, thresholds, and action — is stored as a
`subagent-watchdog-audit` custom entry that never enters LLM context. You'll
see a `🐕 N` footer status while agents are watched.

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
  "globalCooldownMs": 60000,
  "batchWindowMs": 5000,
  "maxCheckInsPerAgent": 2,
  "auditTrail": true,
  "renotifyFactor": 2,
  "signals": {
    "tokens": 250000,
    "contextPercent": 60,
    "toolUses": 40,
    "turns": 30,
    "minutes": 10,
    "compactions": 1
  },
  "models": { "required": null, "onViolation": "notify", "unknownGraceMs": 30000 },
  "hardStop": { "enabled": false, "tokens": 1500000, "minutes": 45 }
}
```

- `action` — `"wake"` queues a batched orchestrator check-in; `"notify"` is
  UI-toast only (breaches aren't consumed when no UI exists to show them).
- `batchWindowMs` collects agents that breach near one another into one model
  turn. `globalCooldownMs` rate-limits the whole fleet; `cooldownMs` still
  rate-limits each agent.
- `maxCheckInsPerAgent` caps automatic LLM wakes. In strict mode the cap is
  absolute; in guide mode a signal the agent has never crossed before (for
  example, its first compaction) may speak once beyond the cap. Other later
  breaches stay UI/audit-only. Human-requested `/watchdog` check-ins bypass it.
- `auditTrail` persists structured `subagent-watchdog-audit` custom entries in
  the root session JSONL. Custom entries are durable but do not participate in
  LLM context.
- Re-arm: after alerting, a signal re-alerts at `value × renotifyFactor`
  (`contextPercent`: +15 pts; `compactions`: each increment). Values are
  sanitized — strings parse, nonsense falls back, floors apply.
- `models.required` — optional exact effective `provider/model-id` invariant,
  read from the live child session on every spawn path with the invocation
  snapshot as a startup fallback. A mismatch is written to the structured
  audit and either notified (the default) or hard-stopped (`onViolation`). A
  running agent whose model stays unknown past `unknownGraceMs` fails closed the
  same way. Bare names are rejected at config load rather than armed. Run
  `/watchdog status` and copy its exact model string into the config. This is
  still defense-in-depth: primary coercion belongs in pi-subagents before launch,
  and workflow/nested children remain invisible to the watchdog.
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
  agent's effective model, vitals, and recent tool calls in one call.

## Token accounting and turn limits

The watchdog does not make child-model calls. Its polling reads in-memory
counters and transcript bytes. A long-lived child can still show quadratic
*lifetime traffic* because every turn reads a growing conversation. If context
grows by roughly `Δ` per turn, cumulative reads after `N` turns include
`Δ × N(N+1)/2`. Prompt caching usually moves that traffic into cheaper
`cacheRead`; a cold or invalidated cache can rewrite the large prefix as
`cacheWrite` and make the displayed lifetime counter jump.

The watchdog's `tokens` signal matches pi-subagents' display counter:
`input + output + cacheWrite`. It deliberately excludes `cacheRead`, which is
repeated prefix traffic rather than new work, even though providers may still
bill it. Use context percentage for current size and cost reporting for spend.

Containment belongs at the agent runner as well as the observer. Configure a
real ceiling in `~/.pi/agent/subagents.json`:

```json
{
  "defaultMaxTurns": 30,
  "graceTurns": 3,
  "maxConcurrent": 8,
  "showCost": true,
  "showModel": true
}
```

Pi-subagents asks the child to wrap at `defaultMaxTurns` and aborts after the
grace turns if it ignores the order. `maxConcurrent` reduces fleet stampedes;
it does not by itself reduce the work assigned. `showModel` adds the effective
model and thinking level to live CLI/widget rows. Agent results and the
watchdog's own surfaces also report the effective model.

## Forensic trail

- Automatic/manual breaches and interventions: non-context
  `subagent-watchdog-audit` entries in the root session under
  `~/.pi/agent/sessions/`.
- LLM wakes and hard-stop reports: `custom_message` entries with
  `customType: "subagent-watchdog"`; these participate in context until
  compacted.
- Child conversation copy: pi-subagents' temporary `.output` JSONL under the
  OS temp directory when `outputTranscript` is enabled.
- Full child session: a normal persisted Pi session when pi-subagents'
  `rememberAgents` is enabled (the default).
- Footer state, UI toasts, poll samples, and event-bus messages are ephemeral.

Turning off `.output` does not save model tokens; it only removes a temporary
forensic source and disables the watchdog's transcript-derived turns/recent
calls.

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
- On breach: complete details go to `pi.appendEntry(...)`; eligible breaches
  enter a fleet batch. One compact `pi.sendMessage(...)` wakes the orchestrator
  after the batch window and global cooldown. Later per-agent breaches beyond
  the automatic cap remain audit/UI-only.
- Hard stops go through the `subagents:rpc:stop` bus verb with reply-verified
  reporting.
- A root-ownership claim (`Symbol.for("subagent-watchdog:owner")`, mirroring
  pi-subagents' own manager-key pattern) keeps child sessions — which re-run
  extension factories in the same process — fully dormant, so check-ins can
  never leak into a child's conversation.

## Limitations

- Top-level agents only: workflow/nested children are owned by their parents
  and invisible to the registry by design. Model policy must therefore also be
  enforced pre-spawn by the subagent manager; the watchdog is the regression
  alarm, not the complete gate.
- Turn count and recent tools need the `.output` transcript
  (pi-subagents' `outputTranscript`, on by default); other signals work
  without it.
- A steer cannot interrupt a *running* tool call — it queues until the tool
  returns. Only a hard stop (auto or `/watchdog`) breaks a wedged execution;
  check-ins say so when they detect that case.
- The roster is in-memory: children already running across a `/resume` are
  re-tracked only if pi-subagents re-emits lifecycle events for them.
