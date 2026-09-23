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
| `!` shell escape | `!cmd` (output goes to model), `!!cmd` (output stays local). Gotcha: pi doesn't *wake* the agent when the command finishes — output sits in context until your next message. `bang-notify.ts` (§14) closes that gap, Claude-style, plus autocomplete for common commands |
| Copy-on-select + "copied" confirmation | Ships in **fullscreen** TUI mode (off by default): `tuiMode: "fullscreen"` copies your drag-selection and flashes `Copied!`. `Ctrl+X` copies the last reply outright (§5) |
| Clicking a link | **Cmd+click** on macOS (Ctrl+click is the Linux/Windows binding, and the right-click gesture on macOS). Labels become clickable with `clickable-links.ts` (§5) |
| `/compact`, `--continue`, `--resume` | `/compact`, `pi -c`, `pi -r`, `pi --session <partial-id>` |
| `/btw` side questions | Type while it works: **Enter** = steering (injected after current tool call), **Alt+Enter** = follow-up (after all work). Or `@agentname question` routes to a subagent without touching main context |
| Checkpoints / rewind | Session **tree**: double-Escape jumps to any earlier point; `/fork` branches; add `git-checkpoint.ts` (below) to restore code state too |
| MCP | `npm:pi-mcp-adapter` extension |

## 5. TUI ergonomics and Claude Code muscle memory

The things that cost an ex-pat the most time aren't missing from pi — they're
bound differently, or off by default.

### Copy-on-select, and the "copied" confirmation

Claude Code copied your mouse selection and flashed a confirmation. pi does the
same, but only in **fullscreen** TUI mode, which is not the default. Try it for
one session:

```bash
pi --tui-mode fullscreen
```

Keep it via `/settings` (applies immediately) or `"tuiMode": "fullscreen"` in
`settings.json`. `fullscreenCopyOnSelect` is already `true`, so there is nothing
else to set: dragging selects and copies, and pi flashes `Copied!` in the corner.
The flash is deliberately brief on success and noticeably longer on
`Copy failed` — so "I didn't see anything" means it worked. Set it `false` and
selections stay highlighted until you press `Ctrl+X`.

In the default `regular` mode pi deliberately does **not** capture the mouse
("the terminal owns its scrollback"), so selection belongs to your terminal.
Ghostty's own `copy-on-select` already defaults to `true` on macOS — silently,
which is why it's easy to assume it's broken. If it isn't landing where `Cmd+V`
reads, make it explicit in `~/.config/ghostty/config`:

```
copy-on-select = clipboard
```

Fullscreen trade-offs worth knowing: it's flagged **experimental**, and pi owns
the screen, so your terminal's native scrollback, search, and selection give way
to pi's own scroll region. `fullscreenExitOutput` (default `transcript`) decides
what's printed when you exit, and `fullscreenScrollbar` tunes the scrollbar
column.

**For whole replies, `Ctrl+X` beats dragging.** `app.message.copy` copies the
last assistant message — or the selected one while you're in `/tree` — with no
selection at all. It flashes in fullscreen and writes a status line in regular
mode.

### Clicking links

**Cmd+click on macOS.** Ctrl+click is the right-click/context-menu gesture
there, so it looks like link-opening is broken; Ctrl+click is the
Linux/Windows binding.

Bare URLs are already clickable through terminal auto-detection, and pi renders
markdown links with the URL visible (`mdLink` and `mdLinkUrl` are separate theme
colors), so those are clickable too. What *isn't* clickable out of the box is a
link's **label**. pi has the machinery — it emits OSC 8 hyperlinks for login
URLs and exports `hyperlink(text, url)` from `@earendil-works/pi-tui` — it just
never applies it to assistant markdown. `clickable-links.ts` below closes that
gap, and in fullscreen mode a plain click (no modifier) opens links.

Inside tmux, OSC 8 needs passthrough: set `PI_HYPERLINKS=1` (it overrides
detection with `1`, `0`, or `auto`) and enable tmux's `allow-passthrough`.

### Fullscreen's silent trap: raw terminal escapes

Worth knowing before you write your own extension, because it cost us an
afternoon. An extension that emits terminal escape sequences by writing to
`process.stdout` directly works in regular mode and **silently does nothing** in
fullscreen mode, where pi owns stdout and repaints whole frames. No error, no
warning — the feature just stops, and the last value it managed to write stays
frozen on screen forever.

- For the **window/tab title** there is a supported API: `ctx.ui.setTitle()`.
  Use it; `tab-status.ts` below does.
