# Pi setup guide (for Claude Code ex-pats)

Distilled from several setup sessions. Total time is about 15 minutes, including npm commands.

Pi's philosophy is the opposite of Claude Code's: it ships minimal and expects
you to extend it. It's sort of like Arch Linux

---

## 1. Install and first run

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

On first run, use `/login` to authenticate a provider (it supports Anthropic subscriptions,
OpenRouter, Copilot, Codex, and local models via `/llama`). API keys can also
live in env vars or `~/.pi/agent/auth.json`.

## 2. Default model and thinking level

Two ways: interactive is easiest:

- `/model` → highlight your model → **Ctrl+S** saves it as the startup default
- `/thinking` → pick a level → **Ctrl+S** saves it

Or edit `~/.pi/agent/settings.json` directly:

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "anthropic/claude-fable-5",
  "defaultThinkingLevel": "xhigh",
  "modelThinkingLevels": { "openrouter/anthropic/claude-opus-5": "xhigh" }
}
```

Thinking levels: `off | minimal | low | medium | high | xhigh | max`.
Project-local `.pi/settings.json` overrides global. `/settings` edits common
options in-app.

**Habit-breaker:** Shift+Tab cycles *thinking level* in pi, not mode like Claude (manual/auto/plan, etc.).

## 3. Approvals: there's only one prompt to configure

Pi has **no per-command approval gate**: `bash`/`edit`/`write` run immediately
with your user permissions (no sandbox; see `docs/security.md`). The only
prompt is **project trust**: whether to load a repo's `.pi/` settings and
extensions (which are arbitrary TypeScript).

- Recommended: leave `defaultProjectTrust: "ask"` and run `/trust` once per
  directory you actually work in (it can trust the parent folder too: one
  `/trust` covers your whole projects dir). Decisions persist in
  `~/.pi/agent/trust.json`.
- `"always"` kills all prompts but means any cloned repo can run its
  own extensions. Only do this if you never open untrusted repos.
- Per-run: `pi -a` (trust) / `pi -na` (ignore project files).

## 4. Claude Code → pi translation (built in, no extension needed)

| Claude Code | pi |
| --- | --- |
| `CLAUDE.md` | Reads `AGENTS.md` **or** `CLAUDE.md` natively (cwd + parents + `~/.pi/agent/AGENTS.md`) |
| Custom slash commands | Prompt templates: `.md` files in `~/.pi/agent/prompts/` or `.pi/prompts/` |
| Skills | Native `SKILL.md` support |
| `!` shell escape | `!cmd` (output goes to model), `!!cmd` (output stays local). Gotcha: pi doesn't *wake* the agent when the command finishes — output sits in context until your next message. `bang-notify.ts` (§13) closes that gap, Claude-style, plus autocomplete for common commands |
| `/compact`, `--continue`, `--resume` | `/compact`, `pi -c`, `pi -r`, `pi --session <partial-id>` |
| `/btw` side questions | Type while it works: **Enter** = steering (injected after current tool call), **Alt+Enter** = follow-up (after all work). Or `@agentname question` routes to a subagent without touching main context |
| Checkpoints / rewind | Session **tree**: double-Escape jumps to any earlier point; `/fork` branches; add `git-checkpoint.ts` (below) to restore code state too |
| MCP | `npm:pi-mcp-adapter` extension |

## 5. The extension stack

This is the tested-together set. Install order doesn't matter, but **restart pi
fully after installing** (`/reload` does not reliably pick up new packages).

```bash
pi install npm:pi-mcp-adapter          # MCP servers as native tools
pi install npm:@tintinweb/pi-subagents # Claude Code-style Agent tool, fleet view, workflows
pi install npm:pi-lens                 # LSP diagnostics feeding the agent: biggest QoL gain
pi install npm:pi-memory               # persistent memory + search across sessions
pi install npm:pi-messenger            # multi-agent mesh: rooms, tasks, file reservations
pi install npm:pi-intercom             # 1:1 messaging between pi sessions on this machine
pi install npm:pi-background-tasks     # long-running commands with completion wake-ups
pi install npm:pi-agent-browser-native # real browser automation (needs binary, see §6)
pi install npm:pi-web-access           # web search / fetch / GitHub / PDF / YouTube
pi install npm:pi-web-ui               # browser cockpit for pi (see §6)
pi install npm:pi-cc-extensions        # Claude Code-style TUI polish (/ccstyle)
```

**Known conflict: do not also install `pi-web-search`.** It registers a
`web_search` tool that collides with `pi-web-access` and pi will refuse to
start. If you ever hit a tool-name conflict, the error names both file paths;
uninstall one (`pi remove npm:<name>`) or use package file-filtering in
settings.json.

**Bundled example extensions** (copy from
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
into `~/.pi/agent/extensions/`, they auto-load):

| Extension | Gives you |
| --- | --- |
| `plan-mode/` | Plan mode: `/plan` or Ctrl+Alt+P, read-only exploration |
| `todo.ts` | TodoWrite-style task list + `/todos` |
| `claude-rules.ts` | Reads your existing `.claude/rules/` folders |
| `notify.ts` | Desktop notification when a turn finishes |
| `git-checkpoint.ts` | Git stash checkpoint per turn; forks restore code state |
| `status-line.ts` | Footer status line |
| `protected-paths.ts` | Blocks writes to `.env`, `.git/`, `node_modules/` |

**Model fallback on refusals:** pi has no built-in fallback-model setting
(`retry.*` covers transient errors only). Quick manual option: keep a
`/scoped-models` shortlist and cycle with **Ctrl+P** on a refusal. Automatic
option: save the extension below as
`~/.pi/agent/extensions/refusal-fallback.ts` (auto-loads on next start) and
edit the three constants at the top for your provider/model:

```typescript
/**
 * Refusal Fallback Extension
 *
 * When a request fails with a provider content-policy refusal (e.g. Anthropic's
 * "blocked under Anthropic's Usage Policy"), switch the session to a fallback
 * model and continue the task automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FALLBACK_PROVIDER = "openrouter";
const FALLBACK_MODEL_ID = "anthropic/claude-opus-5";
const FALLBACK_THINKING = "xhigh" as const;

/** Error messages matching any of these are treated as policy refusals. */
const REFUSAL_PATTERNS = [
  /usage policy/i,
  /refusals-and-fallback/i,
  /blocked under anthropic/i,
  /violative/i,
  /content filter/i,
];

