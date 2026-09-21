/**
 * subagent-watchdog — catch runaway subagents and make the orchestrator check in.
 *
 * The gap this fills: pi-subagents' background children only signal the parent
 * at completion. Between spawn and terminal state the orchestrator model is
 * asleep — a child can burn 2M tokens grepping the known universe and nothing
 * wakes the parent. This extension watches every top-level subagent's live
 * vitals and, when any configurable signal threshold is crossed, injects a
 * compact, fleet-batched check-in into the main conversation (deliverAs:
 * "steer", triggerTurn: true) so the orchestrator assesses the child: on track,
 * lost and needing guidance, or runaway and needing a wrap-up order / stop.
 * Full breach/action details persist as structured custom entries that stay out
 * of LLM context; fleet/per-agent rate limits bound the watchdog's own token tax.
 *
 * Data sources (all verified against @tintinweb/pi-subagents):
 *   - globalThis[Symbol.for("pi-subagents:manager")].getRecord(id) — the LIVE
 *     AgentRecord: lifetimeUsage, toolUses, compactionCount, startedAt, status,
 *     outputFile, session (→ getSessionStats().contextUsage.percent).
 *   - The streamed .output transcript (JSONL, one line per message): derived
 *     turn count (assistant lines) and the recent tool calls — the "what is it
 *     actually doing" feed. Read incrementally by byte offset.
 *   - pi.events "subagents:created/started/completed/failed/compacted".
 *   - Hard stop (opt-in) via the "subagents:rpc:stop" bus verb.
 *
 * Config: ~/.pi/agent/subagent-watchdog.json, overridden per-project by
 * .pi/subagent-watchdog.json (trusted projects only). All signals optional;
 * 0 or null disables a signal. See README.md next to this file.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Signals {
  /** Lifetime tokens (input + output + cacheWrite — matches pi-subagents' counter). */
  tokens?: number | null;
  /** Context window fill percent of the child session (0-100). */
  contextPercent?: number | null;
  /** Cumulative tool uses. */
  toolUses?: number | null;
  /** Turns, derived from the transcript (assistant message count). */
  turns?: number | null;
  /** Wall-clock minutes since spawn. */
  minutes?: number | null;
  /** Session compactions — a compacting "small task" child is a strong runaway tell. */
  compactions?: number | null;
}

interface WatchdogConfig {
  enabled: boolean;
  pollIntervalMs: number;
  /** Minimum ms between breach evaluations for the same agent. */
  cooldownMs: number;
  /** Minimum ms between orchestrator wakes across the whole fleet. */
  globalCooldownMs: number;
  /** Collect nearby breaches into one orchestrator wake for this many ms. */
  batchWindowMs: number;
  /** Maximum automatic LLM check-ins per agent. Human-requested check-ins bypass this cap. */
  maxCheckInsPerAgent: number;
  /** Persist structured breach/action records as non-context custom entries. */
  auditTrail: boolean;
  /** Re-alert a multiplicative signal when it reaches lastAlertedValue * factor. */
  renotifyFactor: number;
  /** "wake" injects a batched check-in for the orchestrator LLM; "notify" is UI-only. */
  action: "wake" | "notify";
  /**
   * Orchestrator posture when signals are hit:
   *   "guide"  — assess with judgment; healthy agents run free (default).
   *   "strict" — thresholds are budgets; default action is wrap-up, continuation
   *              requires cited evidence and ONE named bounded extension.
   */
  mode: "guide" | "strict";
  /** Delivery mode for the wake message. "steer" interrupts after the current tool batch. */
  deliverAs: "steer" | "followUp";
  signals: Signals;
  hardStop: {
    enabled: boolean;
    tokens?: number | null;
    minutes?: number | null;
  };
}

