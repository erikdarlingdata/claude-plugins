# Token and subagent guardrails (HARD LIMITS)

Written 2026-09-23 after a real incident, hardened the same day, and revised after 8 hours of running under it.
Drop it into your agent setup as-is, or trim it to taste. "The operator" is you, the human who owns the usage bill. These limits apply to **every agent session, in every project and every harness**
(pi, Claude Code, or anything else): interactive seats, headless runs, subagents, workflow children and multi-model
fan-out calls.

## Why these exist

An overnight multi-agent orchestration hit the operator's usage limit, and every agent was killed at once. The usage
report showed:
- 100% of usage came from subagent-heavy sessions;
- 99% came from sessions running 8+ hours;
- 95% came at >150k context;
- subagents were reaching about 1M context.

Work was also never ranked, so the spend didn't even buy the most important things first.

**The cost model behind every rule.** An agent pays for its whole context on every turn. A turn happens on every tool
result, every follow-up message, every resume, and every cross-session message that wakes it. So a 500k-context
agent that answers one message costs about as much as reading 500k tokens. Large contexts multiplied by frequent
wakes is the bill.

## 1. Fan-out

- **At most 3 subagents running at once per session**, and **at most 5 agent processes running at once across the
  whole machine** (all seats, headless runs, subagents, workflow children, fan-out candidates). "Running" means
  working: an idle seat waiting on its user doesn't count, but an agent waiting on its own test run does. More needs
  the operator's explicit OK, given for that wave, not standing.
- **One agent per issue is not a plan.** Batch small RELATED issues (same files or subsystem) into ONE agent that
  works them in rank order, sized to finish inside the subagent wall-clock limit (section 4). Measured 2026-09-23: a
  Sonnet lane closed 3–4 related issues in 35–45 minutes. A large or unrelated item gets its own agent.
- **Code-editing agents run isolated** (pi and Claude Code: `isolation: "worktree"`). A brief that says "make your own
  worktree" is not enough: 2 of 12 lanes edited the shared checkout anyway. Read-only reviewers need no isolation.
- **Don't spawn for work you can do in a few tool calls:** verification, `gh` checks, a small edit, one read.
- **Workflow and multi-model fan-out tools need the operator's explicit ask every time** (see the tool table). A call that
  fans out to N models counts as N agents against the caps; a pi `fusion_*` call is 5.
- **Finished agents stop; they don't idle.** Stop background tasks you no longer need. A seat whose queue is done
  writes its handoff and exits instead of idling in a live session, where every incoming message re-reads its whole
  context.

## 2. Model choice

Name models by tier and moving alias, never by an explicit version. A pinned version strands a seat a release behind.

| Tier | pi (OpenRouter) | Claude Code | Use for |
|---|---|---|---|
| **default** | `openrouter/~anthropic/claude-sonnet-latest` | `sonnet` | Mechanical or narrow work: a one-file fix, a grep-driven audit, a flake investigation, recon, verification. |
| **top** | `openrouter/~anthropic/claude-opus-latest` | `opus` | Design, security review, or hard debugging only. Name which one in the brief. |
| small | `openrouter/~openai/gpt-luna-latest` | `haiku` | Pure lookups. (GPT Luna is about 20× cheaper than the default. Use Haiku instead if your provider allows it.) |
| rare | `openrouter/~anthropic/claude-fable-latest`, or Opus if your provider blocks it | `fable` (Fable 5) | Only these three, named in the brief: a tie-break on a tier-1 security or design PR when Opus review rounds conflict; the validator in a design crew; a short, high-judgment coordinator session. Never a worker, a routine reviewer, or a long-running coordinator. About 2.5× the top tier and 5× the default per token. |