- For **desktop notifications** there is none. pi's bundled `notify.ts` example
  posts OSC 777 / OSC 99 escapes, so it goes quiet in fullscreen. On macOS the
  mode-independent fix is to shell out, passing text as argv so quotes and
  backslashes in a title can't break the script or inject anything:

```typescript
await pi.exec("osascript", [
  "-e", "on run argv",
  "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e", "end run",
  "--", body, title,
]);
```

  (OSC 777 remains the better choice over SSH, where it surfaces on the machine
  running your terminal rather than the remote host.)

An extension **cannot** detect which TUI mode it is in — `ctx.mode` is `"tui"`
for both and nothing exposes `tuiMode` — so prefer a transport that works either
way over branching on the mode. And give any write-only output path a test
command (`/tabstatus`, `/notifytest`, `/linktest` all exist for this reason):
when a channel fails silently, the only way to tell "wrong state" from "correct
state that never arrived" is an affordance that reports what the extension
believes.

### Timestamps on replies

`/tree` plus **shift+t** natively toggles timestamps on tree labels, and every
message already carries a `timestamp` in the session file — the live transcript
just never shows one. `reply-timestamps.ts` below adds a dim stamp after each
completed reply and a live footer clock, which is what you want on a tab you
walked away from.

### `reply-timestamps.ts`

Save as `~/.pi/agent/extensions/reply-timestamps.ts`. Stamps are written with
`pi.appendEntry` + `registerEntryRenderer`, which is pi's channel for durable
TUI-only content — custom entries never enter LLM context, so this costs nothing
in tokens and survives `/resume`. Optional config at
`~/.pi/agent/reply-timestamps.json`:
`{ "stampTranscript": true, "showFooter": true, "showDuration": true, "clock": "24h" }`
(`clock` accepts `24h`, `12h`, or `iso`).

