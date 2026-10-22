/**
 * context-wall: tells a SUBAGENT its own context size and walls it off before the watchdog's hard stop.
 *
 * A subagent can't see its own context, and honor-system "hand off at 150k" rules measurably fail (a 2026-09-23
 * usage audit of one multi-agent orchestration found that 0 of 39 subagents honored them). The subagent watchdog
 * can see the size, but it reports to the PARENT, and each report wakes the parent's whole (often huge) context. This tells the child directly:
 *
 *   - nudge (100k): a one-time notice if a code-writing agent (types in `nudgeTypes`, default lane and lane-*) has
 *     not edited any code yet (investigation eating the budget). Read-only types (worker, reviewer, scout, ...) never
 *     get it: for them, no code edits is the job, and the notice once stopped a measurement worker early.
 *   - warn1 / warn2: one-time notices appended to a tool result the agent is already reading. An agent that edited
 *     code and has not run git push / gh pr create yet is told to push a draft PR first; any other agent is told to
 *     put its report in its final message.
 *   - wall: every tool call is blocked EXCEPT shell commands made only of git / gh / docker rm|stop|kill (optionally with cd / export
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
 * Wall clock: the watchdog's minute hard stop gives the child no warning, so a lane killed mid-test-run loses its
 * push and its report. The wall applies the same notice-then-wall to elapsed time: `warnMinutes` and `wallMinutes`
 * in context-wall.json, or, when those are absent, 10 and 5 minutes before the watchdog's own `hardStop.minutes`
 * (~/.pi/agent/subagent-watchdog.json, when the hard stop is enabled). No minute limit anywhere = no time wall.
 * The clock starts when this extension loads in the child, a few seconds after the watchdog's clock.
 *
 * Protected checkouts: `protectedCheckouts` in context-wall.json lists directories no subagent may write, such as a
 * person's own main checkout. At ANY size, not only past the wall, a bash command that names one (absolute, `~/`,
 * `$HOME/` or `../<name>` form) or runs with its cwd inside one is refused when it runs a git subcommand that writes
 * the worktree, the index or refs (checkout, switch, restore, reset, stash, clean, pull, merge, rebase, commit, add,
 * rm, mv, cherry-pick, revert, am, apply, read-tree, update-index, checkout-index, gc, prune). A write/edit to a path
 * inside one is refused too. Reading stays allowed (git show/log/diff/status/fetch/grep/worktree add, sed, cat).
 * Why: on 2026-09-24 a read-only scout ran `git checkout <branch> -- .` and then `git checkout dev -- .` in its
 * parent's main checkout to read a branch's files, overwriting that checkout's staged state.
 *
 * Fails open: any error is a no-op, so a bug here can never block or spam an agent. This is a budget wall, not a
 * security sandbox (a `$(...)` inside a git command still runs).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = { nudge: 100_000, warn1: 150_000, warn2: 200_000, wall: 250_000 };
const DEFAULT_NUDGE_TYPES = ["lane"];
type Limits = typeof DEFAULTS & { warnMinutes: number | null; wallMinutes: number | null; nudgeTypes: string[] };

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Minute limits: explicit context-wall.json values win; else 10/5 minutes before the watchdog's hard stop. */
export function minuteLimits(
  wallCfg: Record<string, unknown> | null,
  watchdogCfg: Record<string, unknown> | null,
): { warnMinutes: number | null; wallMinutes: number | null } {
  let warnMinutes = positive(wallCfg?.warnMinutes);
  let wallMinutes = positive(wallCfg?.wallMinutes);
  const hs = watchdogCfg?.hardStop as Record<string, unknown> | undefined;
  const hardMinutes = hs?.enabled === true ? positive(hs.minutes) : null;
  if (hardMinutes != null) {
    wallMinutes ??= Math.max(1, hardMinutes - 5);
    warnMinutes ??= Math.max(0.5, hardMinutes - 10);
  }
  if (warnMinutes != null && wallMinutes != null && warnMinutes >= wallMinutes) warnMinutes = null;
  return { warnMinutes, wallMinutes };
}

export function readLimits(): Limits {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = readJson(join(dir, "context-wall.json"));
    const pick = (key: keyof typeof DEFAULTS) => positive(raw?.[key]) ?? DEFAULTS[key];
    return {
      nudge: pick("nudge"),
      warn1: pick("warn1"),
      warn2: pick("warn2"),
      wall: pick("wall"),
      nudgeTypes: Array.isArray(raw?.nudgeTypes)
        ? (raw!.nudgeTypes as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
        : DEFAULT_NUDGE_TYPES,
      ...minuteLimits(raw, readJson(join(dir, "subagent-watchdog.json"))),
    };
  } catch {
    return { ...DEFAULTS, warnMinutes: null, wallMinutes: null, nudgeTypes: DEFAULT_NUDGE_TYPES };
  }
}