- On pi, the model comes from the agent file (set pi-subagents' `strictAgentFiles: true` so every spawn uses one), or from an explicit
  caller `model` for a one-off escalation. Agent files (`~/.pi/agent/agents/*.md`) carry the tier their role needs:
  planner and reviewer are top; scout and worker are default.
- On pi, a child on any model outside the watchdog's `models.allowed` list (the tiers you use) is **hard-stopped** as
  soon as it starts.
- A worker escalates to top only for one of the three top-tier reasons, named in its brief.
- Interactive coordinator sessions choose their own model. The policy governs the children they spawn.
- Price context (OpenRouter, 2026-09-23, per M tokens in/out): Opus 5.5 $4/$20; Sonnet 5 $2/$10; GPT Sol $2/$10;
  GPT Luna $0.10/$0.50; Fable and GPT Astra $10/$50; Haiku $1/$5. Workspace guardrails can block models: test each
  alias with one `pi -p` call before you put it in an agent file or an allowlist.

## 3. Context

- **Never fork once your own context is past ~300k.** A fork inherits your whole conversation, and so does any tool
  that seeds a child with a projection of it (pi: `Agent` `inherit_context: true`, `bg_delegate`). Write a
  self-contained brief instead.
- **Never resume a finished agent for NEW work.** Spawn a fresh one with a short brief. Every resume re-reads the
  entire transcript; resumes have run at 700–1,100 prior messages.
- **Put every ruling, boundary, fence and rule in the FIRST prompt.** Each follow-up wakes the agent and re-reads its
  transcript. Budget: at most ONE follow-up per agent, and only for a correction you could not have known at
  dispatch. No nudges, no reminders, no "status?" pings.
- **Cross-session messages cost the same.** Send a large-context seat a non-urgent fact as a handoff/bus file it reads
  at its next boundary, not as a message. Batch whatever must be sent into one message.
- **Every dispatch prompt includes these lines verbatim:**
  - "Never paste full test output. Grep for `[FAIL]|Total:`."
  - "Read files by offset/limit. Never read a whole large file."
  - "Run targeted test classes while iterating. Run the FULL suite ONCE, at the end."
  - "Cap command output: pipe through `head`, `tail -n` or `grep`. Never dump full CI logs, full JSON, or whole
    issue/PR bodies."
  - "Stop and write a handoff note when your context passes about 150k."
  - "Never end your turn to wait for a background notification. Run long commands in the foreground, or poll your
    own output file." (A lost notification stranded a lane idle for 1.5 hours.)
  - "Put your full report in the PR body (an issue comment if there is no PR). Your final message is 400 words or
    fewer and links it." (Long final messages arrive truncated, and recovering the rest costs the one follow-up.
    Report FILES are unreliable: on 2026-09-23 the harness blocked all three lanes' report writes. A PR body is
    durable, and the coordinator reads it anyway. With no PR and no issue, the final message is the report, still
    400 words or fewer.)
- **Standing prompts are context too.** Loop charters, tick prompts, CLAUDE.md/AGENTS.md files and memory indexes are
  loaded on every run. Keep each under ~8k tokens (~30 KB). At every wave boundary, prune what is resolved instead of
  appending forever.
- **At most 2 adversarial review rounds per PR.** Reviewer agents and multi-model validation calls (`fusion_validate`)
  both count. A third-round finding lands only if it is High, and then as a follow-up issue, not a third round.

## 4. Session length