```typescript
/**
 * reply-timestamps — show when the agent last replied.
 *
 * pi stores a `timestamp` on every message but never displays one in the live
 * transcript (only `/tree` + shift+t shows them, for history navigation). Two
 * surfaces here:
 *
 *   1. A dim stamp line appended after each completed reply:
 *        ↩ replied 14:32:05 · took 47s
 *      Written with pi.appendEntry + registerEntryRenderer, so it is TUI-only
 *      and costs NOTHING in LLM context (custom entries don't participate),
 *      and it persists — resumed sessions still show their old stamps.
 *
 *   2. A live footer clock, so a tab you walked away from answers "when did
 *      this finish?" at a glance:
 *        ↩ 14:32:05 (3m ago)
 *
 * Timing is measured from the first agent_start of a reply to agent_settled,
 * so "took" reflects the whole reply including tool calls, retries and
 * auto-compaction — not just the last LLM call.
 *
 * Config (optional): ~/.pi/agent/reply-timestamps.json
 *   {
 *     "enabled": true,
 *     "stampTranscript": true,   // the in-transcript stamp line
 *     "showFooter": true,        // the footer clock
 *     "showDuration": true,      // "· took 47s"
 *     "clock": "24h",            // "24h" | "12h" | "iso"
 *     "footerRefreshMs": 30000   // how often the footer's "(3m ago)" re-renders
 *   }
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENTRY_TYPE = "reply-timestamp";

interface Config {
  enabled: boolean;
  stampTranscript: boolean;
  showFooter: boolean;
  showDuration: boolean;
  clock: "24h" | "12h" | "iso";
  footerRefreshMs: number;
}

function loadConfig(): Config {
  const defaults: Config = {
    enabled: true,
    stampTranscript: true,
    showFooter: true,
    showDuration: true,
    clock: "24h",
    footerRefreshMs: 30_000,
  };
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = JSON.parse(readFileSync(join(dir, "reply-timestamps.json"), "utf8"));
    const clock = raw.clock === "12h" || raw.clock === "iso" ? raw.clock : defaults.clock;
    const refresh = Number(raw.footerRefreshMs);
    return {
      enabled: raw.enabled !== false,
      stampTranscript: raw.stampTranscript !== false,
      showFooter: raw.showFooter !== false,
      showDuration: raw.showDuration !== false,
      clock,
      footerRefreshMs: Number.isFinite(refresh) ? Math.max(1_000, refresh) : defaults.footerRefreshMs,
    };
  } catch {
    return defaults;
  }
}

function formatClock(at: number, clock: Config["clock"]): string {
  const d = new Date(at);
  if (clock === "iso") return d.toISOString().replace("T", " ").slice(0, 19);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: clock === "12h",
  });
}

/** Compact duration: 850ms / 47s / 3m12s / 1h04m. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1_000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Coarse age for the footer: just now / 3m ago / 2h ago / 14:32:05 once stale. */
function formatAge(at: number, now: number, clock: Config["clock"]): string {
  const secs = Math.max(0, Math.round((now - at) / 1_000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatClock(at, clock);
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  let ctx: ExtensionContext | undefined;
  /** First agent_start of the current reply; undefined while idle. */
  let replyStartedAt: number | undefined;
  /** Last completed reply, for the footer. */
  let lastReplyAt: number | undefined;
  let footerTimer: ReturnType<typeof setInterval> | undefined;

  const updateFooter = () => {
    if (!ctx?.hasUI || !cfg.enabled || !cfg.showFooter) return;
    if (lastReplyAt === undefined) {
      ctx.ui.setStatus("reply-clock", undefined);
      return;
    }
    const at = formatClock(lastReplyAt, cfg.clock);
    const age = formatAge(lastReplyAt, Date.now(), cfg.clock);
    ctx.ui.setStatus("reply-clock", `↩ ${at} (${age})`);
  };

  const stopFooterTimer = () => {
    if (footerTimer) {
      clearInterval(footerTimer);
      footerTimer = undefined;
    }
  };

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
    const data = (entry.data ?? {}) as { at?: number; durationMs?: number };
    if (typeof data.at !== "number") return new Text("", 0, 0);
    // Rendered from persisted entry data, not from "now" — a resumed session
    // shows when each reply actually landed.
    let line = `↩ replied ${formatClock(data.at, cfg.clock)}`;
    if (cfg.showDuration && typeof data.durationMs === "number") {
      line += ` · took ${formatDuration(data.durationMs)}`;
    }
    return new Text(theme.fg("dim", line), 0, 0);
  });

  pi.on("session_start", async (_event, c) => {
    cfg = loadConfig();
    // TUI only. This also keeps subagent sessions out: they re-run extension
    // factories in the same process (pi-subagents binds extensions into each
    // child), and neither a footer nor a stamp means anything there.
    if (c.mode !== "tui") return;
    ctx = c;
    replyStartedAt = undefined;
    // Restore the footer from history so a resumed session doesn't read as
    // "never replied" until the next turn.
    lastReplyAt = undefined;
    for (const entry of c.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const at = (entry.data as { at?: number } | undefined)?.at;
        if (typeof at === "number") lastReplyAt = at;
      }
    }
    updateFooter();
    stopFooterTimer();
    if (cfg.enabled && cfg.showFooter) {
      footerTimer = setInterval(updateFooter, cfg.footerRefreshMs);
      footerTimer.unref?.();
    }
  });

  pi.on("agent_start", async () => {
    if (!cfg.enabled) return;
    // First start of this reply wins: agent_start fires again for auto-retry
    // and post-compaction continuation, and those are part of the same reply.
    replyStartedAt ??= Date.now();
  });

  // agent_settled, not agent_end: pi may still auto-retry, auto-compact, or
  // drain queued follow-ups after agent_end. Settled is when the agent has
  // actually finished replying — the moment worth stamping.
  pi.on("agent_settled", async () => {
    if (!cfg.enabled) return;
    const at = Date.now();
    const durationMs = replyStartedAt === undefined ? undefined : at - replyStartedAt;
    replyStartedAt = undefined;
    lastReplyAt = at;
    if (cfg.stampTranscript && ctx?.mode === "tui") {
      pi.appendEntry(ENTRY_TYPE, durationMs === undefined ? { at } : { at, durationMs });
    }
    updateFooter();
  });

  pi.on("session_shutdown", async () => {
    stopFooterTimer();
    if (ctx?.hasUI) ctx.ui.setStatus("reply-clock", undefined);
    ctx = undefined;
  });
}
```

### `clickable-links.ts`

Save as `~/.pi/agent/extensions/clickable-links.ts`. Optional config at
`~/.pi/agent/clickable-links.json`:
`{ "enabled": true, "force": false, "linkBareUrls": true, "skipCode": true }`.
Run `/linktest` afterwards: it renders OSC 8 samples through the same
entry-renderer path pi's login dialog uses, so you can tell "my terminal can't
do OSC 8" apart from "the markdown path didn't apply it".