const CONTINUE_PROMPT =
  "The previous attempt was blocked by the provider's content filter. " +
  "You are now a different model. Please continue with the original request.";

export default function (pi: ExtensionAPI) {
  // Guard: only one fallback attempt per failure, reset on any successful response.
  let attempted = false;

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    const errorMessage = (msg as { errorMessage?: string }).errorMessage;
    if (!errorMessage) {
      attempted = false; // successful assistant message → re-arm
      return;
    }

    if (!REFUSAL_PATTERNS.some((p) => p.test(errorMessage))) return;

    // Already on the fallback model? Nothing left to fall back to.
    if (ctx.model?.provider === FALLBACK_PROVIDER && ctx.model?.id === FALLBACK_MODEL_ID) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Refusal on fallback model (${FALLBACK_MODEL_ID}) too, not retrying. Rephrase and resend.`,
          "error",
        );
      }
      return;
    }

    if (attempted) return;
    attempted = true;

    const model = ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL_ID);
    if (!model) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Fallback model ${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID} not found in catalog`,
          "error",
        );
      }
      return;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      if (ctx.hasUI) {
        ctx.ui.notify(`No auth for fallback provider ${FALLBACK_PROVIDER}`, "error");
      }
      return;
    }
    pi.setThinkingLevel(FALLBACK_THINKING);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Refusal detected, falling back to ${FALLBACK_MODEL_ID} (${FALLBACK_THINKING}). ` +
          "Use Ctrl+L to switch back.",
        "warning",
      );
    }

    // Re-trigger the turn on the new model. If the agent is still winding
    // down the errored turn, queue as a follow-up; otherwise send now.
    try {
      if (ctx.isIdle()) {
        pi.sendUserMessage(CONTINUE_PROMPT);
      } else {
        pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
      }
    } catch {
      // Streaming state changed between check and send; queue it.
      pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
    }
  });
}
```