const DEFAULTS: WatchdogConfig = {
  enabled: true,
  pollIntervalMs: 15_000,
  cooldownMs: 90_000,
  globalCooldownMs: 60_000,
  batchWindowMs: 5_000,
  maxCheckInsPerAgent: 2,
  auditTrail: true,
  renotifyFactor: 2,
  action: "wake",
  mode: "guide",
  deliverAs: "steer",
  signals: {
    tokens: 250_000,
    contextPercent: 60,
    toolUses: 40,
    turns: 30,
    minutes: 10,
    compactions: 1,
  },
  hardStop: {
    enabled: false,
    tokens: 1_500_000,
    minutes: 45,
  },
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readJson(path: string): Partial<WatchdogConfig> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Coerce a required numeric setting: strings parsed, NaN/negatives → fallback, floored at min. */
function num(v: unknown, fallback: number, min: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

/** Coerce an optional signal threshold: null/0/false → disabled, bad values → fallback. */
function optNum(v: unknown, fallback: number | null | undefined): number | null {
  if (v === null || v === 0 || v === false) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback ?? null;
  return n;
}

function loadConfig(cwd: string, projectTrusted: boolean): WatchdogConfig {
  const global = readJson(join(agentDir(), "subagent-watchdog.json"));
  const project = projectTrusted
    ? readJson(join(cwd, CONFIG_DIR_NAME, "subagent-watchdog.json"))
    : undefined;
  const m = {
    ...DEFAULTS,
    ...global,
    ...project,
    signals: { ...DEFAULTS.signals, ...global?.signals, ...project?.signals },
    hardStop: { ...DEFAULTS.hardStop, ...global?.hardStop, ...project?.hardStop },
  } as Record<string, unknown> & { signals: Record<string, unknown>; hardStop: Record<string, unknown> };
  // Sanitize — user JSON can hold strings, zeros, negatives (review finding #4).
  const enabledRaw = m.enabled;
  return {
    enabled: enabledRaw !== false && enabledRaw !== "false" && enabledRaw !== 0,
    pollIntervalMs: num(m.pollIntervalMs, DEFAULTS.pollIntervalMs, 2_000),
    cooldownMs: num(m.cooldownMs, DEFAULTS.cooldownMs, 5_000),
    globalCooldownMs: num(m.globalCooldownMs, DEFAULTS.globalCooldownMs, 5_000),
    batchWindowMs: num(m.batchWindowMs, DEFAULTS.batchWindowMs, 0),
    maxCheckInsPerAgent: Math.floor(num(m.maxCheckInsPerAgent, DEFAULTS.maxCheckInsPerAgent, 1)),
    auditTrail: m.auditTrail !== false && m.auditTrail !== "false" && m.auditTrail !== 0,
    renotifyFactor: num(m.renotifyFactor, DEFAULTS.renotifyFactor, 1.1),
    action: m.action === "notify" ? "notify" : "wake",
    mode: m.mode === "strict" ? "strict" : "guide",
    deliverAs: m.deliverAs === "followUp" ? "followUp" : "steer",
    signals: {
      tokens: optNum(m.signals.tokens, DEFAULTS.signals.tokens),
      contextPercent: optNum(m.signals.contextPercent, DEFAULTS.signals.contextPercent),
      toolUses: optNum(m.signals.toolUses, DEFAULTS.signals.toolUses),
      turns: optNum(m.signals.turns, DEFAULTS.signals.turns),
      minutes: optNum(m.signals.minutes, DEFAULTS.signals.minutes),
      compactions: optNum(m.signals.compactions, DEFAULTS.signals.compactions),
    },
    hardStop: {
      enabled: m.hardStop.enabled === true,
      tokens: optNum(m.hardStop.tokens, DEFAULTS.hardStop.tokens),
      minutes: optNum(m.hardStop.minutes, DEFAULTS.hardStop.minutes),
    },
  };
}

// ---------------------------------------------------------------------------
// pi-subagents integration surfaces
// ---------------------------------------------------------------------------

/** The documented cross-package singleton (docs/rpc.md, "The manager registry"). */
interface ManagerRegistry {
  hasRunning: () => boolean;
  waitForAll: () => Promise<void>;
  getRecord: (id: string) => SubagentRecord | undefined;
}

/** The subset of AgentRecord the watchdog reads. Kept structural — no dependency on pi-subagents. */
interface SubagentRecord {
  id: string;
  type: string;
  handle?: string;
  alias?: string;
  description: string;
  status: string;
  toolUses: number;
  startedAt: number;
  compactionCount?: number;
  outputFile?: string;
  lifetimeUsage?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
  /** Effective model identity populated by pi-subagents once the child session exists. */
  invocation?: {
    modelName?: string;
    modelId?: string;
    thinking?: string;
    requestedModel?: string;
    requestedThinking?: string;
  };
  session?: {
    getSessionStats?: () => { contextUsage?: { percent?: number } | null };
    /** Same call pi-subagents' own steerAgent() makes — injects a user message into the child. */
    steer?: (message: string) => Promise<void>;
  };
}

function getRegistry(): ManagerRegistry | undefined {
  return (globalThis as Record<symbol, unknown>)[
    Symbol.for("pi-subagents:manager")
  ] as ManagerRegistry | undefined;
}

// ---------------------------------------------------------------------------
// Per-agent watch state
// ---------------------------------------------------------------------------

interface Watched {
  id: string;
  type: string;
  description: string;
  // Incremental transcript parse state
  transcriptOffset: number;
  turns: number;
  recentTools: string[];
  // Alerting state
  lastWakeAt: number;
  /** signal name -> value at the last alert that included it (re-arm bookkeeping). */
  alertedAt: Record<string, number>;
  hardStopped: boolean;
  /** All delivered check-ins, including human-requested ones, for display numbering. */
  wakeCount: number;
  /** Automatic LLM wakes only — bounded by maxCheckInsPerAgent. */
  automaticWakeCount: number;
  /** First tick where the registry had no record for this id (eviction grace timer). */
  missingSince?: number;
  /** Counter snapshot at the previous check-in — lets the next one say "unchanged". */
  lastSample?: { tokens: number; toolUses: number; turns: number };
}

interface Vitals {
  tokens: number;
  contextPercent: number | null;
  toolUses: number;
  turns: number;
  minutes: number;
  compactions: number;
}

interface PendingCheckIn {
  id: string;
  handle: string;
  type: string;
  description: string;
  model?: string;
  checkInNumber: number | null;
  vitals: Vitals;
  breaches: Breach[];
  advice: string[];
  recentTools: string[];
  reason?: string;
}

const MAX_TRANSCRIPT_READ = 8 * 1024 * 1024; // per tick, per agent

function newWatched(id: string, type: string, description: string): Watched {
  return {
    id,
    type,
    description,
    transcriptOffset: 0,
    turns: 0,
    recentTools: [],
    lastWakeAt: 0,
    alertedAt: {},
    hardStopped: false,
    wakeCount: 0,
    automaticWakeCount: 0,
  };
}

/**
 * Incrementally consume new transcript bytes: turn count + recent tool calls.
 * Byte-accurate: only whole lines (up to the last \n in the read) are ever
 * decoded, so a multibyte char split at the read cap can't produce a torn
 * fragment or desync the offset (review finding #6).
 */
function updateFromTranscript(w: Watched, file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return; // transcript disabled or not created yet
  }
  if (size < w.transcriptOffset) {
    // Truncated/rotated — start over and recount (review finding #10).
    w.transcriptOffset = 0;
    w.turns = 0;
    w.recentTools = [];
  }
  if (size <= w.transcriptOffset) return;

  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const len = Math.min(size - w.transcriptOffset, MAX_TRANSCRIPT_READ);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, w.transcriptOffset);
    if (read <= 0) return;
    // Consume only up to the last complete line; a partial tail stays
    // unconsumed for the next tick.
    const lastNl = buf.lastIndexOf(0x0a, read - 1);
    if (lastNl < 0) {
      // A single line larger than the read cap: skip it whole rather than
      // wedging. Advance only when the cap (not a mid-write) was the limiter.
      if (read >= MAX_TRANSCRIPT_READ) w.transcriptOffset += read;
      return;
    }
    w.transcriptOffset += lastNl + 1;
    for (const line of buf.toString("utf8", 0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      if (line.length > 2_000_000) continue; // skip pathological lines (review #12)
      try {
        const entry = JSON.parse(line);
        const m = entry?.message;
        if (m?.role !== "assistant") continue;
        w.turns++;
        for (const c of m.content ?? []) {
          if (c?.type !== "toolCall") continue;
          let args = "";
          try {
            args = JSON.stringify(c.arguments ?? {});
          } catch {
            args = "{…}";
          }
          if (args.length > 140) args = args.slice(0, 140) + "…";
          w.recentTools.push(`${c.name} ${args}`);
          if (w.recentTools.length > 5) w.recentTools.shift();
        }
      } catch {
        // partial/corrupt line — skip
      }
    }
  } finally {
    closeSync(fd);
  }
}