```typescript
/**
 * clickable-links — make URLs in agent output genuinely clickable (OSC 8).
 *
 * What pi already does:
 *   - Its markdown renderer styles link text (`mdLink`) and the URL
 *     (`mdLinkUrl`) separately, so `[label](url)` puts the raw URL on screen.
 *     Modern terminals (Ghostty, iTerm2, WezTerm, kitty) auto-detect bare URLs,
 *     so those are already Cmd+clickable without any extension.
 *   - It emits real OSC 8 hyperlinks in the login dialog, exports
 *     `hyperlink(text, url)` from @earendil-works/pi-tui, and its line
 *     compositor is OSC-8 aware (it tracks open links across overlays).
 *
 * The gap: assistant markdown never gets OSC 8, so the *label* of a link is not
 * clickable — only the visible URL is, and only via terminal auto-detection.
 * This extension closes that with a display-only markdown transformer, so
 * `[the PR](https://…)` becomes clickable on the words "the PR".
 *
 * Display-only by construction: registerMarkdownTransformer never alters the
 * stored message or what the model sees, so no escape codes enter context.
 *
 * Safety rails:
 *   - No-ops when the terminal can't do OSC 8 (getCapabilities().hyperlinks),
 *     so dumb terminals/pipes never get escape soup. `PI_HYPERLINKS=1` forces
 *     detection on (needed for tmux passthrough); config can force it too.
 *   - Skips fenced code blocks and inline code, so anything you might copy
 *     stays byte-exact.
 *   - Skips streaming updates: a partial link would be mangled mid-flight.
 *     Links become clickable when the message finalizes.
 *
 * `/linktest` renders known-good OSC 8 through the entry-renderer path (the
 * same path the login dialog uses) so you can tell "my terminal can't do OSC 8"
 * apart from "the markdown path didn't apply it".
 *
 * Config (optional): ~/.pi/agent/clickable-links.json
 *   {
 *     "enabled": true,
 *     "force": false,            // emit OSC 8 even if capability detection says no
 *     "linkBareUrls": true,      // wrap bare https://… too (not just [label](url))
 *     "includeThinking": false,  // also linkify thinking blocks
 *     "skipCode": true           // leave fenced/inline code untouched
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_ENTRY = "clickable-links-test";
const OSC8_MARKER = "\x1b]8;;";

interface Config {
  enabled: boolean;
  force: boolean;
  linkBareUrls: boolean;
  includeThinking: boolean;
  skipCode: boolean;
}

function loadConfig(): Config {
  const defaults: Config = {
    enabled: true,
    force: false,
    linkBareUrls: true,
    includeThinking: false,
    skipCode: true,
  };
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = JSON.parse(readFileSync(join(dir, "clickable-links.json"), "utf8"));
    return {
      enabled: raw.enabled !== false,
      force: raw.force === true,
      linkBareUrls: raw.linkBareUrls !== false,
      includeThinking: raw.includeThinking === true,
      skipCode: raw.skipCode !== false,
    };
  } catch {
    return defaults;
  }
}

/** Trailing characters that are almost always sentence punctuation, not URL. */
function splitTrailingPunctuation(url: string): [string, string] {
  const m = /[.,;:!?)\]}'"]+$/.exec(url);
  if (!m) return [url, ""];
  // Keep a balanced closing paren that belongs to the URL (wiki-style links).
  let cut = m.index;
  const trailer = url.slice(cut);
  if (trailer.startsWith(")")) {
    const opens = (url.slice(0, cut).match(/\(/g) ?? []).length;
    const closes = (url.slice(0, cut).match(/\)/g) ?? []).length;
    if (opens > closes) cut += 1;
  }
  return [url.slice(0, cut), url.slice(cut)];
}

/**
 * One pass over a plain-text segment, handling (in precedence order):
 *   [label](url) -> label is clickable
 *   <url>        -> url is clickable
 *   bare url     -> url is clickable
 */
function linkifySegment(text: string, linkBareUrls: boolean): string {
  const pattern = linkBareUrls
    ? /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>"'`]+)/g
    : /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>/g;
  return text.replace(pattern, (match, label, mdUrl, angleUrl, bareUrl) => {
    if (typeof mdUrl === "string") {
      // Keep the markdown shape so pi still styles and shows the URL; only
      // the label becomes clickable.
      return `[${hyperlink(String(label), mdUrl)}](${mdUrl})`;
    }
    if (typeof angleUrl === "string") return `<${hyperlink(angleUrl, angleUrl)}>`;
    if (typeof bareUrl === "string") {
      const [url, trailer] = splitTrailingPunctuation(bareUrl);
      if (!url) return match;
      return hyperlink(url, url) + trailer;
    }
    return match;
  });
}