**Tab-title status indicator:** with several sessions in terminal tabs, you
can't tell which agents are still working. This extension puts the state in
the tab title — `⏳ <session>` while running, `✅ <session>` when settled, `π
<session>` at rest — and rings the terminal bell on settle, which Ghostty and
iTerm2 render as an attention indicator on unfocused tabs. It hooks
`agent_settled` (not `agent_end`), so ✅ means *actually done*: auto-retries,
auto-compaction, and queued follow-ups exhausted. Save as
`~/.pi/agent/extensions/tab-status.ts`, then `/reload`:

```typescript
/**
 * Tab Status Extension — agent working state in the terminal tab title.
 * TUI-only: headless/rpc/subagent runs emit nothing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import process from "node:process";

const RING_BELL_ON_SETTLE = true;

function label(ctx: ExtensionContext): string {
  const name = ctx.sessionManager.getSessionName();
  return name && name.trim() ? name : basename(process.cwd());
}

function setTitle(text: string): void {
  // OSC 0 sets icon name + window/tab title; BEL-terminated.
  process.stdout.write(`\x1b]0;${text}\x07`);
}

export default function (pi: ExtensionAPI) {
  const inTui = (ctx: ExtensionContext) => ctx.mode === "tui";

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    if (!inTui(ctx)) return;
    setTitle(`π ${label(ctx)}`);
  });

  pi.on("session_info_changed", (_event: unknown, ctx: ExtensionContext) => {
    if (!inTui(ctx)) return;
    setTitle(`${ctx.isIdle() ? "π" : "⏳"} ${label(ctx)}`);
  });

  pi.on("agent_start", (_event: unknown, ctx: ExtensionContext) => {
    if (!inTui(ctx)) return;
    setTitle(`⏳ ${label(ctx)}`);
  });

  // agent_settled (not agent_end): fires only when pi will not continue on
  // its own — no pending auto-retry, auto-compact, or queued follow-up.
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (!inTui(ctx)) return;
    setTitle(`✅ ${label(ctx)}`);
    if (RING_BELL_ON_SETTLE) process.stdout.write("\x07");
  });

  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    if (!inTui(ctx)) return;
    // Clear our title so the shell/terminal takes back over.
    setTitle("");
  });
}
```

## 6. External binaries some extensions need

```bash
# Required by pi-agent-browser-native (the actual browser engine):
npm install -g agent-browser
# Required by pi-memory's search:
npm install -g @tobilu/qmd
# Optional: browser screen recording:
brew install ffmpeg
# pi-web-ui's command isn't put on PATH by `pi install`; make it real:
npm install -g pi-web-ui
```

**Company-registry gotcha:** our npm blocks lifecycle scripts by default and
`agent-browser` needs its postinstall to download the platform binary. If the
install "succeeds" but the binary is missing, rerun with:

```bash
npm install -g --allow-scripts=agent-browser agent-browser
```

## 7. Verify everything (5 minutes)

1. Start pi; the startup header lists every loaded package; failures show there.
2. Browser: ask pi to *"open <https://example.com> and take an interactive
   snapshot"*, you should get back a ref list (`@e1`, `@e2`...).
3. Memory: ask *"check memory status"*, qmd should show available.
4. Diagnostics: make a deliberate type error in a project file; pi-lens should
   report it after the edit.
5. Web UI: `pi-web-ui` → <http://localhost:8787> (loopback-only by default; it
   shares session history with the CLI). Ctrl+C when done.
6. Second terminal, same folder: `/intercom` or Alt+M to message your other
   session.

## 8. Daily-driver commands

| | |
| --- | --- |
| `pi -c` / `pi -r` / `pi --session <id>` | continue last / pick / resume specific (partial ID ok) |
| `/name <name>` | name the session; do this for anything you'll resume, and it's how other sessions identify each other on intercom |
| Double-Escape or `/tree` | jump anywhere in the session tree and continue from there |
| `/fork <msg>` | branch into a new session from an earlier prompt |
| Enter / Alt+Enter while running | steer now / follow up after |
| `@` | fuzzy file search; `@agentname text` messages a subagent |
| Ctrl+P | cycle scoped models (set the list with `/scoped-models`) |
| Ctrl+G / Ctrl+V | external editor / paste image |
| Ctrl+O / Ctrl+T | collapse tool output / thinking blocks |
| `/export`, `/share` | HTML export / gist link |