- **No seat session past ~250k context or ~8 hours, whichever comes first.** At either limit, or at any wave
  boundary:
  1. write a handoff file (state, ranked queue, what's in flight, what not to touch);
  2. tell the operator;
  3. start a fresh session.

  Don't wait for compaction to force it (retrying a stalled compaction on a huge context is a time sink of its own).
- **Coordinator sessions have more leeway.** At ~900k, a coordinator writes a handoff to a sub-coordinator and
  re-surfaces only to report when that completes.
- **Subagents** write a handoff at ~150k tokens; one that passes ~300k is stopped. On pi the child is told directly:
  `[context-wall]` notices at 150k and 200k, and at 250k every tool except git/gh and `.md`/`.txt` writes is refused,
  so it can still commit and report. Wall clock: 30 minutes where the pi watchdog enforces it, so size pi briefs to
  that. In Claude Code, which has no watchdog, the limit is ~60 minutes,
  because a full test run alone takes ~10. The coordinator enforces it.
- **Coordinators don't trust notifications for deadlines.** Set a wall-clock check at each lane's deadline (pi: a
  named `bg_run` `sleep` timer). At every agent report, check that the shared checkout is still clean.
- **Rewrite the handoff file at each boundary; don't append to it.** Delete what is resolved and keep it under ~8 KB.
  An append-only handoff turned into a stale 150-line file that misled the next read.
- **No open-ended "cook" loop.** Before a wave starts, write down in the wave's handoff file: the queue slice, the
  agent count and models, the max wall-clock, and the stop point. Keeping work in flight never overrides these limits.
- **Headless and scheduled runs** (`pi -p`, `claude -p`, cron or tmux ticks, loops, scheduled agents) start a fresh
  session each tick (`--no-session` on pi) with a hard timeout, and their prompt obeys the standing-prompt cap.

## 5. Ranking (before ANY dispatch)

Write the ranked queue, show it to the operator, get an OK, then work top-down.

1. **Release blockers and data loss:** a fresh install broken, collection stopping, lost data, security.
2. **User-visible breakage in the field.**
3. **Field-reported performance, by measured user impact** (seconds waited × how often). Put the measurement or the
   estimate next to each item; an unmeasured item ranks at the bottom of this tier.
4. **Internal performance, cleanup, docs.**
5. **Test flakes and infrastructure.** Exception: a flake that fails CI for every lane moves up to tier 1 for that day.

Also:
- Before a release cut, only tiers 1–2 plus what is already in review.
- An issue filed mid-wave joins the queue at its tier. It doesn't jump to "now" unless it is tier 1. **Filing an
  issue is not permission to work it.**
- The tiers order NEW work. They are never a reason to file a small fix instead of doing it: a gap in something you
  just shipped, or a small in-lane defect (under ~30 minutes), gets fixed now (the "Finish the work" rule).
- Re-rank at every wave boundary.
- **Verify before arming, cheaply.** The coordinator reads each PR's core product diff and checks the one or two
  invariants an agent most often misses:
  - storage precision (PostgreSQL and DuckDB keep microseconds);
  - NULL and tie ordering;
  - a plan that depends on an index some stores won't have yet;
  - translated or locale-specific text;
  - per-row versus per-snapshot semantics.

  On 2026-09-23 this caught real defects in 6 of 25 agent PRs, for far less than a revert. A security PR always gets
  review round 1.
- **Agent PRs open as drafts** (`gh pr create --draft`); the coordinator readies each one after verifying it. A draft
  can't be merged from the UI. On 2026-09-23 three PRs opened ready were merged mid-verification, and one put a
  regression on dev.
- If the operator is unavailable (overnight), work only the pre-approved slice. When it's done, stop. Don't extend the queue
  yourself.

## 6. What is enforced mechanically, and what isn't

Where a harness enforces caps (a concurrency limit, a model allowlist, a context or time watchdog), keep its settings
at or below these rules. The pi settings below are the recommended ones; the plugin README has the exact JSON.

- **pi-subagents** (`~/.pi/agent/subagents.json`): `maxConcurrent: 3` (background) and `maxConcurrentForeground: 1`.
  These are separate pools, so the mechanical ceiling is 4; the rule is still 3. There is no forced model: the agent
  files carry the tiers.
- **pi context wall** (`subagent-extensions/context-wall.ts` in this plugin; thresholds in
  `~/.pi/agent/context-wall.json`, read live): loaded only into subagents, via each agent file's `extensions:` line, never into interactive sessions.
  It judges the larger of live context and total token use (input + output + cache writes, the watchdog's own
  measure), so the wall always comes before the hard stop. It warns the child at 150k and 200k and walls it at 250k.
  It talks to the child, so it costs the parent nothing.
- **pi subagent watchdog** (`~/.pi/agent/subagent-watchdog.json`): `models.allowed` = the default, top and small
  aliases, hard-stop on violation. It wakes the PARENT only for an agent at the wall (250k tokens or 25% context);
  the turn, tool-call and minute triggers are off because they woke the parent for normal work. It hard-stops at
  300k tokens or 30 minutes.
- **pi `lane` agent** (`agents/lane.md` in this plugin, copied to `~/.pi/agent/agents/`): Sonnet,
  `isolation: worktree`, draft PRs, and the dispatch lines baked in. Fan-out, cross-session and MCP tools are
  disallowed; add your own production tools to its `disallowed_tools`. Use it for code-editing lanes.
- **Measure every wave:** `agent-report --session <parent session .jsonl>`. It is `tools/agent-report.ts` in the
  pi-subagent-guardrails package. It reports per agent: turns, base/mean/peak context, the cost split, the largest tool
  results, build/test/push counts, milestones, and violations of the dispatch lines. A proposed change to a brief, an
  agent file or a threshold names the agent-report number it should move, and the next wave's report checks it.
- **Claude Code has no watchdog.** Every rule here is honor system there.

**Honor system everywhere:** the machine-wide 5-process cap, follow-up discipline, seat session length, the
standing-prompt cap, and ranking. Name any violation in the next handoff.

## Tool names: pi and Claude Code

| Rule | pi | Claude Code |
|---|---|---|
| fork | `Agent` `inherit_context: true`; `bg_delegate` | `subagent_type: "fork"` |
| resume | `Agent` `resume` | `SendMessage` to a finished agent |
| follow-up | `steer_subagent`; `intercom` send/ask | `SendMessage` |
| stop | `bg_kill`; agents end when they return | `TaskStop` |
| isolation | `Agent` `isolation: "worktree"` | `isolation: "worktree"` |
| model | `Agent` `model`, or the agent file's `model:` | `model: "sonnet"` / `"opus"` / `"haiku"` |
| fan-out | `SubagentWorkflow`, `fusion_*` | `Workflow` |
