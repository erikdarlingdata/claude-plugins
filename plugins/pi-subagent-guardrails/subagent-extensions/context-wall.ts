/**
 * context-wall: tells a SUBAGENT its own context size and walls it off before the watchdog's hard stop.
 *
 * A subagent can't see its own context, and honor-system "hand off at 150k" rules measurably fail (a 2026-09-23
 * usage audit of one multi-agent orchestration found that 0 of 39 subagents honored them). The subagent watchdog
 * can see the size, but it reports to the PARENT, and each report wakes the parent's whole (often huge) context. This tells the child directly:
 *
 *   - warn1 / warn2: one-time notices appended to a tool result the agent is already reading.
 *   - wall: every tool call is blocked EXCEPT shell commands made only of git / gh (optionally with cd / export
 *     segments; pipes after them are fine) and write/edit to .md/.txt files. The agent can still commit, push and
 *     write its report, then stop, instead of being aborted with its work and report lost.
 *
 * Loaded ONLY through agent-file frontmatter (`extensions: ["*", "<this path>"]`, a pi-subagents feature). It lives
 * outside every auto-discovered extension folder on purpose (~/.pi/agent/extensions/, and this package's
 * `plugins/<name>/extensions` manifest glob), so interactive sessions never load it. Never move it into one: the wall
 * would then block your main session.
 *
 * Judged size: the larger of live context and total token use (see measure()).
 * Thresholds: ~/.pi/agent/context-wall.json {"warn1":150000,"warn2":200000,"wall":250000}, read on every call (no
 * reload needed; missing or bad values fall back to these defaults). The watchdog's hard stop at 300k tokens or
 * 30 min remains the backstop above the wall.
 *
 * Fails open: any error is a no-op, so a bug here can never block or spam an agent. This is a budget wall, not a
 * security sandbox (a `$(...)` inside a git command still runs).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = { warn1: 150_000, warn2: 200_000, wall: 250_000 };
type Limits = typeof DEFAULTS;

export function readLimits(): Limits {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = JSON.parse(readFileSync(join(dir, "context-wall.json"), "utf8")) as Record<string, unknown>;
    const pick = (key: keyof Limits) => {
      const v = raw?.[key];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULTS[key];
    };
    return { warn1: pick("warn1"), warn2: pick("warn2"), wall: pick("wall") };
  } catch {
    return DEFAULTS;
  }
}

const fmtK = (n: number) => `${Math.round(n / 1000)}k`;

/** True when a tool call is a wrap-up action that may run past the wall. */
export function wrapUpAllowed(toolName: string, input: unknown): boolean {
  const args = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    // Split into command segments; for each, only the part before a pipe counts (`gh pr view 1 | head` is fine).
    const segments = cmd
      .split(/&&|\|\||;|\n/)
      .map((s) => s.split("|")[0].trim())
      .filter(Boolean);
    const isGit = (s: string) => /^(git|gh)(\s|$)/.test(s);
    return (
      segments.length > 0 &&
      segments.every((s) => isGit(s) || /^(cd|export)(\s|$)/.test(s)) &&
      segments.some(isGit)
    );
  }
  if (toolName === "write" || toolName === "edit") {
    const p = typeof args.path === "string" ? args.path : "";
    return /\.(md|txt)$/i.test(p);
  }
  return false;
}

export default function contextWall(pi: ExtensionAPI) {
  let warned = 0; // highest warning already sent: 0, 1 or 2

  /**
   * The judged size is the LARGER of the live context and the session's total token use, summed the way the
   * subagent watchdog sums it for its hard stop (input + output + cacheWrite over every assistant message).
   * Total use runs 1.1-1.5x context and keeps growing, so judging context alone would let the watchdog abort the
   * agent (at 300k total) before this wall (250k) ever fired.
   */
  const measure = (ctx: unknown): { judged: number; context: number | null; spent: number } | null => {
    let context: number | null = null;
    let spent = 0;
    try {
      const u = (ctx as { getContextUsage?: () => { tokens?: unknown } | undefined }).getContextUsage?.();
      context = typeof u?.tokens === "number" ? u.tokens : null;
    } catch {
      context = null;
    }
    try {
      const entries =
        (ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager?.getEntries?.() ?? [];
      for (const e of entries as Array<{ type?: string; message?: { role?: string; usage?: Record<string, unknown> } }>) {
        if (e?.type !== "message" || e.message?.role !== "assistant") continue;
        const u = e.message.usage ?? {};
        for (const k of ["input", "output", "cacheWrite"]) if (typeof u[k] === "number") spent += u[k] as number;
      }
    } catch {
      spent = 0;
    }
    const judged = Math.max(context ?? 0, spent);
    return judged > 0 ? { judged, context, spent } : null;
  };
  const describe = (m: { context: number | null; spent: number }) =>
    `context ${m.context == null ? "unknown" : fmtK(m.context)}, total token use ${fmtK(m.spent)}`;

  pi.on("tool_call", (event, ctx) => {
    try {
      const m = measure(ctx);
      if (m == null) return undefined;
      const limits = readLimits();
      if (m.judged < limits.wall) return undefined;
      if (wrapUpAllowed(event.toolName, event.input)) return undefined;
      return {
        block: true,
        reason:
          `context-wall: you are past the ${fmtK(limits.wall)} wall (${describe(m)}). Only git/gh commands ` +
          `and writes to .md/.txt files run now. Commit and push what you have, put your report in the PR body ` +
          `(gh pr edit --body-file) or a .md note, then end your turn with a final message of 400 words or fewer. ` +
          `This is not a bug, and there is no override.`,
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const m = measure(ctx);
      if (m == null) return undefined;
      const limits = readLimits();
      const level = m.judged >= limits.warn2 ? 2 : m.judged >= limits.warn1 ? 1 : 0;
      if (level <= warned) return undefined;
      warned = level;
      const lead =
        level === 1
          ? `You are past the ~${fmtK(limits.warn1)} handoff line. Finish the step you are on, then commit, push, ` +
            `put your report in the PR body, and end your turn.`
          : `This is the last warning before the wall. Wrap up now.`;
      const text =
        `\n\n[context-wall] You are at ${fmtK(m.judged)} (${describe(m)}; warning ${level} of 2). ${lead} ` +
        `At ${fmtK(limits.wall)}, every tool except git/gh commands and .md/.txt writes is blocked.`;
      return { content: [...(event.content ?? []), { type: "text" as const, text }] };
    } catch {
      return undefined;
    }
  });
}