## 9. Migrating in-flight Claude Code work

Pi can't import Claude transcripts (different format), but you don't need it to:

1. Your Claude history is plain JSONL under
   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, which is greppable.
2. Ask pi to read the transcript and distill the *decisions* (not the chatter)
   into an `AGENTS.md` in the project root: data-model choices, naming traps,
   things deliberately not fixed, conventions.
3. `cd` into the project and start pi. It auto-loads `AGENTS.md`, so the new
   session starts fully briefed. Commit the file; it's the handoff document.

This works agent-to-agent generally: any session can brief its successor
through `AGENTS.md`.

### Point, don't migrate: making agents find your Claude memory

The distillation above is for handing off *one project*. For the months of
accumulated Claude Code memory (`~/.claude/projects/*/memory/`, one lesson per
file), don't move or rewrite anything — every transcription is a chance to
introduce errors, and your Claude sessions keep maintaining those dirs. Agents
ignore them for one reason only: nothing tells them they exist. Fix that with
pointers:

1. **Parent-directory context file** — pi loads `AGENTS.md` from the cwd *and
   every parent directory*. One uncommitted file at `~/Documents/GitHub/AGENTS.md`
   (or wherever your repos live) covers every repo beneath it — no commits to
   shared repos. Put in it: the path rule
   (`~/.claude/projects/<cwd with "/" → "-">/memory/`), a per-repo table of
   memory dirs, and the directive *"check before inventing conventions; verify
   the dir exists before concluding there's no prior context."*
2. **Symlink for dual harnesses** — `ln -s AGENTS.md CLAUDE.md` in that same
   directory; Claude Code walks parent dirs too, so both harnesses read one file.