/** Apply `fn` only outside fenced code blocks and inline code spans. */
function outsideCode(markdown: string, fn: (segment: string) => string): string {
  // Fences first: ``` or ~~~ blocks, kept verbatim.
  const fenceSplit = markdown.split(/(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/m);
  return fenceSplit
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk; // a fenced block
      // Then inline code spans within prose.
      return chunk
        .split(/(`+[^`\n]*`+)/)
        .map((piece, j) => (j % 2 === 1 ? piece : fn(piece)))
        .join("");
    })
    .join("");
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();

  const hyperlinksUsable = (): boolean => {
    if (cfg.force) return true;
    try {
      return getCapabilities().hyperlinks === true;
    } catch {
      return false;
    }
  };

  pi.on("session_start", async () => {
    cfg = loadConfig();
  });

  pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
    if (!cfg.enabled) return markdown;
    // A partial link cut mid-token would be rewritten wrong; wait for the
    // finalized message (this hook runs again on finalize and on restore).
    if (isStreaming) return markdown;
    if (messageType === "assistant-thinking" && !cfg.includeThinking) return markdown;
    if (markdown.includes(OSC8_MARKER)) return markdown; // already linked
    if (!markdown.includes("http")) return markdown; // cheap bail
    if (!hyperlinksUsable()) return markdown;
    const linkify = (segment: string) => linkifySegment(segment, cfg.linkBareUrls);
    return cfg.skipCode ? outsideCode(markdown, linkify) : linkify(markdown);
  });

  // ---- Self-test surface -------------------------------------------------
  // Renders raw OSC 8 through the entry-renderer path, which is exactly how
  // pi's own login dialog emits clickable URLs. If these are clickable but
  // links in replies are not, the markdown path is the problem; if neither is,
  // the terminal (or tmux passthrough) is.
  pi.registerEntryRenderer(TEST_ENTRY, (_entry, _opts, theme) => {
    const url = "https://github.com/erikdarlingdata/claude-plugins";
    const caps = (() => {
      try {
        return String(getCapabilities().hyperlinks);
      } catch {
        return "unknown";
      }
    })();
    const modifier = process.platform === "darwin" ? "Cmd+click" : "Ctrl+click";
    const lines = [
      theme.fg("accent", "clickable-links self-test"),
      theme.fg("dim", `  capability: hyperlinks=${caps} · PI_HYPERLINKS=${process.env.PI_HYPERLINKS ?? "(unset)"}`),
      `  1. OSC 8 on text:  ${theme.fg("mdLink", hyperlink("click these words", url))}`,
      `  2. OSC 8 on URL:   ${theme.fg("mdLink", hyperlink(url, url))}`,
      `  3. Bare URL (terminal auto-detect): ${theme.fg("mdLinkUrl", url)}`,
      theme.fg("dim", `  ${modifier} each one. 1+2 clickable = OSC 8 works. Only 3 = terminal auto-detect only.`),
    ];
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.registerCommand("linktest", {
    description: "Render OSC 8 hyperlink samples to check what your terminal supports",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      pi.appendEntry(TEST_ENTRY, { at: Date.now() });
    },
  });
}
```

## 6. The extension stack

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
pi install npm:pi-agent-browser-native # real browser automation (needs binary, see §7)
pi install npm:pi-web-access           # web search / fetch / GitHub / PDF / YouTube
pi install npm:pi-web-ui               # browser cockpit for pi (see §7)
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
auto-compaction, and queued follow-ups exhausted. It also shows `⌨` while a
blocking prompt waits on you (that's what pi's `ui_prompt_start`/`ui_prompt_end`
events are for), and re-asserts the title every 5s against `ctx.isIdle()` —
without that reconciler the indicator is edge-triggered, so one lost OSC write
(easy in fullscreen mode, where pi repaints whole frames) strands the wrong
glyph until the next run. Save as
`~/.pi/agent/extensions/tab-status.ts`, then `/reload`:

```typescript
/**
 * Tab Status Extension
 *
 * Shows the agent's working state in the terminal tab title:
 *   ⏳ <session>  while the agent is running
 *   ⌨ <session>  while a blocking prompt is waiting on YOU (select/confirm/input/editor)
 *   ✅ <session>  when it settles (no auto-retry/follow-up pending) — sticky until the next run
 *   π <session>   at rest
 *
 * TWO BUGS THIS FILE HAS ALREADY HAD, both worth remembering:
 *
 * 1. RAW STDOUT WRITES. The first two versions set the title by writing OSC 0
 *    (`\x1b]0;…\x07`) straight to process.stdout. That works in regular TUI mode,
 *    where the terminal owns the screen — and silently does nothing in fullscreen
 *    (alt-screen) mode, where pi owns stdout and repaints whole frames. The tab
 *    then freezes on whatever glyph was last written before the mode switch.
 *    pi has a first-class API for this, `ctx.ui.setTitle()`, which routes through
 *    pi's renderer (and becomes an extension_ui_request in RPC mode instead of
 *    raw bytes). Use it. The raw path is kept only as a fallback for a pi too old
 *    to expose setTitle.
 *
 * 2. EDGE-TRIGGERED STATE. Before, ⏳ was written on agent_start and cleared only
 *    on agent_settled, with nothing re-asserting truth. Any single lost write
 *    stranded the wrong glyph until the next run, and a run that ended without
 *    settling (abort, fatal error) stranded it indefinitely. So the title is now
 *    level-triggered: a low-frequency tick re-derives state from ctx.isIdle() and
 *    rewrites it, which self-heals.
 *
 * ✅ stays sticky while idle rather than decaying to π, because "finished, come
 * look" is the whole point on an unfocused tab. Only a new run clears it.
 *
 * `/tabstatus` prints what this extension believes, which is the only way to tell
 * "wrong state" apart from "correct state that never reached the terminal".
 *
 * TUI-only: headless/rpc/subagent runs emit nothing.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import process from "node:process";

const RING_BELL_ON_SETTLE = true;
/** How often to re-assert the title, healing a missed transition. */
const RECONCILE_MS = 5_000;

type State = "rest" | "running" | "waiting" | "settled";

const GLYPH: Record<State, string> = {
	rest: "π",
	running: "⏳",
	waiting: "⌨",
	settled: "✅",
};

function label(ctx: ExtensionContext): string {
	const name = ctx.sessionManager.getSessionName();
	return name && name.trim() ? name : basename(process.cwd());
}

export default function (pi: ExtensionAPI) {
	const inTui = (ctx: ExtensionContext) => ctx.mode === "tui";
	let ctx: ExtensionContext | undefined;
	let state: State = "rest";
	let promptDepth = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let usedApi = false;
	let lastTitle = "";

	const writeTitle = (text: string) => {
		lastTitle = text;
		const ui = ctx?.ui as { setTitle?: (t: string) => void } | undefined;
		if (typeof ui?.setTitle === "function") {
			usedApi = true;
			ui.setTitle(text);
			return;
		}
		// Fallback only: pi without setTitle. Unsafe in fullscreen mode.
		usedApi = false;
		process.stdout.write(`\x1b]0;${text}\x07`);
	};

	const apply = () => {
		if (!ctx) return;
		writeTitle(`${GLYPH[state]} ${label(ctx)}`);
	};

	const set = (next: State) => {
		state = next;
		apply();
	};

	/** Re-derive from the one real source of truth and rewrite unconditionally. */
	const reconcile = () => {
		if (!ctx) return;
		if (promptDepth > 0) {
			state = "waiting";
		} else {
			let idle = true;
			try {
				idle = ctx.isIdle();
			} catch {
				idle = true;
			}
			if (idle) {
				if (state !== "settled") state = "rest"; // keep ✅ sticky
			} else {
				state = "running";
			}
		}
		apply();
	};

	pi.on("session_start", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		promptDepth = 0;
		set("rest");
		// Deferred to session_start, not the factory: extensions must not start
		// background resources in a run that may never open a session.
		if (timer) clearInterval(timer);
		timer = setInterval(reconcile, RECONCILE_MS);
		timer.unref?.();
	});

	pi.on("session_info_changed", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		reconcile();
	});

	pi.on("agent_start", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		set("running");
	});

	// agent_settled (not agent_end): fires only when pi will not continue on
	// its own — no pending auto-retry, auto-compact, or queued follow-up.
	pi.on("agent_settled", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		set("settled");
		// Best-effort: Ghostty/iTerm2 turn BEL into a tab attention marker. There
		// is no pi API for the bell, so this is a raw write and may not survive
		// fullscreen mode — the title is the load-bearing signal.
		if (RING_BELL_ON_SETTLE) process.stdout.write("\x07");
	});

	// These exist so status integrations can say "waiting for user" instead of
	// "running" — without them a /watchdog panel or external editor reads as ⏳.
	pi.on("ui_prompt_start", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		promptDepth += 1;
		set("waiting");
	});

	pi.on("ui_prompt_end", (_event: unknown, c: ExtensionContext) => {
		if (!inTui(c)) return;
		ctx = c;
		promptDepth = Math.max(0, promptDepth - 1);
		reconcile();
	});

	pi.on("session_shutdown", (_event: unknown, c: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (!inTui(c)) return;
		writeTitle(""); // hand the title back to the shell
		ctx = undefined;
	});

	pi.registerCommand("tabstatus", {
		description: "Show what tab-status believes about the session (debug)",
		handler: async (_args, c) => {
			if (!c.hasUI) return;
			let idle: boolean | string;
			try {
				idle = c.isIdle();
			} catch (err) {
				idle = `threw: ${err instanceof Error ? err.message : String(err)}`;
			}
			const ui = c.ui as { setTitle?: unknown };
			c.ui.notify(
				[
					`tab-status debug`,
					`  state: ${state} (${GLYPH[state]})`,
					`  isIdle(): ${String(idle)}`,
					`  promptDepth: ${promptDepth}`,
					`  reconciler: ${timer ? `every ${RECONCILE_MS / 1000}s` : "NOT RUNNING"}`,
					`  ctx.ui.setTitle available: ${typeof ui.setTitle === "function"}`,
					`  last write used: ${usedApi ? "ctx.ui.setTitle (supported)" : "raw OSC 0 (fallback)"}`,
					`  last title written: ${JSON.stringify(lastTitle)}`,
					`  mode: ${c.mode}`,
				].join("\n"),
				"info",
			);
		},
	});
}
```

## 7. External binaries some extensions need

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

## 8. Verify everything (5 minutes)

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

## 9. Daily-driver commands

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
| Ctrl+X | copy the last assistant message (or the selected one in `/tree`) |
| Ctrl+O / Ctrl+T | collapse tool output / thinking blocks |
| `/export`, `/share` | HTML export / gist link |

## 10. Migrating in-flight Claude Code work

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

## 11. Where everything lives

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

## 12. Session auto-resume after reboots

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

## 13. Runaway subagent watchdog

pi-subagents' background children only report back at completion — nothing wakes
the orchestrator while one wedges on a giant grep, quietly compacts, or balloons
from 200k to 2M tokens. There is no token budget anywhere in the stack:
`max_turns` caps iterations, not spend. The `pi-subagent-watchdog` extension
ships in the same claude-plugins package as §12, so if you ran that `pi install`
it is already loaded (it needs `@tintinweb/pi-subagents` from §6):

```bash
pi install git:github.com/erikdarlingdata/claude-plugins
```

(Don't *also* hand-copy the extension into `~/.pi/agent/extensions/` — the
package already ships it, and two copies register the same `/watchdog` command
and `subagent_vitals` tool, which pi refuses at startup. Same trap as the
`session-registry.ts` note in §12.)

It polls each running top-level subagent's live vitals — tokens, context %, tool
uses, transcript-derived turns, wall clock, compactions — and when a threshold
crosses, injects a check-in into the main conversation: what crossed, the
agent's most recent tool calls, and a decision protocol. A `🐕 N` footer status
shows while agents are watched.

### The watchdog's own token tax

A check-in *is* an LLM turn, so a naive watchdog amplifies the spend it exists to
police. Four knobs bound that:

| Knob | Default | What it bounds |
| --- | --- | --- |
| `batchWindowMs` | 5000 | agents breaching near each other collapse into ONE wake |
| `globalCooldownMs` | 60000 | minimum gap between wakes across the whole fleet |
| `maxCheckInsPerAgent` | 2 | automatic wakes per agent (manual `/watchdog` check-ins bypass it) |
| `auditTrail` | true | full records go to `subagent-watchdog-audit` custom entries, which never enter LLM context |

So the model-facing message stays compact while the forensics — every retained
tool call, the thresholds crossed, the action taken, and every *cancelled*
check-in with its reason — land on disk for humans and `jq`. In guide mode a
signal the agent has never crossed before can still speak once past the cap, so
a genuinely new failure mode isn't silenced by a quota.

### Modes

- **`guide`** (default) — the check-in asks the orchestrator to assess: on
  track, lost, or runaway. Healthy agents run free.
- **`strict`** — thresholds are budgets: wrap up by default, continuation
  requires cited evidence, and check-in #2 means the exception is spent.

Strict mode is careful about what it can actually promise. An ordinary steering
message **cannot** change a running agent's `max_turns` — that ceiling is
captured at spawn and never re-read — so the check-in only names the real
`extend_subagent` tool when that tool is actually present, and otherwise says
plainly that this version cannot extend a live ceiling and asks the orchestrator
to simply choose not to send a wrap-up steer. Capability is read from the live
active-tool set at delivery time, so it starts naming the tool the moment it
exists, with no restart.

### Model invariant (optional)

`models.required` pins an exact effective `provider/model-id` for every watched
top-level agent, read from the **live session** so it holds across every spawn
path rather than only the Agent tool. A mismatch is audited and either notified
(default) or hard-stopped. Get the string by running `/watchdog status` and
copying it — an invalid value disables enforcement loudly instead of flagging
every agent. This is defense-in-depth: forcing the model before launch belongs
in pi-subagents.

For per-task model choice, use `models.allowed` instead: a list of exact ids
(say Opus for design and security review, Sonnet as the default, a cheap model
for lookups) that supersedes `required`. Put each role's tier in its agent
file's `model:` so children launch on an allowed model, and the watchdog
hard-stops anything else. A malformed list turns enforcement off with a loud
error rather than silently widening the policy.

### Budget guardrails: the context wall and the `lane` agent

The watchdog talks to the **parent**, and each check-in re-reads the parent's
whole context. The child, meanwhile, can't see its own size, so "hand off at
150k" in a prompt is honor system. In one audit, 0 of 39 subagents honored it.
The `pi-subagent-guardrails` plugin (same package) closes that gap from the
child's side:

- **Context wall** (`subagent-extensions/context-wall.ts`). It warns the child
  itself at 150k and 200k. At 250k it refuses every tool but git/gh commands
  and `.md`/`.txt` writes, so the agent commits and reports instead of being
  hard-stopped with its work lost. It judges the larger of live context and
  total token use, the watchdog's own hard-stop measure, so it always fires
  first.
- **It is NOT auto-loaded**, on purpose: in your interactive session it would
  wall *you*. Subagents opt in through their agent file:

  ```yaml
  extensions: ["*", "~/.pi/agent/git/github.com/erikdarlingdata/claude-plugins/plugins/pi-subagent-guardrails/subagent-extensions/context-wall.ts"]
  ```

- **`lane` agent** (`agents/lane.md`, copy it to `~/.pi/agent/agents/`). It's
  for code-editing lanes: Sonnet, `isolation: worktree`, draft PRs only, the
  token rules built in, and no fan-out or MCP tools.
- **`guardrails.md`**: the written rules to point your agents at from
  `AGENTS.md`. They cover fan-out caps, model tiers, first-prompt discipline,
  session length and ranking.

With the wall in place, turn the watchdog's activity triggers (`turns`,
`toolUses`, `minutes`) off and keep only the parent-facing trigger at the wall
plus the hard stop. On normal lanes those triggers woke the parent within
minutes. The recommended JSON is in
[`plugins/pi-subagent-guardrails/README.md`](plugins/pi-subagent-guardrails/README.md).