/** The agent type from pi-subagents' session name (`<type>#<id>`), or null when the session has no name. */
export function agentTypeOf(sessionName: unknown): string | null {
  if (typeof sessionName !== "string" || sessionName.trim() === "") return null;
  return sessionName.split("#")[0].trim() || null;
}

/**
 * Whether the no-code-yet nudge applies to this agent type. A type matches a listed type exactly or as
 * `<type>-<suffix>` (lane matches lane-opus). An unknown type keeps the nudge, as before this check existed.
 */
export function nudgeApplies(agentType: string | null, nudgeTypes: string[]): boolean {
  if (agentType == null) return true;
  const t = agentType.toLowerCase();
  return nudgeTypes.some((n) => t === n.toLowerCase() || t.startsWith(`${n.toLowerCase()}-`));
}

/** What to do with the work, for the wrap-up notices: code changes go to a PR, anything else to the final message. */
const handoff = (codeEdited: boolean) =>
  codeEdited
    ? "commit and push your changes, put your report in the PR body"
    : "put your report in your final message (you have not edited code, so there is nothing to push)";

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
    // Cleanup of a container the agent started (docker rm/stop/kill) is allowed too: a lane walled mid-task
    // otherwise leaves its test database running.
    const isCleanup = (s: string) => /^docker\s+(container\s+)?(rm|stop|kill)(\s|$)/.test(s);
    return (
      segments.length > 0 &&
      segments.every((s) => isGit(s) || isCleanup(s) || /^(cd|export)(\s|$)/.test(s)) &&
      segments.some((s) => isGit(s) || isCleanup(s))
    );
  }
  if (toolName === "write" || toolName === "edit") {
    const p = typeof args.path === "string" ? args.path : "";
    return /\.(md|txt)$/i.test(p);
  }
  return false;
}

const WRITING_GIT =
  /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|-P))*\s+(checkout|switch|restore|reset|stash|clean|pull|merge|rebase|commit|add|rm|mv|cherry-pick|revert|am|apply|read-tree|update-index|checkout-index|gc|prune)\b/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The protected directories from context-wall.json, `~` expanded, trailing slashes dropped. */
