# Pi setup guide (for Claude Code ex-pats)

A short path from a clean machine to a comfortable Pi daily driver, followed by
optional operations and extension recipes.

**Last verified:** 2026-10-14 · **Pi:** 1.2.0 · **Primary test setup:** macOS,
Ghostty, npm 11.17.0, OpenRouter. Core Pi works on Linux and Windows too; macOS-
and terminal-specific steps are labeled.

The **15-minute install checklist** is: §1, the model-picker basics at the start
of §2, §3, one profile from §6, only the binaries that profile needs in §7, and
§8. Sections 4–5 and 9–10 are short reference material for the first few days;
sections 11–15 cover maintenance, recovery, watchdogs, recipes, and troubleshooting.
Reading every optional note is intentionally longer than 15 minutes.

Pi deliberately ships a small core and expects you to choose extensions. Treat
those extensions like executable dependencies, not editor themes: they run with
your user permissions.

---

## 1. Install and first run

```bash
curl -fsSL https://pi.dev/install.sh | sh
cd /path/to/a/project
pi
```

The installer works on macOS and Linux. It pins dependencies, and `pi update`
updates the managed install. It keeps the new release and the one before it
under `~/.pi/agent/install/releases/`.

The npm install is the alternative. It needs Node 22.19 or newer and does not
pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi does not require npm lifecycle scripts for a normal install.

On first run, use `/login` to authenticate. Built-in subscription logins include
"Sign in with ChatGPT" (under the OpenAI provider), Claude Pro/Max, GitHub Copilot, and others. API-key
providers can use `/login`, environment variables, or `~/.pi/agent/auth.json`.
That file contains secrets, is created mode `0600`, and must never be committed.

Try one request before installing anything else:

```text
Summarize this repository and tell me how to run its checks.
```

## 2. Models, reasoning, cost, and OpenAI/Codex notes

Interactive setup is safest because it uses the live model catalog:

- **Ctrl+L** or `/model` → select a model → **Ctrl+S** saves it as the startup default
- `/thinking` → select a level → **Ctrl+S** saves it
- Shift+Tab cycles the current thinking level
- Ctrl+P / Shift+Ctrl+P cycles your `/scoped-models` shortlist

Thinking levels are:

```text
off | minimal | low | medium | high | xhigh | max
```

Only levels supported by the selected model appear or take effect. Project-local
`.pi/settings.json` recursively overrides global settings. Some settings — such
as `defaultProjectTrust`, `cacheWarming`, and `httpProxy` — are global-only.

A direct JSON example, using one tested environment rather than a universal
recommendation:

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "anthropic/claude-fable-5",
  "defaultThinkingLevel": "xhigh",
  "modelThinkingLevels": {
    "openrouter/~anthropic/claude-opus-latest": "xhigh"
  }
}
```

### OpenAI / Codex users

There are three distinct routes. They can expose different catalogs, quotas,
cache behavior, and prices even when model names look similar.

| Route | Setup | Billing / limits |
| --- | --- | --- |
| ChatGPT subscription | `/login` → OpenAI → "Sign in with ChatGPT" | Codex subscription route, officially endorsed by OpenAI. The older provider is now named "OpenAI Codex (legacy)" |
| Direct OpenAI API | `/login` with an API key, or `OPENAI_API_KEY` | OpenAI API billing and quotas |
| OpenRouter | `/login` → OpenRouter | OpenRouter routing, billing, and provider behavior |

Pi maps `/thinking` levels to OpenAI reasoning effort where supported. Do not
invent Anthropic-style thinking-token budgets for direct OpenAI models; use the
catalog's supported effort levels unless a custom compatible endpoint explicitly
requires a token-budget field.

Direct OpenAI GPT-5.6 and GPT-6 models (Sol, Terra, Luna, Astra, and GPT-6.1
Sol) intentionally default to a **272K** context window to remain inside
OpenAI's short-context pricing tier. A larger window is an advanced opt-in.
Put this in `~/.pi/agent/models.json`, not `settings.json`:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": { "contextWindow": 1050000 }
      }
    }
  }
}
```

Above 272K total input, OpenAI applies long-context rates to the whole request,
not just the excess. Apply the same override to Terra or Luna only when the task
needs it.