3. **Global** — `~/.pi/agent/AGENTS.md` loads in every pi session: point it at
   `~/.claude/CLAUDE.md` and any home-scope memory dirs; declare `~/.claude/`
   read-only (new durable knowledge goes to pi memory or the repo's `AGENTS.md`).
4. **Subagent role definitions** (`~/.pi/agent/agents/*.md`) — add a short
   "knowledge sources" preamble with the same path rule, since spawned agents
   are the ones most likely to reinvent conventions.

Rule of thumb: **push conventions, point at archives.** A rule that must never
be violated ("this file is never machine-written") belongs verbatim in the
context file agents always see; everything else is one `ls` away.

## 10. Where everything lives

```
~/.pi/agent/settings.json     global settings + package list
~/.pi/agent/auth.json         provider credentials
~/.pi/agent/trust.json        project trust decisions
~/.pi/agent/sessions/         transcripts, one dir per cwd (shared with pi-web-ui)
~/.pi/agent/extensions/       your local extensions (auto-loaded)
~/.pi/agent/agents/           subagent role definitions (markdown + frontmatter)
~/.pi/agent/prompts/          prompt templates (slash commands)
~/.pi/agent/skills/           skills (SKILL.md dirs)
~/.pi/agent/npm/              pi-installed packages
.pi/                          project-local versions of all of the above
```

Docs live at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`, or
just ask pi about itself; it reads its own documentation.

## 11. Session auto-resume after reboots

Claude Code needed SessionStart/SessionEnd hooks plus a boot script to bring
back your sessions after an update or restart. The pi version ships in the same
package as the SQL Server skill (`pi-session-resume` plugin):

```bash
pi install git:github.com/erikdarlingdata/claude-plugins   # extension auto-loads
brew install jq                                            # script dependency
ln -s ~/.pi/agent/git/github.com/erikdarlingdata/claude-plugins/plugins/pi-session-resume/bin/pi-resume-sessions \
  /usr/local/bin/pi-resume-sessions
```

(If you previously hand-copied `session-registry.ts` into
`~/.pi/agent/extensions/`, delete that copy otherwise the extension runs
twice.)

Then: restart your pi sessions once so they register, name the ones you care
about (`/name`), and after any reboot:

```bash
pi-resume-sessions            # interrupted sessions come back as Ghostty
                              # tabs (newest first); --tmux / --terminal exist
pi-resume-sessions --list     # audit what's registered (age, name, cwd)
```

Rules a user should know:

- **Ctrl+D / `/quit` ends a session for good** (deregisters). Closing the
  terminal window without quitting = interrupted, it comes back next resume.
- Sessions idle >72h are skipped but reported (`--max-age`, `--named-only`,
  `--all` to tune).
- First Ghostty run pops “Terminal wants to control Ghostty”, click **Allow**.
  If you dismiss it, macOS never re-asks; fix with
  `tccutil reset AppleEvents com.apple.Terminal` and rerun.
- Deliberately no LaunchAgent: macOS automation prompts are unreliable from
  background context. Run it by hand after a reboot.

Full design notes and TCC troubleshooting:
`plugins/pi-session-resume/README.md` in the package repo.

## 12. Runaway subagent watchdog

pi-subagents' background children only report back at completion — nothing
wakes the orchestrator while one wedges on a giant grep, quietly compacts, or
balloons from 200k to 2M tokens. There is no token budget anywhere in the
stack (`max_turns` caps iterations, not spend). The `pi-subagent-watchdog`
extension ships in the same claude-plugins package as §11, so if you ran that
`pi install` it's already loaded (requires `@tintinweb/pi-subagents` from §5):

```bash
pi install git:github.com/erikdarlingdata/claude-plugins
```

It polls every running top-level subagent's live vitals (tokens, context %,
tool uses, transcript-derived turns, wall clock, compactions) and on any
threshold breach injects a numbered check-in into the main conversation —
vitals, the child's recent tool calls, and a decision protocol — so the
orchestrator assesses: on track, steer it, or stop it. A `🐕 N` footer status
shows while agents are watched.

| Surface | What it does |
| --- | --- |
| `/watchdog` | panel: pick a running agent → vitals / manual check-in / steer / hard stop |
| `/watchdog help` | full command + settings reference |
| `/watchdog config` | edit config in pi's editor, JSON-validated, applied live |
| `/watchdog reload` | apply a hand-edited config without restarting the session |
| `subagent_vitals` tool | the orchestrator's one-call fleet health snapshot |

Config: `~/.pi/agent/subagent-watchdog.json` (project override:
`.pi/subagent-watchdog.json`). The interesting knob is `mode`:

- **`guide`** (default) — check-ins ask the orchestrator to *assess*; healthy
  agents run free. For interactive work where task sizes vary.
- **`strict`** — thresholds are **budgets**: default action is a wrap-up
  steer; continuation requires cited convergence evidence plus ONE named
  bounded extension ("+2 minutes"), and check-in #2 means the extension is
  spent. For cost-capped or unattended fleets.

Optional `hardStop` block auto-aborts past a hard limit, with the outcome
reported from the RPC reply (a failed stop says "still running, do not
respawn" instead of lying).

Two facts worth knowing even without the extension: a **steer cannot
interrupt a running tool call** (it queues until the tool returns — only a
hard stop breaks a wedged execution), and **wall-clock time is the only
signal that catches a wedged tool** (a child stuck in one giant grep shows
frozen counters). Full docs:
`plugins/pi-subagent-watchdog/README.md` in the claude-plugins repo.

## 13. `!` commands: completion wake-ups + autocomplete

Two Claude Code habits `bang-notify.ts` restores. First: in Claude, the agent
reacts when your `!` command finishes; in stock pi the output lands in context
but nothing triggers a turn, so you type "done" to deliver it. Second:
autocomplete for the commands you run constantly (`aws sso login …`).

Save the code below as `~/.pi/agent/extensions/bang-notify.ts` (auto-loads on
next start; `/reload` picks it up too). Optional config at
`~/.pi/agent/bang-notify.json`:

```json
{
  "enabled": true,
  "minSeconds": 0,
  "alwaysOnError": true,
  "favorites": [
    "aws sso login --profile work-prod"
  ]
}
```

- `minSeconds` — wake the agent only if the command ran at least this long
  (`0` = every command; `8` is a good value if you only want wake-ups for
  commands you walked away from). `!!` never wakes the agent (its output is
  hidden from the model by design), nor does a command you Ctrl+C'd.
- `alwaysOnError` — non-zero exits wake the agent regardless of `minSeconds`,
  with a "diagnose the failure" framing.
- `favorites` — offered first when you type `!`. Learned history (every
  `!`/`!!` command, ranked by frequency then recency, persisted to
  `~/.pi/agent/bang-history.json`) fills the rest of the menu; keep typing to
  filter, Tab to accept.

```typescript
/**
 * bang-notify — quality of life for `!` shell commands.
 *
 * 1) WAKE THE AGENT when a `!` command finishes. pi already sends `!` output
 *    to the model (usage.md), but nothing triggers a turn — the model only
 *    reads it with your next message. This wraps the local bash backend via
 *    the `user_bash` hook and injects a `triggerTurn: true` message when a
 *    command completes (idle only; never for `!!`, whose output the model
 *    can't see; never for commands you Ctrl+C'd).
 *
 * 2) AUTOCOMPLETE for common `!` commands. Type `!` and get suggestions from
 *    your configured favorites plus learned history (every `!`/`!!` command
 *    you run is counted and persisted). Filter by typing; Tab to accept.
 */
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface Config {
  enabled: boolean;
  minSeconds: number;
  alwaysOnError: boolean;
  favorites: string[];
}

interface HistEntry {
  count: number;
  last: number;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function loadConfig(): Config {
  const defaults: Config = { enabled: true, minSeconds: 8, alwaysOnError: true, favorites: [] };
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "bang-notify.json"), "utf8"));
    return {
      enabled: raw.enabled !== false,
      minSeconds: Number.isFinite(Number(raw.minSeconds)) ? Math.max(0, Number(raw.minSeconds)) : defaults.minSeconds,
      alwaysOnError: raw.alwaysOnError !== false,
      favorites: Array.isArray(raw.favorites)
        ? raw.favorites.filter((f: unknown): f is string => typeof f === "string" && f.trim().length > 0).map((f: string) => f.trim())
        : [],
    };
  } catch {
    return defaults;
  }
}