### Surfaces

| | |
| --- | --- |
| `/watchdog` | panel: pick a running agent → vitals / check-in / steer / hard stop |
| `/watchdog status` | thresholds, capabilities, watched agents |
| `/watchdog config` | edit config in pi's editor — validated, applied live |
| `/watchdog reload` | re-read config after hand-editing, no restart |
| `/watchdog help` | full settings reference |
| `subagent_vitals` | the orchestrator's one-call fleet snapshot |

Config: `~/.pi/agent/subagent-watchdog.json`, project override
`.pi/subagent-watchdog.json`. Optional `hardStop` auto-aborts past a hard limit
and reports the outcome **from the RPC reply**, so a failed stop says "still
running, do not respawn" instead of lying.

Two facts worth knowing even if you never install it: a steer **cannot**
interrupt a running tool call (it queues until the tool returns — only a hard
stop breaks a wedged execution), and **wall clock is the only signal that
catches a wedged tool**, because a child stuck inside one giant grep shows
frozen token and turn counters. Full docs:
[`plugins/pi-subagent-watchdog/README.md`](plugins/pi-subagent-watchdog/README.md).

## 14. `!` commands: completion wake-ups + autocomplete

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

## 15. When something breaks

- **"Tool X conflicts with Y" at startup**: two extensions register the same
  tool. `pi remove npm:<one-of-them>`. The error names both paths.
- **New package's tools missing**: fully quit and restart pi; `/reload` keeps
  stale compiled code.
- **Binary "not found" after npm install**: the allow-scripts gotcha (§7).
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
