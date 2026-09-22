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