function readVitals(w: Watched, rec: SubagentRecord): Vitals {
  const lu = rec.lifetimeUsage ?? {};
  let contextPercent: number | null = null;
  try {
    contextPercent = rec.session?.getSessionStats?.().contextUsage?.percent ?? null;
  } catch {
    contextPercent = null;
  }
  return {
    tokens: (lu.input ?? 0) + (lu.output ?? 0) + (lu.cacheWrite ?? 0),
    contextPercent,
    toolUses: rec.toolUses ?? 0,
    turns: w.turns,
    minutes: (Date.now() - rec.startedAt) / 60_000,
    compactions: rec.compactionCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Signal evaluation
// ---------------------------------------------------------------------------

interface Breach {
  name: keyof Signals;
  value: number;
  threshold: number;
}

/**
 * Which signals are breached AND due for (re-)alerting.
 * Re-arm policy: multiplicative signals (tokens/toolUses/turns/minutes) re-alert
 * at lastAlertedValue * renotifyFactor; contextPercent re-alerts every +15pts;
 * compactions re-alerts on every increment.
 */
function dueBreaches(w: Watched, v: Vitals, cfg: WatchdogConfig): Breach[] {
  const out: Breach[] = [];
  const check = (name: keyof Signals, value: number | null, threshold: number | null | undefined) => {
    if (value == null || threshold == null || threshold <= 0) return;
    if (value < threshold) {
      // contextPercent is the one non-monotonic signal (compaction drops it);
      // re-arm from scratch when it falls back below threshold (review #8).
      if (name === "contextPercent" && w.alertedAt[name] !== undefined) delete w.alertedAt[name];
      return;
    }
    const last = w.alertedAt[name];
    if (last !== undefined) {
      if (name === "contextPercent") {
        if (value < last + 15) return;
      } else if (name === "compactions") {
        if (value <= last) return;
      } else {
        if (value < last * cfg.renotifyFactor) return;
      }
    }
    out.push({ name, value, threshold });
  };
  check("tokens", v.tokens, cfg.signals.tokens);
  check("contextPercent", v.contextPercent, cfg.signals.contextPercent);
  check("toolUses", v.toolUses, cfg.signals.toolUses);
  check("turns", v.turns, cfg.signals.turns);
  check("minutes", v.minutes, cfg.signals.minutes);
  check("compactions", v.compactions, cfg.signals.compactions);
  return out;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtSignal(b: Breach): string {
  switch (b.name) {
    case "tokens":
      return `tokens ${fmtTokens(b.value)} ≥ ${fmtTokens(b.threshold)}`;
    case "contextPercent":
      return `context ${Math.round(b.value)}% ≥ ${b.threshold}%`;
    case "minutes":
      return `elapsed ${b.value.toFixed(1)}m ≥ ${b.threshold}m`;
    default:
      return `${b.name} ${Math.round(b.value)} ≥ ${b.threshold}`;
  }
}

function vitalsLine(v: Vitals): string {
  const parts = [
    `${fmtTokens(v.tokens)} tokens`,
    `${v.toolUses} tool uses`,
    v.turns > 0 ? `${v.turns} turns` : undefined,
    v.contextPercent != null ? `context ${Math.round(v.contextPercent)}%` : undefined,
    v.compactions > 0 ? `${v.compactions} compaction${v.compactions === 1 ? "" : "s"}` : undefined,
    `${v.minutes.toFixed(1)} min elapsed`,
  ];
  return parts.filter(Boolean).join(" · ");
}

function modelLine(rec: SubagentRecord): string | undefined {
  const model = rec.invocation?.modelId ?? rec.invocation?.modelName;
  if (!model) return undefined;
  const thinking = rec.invocation?.thinking;
  return thinking ? `${model} · thinking ${thinking}` : model;
}

/**
 * Situational hints for the two known non-distress signatures, so the
 * orchestrator doesn't have to re-derive them from raw vitals on every wake.
 * Both were observed and manually diagnosed during live testing (2026-09-19).
 */
function adviceLines(w: Watched, v: Vitals, breaches: Breach[]): string[] {
  // Wedged-first-tool signature: nothing has completed and the transcript is
  // still empty (its write stream lags), so turns/recent-tools read as zero.
  if (v.toolUses === 0 && w.turns === 0) {
    return [
      `First tool likely still running; a steer will queue. Use /watchdog → Hard stop to interrupt it.`,
    ];
  }
  // Composing signature: only elapsed time crossed and every counter is
  // byte-identical to the previous check-in — a long generation or a
  // long-running tool call, not a loop (loops climb).
  if (
    w.lastSample &&
    v.tokens === w.lastSample.tokens &&
    v.toolUses === w.lastSample.toolUses &&
    w.turns === w.lastSample.turns &&
    breaches.length > 0 &&
    breaches.every((b) => b.name === "minutes")
  ) {
    return [
      `Counters are unchanged and only elapsed crossed; likely composing or inside one long tool call.`,
    ];
  }
  return [];
}

function snapshotCheckIn(
  w: Watched,
  rec: SubagentRecord,
  v: Vitals,
  breaches: Breach[],
  checkInNumber: number | null,
  reason?: string,
): PendingCheckIn {
  return {
    id: w.id,
    handle: rec.alias ?? rec.handle ?? w.id,
    type: w.type,
    description: w.description,
    model: modelLine(rec),
    checkInNumber,
    vitals: { ...v },
    breaches: breaches.map((b) => ({ ...b })),
    advice: adviceLines(w, v, breaches),
    recentTools: [...w.recentTools],
    reason,
  };
}

/** Compact LLM-facing message; the complete structured record lives in a non-context audit entry. */
function checkInMessage(items: PendingCheckIn[], mode: "guide" | "strict"): string {
  const lines: string[] = [
    items.length === 1
      ? `[subagent-watchdog] One agent crossed a guardrail:`
      : `[subagent-watchdog] ${items.length} agents crossed guardrails (batched):`,
  ];
  for (const item of items) {
    const identity = [item.type, item.model].filter(Boolean).join(" · ");
    const reason = item.reason ?? item.breaches.map(fmtSignal).join(", ");
    const task = item.description.length > 100 ? `${item.description.slice(0, 100)}…` : item.description;
    lines.push(
      `- #${item.checkInNumber ?? "?"} "${item.handle}" (${identity}) — "${task}": ${reason}; ${vitalsLine(item.vitals)}.`,
    );
    if (item.recentTools.length > 0) {
      lines.push(`  recent: ${item.recentTools.slice(-2).join(" | ")}`);
    }
    for (const note of item.advice) lines.push(`  note: ${note}`);
  }
  if (mode === "strict") {
    lines.push(
      `STRICT: limits are budgets. Wrap up each agent unless its recent work proves convergence and you grant one named bounded extension; check-in #2 means the extension is spent.`,
    );
  } else {
    lines.push(`Guide: on track → no action; lost → steer; runaway → wrap up. Do not spawn duplicates.`);
  }
  lines.push(`Use subagent_vitals for the full live snapshot; structured audit details are stored outside LLM context.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let cfg: WatchdogConfig = { ...DEFAULTS };
  let ctx: ExtensionContext | undefined;
  const roster = new Map<string, Watched>();
  const pendingCheckIns = new Map<string, PendingCheckIn>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastGlobalWakeAt = 0;
  const unsubs: Array<() => void> = [];

  // --- Root-session ownership claim ---------------------------------------
  // Subagent child sessions re-activate every extension in the same process
  // (pi-subagents agent-runner: session.bindExtensions), so this factory runs
  // once per child too. Without a claim, each child instance would react to
  // the shared-bus subagents:* events and inject check-in messages into the
  // CHILD's conversation. Mirror pi-subagents' own MANAGER_KEY pattern: the
  // first activation (the root session) claims the slot; child activations
  // stay dormant; only the owner releases on shutdown.
  const OWNER_KEY = Symbol.for("subagent-watchdog:owner");
  const instanceId = randomUUID();
  let isOwner = false;
  const g = globalThis as Record<symbol, unknown>;
  // Claim eagerly at factory time too: at pi startup and after /reload the
  // root runtime's factories run before any child session can exist, which
  // closes the release→re-claim window where a late-binding child's
  // session_start could steal the slot (review finding #3). A child factory
  // reaching this line finds the slot taken and no-ops.
  if (g[OWNER_KEY] === undefined) g[OWNER_KEY] = instanceId;
  /** hardStop reply timeouts, cleared on shutdown (review finding #9). */
  const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  const notify = (msg: string, level: "info" | "warning" | "error" = "warning") => {
    if (ctx?.hasUI) ctx.ui.notify(msg, level);
  };

  const appendAudit = (kind: string, data: Record<string, unknown>) => {
    if (!isOwner || !cfg.auditTrail) return;
    try {
      pi.appendEntry("subagent-watchdog-audit", {
        version: 1,
        kind,
        recordedAt: new Date().toISOString(),
        ...data,
      });
    } catch {
      // Auditing must never interfere with containment.
    }
  };

  const cancelPendingCheckIn = (id: string, reason: string) => {
    const checkIn = pendingCheckIns.get(id);
    if (!checkIn) return;
    pendingCheckIns.delete(id);
    appendAudit("check-in-cancelled", { agentId: id, reason, checkIn });
  };

  const clearPendingCheckIns = (reason: string) => {
    for (const id of [...pendingCheckIns.keys()]) cancelPendingCheckIn(id, reason);
  };

  const setStatus = () => {
    if (!ctx?.hasUI) return;
    const n = roster.size;
    // undefined clears the slot; "" can leave a stale footer entry (review #5).
    // SAFETY: pi's setStatus accepts undefined to clear a status slot
    // (extensions.md "setStatus" — clearing), but the published param type is
    // string; the cast only widens what the runtime already supports.
    ctx.ui.setStatus("watchdog", n > 0 ? `🐕 ${n}` : (undefined as unknown as string));
  };

  const ensureTimer = () => {
    if (timer || !cfg.enabled) return;
    timer = setInterval(tick, cfg.pollIntervalMs);
  };

  const stopTimerIfIdle = () => {
    if (timer && roster.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const track = (id: unknown, type: unknown, description: unknown) => {
    if (!isOwner || !cfg.enabled) return;
    if (typeof id !== "string" || id.length === 0) return;
    if (!roster.has(id)) {
      roster.set(
        id,
        newWatched(id, typeof type === "string" ? type : "?", typeof description === "string" ? description : ""),
      );
    }
    ensureTimer();
    setStatus();
  };

  const untrack = (id: unknown) => {
    if (typeof id === "string") {
      roster.delete(id);
      cancelPendingCheckIn(id, "agent reached a terminal state before batch delivery");
    }
    stopTimerIfIdle();
    setStatus();
  };

  function hardStop(w: Watched, rec: SubagentRecord, v: Vitals, reason: string) {
    // Optimistically latched so the poll loop doesn't re-fire while the stop is
    // in flight; reset on failure so retry / manual action stays possible.
    w.hardStopped = true;
    cancelPendingCheckIn(w.id, "hard stop superseded the queued check-in");
    const handle = rec.alias ?? rec.handle ?? w.id;
    const requestId = randomUUID();
    const replyChannel = `subagents:rpc:stop:reply:${requestId}`;
    let settled = false;
    appendAudit("hard-stop-requested", {
      agentId: w.id,
      handle,
      agentType: w.type,
      description: w.description,
      model: modelLine(rec),
      reason,
      vitals: v,
    });
    const tellOrchestrator = (content: string) => {
      pi.sendMessage(
        { customType: "subagent-watchdog", content, display: true },
        { deliverAs: cfg.deliverAs, triggerTurn: true },
      );
    };
    // The orchestrator-facing report is sent from the REPLY, not optimistically
    // — a failed stop reported as success invites spawning a duplicate agent
    // while the original still runs (review finding #2).
    const settle = (reply: { success?: boolean; error?: string } | undefined) => {
      if (settled) return;
      settled = true;
      try {
        if (typeof unsub === "function") unsub();
      } catch {
        /* older bus without unsub */
      }
      if (reply?.success === true) {
        notify(`watchdog: hard-stopped agent "${handle}" (${reason})`);
        appendAudit("hard-stop-succeeded", { agentId: w.id, handle, reason, vitals: v });
        tellOrchestrator(
          `[subagent-watchdog] HARD-STOPPED agent "${handle}" (${w.type}, id ${w.id}) — ${reason}.\n` +
            `Final observed vitals: ${vitalsLine(v)}.\n` +
            `Retrieve partial output with get_subagent_result, then re-scope the remaining work into a smaller task before respawning.`,
        );
      } else {
        w.hardStopped = false;
        const detail = reply ? (reply.error ?? "unknown error") : "no reply from pi-subagents (stop verb unavailable?)";
        notify(`watchdog: hard-stop of "${handle}" FAILED: ${detail}`, "error");
        appendAudit("hard-stop-failed", { agentId: w.id, handle, reason, detail, vitals: v });
        tellOrchestrator(
          `[subagent-watchdog] Hard-stop of agent "${handle}" (id ${w.id}) FAILED: ${detail}.\n` +
            `The agent is STILL RUNNING (${vitalsLine(v)}; trigger: ${reason}).\n` +
            `Intervene manually: steer_subagent it to wrap up, or stop it via /agents. Do NOT spawn a replacement while it runs.`,
        );
      }
    };
    const unsub = pi.events.on(replyChannel, (reply: unknown) =>
      settle(reply as { success?: boolean; error?: string }),
    );
    pi.events.emit("subagents:rpc:stop", { agentId: w.id, requestId });
    const t = setTimeout(() => {
      pendingTimeouts.delete(t);
      settle(undefined);
    }, 10_000);
    pendingTimeouts.add(t);
  }

  function scheduleBatchFlush() {
    if (batchTimer || pendingCheckIns.size === 0) return;
    const sinceLastWake = Date.now() - lastGlobalWakeAt;
    const globalDelay = lastGlobalWakeAt === 0 ? 0 : Math.max(0, cfg.globalCooldownMs - sinceLastWake);
    batchTimer = setTimeout(flushCheckInBatch, Math.max(cfg.batchWindowMs, globalDelay));
  }

  function flushCheckInBatch() {
    batchTimer = undefined;
    if (!isOwner) {
      pendingCheckIns.clear();
      return;
    }
    if (!cfg.enabled) {
      clearPendingCheckIns("watchdog disabled before batch delivery");
      return;
    }
    if (cfg.action !== "wake") {
      clearPendingCheckIns("action changed before batch delivery");
      return;
    }

    const registry = getRegistry();
    const items: PendingCheckIn[] = [];
    for (const [id, item] of [...pendingCheckIns]) {
      const rec = registry?.getRecord(id);
      const w = roster.get(id);
      if (!w || rec?.status !== "running") {
        cancelPendingCheckIn(id, "agent was no longer running at batch delivery");
        continue;
      }
      if (w.automaticWakeCount >= cfg.maxCheckInsPerAgent) {
        cancelPendingCheckIn(id, "automatic check-in cap was reached before batch delivery");
        continue;
      }
      pendingCheckIns.delete(id);
      w.wakeCount += 1;
      w.automaticWakeCount += 1;
      item.checkInNumber = w.wakeCount;
      items.push(item);
    }
    if (items.length === 0) return;

    try {
      pi.sendMessage(
        {
          customType: "subagent-watchdog",
          content: checkInMessage(items, cfg.mode),
          display: true,
        },
        { deliverAs: cfg.deliverAs, triggerTurn: true },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const item of items) {
        const w = roster.get(item.id);
        if (w) {
          w.wakeCount = Math.max(0, w.wakeCount - 1);
          w.automaticWakeCount = Math.max(0, w.automaticWakeCount - 1);
          w.lastWakeAt = 0;
          for (const breach of item.breaches) delete w.alertedAt[breach.name];
        }
        appendAudit("check-in-cancelled", {
          agentId: item.id,
          reason: "pi.sendMessage rejected the batch",
          detail,
          checkIn: item,
        });
      }
      notify(`watchdog: batched check-in delivery failed: ${detail}`, "error");
      return;
    }
    lastGlobalWakeAt = Date.now();
    appendAudit("check-in-batch-delivered", {
      checkIns: items,
      count: items.length,
      mode: cfg.mode,
      deliverAs: cfg.deliverAs,
    });
  }

  function wake(w: Watched, rec: SubagentRecord, v: Vitals, breaches: Breach[]) {
    // If nothing would actually surface (notify-only mode with no UI), don't
    // consume the breach — alertedAt/lastWakeAt advancing would silently
    // increase the re-arm threshold with zero delivery (review finding #7).
    if (cfg.action !== "wake" && ctx?.hasUI !== true) return;

    w.lastWakeAt = Date.now();
    for (const b of breaches) w.alertedAt[b.name] = b.value;
    const handle = rec.alias ?? rec.handle ?? w.id;
    notify(`watchdog: "${handle}" crossed ${breaches.map((b) => b.name).join(", ")} — ${vitalsLine(v)}`);

    let delivery: "notify-only" | "queued" | "merged-queued" | "suppressed-cap" = "notify-only";
    let item = snapshotCheckIn(w, rec, v, breaches, null);
    if (cfg.action === "wake") {
      const pending = pendingCheckIns.get(w.id);
      if (pending) {
        const mergedBreaches = new Map<keyof Signals, Breach>();
        for (const breach of [...pending.breaches, ...item.breaches]) mergedBreaches.set(breach.name, breach);
        item = {
          ...item,
          breaches: [...mergedBreaches.values()],
          advice: [...new Set([...pending.advice, ...item.advice])],
          reason: pending.reason ?? item.reason,
        };
        pendingCheckIns.set(w.id, item);
        delivery = "merged-queued";
        scheduleBatchFlush();
      } else if (w.automaticWakeCount >= cfg.maxCheckInsPerAgent) {
        delivery = "suppressed-cap";
        notify(
          `watchdog: "${handle}" reached the automatic check-in cap (${cfg.maxCheckInsPerAgent}); breach stored in audit only`,
          "info",
        );
      } else {
        pendingCheckIns.set(w.id, item);
        delivery = "queued";
        scheduleBatchFlush();
      }
    }
    appendAudit("breach", { delivery, checkIn: item });

    // Snapshot AFTER building advice, so the next wake compares against this one.
    w.lastSample = { tokens: v.tokens, toolUses: v.toolUses, turns: w.turns };
  }

  function tick() {
    if (!isOwner || !cfg.enabled) return;
    const registry = getRegistry();
    if (!registry) return; // pi-subagents not active in this session
    for (const [id, w] of roster) {
      const rec = registry.getRecord(id);
      if (!rec) {
        // Not visible: queued startup, or the record was evicted before its
        // completion event reached us. Grace period, then stop watching so the
        // roster (and timer) can't leak forever.
        w.missingSince ??= Date.now();
        if (Date.now() - w.missingSince > 60_000) untrack(id);
        continue;
      }
      w.missingSince = undefined;
      if (rec.status !== "running") {
        if (rec.status !== "queued") untrack(id); // terminal — completion event may have raced us
        continue;
      }
      if (rec.outputFile) updateFromTranscript(w, rec.outputFile);
      const v = readVitals(w, rec);

      // Hard stop first — it supersedes a check-in.
      if (cfg.hardStop.enabled && !w.hardStopped) {
        const ht = cfg.hardStop.tokens;
        const hm = cfg.hardStop.minutes;
        if (ht != null && ht > 0 && v.tokens >= ht) {
          hardStop(w, rec, v, `tokens ${fmtTokens(v.tokens)} ≥ hard limit ${fmtTokens(ht)}`);
          continue;
        }
        if (hm != null && hm > 0 && v.minutes >= hm) {
          hardStop(w, rec, v, `elapsed ${v.minutes.toFixed(1)}m ≥ hard limit ${hm}m`);
          continue;
        }
      }

      if (Date.now() - w.lastWakeAt < cfg.cooldownMs) continue;
      const breaches = dueBreaches(w, v, cfg);
      if (breaches.length > 0) wake(w, rec, v, breaches);
    }
    setStatus();
  }

  // ---- pi-subagents lifecycle events (shared bus; handlers get no ctx) ----
  const on = (channel: string, fn: (data: unknown) => void) => {
    const maybeUnsub = pi.events.on(channel, fn);
    if (typeof maybeUnsub === "function") unsubs.push(maybeUnsub);
  };

  on("subagents:created", (d) => {
    const e = d as { id?: string; type?: string; description?: string };
    track(e?.id, e?.type, e?.description);
  });
  on("subagents:started", (d) => {
    const e = d as { id?: string; type?: string; description?: string };
    track(e?.id, e?.type, e?.description);
  });
  on("subagents:completed", (d) => untrack((d as { id?: string })?.id));
  on("subagents:failed", (d) => untrack((d as { id?: string })?.id));
  on("subagents:compacted", (d) => {
    // A compaction is a point event worth reacting to immediately rather than
    // on the next poll — the record's compactionCount is already bumped.
    if (!isOwner) return;
    const e = d as { id?: string };
    if (typeof e?.id !== "string" || !roster.has(e.id)) return;
    tick();
  });

  // ---- pi lifecycle ----
  pi.on("session_start", async (_event, c) => {
    // Claim root ownership if the slot is free; a child session's activation
    // finds it taken and stays dormant for its whole life.
    if (g[OWNER_KEY] === undefined) g[OWNER_KEY] = instanceId;
    isOwner = g[OWNER_KEY] === instanceId;
    if (!isOwner) return;
    ctx = c;
    cfg = loadConfig(c.cwd, c.isProjectTrusted());
    // Roster is process-memory; a /resume mid-run of children can't be
    // reconstructed reliably, so start clean. Running agents will still be
    // caught if pi-subagents re-emits started (queued starts) — otherwise the
    // next spawn re-arms the watchdog.
    clearPendingCheckIns("session restarted before batch delivery");
    roster.clear();
    lastGlobalWakeAt = 0;
    setStatus();
  });

  pi.on("session_shutdown", async () => {
    // Record cancellations while the old session API and ownership claim are
    // still valid; custom audit entries do not enter LLM context.
    if (isOwner) clearPendingCheckIns("session shut down before batch delivery");
    // Release the claim only if this activation holds it — a child instance's
    // shutdown must not delete the root's slot.
    if (isOwner && g[OWNER_KEY] === instanceId) delete g[OWNER_KEY];
    isOwner = false;
    for (const t of pendingTimeouts) clearTimeout(t);
    pendingTimeouts.clear();
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
    for (const u of unsubs.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    roster.clear();
  });

  // ---- Orchestrator-facing vitals tool ----
  pi.registerTool({
    name: "subagent_vitals",
    label: "Subagent Vitals",
    description:
      "Live identity and vitals for all currently watched (running) subagents: effective model, tokens, " +
      "tool uses, derived turns, context %, compactions, elapsed time, and recent tool calls. " +
      "Use this when a subagent-watchdog check-in arrives, or any time you want a fleet health snapshot " +
      "without consuming results.",
    parameters: Type.Object({}),
    async execute() {
      if (!isOwner) {
        return {
          content: [
            {
              type: "text" as const,
              text: "subagent-watchdog is dormant in this session (not the root orchestrator session).",
            },
          ],
          details: {},
        };
      }
      const registry = getRegistry();
      if (!registry) {
        return {
          content: [{ type: "text" as const, text: "pi-subagents is not active in this session." }],
          details: {},
        };
      }
      if (roster.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagents currently watched (none running)." }],
          details: {},
        };
      }
      const blocks: string[] = [];
      for (const [id, w] of roster) {
        const rec = registry.getRecord(id);
        if (!rec) {
          blocks.push(`${id} — not visible (queued or evicted)`);
          continue;
        }
        if (rec.outputFile) updateFromTranscript(w, rec.outputFile);
        const v = readVitals(w, rec);
        const handle = rec.alias ?? rec.handle ?? id;
        const lines = [
          `agent "${handle}" (${w.type}, id ${id}) — status ${rec.status}`,
          `  task: ${w.description}`,
          ...(modelLine(rec) ? [`  model: ${modelLine(rec)}`] : []),
          `  vitals: ${vitalsLine(v)}`,
        ];
        if (w.recentTools.length > 0) {
          lines.push(`  recent tools: ${w.recentTools.join("  |  ")}`);
        }
        blocks.push(lines.join("\n"));
      }
      return { content: [{ type: "text" as const, text: blocks.join("\n\n") }], details: {} };
    },
  });

  // ---- Human-facing command: audit + intervention ----
  const WRAP_UP_STEER =
    "Stop what you are doing. Return your best partial results now: summarize what you completed, " +
    "what remains, and any findings so far. Do not start new work.";

  function statusLines(): string[] {
    const registry = getRegistry();
    const lines: string[] = [
      `watchdog: ${cfg.enabled ? "enabled" : "disabled"} · mode ${cfg.mode} · poll ${cfg.pollIntervalMs / 1000}s · action ${cfg.action}`,
      `delivery: per-agent cooldown ${cfg.cooldownMs / 1000}s · fleet cooldown ${cfg.globalCooldownMs / 1000}s · batch ${cfg.batchWindowMs / 1000}s · max ${cfg.maxCheckInsPerAgent}/agent · audit ${cfg.auditTrail ? "on" : "off"}`,
      `signals: ${Object.entries(cfg.signals)
        .filter(([, v]) => v != null && v > 0)
        .map(([k, v]) => `${k}≥${v}`)
        .join(", ")}`,
      `hardStop: ${cfg.hardStop.enabled ? `tokens≥${cfg.hardStop.tokens ?? "-"} minutes≥${cfg.hardStop.minutes ?? "-"}` : "off"}`,
      `registry: ${registry ? "connected" : "NOT FOUND (pi-subagents inactive?)"}`,
      `watched: ${roster.size}`,
    ];
    for (const [id, w] of roster) {
      const rec = registry?.getRecord(id);
      if (rec?.outputFile) updateFromTranscript(w, rec.outputFile);
      const v = rec ? readVitals(w, rec) : undefined;
      const label = rec ? (rec.alias ?? rec.handle ?? id) : id;
      const model = rec ? modelLine(rec) : undefined;
      lines.push(v ? `  ${label}${model ? ` [${model}]` : ""}: ${vitalsLine(v)}` : `  ${label}: (no record)`);
    }
    return lines;
  }

  const applyConfig = (c: { cwd: string; isProjectTrusted: () => boolean }) => {
    cfg = loadConfig(c.cwd, c.isProjectTrusted());
    // Poll and batch cadence may have changed — rebuild live timers.
    if (timer) {
      clearInterval(timer);
      timer = undefined;
      ensureTimer();
    }
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
    if (!cfg.enabled) clearPendingCheckIns("watchdog disabled by configuration reload");
    else if (cfg.action !== "wake") clearPendingCheckIns("action changed to notify by configuration reload");
    else scheduleBatchFlush();
  };

  const helpText = () =>
    [
      `subagent-watchdog — catches runaway subagents and wakes the orchestrator to check in.`,
      ``,
      `Commands:`,
      `  /watchdog          interactive panel: pick a running agent → vitals / check-in / steer / hard stop (Esc = status)`,
      `  /watchdog status   status summary (mode, thresholds, watched agents)`,
      `  /watchdog config   edit the global config in-editor — validated, saved, applied live`,
      `  /watchdog reload   re-read config files and apply live (after hand-editing)`,
      `  /watchdog help     this text`,
      ``,
      `Config files (project overrides global; project file honored in trusted projects only):`,
      `  ${join(agentDir(), "subagent-watchdog.json")}`,
      `  <project>/${CONFIG_DIR_NAME}/subagent-watchdog.json`,
      ``,
      `Settings:`,
      `  enabled          true/false master switch`,
      `  mode             "guide" = orchestrator assesses with judgment (default) · "strict" = thresholds are budgets`,
      `  action           "wake" = batched orchestrator check-in · "notify" = UI toast only`,
      `  deliverAs        "steer" = interrupt after current tool batch · "followUp" = wait until idle`,
      `  pollIntervalMs   vitals poll cadence (min 2000)`,
      `  cooldownMs       min gap between breach evaluations per agent (min 5000)`,
      `  globalCooldownMs min gap between LLM wakes across the fleet (min 5000)`,
      `  batchWindowMs    collect nearby agent breaches into one wake`,
      `  maxCheckInsPerAgent maximum automatic LLM wakes per agent (min 1; manual bypasses)`,
      `  auditTrail       persist full structured records outside LLM context`,
      `  renotifyFactor   re-alert when a signal reaches lastAlerted × factor (min 1.1)`,
      `  signals          thresholds — 0 or null disables one:`,
      `    tokens           lifetime tokens (input+output+cacheWrite)`,
      `    contextPercent   child context fill % (earliest runaway tell)`,
      `    toolUses         completed tool calls`,
      `    turns            assistant turns (transcript-derived)`,
      `    minutes          wall-clock since spawn — the only signal that catches a wedged tool`,
      `    compactions      child auto-compactions (≥1 on a small task is a red flag)`,
      `  hardStop         { enabled, tokens, minutes } — automatic abort, outcome reported from the RPC reply`,
      ``,
      `Docs: https://github.com/erikdarlingdata/claude-plugins/tree/main/plugins/pi-subagent-watchdog`,
    ].join("\n");

  pi.registerCommand("watchdog", {
    description: "Subagent watchdog: audit/steer/stop agents · status · config · reload · help",
    handler: async (args, c) => {
      if (!c.hasUI) return;
      if (!isOwner) {
        c.ui.notify("subagent-watchdog is dormant in this session (not the root orchestrator session).", "warning");
        return;
      }
      const sub = args?.trim().toLowerCase();
      if (sub === "help") {
        c.ui.notify(helpText(), "info");
        return;
      }
      if (sub === "status") {
        c.ui.notify(statusLines().join("\n"), "info");
        return;
      }
      if (sub === "reload") {
        applyConfig(c);
        c.ui.notify(`watchdog config reloaded\n${statusLines().slice(0, 3).join("\n")}`, "info");
        return;
      }
      if (sub === "config") {
        const path = join(agentDir(), "subagent-watchdog.json");
        let current: string;
        try {
          current = readFileSync(path, "utf8");
        } catch {
          current = JSON.stringify(DEFAULTS, null, 2) + "\n";
        }
        const edited = await c.ui.editor(`Edit ${path}`, current);
        if (edited === undefined || edited === current) {
          c.ui.notify("Config unchanged.", "info");
          return;
        }
        try {
          JSON.parse(edited);
        } catch (err) {
          c.ui.notify(
            `Not saved — invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
        writeFileSync(path, edited.endsWith("\n") ? edited : edited + "\n", "utf8");
        applyConfig(c);
        c.ui.notify(`Saved + applied.\n${statusLines().slice(0, 3).join("\n")}`, "info");
        return;
      }
      if (sub) {
        c.ui.notify(`Unknown subcommand "${sub}" — try /watchdog help`, "warning");
        return;
      }
      const registry = getRegistry();
      const live = [...roster.entries()].filter(([id]) => registry?.getRecord(id)?.status === "running");

      if (!registry || live.length === 0) {
        c.ui.notify(`${statusLines().join("\n")}\n(/watchdog help for commands and settings)`, "info");
        return;
      }

      // Pick an agent (or just show status)
      const agentOptions = live.map(([id, w], i) => {
        const rec = registry.getRecord(id);
        const handle = rec ? (rec.alias ?? rec.handle ?? id) : id;
        return `${i + 1}. ${handle} — ${w.description.slice(0, 60)}`;
      });
      const pick = await c.ui.select("Watchdog — pick an agent (Esc for status only):", agentOptions);
      if (pick === undefined) {
        c.ui.notify(statusLines().join("\n"), "info");
        return;
      }
      const [id, w] = live[agentOptions.indexOf(pick)];
      const rec = registry.getRecord(id);
      if (!rec || rec.status !== "running") {
        c.ui.notify("Agent is no longer running.", "warning");
        return;
      }
      if (rec.outputFile) updateFromTranscript(w, rec.outputFile);
      const v = readVitals(w, rec);
      const handle = rec.alias ?? rec.handle ?? id;

      const action = await c.ui.select(`${handle}: ${vitalsLine(v)}`, [
        "Show vitals + recent tools",
        "Request check-in (wake orchestrator now)",
        "Steer: custom message…",
        "Steer: wrap up and return partial results",
        "Hard stop",
      ]);
      if (action === undefined) return;

      if (action.startsWith("Show")) {
        const lines = [
          `${handle} (${w.type}, id ${id})`,
          `task: ${w.description}`,
          ...(modelLine(rec) ? [`model: ${modelLine(rec)}`] : []),
          `vitals: ${vitalsLine(v)}`,
        ];
        if (w.recentTools.length > 0) {
          lines.push("recent tools:");
          for (const t of w.recentTools) lines.push(`  - ${t}`);
        }
        c.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action.startsWith("Request check-in")) {
        w.lastWakeAt = Date.now();
        w.wakeCount += 1;
        const item = snapshotCheckIn(
          w,
          rec,
          v,
          [],
          w.wakeCount,
          "User-requested check-in via /watchdog",
        );
        appendAudit("manual-check-in", { checkIn: item });
        pi.sendMessage(
          {
            customType: "subagent-watchdog",
            content: checkInMessage([item], cfg.mode),
            display: true,
          },
          { deliverAs: cfg.deliverAs, triggerTurn: true },
        );
        c.ui.notify(`Check-in for "${handle}" queued to the orchestrator.`, "info");
        return;
      }

      if (action.startsWith("Steer: custom")) {
        const msg = await c.ui.input(`Steering message for ${handle}:`, "");
        if (!msg) return;
        try {
          if (!rec.session?.steer) throw new Error("no live session to steer");
          await rec.session.steer(msg);
          appendAudit("manual-steer", { agentId: id, handle, model: modelLine(rec), message: msg });
          c.ui.notify(`Steered "${handle}".`, "info");
        } catch (err) {
          c.ui.notify(`Steer failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      if (action.startsWith("Steer: wrap")) {
        try {
          if (!rec.session?.steer) throw new Error("no live session to steer");
          await rec.session.steer(WRAP_UP_STEER);
          appendAudit("manual-wrap-up", { agentId: id, handle, model: modelLine(rec) });
          c.ui.notify(`Wrap-up steer sent to "${handle}".`, "info");
        } catch (err) {
          c.ui.notify(`Steer failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      if (action === "Hard stop") {
        const ok = await c.ui.confirm("Hard stop", `Stop "${handle}" now? Partial work may be lost.`);
        if (!ok) return;
        hardStop(w, rec, v, "user-requested via /watchdog");
      }
    },
  });
}