const HISTORY_PATH = () => join(agentDir(), "bang-history.json");
const HISTORY_CAP = 50;

function loadHistory(): Record<string, HistEntry> {
  try {
    const raw = JSON.parse(readFileSync(HISTORY_PATH(), "utf8"));
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

function saveHistory(history: Record<string, HistEntry>): void {
  try {
    const entries = Object.entries(history)
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, HISTORY_CAP);
    writeFileSync(HISTORY_PATH(), JSON.stringify(Object.fromEntries(entries), null, 2) + "\n", "utf8");
  } catch {
    /* history is best-effort */
  }
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  let history = loadHistory();
  let autocompleteRegistered = false;

  const recordCommand = (command: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    const e = history[cmd] ?? { count: 0, last: 0 };
    e.count += 1;
    e.last = Date.now();
    history[cmd] = e;
    saveHistory(history);
  };

  /** Favorites first (config order), then history by frequency/recency; deduped; max 8. */
  const bangSuggestions = (typed: string) => {
    const q = typed.trim().toLowerCase();
    const seen = new Set<string>();
    const items: Array<{ value: string; label: string; description: string }> = [];
    const push = (cmd: string, description: string) => {
      if (seen.has(cmd) || items.length >= 8) return;
      seen.add(cmd);
      items.push({
        value: `!${cmd}`,
        label: `!${cmd.length > 70 ? cmd.slice(0, 70) + "…" : cmd}`,
        description,
      });
    };
    for (const f of cfg.favorites) {
      if (!q || f.toLowerCase().includes(q)) push(f, "favorite");
    }
    const ranked = Object.entries(history)
      .filter(([c]) => !q || c.toLowerCase().includes(q))
      .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last);
    for (const [c, e] of ranked) push(c, `used ${e.count}×`);
    return items;
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig();
    history = loadHistory();
    // Stack a `!` completion provider on pi's built-in autocomplete. At most
    // once per activation — pi appends wrappers to a list it never prunes
    // (same rule pi-subagents follows for its @mention provider). TUI only.
    if (ctx.mode !== "tui" || autocompleteRegistered) return;
    if (typeof ctx.ui.addAutocompleteProvider !== "function") return;
    autocompleteRegistered = true;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: [...(current.triggerCharacters ?? []), "!"],
      async getSuggestions(lines, line, col, options) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        // Bang completion only when the editor's first line IS the command
        // (bang at column 0) — `!` mid-sentence is prose, not a command.
        const m = line === 0 ? beforeCursor.match(/^!{1,2}\s*(.*)$/) : null;
        if (!m) return current.getSuggestions(lines, line, col, options);
        const items = bangSuggestions(m[1] ?? "");
        if (items.length === 0) return current.getSuggestions(lines, line, col, options);
        return { prefix: beforeCursor, items };
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  });

  pi.on("user_bash", (event, ctx) => {
    if (!cfg.enabled) return;

    const local = createLocalBashOperations();
    const operations: BashOperations = {
      exec: async (command, cwd, options) => {
        const started = Date.now();
        const result = await local.exec(command, cwd, options);
        const seconds = (Date.now() - started) / 1000;
        const killed = result.exitCode === null;

        // Learn every completed command (`!` and `!!` alike) for autocomplete.
        if (!killed) recordCommand(command);

        // Wake the agent — but never for `!!` (its output is hidden from the
        // model) and never for a command the user killed themselves.
        const failed = !killed && result.exitCode !== 0;
        const dueTime = seconds >= cfg.minSeconds;
        const dueError = cfg.alwaysOnError && failed;
        if (!event.excludeFromContext && !killed && (dueTime || dueError) && ctx.isIdle()) {
          // Small delay so pi appends the bash entry (command + output) to the
          // session BEFORE the triggered turn snapshots context.
          setTimeout(() => {
            if (!ctx.isIdle()) return; // user started something meanwhile
            const oneLine = command.length > 120 ? command.slice(0, 120) + "…" : command.replace(/\n/g, " ");
            const verdict = failed ? `FAILED (exit ${result.exitCode}` : `finished (exit ${result.exitCode}`;
            pi.sendMessage(
              {
                customType: "bang-notify",
                content:
                  `The user's shell command \`${oneLine}\` just ${verdict}, ${seconds.toFixed(0)}s). ` +
                  `Its output is in the conversation above — review it and ` +
                  (failed ? `diagnose the failure.` : `continue whatever it was for.`),
                display: true,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }, 400);
        }

        return result;
      },
    };
    return { operations };
  });
}
```

## 14. When something breaks

- **"Tool X conflicts with Y" at startup**: two extensions register the same
  tool. `pi remove npm:<one-of-them>`. The error names both paths.
- **New package's tools missing**: fully quit and restart pi; `/reload` keeps
  stale compiled code.
- **Binary "not found" after npm install**: the allow-scripts gotcha (§6).
- **Model refusal / policy block**: Ctrl+P to the next scoped model, resend.
- **400 "Mid-conversation reasoning effort (configuration_update) is not
  supported" after switching models mid-session**: the model's catalog
  metadata claims per-turn effort support (`supportsMidConvoEffort`) that the
  OpenRouter transport doesn't actually have. Override it in
  `~/.pi/agent/models.json`, then restart pi:

  ```json
  {
    "providers": {
      "openrouter": {
        "modelOverrides": {
          "anthropic/claude-opus-5": {
            "compat": {
              "supportsMidConvoEffort": false,
              "forceAdaptiveThinking": true,
              "supportsTemperature": false
            }
          }
        }
      }
    }
  }
  ```

  (Affects `anthropic/claude-opus-5` via OpenRouter only — `fable-5.1` accepts
  mid-convo effort there. Tracked upstream: earendil-works/pi#9165.)
- **Which model am I actually on?**: `echo $PI_PROVIDER/$PI_MODEL` (pi injects
  `PI_*` vars into every shell command; `PI_REASONING_LEVEL`, `PI_SESSION_ID`
  too).