`PI_PROVIDER` and `PI_MODEL` report the model Pi selected. A router can choose a
different concrete backend; when attribution matters, inspect the assistant
message's `responseModel` in the session JSONL.

Leave `transport: "auto"` unless troubleshooting. `transport: "sse"` is the
conservative fallback when a proxy or network path breaks WebSockets.

### Watch cost and cache behavior

The footer shows input, output, cache-read, cache-write, cost, and context usage.
`/session` shows totals and the current cache-warming decision. Temporarily set
`showCacheMissNotices: true` when investigating expensive misses.

Subagents run in their own sessions, so the footer's `$` leaves out what they
spend unless pi-subagents' `reportUsage` setting is on. The footer also covers
one session only. To see spend by agent type and thinking level, and every
session's own spend plus its agents' across the machine, use the
`subagent-cost.ts` recipe (section 14).

`cacheWarming` is `off`, `streaming`, or `idle` and defaults to `streaming`.
Warming needs a `promptCache` lifetime on the model. The bundled catalog sets
it only for direct Anthropic models. Direct OpenAI has none, so warming may
report unavailable even when provider-side prompt caching exists. OpenRouter
models have none either. You can declare one with a `modelOverrides` entry
in `models.json`.
`PI_CACHE_RETENTION=long` requests longer retention where supported; inspect
`/session` rather than assuming it took effect. `long` is the only value that
changes anything; unset or any other value means the 5-minute cache. On
OpenRouter it applies to `anthropic/...` model IDs, not to `~anthropic/...`
aliases.

For sessions that run for days and are woken by notifications, most of the
bill is cache writes, not output. Measured on one week of such sessions (pi
1.0.4, Claude Opus 5.5 through OpenRouter):

- A wake after more than 5 minutes idle rewrote the whole context with the
  default 5-minute cache. The 1-hour cache fixes waits under an hour. pi's
  idle warming stops 30 minutes after the last request, so it does not cover
  longer waits.
