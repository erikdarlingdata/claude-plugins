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
 *
 * Config (optional): ~/.pi/agent/bang-notify.json
 *   {
 *     "enabled": true,
 *     "minSeconds": 0,        // notify only if the command ran >= this (0 = always)
 *     "alwaysOnError": true,  // non-zero exit notifies regardless of minSeconds
 *     "favorites": ["aws sso login --profile whatever"]
 *   }
 * History: ~/.pi/agent/bang-history.json (last 50 distinct commands).
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
