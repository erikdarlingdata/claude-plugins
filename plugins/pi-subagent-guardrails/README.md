# pi-subagent-guardrails

Token-budget guardrails for multi-agent pi setups. The central fact: an agent pays for its whole context on every
turn, and a turn happens on every tool result, follow-up, resume and cross-session message. Large contexts
multiplied by frequent wakes is the bill. One overnight orchestration that ignored this hit its usage limit and lost
every agent at once: 100% of the usage came from subagent-heavy sessions, 99% from sessions running 8+ hours, and
95% at more than 150k context.

This plugin has three pieces. They work without each other, but they're designed together:

| File | What it is |
|---|---|
| [`guardrails.md`](guardrails.md) | The written rules: fan-out caps, model tiers, context discipline, session length, ranking, and which rules a mechanism enforces. Point your agents at it from `AGENTS.md`. |
| [`subagent-extensions/context-wall.ts`](subagent-extensions/context-wall.ts) | A subagent-only extension that tells the CHILD its own size and walls it off before the watchdog's hard stop. |
| [`agents/lane.md`](agents/lane.md) | A pi-subagents agent type for code-editing lanes: Sonnet, its own worktree, draft PRs, the dispatch rules built in, the context wall loaded, and no fan-out tools. |

Requires [pi-subagents](https://github.com/tintinweb/pi-subagents). The wall's hard-stop backstop is
[`pi-subagent-watchdog`](../pi-subagent-watchdog/README.md), from the same package.

## The context wall

A subagent can't see its own context size, so "hand off at 150k" in a prompt is an honor-system rule. In one audit,
0 of 39 subagents honored it. The watchdog can see the size, but it reports to the **parent**, and each report wakes
the parent's whole context. A parent at 400k that handles two check-ins has spent ~800k tokens managing one child.

The wall talks to the child instead:

| Judged size | What happens |
|---|---|
| 100k (`nudge`) | Only if the agent has not edited any code yet (write/edit to anything but `.md`/`.txt`): a one-time notice to stop investigating, make the smallest change that meets the brief, and push a draft PR. Added after two lanes spent their whole budget reading and shipped nothing. |
| 150k (`warn1`) | A one-time `[context-wall]` notice is appended to the tool result the agent is already reading: finish the step, commit, push, report, stop. |
| 200k (`warn2`) | One last notice. Until the agent has run a `git push` or `gh pr create`, both notices lead with "nothing is pushed yet: push a draft PR first." |
| 250k (`wall`) | Every tool call is refused **except** shell commands made of `git`/`gh` (with `cd`/`export` segments and trailing pipes allowed) and writes to `.md`/`.txt` files. The agent can still commit, push and write its report; it just can't keep working. |

The **judged size** is the larger of live context (`ctx.getContextUsage()`) and total token use (input + output +
cache writes summed over the session's assistant messages, the same measure the watchdog's `hardStop.tokens`
uses). Total use outruns context by 1.1–1.5×, so judging context alone would let the watchdog abort the agent,
losing its uncommitted work and its report, before the wall ever fired.

**Elapsed time gets the same treatment.** The watchdog's `hardStop.minutes` kills a child with no warning, so a lane
stopped in the middle of a full test run loses its push and its report. The wall sends one notice at `warnMinutes`
("start no new step and no full test run; commit, push, report") and applies the same git/gh-and-notes-only wall at
`wallMinutes`. When `context-wall.json` doesn't set them, they default to 10 and 5 minutes before the watchdog's
`hardStop.minutes` (read from `~/.pi/agent/subagent-watchdog.json`, only when its hard stop is enabled): 20 and 25
for a 30-minute stop. With no minute limit anywhere, there is no time wall.

It fails open: any error is a no-op, so a bug can't block or spam an agent. It's a budget wall, not a security
sandbox (a `$(...)` inside a git command still runs).

### Install

The package ships the file, but deliberately **not** as an auto-loaded extension. If it loaded into your interactive
session, the wall would block *you* at 250k. Subagents load it through their agent file's frontmatter:

```yaml
extensions: ["*", "~/.pi/agent/git/github.com/erikdarlingdata/claude-plugins/plugins/pi-subagent-guardrails/subagent-extensions/context-wall.ts"]
```

`"*"` keeps every normally discovered extension, and the path adds the wall. That path is where
`pi install git:github.com/erikdarlingdata/claude-plugins` puts it. Adjust it for an npm install or your own copy.
Add the line to each agent file in `~/.pi/agent/agents/` whose children should be walled (worker, scout, planner,
reviewer, and so on). `agents/lane.md` already has it.

Thresholds live in `~/.pi/agent/context-wall.json` (copy [`context-wall.example.json`](context-wall.example.json)).
The file is read on every call, so no reload is needed. A missing file or bad values fall back to 100k / 150k / 200k / 250k.

**Smoke test:** set `{"warn1": 1, "warn2": 900000000, "wall": 2}`, spawn a cheap subagent that runs `ls` and then
`git --version`, and check that `ls` is refused with a `context-wall:` reason while `git` runs and carries the
warning. Then restore the file right away, because the thresholds are live for every running subagent.

## The lane agent

Copy [`agents/lane.md`](agents/lane.md) to `~/.pi/agent/agents/lane.md` and dispatch with
`subagent_type: "lane"`. What it encodes:

- **Model and isolation:** Sonnet, `isolation: worktree` (2 of 12 lanes told to "make your own worktree" edited the
  shared checkout anyway), and `max_turns: 100`.
- **Git discipline:** draft PRs only, explicit-path staging, and no destructive git.
- **Token rules:** the dispatch-prompt lines from `guardrails.md`, a 400-word final message, and the full report in
  the PR body.
- **No fan-out:** `disallowed_tools` removes spawning, workflow, fusion, background, messaging and MCP tools, so a
  lane can't fan out or reach production on its own. Add your own production-facing tools to that list. Unknown
  names are harmless.

## Recommended companion settings

`~/.pi/agent/subagents.json` (pi-subagents):

```json
{ "maxConcurrent": 3, "maxConcurrentForeground": 1, "strictAgentFiles": true }
```

`~/.pi/agent/subagent-watchdog.json`: wake the parent only for an agent at the wall, and hard-stop past it:

```json
{
  "mode": "strict",
  "signals": { "tokens": 250000, "contextPercent": 25, "toolUses": null, "turns": null, "minutes": null, "compactions": 1 },
  "models": {
    "allowed": ["openrouter/~anthropic/claude-opus-latest", "openrouter/~anthropic/claude-sonnet-latest", "openrouter/~openai/gpt-luna-latest"],
    "onViolation": "hard-stop"
  },
  "hardStop": { "enabled": true, "tokens": 300000, "minutes": 30 }
}
```

The activity triggers (turns, tool uses, minutes) are off on purpose. On normal lanes they woke the parent within
minutes, and every wake re-reads the parent's whole context. The wall covers the child, and the watchdog covers the
parent's view and the hard stop. Put the model tiers in the agent files (`model:` per role) rather than forcing one
model for every child. Test each alias with one `pi -p` call first, because workspace guardrails on your provider can
block models.