- Before pi 1.2.0, pi did not run `before_agent_start` for runs started by a
  notification
  ([earendil-works/pi#10267](https://github.com/earendil-works/pi/issues/10267)).
  Prompt text that extensions add there (pi-background-tasks, the agent-browser
  extension, pi-memory) disappeared and came back, and each change rewrote
  the whole conversation. pi 1.2.0 fixes this.
- pi-lens injects one-time messages that the next request does not have.
- pi-memory keeps one memory snapshot per pi process, and pi-subagents runs
  its children in the parent's process. Each subagent that loads pi-memory
  refreshes the snapshot at its start, so the parent's next request has a new
  system prompt and rewrites the whole conversation. Measured on pi 1.2.0:
  25 full rewrites in 24 hours, most from one session with an hourly subagent.

The `cache-tuning.ts` recipe (section 14) covers the first, adds a
keep-warm for idle sessions and logs the cause of every full rewrite. On pi
before 1.2.0 it also works around the second. For the third and fourth, see
the pi-lens and pi-memory notes in section 6.

### Compaction budget on large-context models

Pi caps the compaction summary at `min(0.8 × compaction.reserveTokens, model
maxTokens)` (checked against Pi 0.87.0's `compaction.js`, and still true in 1.2.0). The default
`reserveTokens` is 16384, so the summary gets about 13K output tokens. Compaction
also runs at the session's current thinking level, and reasoning tokens count
against that same cap. A long session on a 1M-context model at `xhigh` can use up
the budget before the summary finishes:

```text
Error: Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete
```

Retrying fails the same way every time. Pi 1.2.0 leaves thinking blocks out of
the compaction input, which shrinks the request. Keep the reserve advice below.
Give large-context models a bigger
reserve with a per-model override; keys are exact `provider/modelId` values:

```json
{
  "compaction": {
    "modelOverrides": {
      "openrouter/anthropic/claude-opus-5.5": { "reserveTokens": 65536 }
    }
  }
}
```

On a 1M window this raises the summary cap to about 52K and moves auto-compaction
from about 984K to about 934K tokens. `reserveTokens` is also the headroom the
summarization request itself needs, so raise it moderately rather than to the
model's full output limit. `/reload` re-reads settings. To recover a session
that is already stuck, see §15.

## 3. Trust, approvals, and safer modes

Pi has no built-in per-command approval gate. `bash`, `edit`, and `write` run
immediately with your user permissions. Project trust controls which project
resources load; it is not a sandbox.

Recommended defaults:

- Keep `defaultProjectTrust: "ask"`.
- Use `/trust` in directories you control. The UI can trust the immediate parent,
  which covers a projects directory when repositories are direct children.
- Restart after `/trust`; it writes `trust.json` for future sessions but does not
  retroactively load resources skipped by the current session.
- Use `pi -a` to trust project resources for one run or `pi -na` to ignore them.

Trust protects project `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`,
`.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, project `.pi/mcp.json`, project packages, and project
`.agents/skills`. **Context files still load regardless of trust**:
`AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` can all influence the model.
Treat instructions in an untrusted clone as untrusted input.

Non-interactive modes cannot ask. With no saved decision,
`defaultProjectTrust: "ask"` and `"never"` skip protected project resources;
pass `--approve` explicitly when automation requires them.

Useful containment and recovery modes:

```bash
# Read-only built-ins. --tools keeps MCP tools, so add --no-mcp
pi --tools read,grep,find,ls --no-mcp

# Start without any discovered extensions (this also turns off the
# built-in extensions, MCP included)
pi --no-extensions

# Disable all discovered extensions, then load exactly one
pi --no-extensions -e ./extension.ts
```

For untrusted or unattended work, use a container, VM, micro-VM, or other OS
boundary with minimal files, credentials, and network access. Project trust does
not replace isolation.

Bundled examples worth knowing:

- `permission-gate.ts`
- `confirm-destructive.ts`
- `dirty-repo-guard.ts`
- `protected-paths.ts`

## 4. Claude Code → Pi translation

| Claude Code | Pi |
| --- | --- |
| `CLAUDE.md` | Loads `AGENTS.override.md`, otherwise `AGENTS.md` or `CLAUDE.md`, from cwd and parents; global `~/.pi/agent/AGENTS.md` also loads |
| Custom slash commands | Prompt templates in `~/.pi/agent/prompts/` or `.pi/prompts/` |
| Skills | Native `SKILL.md` support |
| `!` shell escape | `!cmd` sends output to the model; `!!cmd` stays local. Stock Pi does not trigger a model turn when it finishes; the optional `bang-notify.ts` recipe in §14 does |
| Copy-on-select | Fullscreen mode copies mouse selection and flashes confirmation; Ctrl+X copies the last assistant reply |
| Links | Bare URLs are terminal-detected; OSC 8 labels are available through the optional `clickable-links.ts` recipe |
| `/compact`, continue, resume | `/compact`, `pi -c`, `pi -r`, `pi --session <path-or-id>` |
| `/btw` | Type while Pi works: Enter steers after the current tool call; Alt+Enter queues a follow-up |
| Checkpoints / rewind | Double-Escape or `/tree`; `/fork` and `/clone` branch session history |
| MCP | Built in: `/mcp`, `pi mcp add`, config in `~/.pi/agent/mcp.json` |
| Ephemeral chat | `pi --no-session` |

## 5. Terminal ergonomics

### Fullscreen and copying

Fullscreen is the default since Pi 1.0.0. For normal terminal scrollback, use
regular mode for one session:

```bash
pi --tui-mode regular
```

Persist it through `/settings` or:

```json
{ "tuiMode": "regular" }
```

`fullscreenCopyOnSelect` defaults to `true`. Ctrl+X copies the last assistant
message, the selected `/tree` message, or an active fullscreen selection when
auto-copy is disabled.

In fullscreen, Pi owns the screen, so terminal-native
scrollback/search/selection give way to Pi's scroll region.

### Ghostty and modified Enter keys

Ghostty config locations:

- macOS: `~/Library/Application Support/com.mitchellh.ghostty/config`
- Linux: `~/.config/ghostty/config`

Useful mapping:

```text
keybind = alt+backspace=text:\x1b\x7f
```

Remove the old Claude Code mapping below unless another tool still needs it:

```text
keybind = shift+enter=text:\n
```

It sends a raw linefeed indistinguishable from Ctrl+J, so Pi cannot see a real
Shift+Enter event.

### tmux

For tmux 3.5 or newer:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

On tmux 3.2–3.4, enable `extended-keys` but omit `extended-keys-format csi-u`.
Without extended keys, Shift+Enter and Alt+Enter can collapse into plain Enter.

OSC 8 links behind tmux also need terminal passthrough and, when detection cannot
see through the multiplexer, `PI_HYPERLINKS=1`.

### Write-only terminal surfaces fail silently

Raw terminal escapes written to `process.stdout` can work in regular mode and
vanish in fullscreen mode, where Pi owns stdout and repaints frames. No documented
extension API exposes `tuiMode`; `ctx.mode` is simply `"tui"` for both.

Prefer supported UI APIs where they behave correctly. For any write-only output
path, include a self-test command that reports what the extension believes — the
same reason `/linktest` exists. Ghostty and iTerm2 can turn BEL into an
unfocused-tab attention marker; the optional `settle-bell.ts` recipe rings only
on `agent_settled`.

## 6. Choose an extension profile

Pi packages execute arbitrary code with your user permissions. Review source,
try packages with `pi -e`, and pin versions or git refs for a shared known-good
stack.

### Core coding

```bash
pi install npm:pi-lens
pi install npm:pi-memory
```

MCP is built in since Pi 1.0.0: use `/mcp` and `pi mcp add|list|login|logout|remove`.
Servers live in `~/.pi/agent/mcp.json`, and `--no-mcp` turns them off for one
run. `pi-mcp-adapter` is an alternative. If you keep it, add `-builtin:mcp` to
`extensions` in `settings.json` so two MCP stacks do not run.

Pi also ships `codemode` and `tool_search` built-in extensions. See
`docs/codemode.md` in the Pi docs (section 11).

If you use pi-memory with pi-subagents, keep pi-memory out of subagents. Add
`exclude_extensions: [pi-memory]` to each agent file in `~/.pi/agent/agents/`
that loads extensions with `"*"`. Subagents then lose the memory tools and the
memory block, and the parent's prompt cache survives each spawn. Only add it
where pi-memory is installed: pi-subagents warns about an exclude that matches
no extension.

The Agent tool reads the agent files again on each call. Scheduled subagent
jobs do not. They use the agent files that the session loaded, until the
session reloads or runs the Agent tool. After you change an agent file, run
`/reload` in each session that has scheduled jobs.

In long-running sessions on a cached model, turn off pi-lens context injection
with `{"contextInjection": {"enabled": false}}` in `~/.pi-lens/config.json`.
Its messages are sent once and not saved, so the next request rewrites the
conversation after them. Tools, LSP and the read guard keep working.

### Delegation

```bash
pi install npm:@tintinweb/pi-subagents
pi install git:github.com/erikdarlingdata/claude-plugins
```

The second package supplies session auto-resume, the watchdog, and the SQL Server
query-plan skill. Do not also hand-copy either extension; duplicate commands and
tools cause startup conflicts.

### Collaboration

```bash
pi install npm:pi-messenger
pi install npm:pi-intercom
pi install npm:pi-background-tasks
```

`pi-messenger` provides rooms/tasks/crew coordination. `pi-intercom` is direct
same-machine session-to-session messaging. Install only what you use; each active
tool and its schema adds model context.

### Web and browser

```bash
pi install npm:pi-web-access
pi install npm:pi-agent-browser-native
pi install npm:pi-web-ui
```

### Cosmetic compatibility

```bash
pi install npm:pi-cc-extensions
```

For this tested stack, `pi-web-search` and `pi-web-access` have been observed to
register a conflicting `web_search` tool. Prefer `pi config` or package filtering
to disable one non-destructively.

Package operations:

```bash
pi -e npm:<package>            # try without installing
pi list                        # authoritative installed-package inventory
pi config                      # enable/disable package resources
pi remove npm:<package>
pi update --extensions         # update packages; pinned specs stay pinned
pi update --models             # refresh model catalogs
pi update --self               # update Pi only
pi update --all                # update Pi and packages
```

After installing a new package, a full restart is the safest path. `/reload`
reliably reloads auto-discovered local extensions and resources; freshly changed
package settings have occasionally required a restart in this tested stack.

**Do not reload a parent Pi session while useful subagents are running.**
Pi-subagents aborts its children during session shutdown.

## 7. External binaries

```bash
# Browser engine used by pi-agent-browser-native
npm install -g agent-browser
agent-browser install    # downloads Chrome for Testing (--with-deps on Linux)

# Search backend used by pi-memory
npm install -g @tobilu/qmd

# Optional browser recording
brew install ffmpeg

# Put the web UI command on PATH
npm install -g pi-web-ui
```

The tested company npm configuration blocks lifecycle scripts by default, while
`agent-browser` needs its postinstall. With npm 11:

```bash
npm install -g --allow-scripts=agent-browser agent-browser
```

This is npm-version and registry-policy specific; `npm install --help` shows
whether `--allow-scripts` is available.

`pi-agent-browser-native` needs Node 24.21 or newer and Pi 1.0.0 or newer. Any
stable agent-browser 0.35.0 or later works with it.

## 8. Verify the setup

Start with deterministic inventory and recovery checks:

```bash
pi --version
pi list
pi -p "Reply exactly: OK"
pi --tools read,grep,find,ls --no-mcp -p "List the repository's top-level files"
pi --no-extensions -p "Reply exactly: SAFE_MODE_OK"
```

`pi -p` exits 1 when the reply is cut off at the output limit.

Then verify only the profiles you installed:

1. `/session` — confirm the session file, selected model, token/cache totals, and cost.
2. `/watchdog status` — confirm thresholds, model policy, active capabilities, and no configuration error.
3. Subagents — run one tiny read-only child and confirm its **effective** model in the result/widget.
4. Browser — open <https://example.com> and take an interactive snapshot; expect `@e1`-style refs.
5. Memory — ask for memory status; qmd should be available.
6. Diagnostics — introduce a deliberate type error in a disposable file and confirm Pi Lens reports it; then remove it.
7. Web UI — run `pi-web-ui`, open <http://localhost:8787>, then Ctrl+C.
8. Intercom — from another session in the same folder, use `/intercom` or Alt+M.

The startup header lists loaded resources. `pi list` is the authoritative package
inventory.

## 9. Daily-driver commands

| Command | Purpose |
| --- | --- |
| `pi -c` | Continue the most recent session |
| `pi -r` | Browse previous sessions |
| `pi --session <path-or-id>` | Open a specific session; partial ID is accepted |
| `pi --no-session` | Ephemeral session |
| `/name <name>` | Name a session for resume and intercom |
| `/session` | Session ID/file, messages, token/cache totals, cost |
| Double-Escape or `/tree` | Navigate session history |
| `/fork` / `/clone` | Branch before / at a selected entry |
| Enter / Alt+Enter while running | Steer / queue follow-up |
| `@` | Fuzzy file search; pi-subagents also adds agent handles |
| Ctrl+L | Model picker |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models |
| Ctrl+G / Ctrl+V | External editor / paste image or text |
| Ctrl+X | Copy last assistant reply or selected tree message |
| Ctrl+O / Ctrl+T | Toggle tool output / thinking visibility |
| `/new` / `/resume` | Start a new session / pick a previous one |
| `/reload` | Re-read settings and local resources |
| `/copy` | Copy the last assistant reply (alternative to Ctrl+X) |
| `/trust` | Trust the current project directory |
| `/export` / `/share` | HTML export / gist link |
| `/hotkeys` | Show active keybindings |
| `/bug` | Report a Pi issue with session diagnostics |

The shell-tool environment includes `PI_SESSION_ID`, `PI_SESSION_FILE`,
`PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. These are available inside
the LLM-callable `bash`/`powershell` tools, **not** user-entered `!`/`!!` commands.

## 10. Move Claude Code work and memory without rewriting it

Pi cannot import a Claude Code transcript as a native Pi session. Claude history
is plain JSONL under `~/.claude/projects/<encoded-cwd>/`; ask Pi to read it and
distill decisions into project `AGENTS.md`: conventions, traps, deliberate
non-fixes, and run commands.

For the accumulated per-project Claude memory dirs, prefer pointers over a
migration:

1. Put one uncommitted parent `AGENTS.md` in the directory containing your repos.
   Describe the path rule:
   `~/.claude/projects/<cwd with "/" replaced by "-">/memory/`.
2. If both harnesses should read the same file, symlink `CLAUDE.md` to it.
3. In `~/.pi/agent/AGENTS.md`, point to `~/.claude/CLAUDE.md` and home-scope
   memories; mark `~/.claude/` read-only.
4. Add the same short knowledge-source rule to subagent definitions.
5. Check for `AGENTS.override.md`; it replaces `AGENTS.md`/`CLAUDE.md` for that
   directory and can silently defeat a shared symlink strategy.

Rule of thumb: **push conventions, point at archives**.

## 11. Files, package maintenance, and recovery

Global state:

```text
~/.pi/agent/settings.json     settings + package list
~/.pi/agent/auth.json         credentials (secret; 0600)
~/.pi/agent/trust.json        project trust decisions
~/.pi/agent/keybindings.json  key overrides
~/.pi/agent/models.json       custom models and overrides
~/.pi/agent/models-store.json refreshed provider catalogs
~/.pi/agent/mcp.json          MCP servers (project: .pi/mcp.json)
~/.pi/agent/SYSTEM.md         system prompt replacement (optional)
~/.pi/agent/APPEND_SYSTEM.md  text appended to the system prompt (optional)
~/.pi/agent/install/          managed install releases (installer only)
~/.pi/agent/sessions/         transcripts grouped by cwd
~/.pi/agent/extensions/       local extensions
~/.pi/agent/agents/           pi-subagents definitions
~/.pi/agent/prompts/          prompt templates
~/.pi/agent/skills/           skills
~/.pi/agent/npm/              npm packages
~/.pi/agent/git/              git packages
```

Project-local `.pi/` supports settings, extensions, skills, prompts, themes,
system-prompt files, package installs, and any package-specific directories.
Credentials and trust decisions remain global. Sessions remain global unless
`sessionDir` or `--session-dir` says otherwise.

Official docs are under one of these, depending on how you installed Pi:

```bash
~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs
"$(npm root -g)/@earendil-works/pi-coding-agent/docs"
```

Upgrade deliberately:

```bash
pi list
pi update --models
pi update --extensions
pi update --self
```

A bare `pi update` updates Pi only. `pi update --all` updates Pi and packages.
Versioned npm specs and git refs are pinned and do not move during ordinary
package updates. Re-run §8 after updates. Keep `retry.provider.maxRetries` at
`0` unless provider-level retries are intentional; otherwise SDK retries can
hold quota failures before Pi's agent-level retry logic sees them.

If startup breaks:

```bash
pi --no-extensions
pi config
pi remove npm:<offending-package>
```

Use `PI_OFFLINE=1` to disable startup network operations, or
`PI_SKIP_VERSION_CHECK=1` only to suppress the version request.

## 12. Session auto-resume after reboots

`pi-session-resume` ships in `claude-plugins` from §6. Install its shell wrapper:

```bash
# macOS dependency; use your platform's jq package otherwise
brew install jq
mkdir -p ~/.local/bin
ln -sf ~/.pi/agent/git/github.com/erikdarlingdata/claude-plugins/plugins/pi-session-resume/bin/pi-resume-sessions \
  ~/.local/bin/pi-resume-sessions
# Ensure ~/.local/bin is on PATH.
```

If you previously hand-copied `session-registry.ts`, remove that duplicate.
Restart sessions once so they register and name important ones with `/name`.

```bash
pi-resume-sessions
pi-resume-sessions --list
```

Rules:

- Ctrl+D or `/quit` deregisters the session permanently.
- Closing a terminal without quitting marks it interrupted and resumable.
- Sessions idle over 72h are skipped but reported; tune with `--max-age`,
  `--named-only`, or `--all`.
- `--tmux` and `--terminal` are available alternatives to Ghostty tabs.
- On first Ghostty automation, allow Terminal to control Ghostty. If the macOS
  prompt was dismissed: `tccutil reset AppleEvents com.apple.Terminal`.
- There is deliberately no LaunchAgent; run the script after a reboot.

Full details:
<https://github.com/erikdarlingdata/claude-plugins/tree/main/plugins/pi-session-resume>

## 13. Runaway subagent watchdog

`pi-subagent-watchdog` also ships in `claude-plugins` and requires
`@tintinweb/pi-subagents`. Do not hand-copy a second instance.

It watches running **top-level** children for lifetime tokens, context usage,
tool calls, transcript-derived turns, per-run wall clock, and compactions. A
compact check-in wakes the orchestrator while complete structured audit records
stay out of LLM context.

Token-tax controls:

| Setting | Default | Purpose |
| --- | --- | --- |
| `batchWindowMs` | 5000 | Collapse nearby breaches into one wake |
| `globalCooldownMs` | 60000 | Minimum gap between fleet wakes |
| `maxCheckInsPerAgent` | 2 | Automatic wakes per agent |
| `auditTrail` | true | Persist full non-context forensic entries |

Modes:

- `guide` — assess on-track / lost / runaway; healthy work continues.
- `strict` — thresholds are budgets; wrap by default. When the live active tool
  set contains `extend_subagent`, continuation requires a real bounded extension;
  older pi-subagents get truthful leave-alone/wrap guidance instead.

Optional `models.required` enforces an exact effective `provider/model-id` for
watched top-level agents. Identity comes from the live child session across all
spawn paths, with startup metadata only as fallback. Mismatches default to
`notify`; `hard-stop` is opt-in. `/watchdog status` prints the exact copyable
model string and active capabilities. For per-task model choice, use
`models.allowed` (a list of exact ids that supersedes `required`) and put each
role's tier in its agent file's `model:`.

Budget guardrails: the watchdog wakes the **parent**, and each wake re-reads
the parent's whole context. `pi-subagent-guardrails` (same package) adds the
child-side half:

- **A context wall.** It warns the child itself at 150k and 200k, then refuses
  everything but git/gh and `.md`/`.txt` writes at 250k, so the agent commits
  and reports before the hard stop.
- **A `lane` agent** for code-editing lanes.
- **Written rules** for fan-out, model tiers, context and ranking.

The wall is deliberately not auto-loaded; subagents opt in through their agent
file's `extensions:` line. With it in place, turn the watchdog's `turns`,
`toolUses` and `minutes` triggers off. Setup and the recommended JSON:
<https://github.com/erikdarlingdata/claude-plugins/tree/main/plugins/pi-subagent-guardrails>

Surfaces:

| Command/tool | Purpose |
| --- | --- |
| `/watchdog` | Human panel: inspect, check in, steer, hard stop |
| `/watchdog status` | Config, capabilities, watched agents |
| `/watchdog config` | Edit validated global JSON and apply live |
| `/watchdog reload` | Re-read hand-edited config |
| `/watchdog help` | Full settings reference |
| `subagent_vitals` | One-call fleet snapshot for the orchestrator |

A steer cannot interrupt a running tool call; only a hard stop can. Wall clock
is therefore the only signal that catches a child wedged inside one giant tool.

Cost controls. All are off until you set a value:

| Setting | Effect |
| --- | --- |
| `signals.costUsd` | Check-in when one agent's spend passes the amount |
| `hardStop.costUsd` | Stop one agent at the amount (needs `hardStop.enabled`) |
| `budget.sessionUsd` | Warn the parent each time this session's subagent spend passes 1×, 2×, 3× the amount |
| `budget.dailyUsd` | Same, for today's (UTC) spend across every pi session, read from the ledger |
| `budget.ledgerDir` | Ledger directory; default `~/.pi/agent/subagent-ledger` |

Budget warnings never stop an agent. The per-agent signals read pi-subagents'
own lifetime cost and work with any version. The session budget needs the
`subagents:usage` event, and the daily budget needs the ledger that the
`subagent-cost.ts` recipe writes (section 14). With neither in place they stay
at $0. Each session watches the ledger on its own, so every session with agents
running gets its own daily warning.

To get a feel for real numbers before choosing values, leave them unset and use
`subagent_vitals`, `/watchdog status` (shows this session's spend) and
`/subagent-cost`.

Full details:
<https://github.com/erikdarlingdata/claude-plugins/tree/main/plugins/pi-subagent-watchdog>

## 14. Optional extension recipes

Full, maintained source moved out of the 15-minute path:

<https://github.com/erikdarlingdata/claude-plugins/tree/main/recipes/extensions>

Available recipes:

- `reply-timestamps.ts` — durable reply stamps and footer clock
- `clickable-links.ts` — OSC 8 labels, `/linktest`
- `bang-notify.ts` — completion wake-ups and learned `!` command suggestions
- `settle-bell.ts` — BEL on `agent_settled`; terminal-native attention marker
- `refusal-fallback.ts` — advanced, policy-sensitive automatic fallback
- `subagent-cost.ts` — subagent spend in the footer by type and thinking level,
  a machine-wide ledger of every session's own spend and its agents', and
  `/subagent-cost` reports by type, agent, session, issue or day, for one
  session or all of them. Needs a pi-subagents build with the `subagents:usage`
  event (see the recipe README). `recipes/scripts/subagent-ledger-backfill.py`
  rebuilds the ledger from saved subagent sessions.
- `cache-tuning.ts` — prompt-cache fixes for long-lived sessions on Anthropic
  models: 1-hour cache for the main session only, workarounds for prompt text
  that disappears on notification runs (pi#10267, fixed in pi 1.2.0, so
  needed only on older pi), a keep-warm for idle
  sessions, and a debug log of why each full cache rewrite happened
  (`recipes/scripts/cache-debug-report.py`).

Copy only what you want into `~/.pi/agent/extensions/`, review it first, and run
`/reload` only after useful subagents have finished.

## 15. Troubleshooting

- **Extension prevents startup:** `pi --no-extensions`, then `pi config` or
  `pi remove npm:<package>`.
- **Tool-name conflict:** disable one resource with `pi config`; package filtering
  is preferable to uninstalling when testing a fix.
- **Newly installed package appears stale:** fully restart Pi. `/reload` handles
  local auto-discovered resources, but this tested stack has occasionally needed
  a restart after package-list changes.
- **Do not `/reload` with useful subagents running:** parent shutdown aborts them.
- **Binary missing after install:** check the registry's lifecycle-script policy
  and `npm install --help`; see §7.
- **Model refusal:** switch with Ctrl+L/Ctrl+P or use the advanced refusal recipe
  only for an approved false positive and approved destination provider.
- **Which model am I on?** Ask Pi to run this through its `bash` tool:
  `printf '%s/%s (%s)\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`.
  User-entered `!` commands do not receive those variables.
- **400 `configuration_update` / mid-conversation effort error:** first refresh
  models with `pi update --models`. If the catalog still overclaims
  `supportsMidConvoEffort` (the 1.2.0 catalog no longer claims it for
  `openrouter/anthropic/claude-opus-5`, so an override there is redundant), apply a model-specific `compat` override in
  `~/.pi/agent/models.json`; remove it once the upstream catalog is corrected.
- **`Compaction failed: … hit the token cap`:** in the stuck session, run
  `/reload` if you just changed settings, then `/thinking` → `off`, `/compact`,
  and restore the thinking level afterward. Prevent a repeat with the
  `compaction.modelOverrides` reserve in §2. If it still fails with thinking off,
  the history is too large for one pass: `/tree` or `/fork` back to an earlier
  point, or have the agent write a handoff file and start `/new` from it.
- **Slow/hung quota failure:** verify `retry.provider.maxRetries` is `0` and
  `retry.maxAgentDelayMs` is bounded.
- **Cache surprise:** inspect `/session`; temporarily enable
  `showCacheMissNotices` rather than guessing from context size alone.
- **Terminal key acts like Enter:** check Ghostty's old Shift+Enter mapping and
  tmux extended-key settings in §5.
- **Need to report Pi itself:** `/bug <description>` includes session diagnostics.

Platform references:

- `docs/terminal-setup.md`
- `docs/tmux.md`
- `docs/windows.md`
- `docs/containerization.md`
- `docs/security.md`

Resolve those paths under the managed install
(`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent`)
or, for an npm install:

```bash
"$(npm root -g)/@earendil-works/pi-coding-agent"
```