export function readProtectedCheckouts(): string[] {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = readJson(join(dir, "context-wall.json"))?.protectedCheckouts;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is string => typeof p === "string" && p.trim().length > 1)
      .map((p) => p.trim().replace(/^~(?=\/)/, homedir()).replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

/**
 * The protected checkout a tool call would write, or null. `cwd` is the agent's working directory; `home` is a test
 * seam. Named forms: the absolute path, `~/...`, `$HOME/...`, `${HOME}/...`, and `../<basename>` (a sibling worktree
 * reaching over). Each must end at a path boundary, so `.../PerformanceMonitor-wt` is not the checkout.
 */
export function protectedWriteTarget(
  toolName: string,
  input: unknown,
  cwd: string,
  protectedDirs: string[],
  home: string = homedir(),
): string | null {
  if (protectedDirs.length === 0) return null;
  const args = (input ?? {}) as Record<string, unknown>;
  const inside = (p: string, d: string) => p === d || p.startsWith(d + "/");
  if (toolName === "write" || toolName === "edit") {
    const raw = typeof args.path === "string" ? args.path : "";
    if (!raw) return null;
    const abs = raw.startsWith("~/") ? home + raw.slice(1) : raw.startsWith("/") ? raw : join(cwd, raw);
    return protectedDirs.find((d) => inside(abs, d)) ?? null;
  }
  if (toolName !== "bash") return null;
  const cmd = typeof args.command === "string" ? args.command : "";
  if (!WRITING_GIT.test(cmd)) return null;
  const end = "(?=$|[\\s/'\"`;&|)])";
  for (const d of protectedDirs) {
    if (inside(cwd, d)) return d;
    const forms = [escapeRe(d)];
    if (inside(d, home) && d !== home) {
      const rel = escapeRe(d.slice(home.length)); // "/Documents/..."
      forms.push(`~${rel}`, `\\$HOME${rel}`, `\\$\\{HOME\\}${rel}`);
    }
    const base = d.split("/").pop();
    if (base) forms.push(`(?:\\.\\./)+${escapeRe(base)}`);
    if (forms.some((f) => new RegExp(f + end).test(cmd))) return d;
  }
  return null;
}

/** Test seam: the clock the time wall reads. */
export const clock = { now: () => Date.now() };

export default function contextWall(pi: ExtensionAPI) {
  let warned = 0; // highest warning already sent: 0, 1 or 2
  let timeWarned = false;
  let codeEdited = false; // a write/edit to anything but .md/.txt has been attempted
  let pushed = false; // a `git push` or `gh pr create` has been attempted
  let nudged = false;
  const startedAt = clock.now();
  const elapsedMinutes = () => (clock.now() - startedAt) / 60_000;

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
      const args = (event.input ?? {}) as Record<string, unknown>;
      if ((event.toolName === "write" || event.toolName === "edit") && !/\.(md|txt)$/i.test(String(args.path ?? ""))) {
        codeEdited = true;
      }
      const guarded = protectedWriteTarget(
        event.toolName,
        event.input,
        String((ctx as { cwd?: unknown })?.cwd ?? process.cwd()),
        readProtectedCheckouts(),
      );
      if (guarded != null) {
        return {
          block: true,
          reason:
            `context-wall: ${guarded} is a protected checkout (someone's own working copy). Nothing may write its ` +
            `files, index or refs: no git checkout/switch/restore/reset/stash/clean/pull/commit/add there, and no ` +
            `write or edit inside it. To read another ref's files, use \`git show <ref>:<path>\`, \`git diff\` or ` +
            `\`git ls-tree\` from your own worktree. This is not a bug, and there is no override.`,
        };
      }
      if (event.toolName === "bash" && /\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(String(args.command ?? ""))) {
        pushed = true;
      }
      const limits = readLimits();
      const m = measure(ctx);
      const sizeHit = m != null && m.judged >= limits.wall;
      const mins = elapsedMinutes();
      const timeHit = limits.wallMinutes != null && mins >= limits.wallMinutes;
      if (!sizeHit && !timeHit) return undefined;
      if (wrapUpAllowed(event.toolName, event.input)) return undefined;
      const why = sizeHit
        ? `you are past the ${fmtK(limits.wall)} wall (${describe(m!)})`
        : `you have run ${Math.floor(mins)} minutes, past the ${limits.wallMinutes}-minute wall; the watchdog stops ` +
          `you in a few minutes`;
      return {
        block: true,
        reason:
          `context-wall: ${why}. Only git/gh commands ` +
          `and writes to .md/.txt files run now. ` +
          (codeEdited
            ? `Commit and push what you have, put your report in the PR body (gh pr edit --body-file) or a .md note, `
            : `Put your report in your final message, `) +
          `then end your turn with a final message of 400 words or fewer. ` +
          `This is not a bug, and there is no override.`,
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const limits = readLimits();
      const mins = elapsedMinutes();
      if (!timeWarned && limits.warnMinutes != null && mins >= limits.warnMinutes) {
        timeWarned = true;
        const wallAt = limits.wallMinutes != null ? ` At ${limits.wallMinutes} minutes, every tool except git/gh ` +
          `commands and .md/.txt writes is blocked.` : "";
        const text =
          `\n\n[context-wall] You have run ${Math.floor(mins)} minute${Math.floor(mins) === 1 ? "" : "s"}. Start no new step and no full test run. ` +
          `Then ${handoff(codeEdited)}, and end your turn.${wallAt}`;
        return { content: [...(event.content ?? []), { type: "text" as const, text }] };
      }
      const m = measure(ctx);
      if (m == null) return undefined;
      const level = m.judged >= limits.warn2 ? 2 : m.judged >= limits.warn1 ? 1 : 0;
      const agentType = agentTypeOf(
        (ctx as { sessionManager?: { getSessionName?: () => unknown } })?.sessionManager?.getSessionName?.(),
      );
      if (level === 0 && !nudged && !codeEdited && m.judged >= limits.nudge && nudgeApplies(agentType, limits.nudgeTypes)) {
        nudged = true;
        const text =
          `\n\n[context-wall] You are at ${fmtK(m.judged)} and have not edited any code yet. Stop investigating. ` +
          `Make the smallest change that meets your brief now, push it as a draft PR, and put open questions in the ` +
          `PR body. The handoff line is ${fmtK(limits.warn1)}.`;
        return { content: [...(event.content ?? []), { type: "text" as const, text }] };
      }
      if (level <= warned) return undefined;
      warned = level;
      const unpushed =
        codeEdited && !pushed ? "You have code changes and nothing is pushed yet: commit and push a draft PR before any other step. " : "";
      const lead =
        unpushed +
        (level === 1
          ? `You are past the ~${fmtK(limits.warn1)} handoff line. Finish the step you are on, then ` +
            `${handoff(codeEdited)}, and end your turn.`
          : `This is the last warning before the wall. Wrap up now: ${handoff(codeEdited)}.`);
      const text =
        `\n\n[context-wall] You are at ${fmtK(m.judged)} (${describe(m)}; warning ${level} of 2). ${lead} ` +
        `At ${fmtK(limits.wall)}, every tool except git/gh commands and .md/.txt writes is blocked.`;
      return { content: [...(event.content ?? []), { type: "text" as const, text }] };
    } catch {
      return undefined;
    }
  });
}
